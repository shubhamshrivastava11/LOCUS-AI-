// Offline aggregation-channel detection.
//
// Conditions (1) to (4) of the access rule are per-record. They cannot see a
// fact derived from two records that each pass. This finds those combinations
// ahead of time, so the query-time gate can be a subset-containment check
// against a precomputed table rather than a model call on the hot path.
//
// Shape, and why it is this shape
// -------------------------------
// The expensive question - "do these records together imply this fact?" - is
// asked of Claude. The cheap question - "are these records even about the same
// area?" - is asked of pgvector. So the vector index does the narrowing and the
// model only ever sees what survives it, which is the same trade that makes the
// conflict detector affordable. Measured on production, 15 Sep 2026: 256
// decisions give 14,739 within-tenant pairs, of which 298 clear the 0.72 cosine
// floor. Two percent.
//
// Triples are where an unbounded search stops being affordable - extending
// every positive pair across a corpus is thousands of calls. Two rules bound
// it, and both come from minimality rather than from a budget:
//
//   1. A fact whose pair search found ANY sufficient pair is not extended at
//      all. A superset of a sufficient set is not a minimal set, so the triples
//      would be discarded even if they were computed.
//   2. A fact with no sufficient pair extends only its best-scoring pairs, and
//      only with records already inside the fact's own candidate window.
//
// Everything runs under the same daily ceiling ai-worker checks, and every call
// is recorded in pipeline_daily_usage, so a runaway sweep stops rather than
// arriving as a surprise on the Anthropic bill.

import { withAdmin, withTenant } from "../_shared/db.ts";
import { requireInternalKey } from "../_shared/internalAuth.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const VOYAGE_API_KEY = Deno.env.get("VOYAGE_API_KEY") ?? "";
const VOYAGE_MODEL = Deno.env.get("VOYAGE_EMBED_MODEL") ?? "voyage-4-large";
const MODEL = "claude-haiku-4-5-20251001";

/** Same ceiling ai-worker enforces, and the same table behind it. */
const DAILY_SPEND_CAP_USD = Number(Deno.env.get("AI_DAILY_SPEND_CAP_USD") ?? "1");

/** Below this two records are not about the same thing closely enough to combine. */
const COSINE_FLOOR = Number(Deno.env.get("DETECT_COSINE_FLOOR") ?? "0.60");

/** How many records around a fact are considered at all. */
const CANDIDATE_WINDOW = 14;

/** Pairs sent to the model per fact. The window squared, capped. */
const MAX_PAIRS_PER_FACT = 40;

/** Only for facts where no pair sufficed. See the header. */
const MAX_TRIPLES_PER_FACT = 24;

const HAIKU_INPUT_PER_MTOK = 1.0;
const HAIKU_OUTPUT_PER_MTOK = 5.0;

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

/**
 * Every field is put through Number() first, and that is not defensive noise.
 *
 * pipeline_daily_usage stores these as bigint, and postgres.js hands a bigint
 * back as a STRING to avoid losing precision. So `a + b` over three token
 * counts concatenates instead of adding: 10354 and 20236 became "1035420236",
 * which divided out to a reported spend of $77 million and made this function
 * refuse to do anything on its first real run. Multiplication would have
 * coerced silently and hidden it, which is exactly how ai-worker's own copy of
 * this arithmetic has been correct by luck rather than by intent.
 */
function costUsd(u: Usage): number {
  const n = (v: unknown) => Number(v ?? 0) || 0;
  const input = n(u.input_tokens) + n(u.cache_creation_input_tokens) +
    n(u.cache_read_input_tokens);
  return (input / 1e6) * HAIKU_INPUT_PER_MTOK +
    (n(u.output_tokens) / 1e6) * HAIKU_OUTPUT_PER_MTOK;
}

async function todaysSpendUsd(): Promise<number> {
  try {
    const rows = await withAdmin(async (sql) =>
      await sql`
        select input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens
        from public.pipeline_daily_usage where usage_date = current_date
      `
    ) as unknown as Usage[];
    if (rows.length === 0) return 0;
    return costUsd(rows[0]);
  } catch (err) {
    // Fails OPEN, matching ai-worker: an unreadable accounting table must not
    // stop the pipeline. The sweep is manually triggered and bounded by the
    // per-run caps above, so the exposure here is one run, not a runaway.
    console.error("spend lookup failed, proceeding:", err);
    return 0;
  }
}

async function recordUsage(u: Usage): Promise<void> {
  await withAdmin(async (sql) => {
    await sql`
      insert into public.pipeline_daily_usage as p (
        usage_date, input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens, request_count
      ) values (
        current_date, ${u.input_tokens ?? 0}, ${u.output_tokens ?? 0},
        ${u.cache_creation_input_tokens ?? 0}, ${u.cache_read_input_tokens ?? 0}, 1
      )
      on conflict (usage_date) do update set
        input_tokens = p.input_tokens + excluded.input_tokens,
        output_tokens = p.output_tokens + excluded.output_tokens,
        cache_creation_input_tokens = p.cache_creation_input_tokens + excluded.cache_creation_input_tokens,
        cache_read_input_tokens = p.cache_read_input_tokens + excluded.cache_read_input_tokens,
        request_count = p.request_count + 1
    `;
  });
}

let spentThisRun = 0;

async function callClaude(
  system: string,
  userMessage: string,
  tool: Record<string, unknown>,
  toolName: string,
  maxTokens: number,
): Promise<Record<string, unknown>> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      temperature: 0,
      system,
      messages: [{ role: "user", content: userMessage }],
      tools: [tool],
      tool_choice: { type: "tool", name: toolName },
    }),
  });
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${(await resp.text()).slice(0, 300)}`);

  const body = await resp.json();
  const usage = (body.usage ?? {}) as Usage;
  spentThisRun += costUsd(usage);
  await recordUsage(usage);

  const block = (body.content ?? []).find((c: { type: string }) => c.type === "tool_use");
  if (!block) throw new Error("model returned no tool_use block");
  return block.input as Record<string, unknown>;
}

async function embed(text: string): Promise<number[]> {
  const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ input: [text], model: VOYAGE_MODEL, input_type: "query" }),
  });
  if (!resp.ok) throw new Error(`Voyage ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const body = await resp.json();
  return body.data[0].embedding as number[];
}

// ── The two questions ────────────────────────────────────────────────────

const ENTAILMENT_TOOL = {
  name: "record_entailment",
  description: "For each numbered candidate set, say whether the set as a whole establishes the target fact.",
  input_schema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            candidate_number: { type: "integer" },
            // The two halves that make a set a CHANNEL rather than a leak. A
            // set only counts when the whole establishes the fact AND no
            // member does so on its own - otherwise the per-record rule would
            // already have caught it and there is nothing here to detect.
            set_establishes: { type: "boolean" },
            any_single_record_establishes: { type: "boolean" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reason: { type: "string" },
          },
          required: [
            "candidate_number", "set_establishes",
            "any_single_record_establishes", "confidence", "reason",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["results"],
    additionalProperties: false,
  },
};

const ENTAILMENT_SYSTEM =
  `You decide whether a small set of workplace records, read together, establishes a target fact.

A set establishes the fact when someone who read every record in the set, and nothing else, would conclude the fact is true. Not "might suspect" and not "would find it consistent with" - would conclude it.

Two judgements per candidate, and the second is what matters:

- set_establishes: does the set as a whole establish the target fact?
- any_single_record_establishes: does at least ONE record in the set establish the target fact on its own, without the others?

A set is only interesting when set_establishes is true and any_single_record_establishes is FALSE. That is the case where the fact emerges from the combination and no per-record check could ever have caught it. If one record already states or plainly implies the fact, say so - the set is then not a combination effect and reporting it would be a false positive.

Be strict. A shared topic is not entailment. Two records about the same office, the same quarter or the same team do not establish anything just by sitting next to each other. Default to false when genuinely unsure: a missed channel costs recall in a measurement, a false one is withheld content a person needed.

Call record_entailment exactly once, with one result per candidate, in the order given.`;

type DecisionRow = { id: string; decision_statement: string; rationale: string | null; similarity: number };

function renderRecord(d: DecisionRow): string {
  return d.rationale ? `${d.decision_statement} (reason: ${d.rationale})` : d.decision_statement;
}

function renderCandidates(sets: DecisionRow[][]): string {
  return sets.map((set, i) =>
    `Candidate ${i + 1}:\n` + set.map((d, j) => `  Record ${j + 1}: ${renderRecord(d)}`).join("\n")
  ).join("\n\n");
}

type Verdict = {
  candidate_number: number;
  set_establishes: boolean;
  any_single_record_establishes: boolean;
  confidence: number;
  reason: string;
};

async function judge(fact: string, sets: DecisionRow[][]): Promise<Verdict[]> {
  const out = await callClaude(
    ENTAILMENT_SYSTEM,
    `Target fact:\n${fact}\n\n${renderCandidates(sets)}`,
    ENTAILMENT_TOOL,
    "record_entailment",
    2048,
  );
  return (out.results ?? []) as Verdict[];
}

// ── The sweep ────────────────────────────────────────────────────────────

function pairsOf<T>(xs: T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) out.push([xs[i], xs[j]]);
  }
  return out;
}

async function detectForTenant(
  tenantId: string,
  minConfidence: number,
  dryRun: boolean,
  cosineFloor: number,
  offset: number,
  limit: number,
): Promise<Record<string, unknown>> {
  // Sliced rather than swept in one go. Supabase's gateway closes a request
  // after 150 seconds of silence, and a fact costs an embedding plus one or two
  // Claude calls over forty candidates, so a corpus of any size will exceed
  // that. The caller walks the offset; a cron-driven version does the same
  // thing one tick at a time, which is the shape this wants in production
  // anyway.
  const total = await withTenant(tenantId, async (sql) =>
    await sql`select count(*)::int as n from public.protected_facts where tenant_id = ${tenantId}::uuid`
  ) as unknown as { n: number }[];

  const facts = await withTenant(tenantId, async (sql) =>
    await sql`
      select id, statement, scope_hint from public.protected_facts
      where tenant_id = ${tenantId}::uuid order by created_at
      limit ${limit} offset ${offset}
    `
  ) as unknown as { id: string; statement: string; scope_hint: string | null }[];

  const report: Record<string, unknown>[] = [];
  let pairCalls = 0;
  let tripleCalls = 0;
  let written = 0;

  for (const fact of facts) {
    const spent = await todaysSpendUsd();
    if (spent >= DAILY_SPEND_CAP_USD) {
      report.push({ fact_id: fact.id, skipped: "daily spend cap reached", spent_usd: spent });
      break;
    }

    // The candidate window: the records nearest the fact itself. A record that
    // is not about the fact's subject cannot be part of a minimal set that
    // establishes it, so this is narrowing rather than sampling.
    const embedding = await embed(fact.statement);
    const literal = "[" + embedding.join(",") + "]";
    const candidates = await withTenant(tenantId, async (sql) =>
      await sql`
        select d.id, d.decision_statement, d.rationale,
               1 - (de.embedding <=> ${literal}::vector) as similarity
        from public.decision_embeddings de
        join public.decisions d on d.id = de.decision_id and d.tenant_id = de.tenant_id
        where d.tenant_id = ${tenantId}::uuid and d.superseded_by is null
        order by de.embedding <=> ${literal}::vector asc
        limit ${CANDIDATE_WINDOW}
      `
    ) as unknown as DecisionRow[];

    const window = candidates.filter((c) => Number(c.similarity) >= cosineFloor);
    // The observed range is reported whether or not anything clears the floor.
    // A run that finds nothing should say whether that is because the corpus
    // holds no channels or because the floor was set above everything in it -
    // those need opposite responses and look identical without this.
    const top = candidates.length > 0 ? Number(candidates[0].similarity) : null;
    const bottom = candidates.length > 0
      ? Number(candidates[candidates.length - 1].similarity)
      : null;
    if (window.length < 2) {
      report.push({
        fact_id: fact.id, statement: fact.statement, window: window.length,
        considered: candidates.length, top_similarity: top, floor: cosineFloor,
        sets_found: 0,
      });
      continue;
    }

    const pairs = pairsOf(window)
      .sort((a, b) =>
        (Number(b[0].similarity) + Number(b[1].similarity)) -
        (Number(a[0].similarity) + Number(a[1].similarity))
      )
      .slice(0, MAX_PAIRS_PER_FACT)
      .map(([a, b]) => [a, b]);

    const verdicts = await judge(fact.statement, pairs);
    pairCalls++;

    const found: { ids: string[]; confidence: number; reason: string }[] = [];
    for (const v of verdicts) {
      const set = pairs[v.candidate_number - 1];
      if (!set) continue;
      if (!v.set_establishes || v.any_single_record_establishes) continue;
      if (Number(v.confidence) < minConfidence) continue;
      found.push({ ids: set.map((d) => d.id), confidence: Number(v.confidence), reason: v.reason });
    }

    // Rule 1 from the header. Triples are only searched where no pair sufficed,
    // because a superset of a sufficient set is not minimal and would be thrown
    // away regardless. This is what keeps the combinatorics from opening up.
    if (found.length === 0 && window.length >= 3) {
      const best = window.slice(0, 6);
      const triples: DecisionRow[][] = [];
      for (let i = 0; i < best.length && triples.length < MAX_TRIPLES_PER_FACT; i++) {
        for (let j = i + 1; j < best.length && triples.length < MAX_TRIPLES_PER_FACT; j++) {
          for (let k = j + 1; k < best.length && triples.length < MAX_TRIPLES_PER_FACT; k++) {
            triples.push([best[i], best[j], best[k]]);
          }
        }
      }
      if (triples.length > 0) {
        const tv = await judge(fact.statement, triples);
        tripleCalls++;
        for (const v of tv) {
          const set = triples[v.candidate_number - 1];
          if (!set) continue;
          if (!v.set_establishes || v.any_single_record_establishes) continue;
          if (Number(v.confidence) < minConfidence) continue;
          found.push({ ids: set.map((d) => d.id), confidence: Number(v.confidence), reason: v.reason });
        }
      }
    }

    if (!dryRun && found.length > 0) {
      await withTenant(tenantId, async (sql) => {
        await sql`delete from public.derivation_sets where tenant_id = ${tenantId}::uuid and fact_id = ${fact.id}::uuid`;
        for (const f of found) {
          await sql`
            insert into public.derivation_sets (tenant_id, fact_id, decision_ids, confidence)
            values (${tenantId}::uuid, ${fact.id}::uuid, ${f.ids}::uuid[], ${f.confidence})
          `;
        }
      });
      written += found.length;
    }

    report.push({
      fact_id: fact.id,
      statement: fact.statement,
      top_similarity: top,
      lowest_considered: bottom,
      window: window.length,
      pairs_tested: pairs.length,
      sets_found: found.length,
      sets: found,
    });
  }

  return {
    tenant_id: tenantId,
    facts: facts.length,
    fact_offset: offset,
    facts_total: total[0]?.n ?? 0,
    next_offset: offset + facts.length < (total[0]?.n ?? 0) ? offset + facts.length : null,
    pair_calls: pairCalls,
    triple_calls: tripleCalls,
    sets_written: written,
    run_cost_usd: Number(spentThisRun.toFixed(4)),
    dry_run: dryRun,
    detail: report,
  };
}

// == Exploratory mode =====================================================
//
// The mode above answers "which records establish THIS fact". It needs the
// fact written down first, and measured on the test corpus it also does not
// work: fact-to-record cosine similarity topped out at 0.50 across ten planted
// facts, where record-to-record similarity in the same corpus reaches 0.72.
// That is not a tuning problem, it is the phenomenon itself. A protected fact
// is an abstract conclusion, and the records are concrete operational
// statements that deliberately do not state it - so being semantically FAR
// from the fact is close to the definition of belonging to a derivation
// channel. Retrieving by similarity to the fact retrieves the wrong things by
// construction, and lowering the floor only buys noise.
//
// This mode inverts the narrowing. Find records near EACH OTHER, which is
// cheap and which the same corpus shows is discriminating, then ask what the
// pair jointly establishes. Nothing has to be anticipated, and the output is
// candidate facts rather than confirmations of facts somebody already thought
// of - which also answers the honest limitation of the whole mechanism, that
// it otherwise protects only what was written down in advance.

const DISCOVERY_TOOL = {
  name: "record_discoveries",
  description: "For each numbered pair, report any fact the pair establishes that neither record states.",
  input_schema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            candidate_number: { type: "integer" },
            implies_unstated_fact: { type: "boolean" },
            fact: {
              type: ["string", "null"],
              description: "One sentence: the fact the pair establishes. Null when there is none.",
            },
            sensitivity: {
              type: ["integer", "null"],
              enum: [0, 1, 2, 3, null],
              description: "How sensitive the derived fact is. 0 anyone, 1 ordinary, 2 restricted, 3 confidential.",
            },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["candidate_number", "implies_unstated_fact", "fact", "sensitivity", "confidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["results"],
    additionalProperties: false,
  },
};

const DISCOVERY_SYSTEM =
  "You are given pairs of workplace records. For each pair, decide whether reading BOTH establishes some fact that NEITHER record states on its own.\n" +
  "\n" +
  "You are looking for one specific thing: a conclusion that emerges only from the combination. A cancelled office lease in one record and a team moved to a different city in the other together establish that the office is closing, though neither says so. That is the shape to report.\n" +
  "\n" +
  "What is NOT a finding, and these are the common false positives:\n" +
  "\n" +
  "- The pair is about the same topic. Topic overlap is not entailment.\n" +
  "- One record already states the conclusion. Then nothing emerged from combining them.\n" +
  "- The proposed fact is a summary of the two records stuck together. A restatement is not a derivation.\n" +
  "- Reaching the conclusion needs an assumption a reader could not get from these two records.\n" +
  "\n" +
  "Set implies_unstated_fact to false for all of those, and expect to set it false most of the time. Most pairs of records establish nothing new, and a confident wrong answer here becomes content withheld from someone who needed it.\n" +
  "\n" +
  "When you do report one, write the fact as a single plain sentence, and rate how sensitive it would be inside a company: 0 safe for anyone, 1 ordinary work, 2 personnel or security or unreleased commercial, 3 legal exposure or acquisitions or named-individual harm.\n" +
  "\n" +
  "Call record_discoveries exactly once, with one result per pair, in the order given.";

type Discovery = {
  candidate_number: number;
  implies_unstated_fact: boolean;
  fact: string | null;
  sensitivity: number | null;
  confidence: number;
};

type PairRow = {
  a_id: string;
  b_id: string;
  similarity: number;
  a_statement: string;
  a_rationale: string | null;
  b_statement: string;
  b_rationale: string | null;
};

function renderPair(p: PairRow, n: number): string {
  const a = p.a_rationale ? p.a_statement + " (reason: " + p.a_rationale + ")" : p.a_statement;
  const b = p.b_rationale ? p.b_statement + " (reason: " + p.b_rationale + ")" : p.b_statement;
  return "Pair " + n + ":\n  Record A: " + a + "\n  Record B: " + b;
}

async function exploreTenant(
  tenantId: string,
  cosineFloor: number,
  minConfidence: number,
  offset: number,
  limit: number,
): Promise<Record<string, unknown>> {
  const totalRows = await withTenant(tenantId, async (sql) =>
    await sql`
      select count(*)::int as n
      from public.decision_embeddings a
      join public.decision_embeddings b
        on b.tenant_id = a.tenant_id and a.decision_id < b.decision_id
      where a.tenant_id = ${tenantId}::uuid
        and 1 - (a.embedding <=> b.embedding) >= ${cosineFloor}
    `
  ) as unknown as { n: number }[];
  const total = totalRows[0]?.n ?? 0;

  const rows = await withTenant(tenantId, async (sql) =>
    await sql`
      select a.decision_id as a_id, b.decision_id as b_id,
             1 - (a.embedding <=> b.embedding) as similarity,
             da.decision_statement as a_statement, da.rationale as a_rationale,
             db.decision_statement as b_statement, db.rationale as b_rationale
      from public.decision_embeddings a
      join public.decision_embeddings b
        on b.tenant_id = a.tenant_id and a.decision_id < b.decision_id
      join public.decisions da on da.id = a.decision_id and da.tenant_id = a.tenant_id
      join public.decisions db on db.id = b.decision_id and db.tenant_id = b.tenant_id
      where a.tenant_id = ${tenantId}::uuid
        and 1 - (a.embedding <=> b.embedding) >= ${cosineFloor}
        and da.superseded_by is null and db.superseded_by is null
      order by 1 - (a.embedding <=> b.embedding) desc, a.decision_id, b.decision_id
      limit ${limit} offset ${offset}
    `
  ) as unknown as PairRow[];

  const found: Record<string, unknown>[] = [];
  let calls = 0;
  const BATCH = 8;

  for (let i = 0; i < rows.length; i += BATCH) {
    const spent = await todaysSpendUsd();
    if (spent >= DAILY_SPEND_CAP_USD) {
      return {
        tenant_id: tenantId, mode: "explore", cosine_floor: cosineFloor,
        pairs_total: total, pairs_examined: i, pair_offset: offset,
        next_offset: offset + i, calls, found_count: found.length,
        stopped: "daily spend cap reached",
        run_cost_usd: Number(spentThisRun.toFixed(4)), found,
      };
    }

    const batch = rows.slice(i, i + BATCH);
    const rendered = batch.map((p, j) => renderPair(p, j + 1)).join("\n\n");
    const out = await callClaude(DISCOVERY_SYSTEM, rendered, DISCOVERY_TOOL, "record_discoveries", 2048);
    calls++;

    for (const d of (out.results ?? []) as Discovery[]) {
      const pair = batch[d.candidate_number - 1];
      if (!pair) continue;
      if (!d.implies_unstated_fact || !d.fact) continue;
      if (Number(d.confidence) < minConfidence) continue;
      found.push({
        decision_ids: [pair.a_id, pair.b_id],
        similarity: Number(pair.similarity),
        fact: d.fact,
        sensitivity: d.sensitivity,
        confidence: Number(d.confidence),
        records: [pair.a_statement, pair.b_statement],
      });
    }
  }

  return {
    tenant_id: tenantId,
    mode: "explore",
    cosine_floor: cosineFloor,
    pairs_total: total,
    pairs_examined: rows.length,
    pair_offset: offset,
    next_offset: offset + rows.length < total ? offset + rows.length : null,
    calls,
    found_count: found.length,
    run_cost_usd: Number(spentThisRun.toFixed(4)),
    found,
  };
}

Deno.serve(async (req: Request) => {
  const auth = await requireInternalKey(req);
  if (auth) return auth;

  let body: {
    tenant_id?: string; min_confidence?: number; dry_run?: boolean;
    cosine_floor?: number; offset?: number; limit?: number; mode?: string;
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }

  const tenantId = String(body.tenant_id ?? "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    return new Response(JSON.stringify({ error: "tenant_id must be a UUID" }), {
      status: 422, headers: { "content-type": "application/json" },
    });
  }

  spentThisRun = 0;
  try {
    if (body.mode === "explore") {
      const explored = await exploreTenant(
        tenantId,
        typeof body.cosine_floor === "number" ? body.cosine_floor : COSINE_FLOOR,
        typeof body.min_confidence === "number" ? body.min_confidence : 0.6,
        typeof body.offset === "number" ? Math.max(0, body.offset) : 0,
        typeof body.limit === "number" ? Math.min(64, Math.max(1, body.limit)) : 24,
      );
      return new Response(JSON.stringify(explored), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }

    const result = await detectForTenant(
      tenantId,
      typeof body.min_confidence === "number" ? body.min_confidence : 0.6,
      body.dry_run === true,
      typeof body.cosine_floor === "number" ? body.cosine_floor : COSINE_FLOOR,
      typeof body.offset === "number" ? Math.max(0, body.offset) : 0,
      typeof body.limit === "number" ? Math.min(20, Math.max(1, body.limit)) : 3,
    );
    return new Response(JSON.stringify(result), {
      status: 200, headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error("detection failed:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
});
