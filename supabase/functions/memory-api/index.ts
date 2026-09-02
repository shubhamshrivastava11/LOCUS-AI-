// supabase/functions/memory-api/index.ts
//
// Owns the read/action surface for the Memory Intelligence layer (entity
// review queue, evidence, attention, resolve). As of the memory-explorer
// upgrade, ai-worker is the sole ingestion engine - it writes directly to
// public.memories - so this function no longer owns any write/ingestion
// path of its own. The fixture-loader and real-replay debug endpoints that
// used to live here were removed for that reason, not because ingestion
// moved elsewhere; there is no elsewhere, ai-worker is it.

import { withAdmin, withTenant } from "../_shared/db.ts";
import { extractMemory, validatePayloadForType } from "../_shared/memory/extraction.ts";
import { resolveEntityMention, resolveReferencedMention, confirmNewEntity, mergeIntoExistingEntity, linkQueuedMentionsToMemory } from "../_shared/memory/entityResolution.ts";
import { writeMemory, detectConflicts, classifyRelation, ZeroSourceEventsError } from "../_shared/memory/reconcile.ts";
import { embedText } from "../_shared/memory/embeddings.ts";
import type { MemoryType } from "../_shared/memory/types.ts";
import { requireServiceRole } from "../_shared/requireServiceRole.ts";
import { isMemoryAccessible, isMemoryAccessibleBatch } from "../_shared/memory/permissions.ts";
import { loadMemoriesForTenant } from "../_shared/memory/loadMemories.ts";
import { getCurrentTenant, resolvePermissionScopes, type TenantContext } from "../_shared/tenantAuth.ts";
import { runGoldenEval } from "../_shared/memory/eval/evalRunner.ts";
import { getAttentionItems, resolveMemory, actionForCategory, MemoryNotAccessibleError, type ResolutionAction } from "../_shared/memory/attentionStrip.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

// Real gate, found missing during Checkpoint A follow-up: every route in
// this function previously relied only on Supabase's default per-function
// JWT verification, which the PUBLIC anon key satisfies - meaning
// /fixtures/load (writes fabricated "memories" into any real tenant) and
// /debug/delete-memories (deletes any tenant's real data) were reachable
// by anyone holding the project's anon key, which ships in the frontend
// bundle and is visible to any browser. This isn't a hypothetical: it was
// the actual deployed state until this check was added. Requires the JWT's
// role claim to be service_role - the key that never ships to any
// frontend - not just "any successfully verified JWT". Every route below
// goes through this, no exceptions, including the debug/verification ones.
// requireServiceRole now lives in ../_shared/requireServiceRole.ts (also
// used by slack-membership-sync) - moved so a second admin-only function
// doesn't grow its own hand-copied, silently-drifting version.

async function handleDebugTenants(): Promise<Response> {
  const rows = await withAdmin(async (sql) => {
    return await sql`
      select t.id as tenant_id, t.name, count(re.id)::int as raw_event_count,
             count(re.id) filter (where re.source = 'slack')::int as slack_count,
             count(re.id) filter (where re.source = 'gmail')::int as gmail_count,
             count(re.id) filter (where re.source = 'notion')::int as notion_count
      from public.tenants t
      left join public.raw_events re on re.tenant_id = t.id
      group by t.id, t.name
      order by count(re.id) desc
      limit 20
    `;
  });
  return json({ tenants: rows });
}

// Read-only summary of what's actually been written for a tenant -
// verification helper for Checkpoint A/B, not a permanent product endpoint.
async function handleDebugMemories(tenantId: string): Promise<Response> {
  const rows = await withTenant(tenantId, async (sql) => {
    return await sql`
      select m.type, count(*)::int as n,
             array_agg(distinct mfe.source) as sources
      from public.memories m
      join public.memory_source_events mse on mse.memory_id = m.memory_id
      join public.memory_fixture_events mfe on mfe.id = mse.fixture_event_id
      where m.tenant_id = ${tenantId}
      group by m.type
      order by n desc
    `;
  });
  const sample = await withTenant(tenantId, async (sql) => {
    return await sql`
      select memory_id, type, title, summary, status, valid_from, confidence
      from public.memories where tenant_id = ${tenantId}
      order by created_at desc limit 10
    `;
  });
  const duplicateCheck = await withTenant(tenantId, async (sql) => {
    return await sql`
      select mfe.id as fixture_event_id, mfe.source, mfe.source_id,
             count(distinct mse.memory_id)::int as memory_count,
             array_agg(distinct mse.memory_id) as memory_ids
      from public.memory_fixture_events mfe
      join public.memory_source_events mse on mse.fixture_event_id = mfe.id
      where mfe.tenant_id = ${tenantId}
      group by mfe.id, mfe.source, mfe.source_id
      having count(distinct mse.memory_id) > 1
    `;
  });

  return json({ tenant_id: tenantId, counts_by_type: rows, recent_sample: sample, duplicate_memories_per_event: duplicateCheck });
}

// One-off cleanup utility for the duplicate memories the pre-fix bug
// created (see the "already processed" guard above) - deletes by explicit
// id list only, cascades through memory_entities/memory_source_events/
// memory_citations/memory_embeddings via their FKs. Not a general delete
// endpoint - intentionally narrow.
async function handleDebugDeleteMemories(req: Request): Promise<Response> {
  const body = await req.json() as { tenant_id?: string; memory_ids?: string[] };
  if (!body.tenant_id || !body.memory_ids?.length) {
    return json({ detail: "tenant_id and memory_ids[] are required" }, 400);
  }
  const deleted = await withTenant(body.tenant_id, async (sql) => {
    return await sql`
      delete from public.memories
      where tenant_id = ${body.tenant_id} and memory_id = any(${body.memory_ids})
      returning memory_id
    `;
  });
  return json({ deleted_count: deleted.length, deleted_ids: deleted.map((r: { memory_id: string }) => r.memory_id) });
}

// Live proof the zero-source-events guard actually fires, not just a code
// read - calls the real writeMemory() with an empty source list and
// reports whether it threw ZeroSourceEventsError, and confirms nothing
// landed in public.memories as a result.
async function handleDebugZeroSourceTest(req: Request): Promise<Response> {
  const body = await req.json() as { tenant_id?: string };
  if (!body.tenant_id) return json({ detail: "tenant_id is required" }, 400);
  const tenantId = body.tenant_id;

  let threw: string | null = null;
  try {
    await withTenant(tenantId, async (sql) => {
      await writeMemory(sql, {
        tenantId,
        type: "Context",
        title: "debug zero-source-events test - should never persist",
        summary: "debug zero-source-events test - should never persist",
        payload: { attribute_key: "debug-zero-source-test" },
        entityIds: [],
        occurredAt: new Date().toISOString(),
        validFrom: new Date().toISOString(),
        confidence: 0.5,
        searchableText: "debug zero-source-events test",
        sourceEventIds: [], // <- the thing being tested
        citations: [],
      });
    });
  } catch (err) {
    threw = err instanceof ZeroSourceEventsError ? "ZeroSourceEventsError" : `unexpected: ${err instanceof Error ? err.message : String(err)}`;
  }

  const leaked = await withTenant(tenantId, async (sql) => {
    return await sql`select memory_id from public.memories where title = 'debug zero-source-events test - should never persist'`;
  });

  return json({ threw, leaked_rows: leaked.length, guard_worked: threw === "ZeroSourceEventsError" && leaked.length === 0 });
}

// ── Entity review queue ───────────────────────────────────────────────

// One side of a review-queue card - either the flagged/mentioned thing, or
// the candidate it might be a duplicate of. Same shape for both sides so
// the frontend renders one component twice rather than two.
interface ReviewQueueSide {
  entity_id: string | null; // null for a raw mention that was never confirmed into an entity
  name: string;
  entity_type: string;
  memory_count: number;
  snippet: string | null; // most recent linked memory's summary, or the one memory that named a raw mention
  sources: string[];
}

// Lets the internal review-queue page (staff only, not customer-facing -
// removed from the customer nav entirely) look at ANY tenant's queue for
// extraction/resolution quality checks, while every customer-facing call
// into these same five endpoints (confirm/merge/dismiss/search/list, all
// still real-user auth, no service-role key involved) keeps working
// unchanged for its own tenant. A requested tenant_id is only ever
// honored for a caller whose own email is on STAFF_EMAILS - anyone else
// requesting a different tenant is refused, not silently redirected to
// their own.
const STAFF_EMAILS = new Set(
  (Deno.env.get("STAFF_EMAILS") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
);

async function resolveTargetTenant(ctx: TenantContext, requestedTenantId: string | null): Promise<string> {
  if (!requestedTenantId || requestedTenantId === ctx.tenantId) return ctx.tenantId;
  const rows = await withAdmin((sql) => sql`select email from auth.users where id = ${ctx.userId}`);
  const email = (rows[0]?.email as string | undefined)?.toLowerCase();
  if (!email || !STAFF_EMAILS.has(email)) {
    throw new Error("Not authorized to view another tenant's data");
  }
  return requestedTenantId;
}

async function entitySide(
  // deno-lint-ignore no-explicit-any
  sql: any,
  entityId: string | null,
  name: string,
  entityType: string,
): Promise<ReviewQueueSide> {
  if (!entityId) return { entity_id: null, name, entity_type: entityType, memory_count: 0, snippet: null, sources: [] };
  const rows = await sql`
    select m.summary, m.valid_from,
      (select array_agg(distinct mfe.source) from public.memory_source_events mse
       join public.memory_fixture_events mfe on mfe.id = mse.fixture_event_id
       where mse.memory_id = m.memory_id) as sources
    from public.memory_entities me
    join public.memories m on m.memory_id = me.memory_id
    where me.entity_id = ${entityId}
    order by m.valid_from desc
  `;
  const sourceSet = new Set<string>();
  for (const r of rows) for (const s of (r.sources as string[] | null) ?? []) sourceSet.add(s);
  return {
    entity_id: entityId,
    name,
    entity_type: entityType,
    memory_count: rows.length,
    snippet: rows[0]?.summary ?? null,
    sources: [...sourceSet],
  };
}

// Lets a reviewer manually find a merge target for a review-queue card
// that has no suggested candidate at all - confirmNewEntity only flags a
// merge-review row WITH a candidate when its own live re-check found one;
// entity_ids passed straight to /debug/flag-entity-cluster with no
// target_entity_id (the "genuinely ambiguous, human has to look" case)
// land with candidate_entity_id null. Without this, roughly two-thirds of
// real pending rows were a dead end: two buttons that both just dismiss,
// no way to say "actually, merge it into this one I found myself."
async function handleSearchEntities(req: Request): Promise<Response> {
  const ctx = await getCurrentTenant(req);
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const tenantId = await resolveTargetTenant(ctx, url.searchParams.get("tenant_id"));
  if (q.length < 2) return json({ entities: [] });
  const rows = await withTenant(tenantId, (sql) => sql`
    select entity_id, canonical_name, entity_type
    from public.entities
    where tenant_id = ${tenantId} and status = 'current' and canonical_name ilike ${"%" + q + "%"}
    order by canonical_name
    limit 10
  `);
  return json({ entities: rows });
}

// Real-user routes (moved above the service-role gate, see Deno.serve
// dispatch) - a real bug found while wiring this up: these three routes
// previously only accepted a client-supplied tenant_id (query param or
// body field) with no verification it matched the caller, which was
// harmless only because they sat behind requireServiceRole. tenant_id now
// only ever comes from the verified JWT (ctx.tenantId) UNLESS the caller
// is confirmed staff (resolveTargetTenant) - the customer-facing path
// (attention strip) never passes tenant_id at all, so its behavior is
// unchanged; the internal review-queue page passes it explicitly to view
// any tenant for extraction/resolution quality checks.
async function handleListUnresolvedEntities(req: Request): Promise<Response> {
  const ctx = await getCurrentTenant(req);
  const url = new URL(req.url);
  const tenantId = await resolveTargetTenant(ctx, url.searchParams.get("tenant_id"));
  const items = await withTenant(tenantId, async (sql) => {
    const rows = await sql`
      select ue.id, ue.mention_text, ue.entity_type_guess, ue.candidate_score, ue.source_entity_id, ue.memory_id,
             ue.candidate_entity_id, e_cand.canonical_name as candidate_name, e_cand.entity_type as candidate_type,
             e_src.canonical_name as source_name, e_src.entity_type as source_type,
             m.summary as raw_mention_snippet,
             (select array_agg(distinct mfe.source) from public.memory_source_events mse
              join public.memory_fixture_events mfe on mfe.id = mse.fixture_event_id
              where mse.memory_id = ue.memory_id) as raw_mention_sources
      from public.unresolved_entities ue
      left join public.entities e_cand on e_cand.entity_id = ue.candidate_entity_id
      left join public.entities e_src on e_src.entity_id = ue.source_entity_id
      left join public.memories m on m.memory_id = ue.memory_id
      where ue.tenant_id = ${tenantId} and ue.status = 'pending'
      order by ue.created_at desc
    `;

    return await Promise.all(rows.map(async (row: Record<string, unknown>) => {
      const isRawMention = row.source_entity_id === null;
      const left: ReviewQueueSide = isRawMention
        ? {
            entity_id: null,
            name: row.mention_text as string,
            entity_type: row.entity_type_guess as string,
            memory_count: row.memory_id ? 1 : 0,
            snippet: (row.raw_mention_snippet as string | null) ?? null,
            sources: (row.raw_mention_sources as string[] | null) ?? [],
          }
        : await entitySide(sql, row.source_entity_id as string, row.source_name as string, row.source_type as string);
      const right = row.candidate_entity_id
        ? await entitySide(sql, row.candidate_entity_id as string, row.candidate_name as string, row.candidate_type as string)
        : null;
      return {
        id: row.id,
        kind: isRawMention ? "raw_mention" : "confirmed_duplicate",
        candidate_score: row.candidate_score,
        left,
        right,
      };
    }));
  });

  return json({ tenant_id: tenantId, pending: items });
}

async function handleConfirmNewEntity(req: Request): Promise<Response> {
  const ctx = await getCurrentTenant(req);
  const body = await req.json() as { unresolved_id?: string; tenant_id?: string };
  if (!body.unresolved_id) return json({ detail: "unresolved_id is required" }, 400);
  const tenantId = await resolveTargetTenant(ctx, body.tenant_id ?? null);
  const result = await withTenant(tenantId, (sql) => confirmNewEntity(sql, tenantId, body.unresolved_id!));
  return json({
    entity_id: result.entityId,
    attached_existing: result.attachedExisting,
    flagged_for_merge_review: result.flaggedForMergeReview,
  });
}

async function handleMergeEntity(req: Request): Promise<Response> {
  const ctx = await getCurrentTenant(req);
  const body = await req.json() as { unresolved_id?: string; target_entity_id?: string; tenant_id?: string };
  if (!body.unresolved_id || !body.target_entity_id) {
    return json({ detail: "unresolved_id and target_entity_id are required" }, 400);
  }
  const tenantId = await resolveTargetTenant(ctx, body.tenant_id ?? null);
  await withTenant(tenantId, (sql) => mergeIntoExistingEntity(sql, tenantId, body.unresolved_id!, body.target_entity_id!));
  return json({ merged: true });
}

// "Keep separate"/"skip for now" - the reviewer looked at both sides and
// decided not to act, at least not right now. Leaves both entities exactly
// as they are (no merge, no new entity), just takes the row off the
// pending list so it stops competing for review attention. Distinct from
// merge/confirm, which is why it's its own status rather than overloading
// 'merged' or 'confirmed_new' for a row where nothing was actually created.
async function handleDismissUnresolvedEntity(req: Request): Promise<Response> {
  const ctx = await getCurrentTenant(req);
  const body = await req.json() as { unresolved_id?: string; tenant_id?: string };
  if (!body.unresolved_id) return json({ detail: "unresolved_id is required" }, 400);
  const tenantId = await resolveTargetTenant(ctx, body.tenant_id ?? null);
  await withTenant(tenantId, (sql) => sql`
    update public.unresolved_entities set status = 'dismissed', resolved_at = now()
    where id = ${body.unresolved_id} and tenant_id = ${tenantId} and status = 'pending'
  `);
  return json({ dismissed: true });
}

// ── Batch 2 audits: reconcile what Batch 1's interim logic already did ──

// Runs the real embedding-similarity check pairwise over every entity a
// tenant already has (all of which, since Batch 2's resolver never
// auto-creates, were necessarily created by Batch 1's interim
// exact-match-or-create). Any pair clearing CANDIDATE_FLOOR gets queued
// into unresolved_entities as a merge candidate - see the plan's stated
// decision: Batch 2 reconciles retroactively, not just going forward.
async function handleAuditBatch1Entities(req: Request): Promise<Response> {
  const body = await req.json() as { tenant_id?: string };
  if (!body.tenant_id) return json({ detail: "tenant_id is required" }, 400);
  const tenantId = body.tenant_id;

  const result = await withTenant(tenantId, async (sql) => {
    // Batch 1's interim resolver (resolveOrCreateEntityExactMatch) never
    // wrote entity_embeddings - only Batch 2's real resolver does. Backfill
    // before comparing, otherwise every Batch-1-created entity would be
    // silently invisible to this audit (confirmed live: the first run of
    // this endpoint reported 0 entities checked against a tenant that
    // demonstrably has entities, purely because of this gap).
    const missingEmbeddings = await sql`
      select e.entity_id, e.canonical_name from public.entities e
      left join public.entity_embeddings ee on ee.entity_id = e.entity_id
      where e.tenant_id = ${tenantId} and ee.entity_id is null
    `;
    let backfilled = 0;
    for (const row of missingEmbeddings) {
      const embedding = await embedText(row.canonical_name, "document");
      await sql`
        insert into public.entity_embeddings (entity_id, tenant_id, embedding)
        values (${row.entity_id}, ${tenantId}, ${JSON.stringify(embedding)})
        on conflict (entity_id) do update set embedding = excluded.embedding
      `;
      backfilled++;
    }

    const entities = await sql`
      select e.entity_id, e.entity_type, e.canonical_name, ee.embedding
      from public.entities e
      join public.entity_embeddings ee on ee.entity_id = e.entity_id
      where e.tenant_id = ${tenantId}
    `;
    const CANDIDATE_FLOOR = 0.75;
    // Cosine similarity computed in memory, not one SQL round trip per
    // pair - O(n^2) DB calls timed out the edge function on the first
    // attempt at real scale. postgres.js returns pgvector columns as
    // strings like "[0.1,0.2,...]"; parse once per entity, not per pair.
    const parsedEmbeddings = entities.map((e: { embedding: string }) =>
      (typeof e.embedding === "string" ? JSON.parse(e.embedding) : e.embedding) as number[]
    );
    function cosineSimilarity(a: number[], b: number[]): number {
      let dot = 0, normA = 0, normB = 0;
      for (let k = 0; k < a.length; k++) { dot += a[k] * b[k]; normA += a[k] * a[k]; normB += b[k] * b[k]; }
      return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    const flagged: { entity_a: string; entity_b: string; similarity: number }[] = [];
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        if (entities[i].entity_type !== entities[j].entity_type) continue;
        const similarity = cosineSimilarity(parsedEmbeddings[i], parsedEmbeddings[j]);
        if (similarity >= CANDIDATE_FLOOR) {
          flagged.push({ entity_a: entities[i].canonical_name, entity_b: entities[j].canonical_name, similarity });
          // on conflict: this endpoint used to have no dedup guard at all -
          // a second run against the same tenant silently re-inserted every
          // flagged pair again (found live: 39 real pairs had become 78
          // rows). idx_unresolved_entities_audit_dedup makes a re-run a
          // no-op instead of a duplicate.
          await sql`
            insert into public.unresolved_entities (tenant_id, mention_text, entity_type_guess, candidate_entity_id, candidate_score, status)
            values (${tenantId}, ${entities[j].canonical_name}, ${entities[j].entity_type}, ${entities[i].entity_id}, ${similarity}, 'pending')
            on conflict (tenant_id, mention_text, candidate_entity_id) where status = 'pending' and memory_id is null and candidate_entity_id is not null
            do nothing
          `;
        }
      }
    }
    return { total_entities_checked: entities.length, embeddings_backfilled: backfilled, flagged_pairs: flagged };
  });

  return json(result);
}

// Read-only. Every real decisions row where superseded_by is not null was
// set exclusively by ai-worker's duplicate-auto-merge (the Python
// /correct "edited" path that also sets it was never ported to Deno - see
// plan's flagged assumption). Reconstructs each pair and runs the NEW
// classifyRelation over it to see how many historical silent merges look
// like real conflicts under the corrected logic. Writes nothing back to
// decisions.
async function handleAuditHistoricalDuplicates(req: Request): Promise<Response> {
  const body = await req.json() as { tenant_id?: string; limit?: number };
  if (!body.tenant_id) return json({ detail: "tenant_id is required" }, 400);
  const tenantId = body.tenant_id;
  const limit = body.limit ?? 15;

  const pairs = await withAdmin(async (sql) => {
    return await sql`
      select old.id as old_id, old.decision_statement as old_statement, old.rationale as old_rationale, old.created_at as old_created_at,
             new.id as new_id, new.decision_statement as new_statement, new.rationale as new_rationale, new.created_at as new_created_at
      from public.decisions old
      join public.decisions new on new.id = old.superseded_by
      where old.tenant_id = ${tenantId}
      limit ${limit}
    `;
  });

  const audited = [];
  for (const pair of pairs) {
    const classifications = await classifyRelation(
      { title: pair.new_statement, summary: pair.new_rationale ?? "", valid_from: new Date(pair.new_created_at).toISOString() },
      [{ memory_id: pair.old_id, title: pair.old_statement, summary: pair.old_rationale ?? "", valid_from: new Date(pair.old_created_at).toISOString() }],
    );
    audited.push({
      old_decision_id: pair.old_id, new_decision_id: pair.new_id,
      old_statement: pair.old_statement, new_statement: pair.new_statement,
      new_classification: classifications[0]?.relationship ?? "no_classification_returned",
      reason: classifications[0]?.reason ?? null,
    });
  }

  const summary = audited.reduce((acc, a) => {
    acc[a.new_classification] = (acc[a.new_classification] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return json({ tenant_id: tenantId, pairs_examined: audited.length, summary, audited });
}

// Spec Section 12's golden evaluation set, run for real. Exists as an
// endpoint (not just the deno-run CLI script in _shared/memory/eval/) so
// it runs where ANTHROPIC_API_KEY is actually configured - a local shell
// doesn't have it, this deployed function does. No tenant_id needed: every
// case is self-contained (hand-built fixtures or synthetic memories), not
// tied to any real tenant's data.
async function handleRunGoldenEval(): Promise<Response> {
  const report = await runGoldenEval();
  return json(report);
}

// Deterministic test of reconciliation itself, decoupled from extraction's
// own (somewhat unpredictable) type/attribute_key choices - writes three
// synthetic same-type memories directly (bypassing extraction) matching
// the spec's own worked example, and reports what detectConflicts actually
// did to each.
async function handleDebugTestReconciliation(req: Request): Promise<Response> {
  const body = await req.json() as { tenant_id?: string };
  if (!body.tenant_id) return json({ detail: "tenant_id is required" }, 400);
  const tenantId = body.tenant_id;

  const events = await withTenant(tenantId, async (sql) => {
    const ev1 = await sql`
      insert into public.memory_fixture_events (tenant_id, source, source_id, actor_display_name, permission_scope, raw_content, occurred_at)
      values (${tenantId}, 'slack', 'debug-recon-1-' || extract(epoch from now()), 'Test', '{}', 'debug event 1', now()) returning id`;
    const ev2 = await sql`
      insert into public.memory_fixture_events (tenant_id, source, source_id, actor_display_name, permission_scope, raw_content, occurred_at)
      values (${tenantId}, 'slack', 'debug-recon-2-' || extract(epoch from now()), 'Test', '{}', 'debug event 2', now()) returning id`;
    const ev3 = await sql`
      insert into public.memory_fixture_events (tenant_id, source, source_id, actor_display_name, permission_scope, raw_content, occurred_at)
      values (${tenantId}, 'slack', 'debug-recon-3-' || extract(epoch from now()), 'Test', '{}', 'debug event 3', now()) returning id`;
    return { ev1: ev1[0].id, ev2: ev2[0].id, ev3: ev3[0].id };
  });

  const outcomes: Record<string, unknown> = {};

  await withTenant(tenantId, async (sql) => {
    // The spec's own candidate query requires a SHARED entity, not just
    // matching type+attribute_key (spec Section 6: "m.entities.some(e =>
    // newMemory.entities.some(...))") - each scenario needs its own shared
    // entity so detectConflicts can find its candidates at all.
    const projectEntity = await sql`
      insert into public.entities (tenant_id, entity_type, canonical_name) values (${tenantId}, 'Project', 'debug-recon-project-x')
      on conflict (tenant_id, entity_type, canonical_name) do update set canonical_name = excluded.canonical_name returning entity_id`;
    const pricingEntity = await sql`
      insert into public.entities (tenant_id, entity_type, canonical_name) values (${tenantId}, 'Topic', 'debug-recon-pricing')
      on conflict (tenant_id, entity_type, canonical_name) do update set canonical_name = excluded.canonical_name returning entity_id`;
    const projectEntityId = projectEntity[0].entity_id as string;
    const pricingEntityId = pricingEntity[0].entity_id as string;

    // Memory 1: beta start date - DIFFERENT attribute_key (but same entity),
    // should never become a candidate for memory 2/3 (structural
    // different_concept - excluded by attribute_key, not entity).
    const beta = await writeMemory(sql, {
      tenantId, type: "Decision", title: "Beta starts September 10th", summary: "Beta program starts Sep 10",
      payload: { attribute_key: "beta-start-date", decision_status: "decided", alternatives_considered: [] },
      entityIds: [projectEntityId], occurredAt: new Date().toISOString(), validFrom: new Date().toISOString(),
      confidence: 0.9, searchableText: "Decision: Beta starts September 10th",
      sourceEventIds: [events.ev1], citations: [],
    });
    outcomes.beta_memory_id = beta;

    // Memory 2: public launch, first claim.
    const launch1 = await writeMemory(sql, {
      tenantId, type: "Decision", title: "Public launch is September 1st", summary: "Public launch date set to Sep 1",
      payload: { attribute_key: "public-launch-date", decision_status: "decided", alternatives_considered: [] },
      entityIds: [projectEntityId], occurredAt: new Date(Date.now() - 60_000).toISOString(), validFrom: new Date(Date.now() - 60_000).toISOString(),
      confidence: 0.9, searchableText: "Decision: Public launch is September 1st",
      sourceEventIds: [events.ev2], citations: [],
    });
    outcomes.launch1_memory_id = launch1;

    // Memory 3: public launch, explicitly framed as a correction -> should
    // classify as "update" (same fact, natural evolution) against memory 2,
    // and never even be compared against memory 1 (different attribute_key).
    const launch2 = await writeMemory(sql, {
      tenantId, type: "Decision", title: "Public launch pushed back to September 15th",
      summary: "We're pushing the public launch from September 1st to September 15th because QA found a blocking issue that needs another week.",
      payload: { attribute_key: "public-launch-date", decision_status: "decided", alternatives_considered: [] },
      entityIds: [projectEntityId], occurredAt: new Date().toISOString(), validFrom: new Date().toISOString(),
      confidence: 0.9, searchableText: "Decision: Public launch pushed back to September 15th",
      sourceEventIds: [events.ev3], citations: [],
    });
    outcomes.launch2_memory_id = launch2;
    outcomes.launch2_vs_launch1 = await detectConflicts(sql, tenantId, launch2);

    // Memory 4: a genuine conflict - two equally-confident, unreconciled
    // claims about the same attribute, neither framed as correcting the
    // other.
    const conflictA = await writeMemory(sql, {
      tenantId, type: "Decision", title: "The pricing model will be usage-based", summary: "Team decided on usage-based pricing.",
      payload: { attribute_key: "pricing-model", decision_status: "decided", alternatives_considered: [] },
      entityIds: [pricingEntityId], occurredAt: new Date(Date.now() - 30_000).toISOString(), validFrom: new Date(Date.now() - 30_000).toISOString(),
      confidence: 0.85, searchableText: "Decision: pricing model usage-based",
      sourceEventIds: [events.ev1], citations: [],
    });
    const conflictB = await writeMemory(sql, {
      tenantId, type: "Decision", title: "The pricing model will be flat-rate", summary: "Team decided on flat-rate pricing.",
      payload: { attribute_key: "pricing-model", decision_status: "decided", alternatives_considered: [] },
      entityIds: [pricingEntityId], occurredAt: new Date(Date.now() - 30_000).toISOString(), validFrom: new Date(Date.now() - 30_000).toISOString(),
      confidence: 0.85, searchableText: "Decision: pricing model flat-rate",
      sourceEventIds: [events.ev2], citations: [],
    });
    outcomes.conflict_a_id = conflictA;
    outcomes.conflict_b_id = conflictB;
    outcomes.conflict_b_vs_a = await detectConflicts(sql, tenantId, conflictB);

    const finalStates = await sql`
      select memory_id, title, status, supersedes from public.memories
      where memory_id = any(${[beta, launch1, launch2, conflictA, conflictB]})
    `;
    outcomes.final_states = finalStates;
  });

  return json(outcomes);
}

// Live test of the judgment tier added to resolveEntityMention - proves
// it actually calls the model and acts on a real answer, not just that
// the code reads like it should. Requires an existing entity of a
// DIFFERENT type with the exact same name already in the tenant (the
// cross-type-exact case, which findBestMatch always returns regardless of
// embedding score) - the judgment call should confidently attach the
// mention to it rather than creating a duplicate or queuing.
async function handleDebugTestJudgmentTier(req: Request): Promise<Response> {
  const body = await req.json() as { tenant_id?: string; existing_entity_name?: string; existing_entity_type?: string; mention_type_guess?: string; mention_context?: string };
  if (!body.tenant_id || !body.existing_entity_name || !body.existing_entity_type || !body.mention_type_guess || !body.mention_context) {
    return json({ detail: "tenant_id, existing_entity_name, existing_entity_type, mention_type_guess, and mention_context are required" }, 400);
  }
  const tenantId = body.tenant_id;

  const result = await withTenant(tenantId, (sql) =>
    resolveEntityMention(sql, tenantId, body.existing_entity_name!, body.mention_type_guess!, undefined, body.mention_context!)
  );

  return json({
    reason: result.reason,
    entity_id: result.entityId,
    queued: result.queued,
    passed: result.reason === "judged_match",
  });
}

// Live reproduction of the exact bug found in production: two mentions of
// one real new entity, queued separately during extraction (when neither
// had anything to match against yet), then confirmed in the same
// sequential batch. Before the fix, confirmNewEntity never re-checked
// against what the batch itself had already created - this proves the fix
// actually catches it, not just that the code reads like it should.
async function handleDebugTestEntityMergeGuard(req: Request): Promise<Response> {
  const body = await req.json() as { tenant_id?: string };
  if (!body.tenant_id) return json({ detail: "tenant_id is required" }, 400);
  const tenantId = body.tenant_id;

  const suffix = Date.now();
  const result = await withTenant(tenantId, async (sql) => {
    // Two DIFFERENT strings for the same real thing (not an exact-text
    // duplicate - this specifically tests the similarity re-check, the
    // part that was actually missing). Inserted directly, bypassing
    // resolveEntityMention, to mirror the exact real state a genuine
    // extraction run leaves behind: two pending rows, neither with a
    // candidate, because nothing existed to match against when either was
    // queued.
    const q1 = await sql`
      insert into public.unresolved_entities (tenant_id, mention_text, entity_type_guess, status)
      values (${tenantId}, ${"Debug Merge Guard Sync " + suffix}, 'Project', 'pending') returning id
    `;
    const q2 = await sql`
      insert into public.unresolved_entities (tenant_id, mention_text, entity_type_guess, status)
      values (${tenantId}, ${"Debug Merge Guard Synchronization " + suffix}, 'Project', 'pending') returning id
    `;

    const first = await confirmNewEntity(sql, tenantId, q1[0].id as string);
    const second = await confirmNewEntity(sql, tenantId, q2[0].id as string);

    const entityRows = await sql`
      select entity_id, canonical_name, status from public.entities
      where tenant_id = ${tenantId} and canonical_name ilike ${"Debug Merge Guard%" + suffix}
    `;

    return { first, second, real_entity_count: entityRows.length, entities: entityRows };
  });

  const passed = result.real_entity_count === 1 || (result.real_entity_count === 2 && result.second.flaggedForMergeReview !== null);
  return json({
    tenant_id: tenantId,
    first_confirm: result.first,
    second_confirm: result.second,
    real_entity_count: result.real_entity_count,
    entities: result.entities,
    passed,
    verdict: passed
      ? (result.real_entity_count === 1 ? "second confirm auto-attached to the first - no duplicate created" : "second confirm created a second entity but correctly flagged it for merge review")
      : "FAIL: a duplicate entity was created with no flag - the bug reproduced",
  });
}

// Retroactive cleanup for entities that were confirmed BEFORE the
// confirmNewEntity fix existed - real duplicates that got created with no
// flag at all (the "worse bug" scenario). Queues each entity_id in the
// cluster as a source_entity_id-based unresolved_entities row, exactly the
// same shape the fixed confirmNewEntity now produces going forward, so
// they go through the same real review UI rather than a manual fix. A
// target_entity_id pre-populates the suggested merge (still requires a
// human click via /entities/merge to execute); omitting it queues the
// cluster as flagged-ambiguous with no pre-selected direction.
async function handleDebugFlagEntityCluster(req: Request): Promise<Response> {
  const body = await req.json() as { tenant_id?: string; entity_ids?: string[]; target_entity_id?: string; note?: string };
  if (!body.tenant_id || !body.entity_ids || body.entity_ids.length < 2) {
    return json({ detail: "tenant_id and at least 2 entity_ids are required" }, 400);
  }
  const tenantId = body.tenant_id;

  const flagged = await withTenant(tenantId, async (sql) => {
    const entityRows = await sql`
      select entity_id, entity_type, canonical_name from public.entities
      where tenant_id = ${tenantId} and entity_id = any(${body.entity_ids})
    `;
    const byId = new Map(entityRows.map((r: { entity_id: string; entity_type: string; canonical_name: string }) => [r.entity_id, r]));

    const results = [];
    for (const entityId of body.entity_ids!) {
      if (entityId === body.target_entity_id) continue; // the survivor doesn't flag itself
      const entity = byId.get(entityId) as { entity_type: string; canonical_name: string } | undefined;
      if (!entity) continue;
      const row = await sql`
        insert into public.unresolved_entities (tenant_id, mention_text, entity_type_guess, source_entity_id, candidate_entity_id, status)
        values (${tenantId}, ${entity.canonical_name}, ${entity.entity_type}, ${entityId}, ${body.target_entity_id ?? null}, 'pending')
        returning id
      `;
      results.push({ unresolved_id: row[0].id, entity_id: entityId, canonical_name: entity.canonical_name, suggested_target: body.target_entity_id ?? null });
    }
    return results;
  });

  return json({ tenant_id: tenantId, flagged_count: flagged.length, flagged });
}

// ── Real-user-facing endpoints (Memory Timeline, evidence drawer) ───────
//
// Everything above this line is admin/debug/fixture-loading and gated on
// requireServiceRole (the key that never ships to a browser). These two
// are the opposite: they're what the actual frontend, logged in as a real
// tenant member, calls - so they authenticate with the SAME app-issued
// tenant JWT api/index.ts's /search and /digest already accept
// (getCurrentTenant, from _shared/tenantAuth.ts), not the service role key.
//
// isMemoryAccessible() is re-run fresh on every call here, never cached
// from write time or from a prior request - the fail-closed default only
// means something if a scope that later gets real source_scope_members
// data starts resolving to "accessible" the moment that data lands,
// without anything needing to be re-written.

async function handleListMemories(req: Request): Promise<Response> {
  const ctx = await getCurrentTenant(req);
  const url = new URL(req.url);
  const entityId = url.searchParams.get("entity_id") ?? undefined;

  const permissionScopes = await resolvePermissionScopes(ctx.userId, ctx.tenantId);
  // One pooled connection for both steps, not two - a fresh connection has
  // its own real setup cost, and the batched permission check doesn't need
  // a separate one now that it's a single query instead of N.
  const { memories, accessFlags } = await withTenant(ctx.tenantId, async (sql) => {
    const memories = await loadMemoriesForTenant(sql, ctx.tenantId, entityId);
    const accessFlags = await isMemoryAccessibleBatch(sql, ctx.tenantId, permissionScopes, memories.map((m) => m.permissions.visible_to));
    return { memories, accessFlags };
  });
  const visible = memories.filter((_, i) => accessFlags[i]);
  const hiddenCount = memories.length - visible.length;

  return json({
    memories: visible,
    hidden_count: hiddenCount,
    // Surfaced so the UI can show the disclosed "some content isn't shown
    // yet" note rather than silently looking like an empty/broken product -
    // per the plan's Checkpoint C requirement, this is never hidden from
    // the user.
    some_content_hidden: hiddenCount > 0,
  });
}

// "Related" panel: which other entities co-occur with this one, ranked by
// how many accessible memories they share. Real join-table query against
// data that already exists (memory_entities), not a new engine - never
// bypasses permissions, since it's computed from the SAME
// isMemoryAccessible-filtered memory list every other read path uses, not
// a raw cross-tenant SQL join.
async function handleRelatedEntities(req: Request, entityId: string): Promise<Response> {
  const ctx = await getCurrentTenant(req);
  const permissionScopes = await resolvePermissionScopes(ctx.userId, ctx.tenantId);

  const related = await withTenant(ctx.tenantId, async (sql) => {
    const memories = await loadMemoriesForTenant(sql, ctx.tenantId, entityId);
    const accessFlags = await isMemoryAccessibleBatch(sql, ctx.tenantId, permissionScopes, memories.map((m) => m.permissions.visible_to));
    const accessible = memories.filter((_, i) => accessFlags[i]);

    const counts = new Map<string, { canonical_name: string; entity_type: string; flagged: boolean; count: number }>();
    for (const m of accessible) {
      for (const e of m.entities) {
        if (e.entity_id === entityId) continue;
        const existing = counts.get(e.entity_id);
        if (existing) existing.count++;
        else counts.set(e.entity_id, { canonical_name: e.canonical_name, entity_type: e.entity_type, flagged: e.flagged, count: 1 });
      }
    }
    return [...counts.entries()]
      .map(([id, v]) => ({ entity_id: id, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  });

  return json({ entity_id: entityId, related });
}

async function handleMemoryEvidence(req: Request, memoryId: string): Promise<Response> {
  const ctx = await getCurrentTenant(req);
  const permissionScopes = await resolvePermissionScopes(ctx.userId, ctx.tenantId);

  const { memory, accessible } = await withTenant(ctx.tenantId, async (sql) => {
    const memories = await loadMemoriesForTenant(sql, ctx.tenantId);
    const memory = memories.find((m) => m.memory_id === memoryId);
    if (!memory) return { memory: null, accessible: false };
    const accessible = await isMemoryAccessible(sql, ctx.tenantId, permissionScopes, memory.permissions.visible_to);
    return { memory, accessible };
  });
  if (!memory) return json({ detail: "Memory not found" }, 404);
  if (!accessible) return json({ detail: "Not accessible" }, 403);

  return json({
    memory_id: memory.memory_id,
    title: memory.title,
    summary: memory.summary,
    source_events: memory.source_events,
    citations: memory.citations,
    confidence: memory.confidence,
    freshness: memory.freshness,
    status: memory.status,
    supersedes: memory.supersedes,
  });
}

async function handleAttention(req: Request): Promise<Response> {
  const ctx = await getCurrentTenant(req);
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 4), 1), 20);

  const permissionScopes = await resolvePermissionScopes(ctx.userId, ctx.tenantId);
  const { accessible, entityDuplicates } = await withTenant(ctx.tenantId, async (sql) => {
    const allMemories = await loadMemoriesForTenant(sql, ctx.tenantId);
    const accessFlags = await isMemoryAccessibleBatch(sql, ctx.tenantId, permissionScopes, allMemories.map((m) => m.permissions.visible_to));
    const accessible = allMemories.filter((_, i) => accessFlags[i]);

    // Only rows with a specific suggested target - a genuine "possible
    // duplicate of X" the customer can act on in one click. No-candidate
    // rows have nothing actionable to show here; they stay staff-only,
    // visible on the internal review-queue page for quality checks.
    const rows = await sql`
      select ue.id, ue.mention_text, ue.entity_type_guess, e.entity_id as candidate_entity_id, e.canonical_name as candidate_name
      from public.unresolved_entities ue
      join public.entities e on e.entity_id = ue.candidate_entity_id
      where ue.tenant_id = ${ctx.tenantId} and ue.status = 'pending' and ue.candidate_entity_id is not null
      order by ue.created_at desc
    `;
    const entityDuplicates = rows.map((r: Record<string, unknown>) => ({
      unresolvedId: r.id as string,
      mentionText: r.mention_text as string,
      entityType: r.entity_type_guess as string,
      candidateEntityId: r.candidate_entity_id as string,
      candidateName: r.candidate_name as string,
    }));
    return { accessible, entityDuplicates };
  });

  const result = getAttentionItems(accessible, entityDuplicates, limit);
  return json({
    items: result.items.map((item) => item.kind === "entity_duplicate" ? {
      kind: "entity_duplicate",
      unresolved_id: item.unresolvedId,
      mention_text: item.mentionText,
      entity_type: item.entityType,
      candidate_entity_id: item.candidateEntityId,
      candidate_name: item.candidateName,
      category: item.category,
      weight: item.weight,
    } : {
      kind: "memory",
      memory_id: item.memory.memory_id,
      title: item.memory.title,
      summary: item.memory.summary,
      type: item.memory.type,
      category: item.category,
      weight: item.weight,
      action: actionForCategory(item.category),
    }),
    total: result.total,
  });
}

async function handleResolveMemory(req: Request, memoryId: string): Promise<Response> {
  const ctx = await getCurrentTenant(req);
  const permissionScopes = await resolvePermissionScopes(ctx.userId, ctx.tenantId);

  let body: { action?: ResolutionAction; note?: string };
  try {
    body = await req.json();
  } catch {
    return json({ detail: "Invalid JSON body" }, 400);
  }
  const validActions: ResolutionAction[] = ["confirm_decision", "check_in_commitment", "recheck_freshness", "dismiss_conflict"];
  if (!body.action || !validActions.includes(body.action)) {
    return json({ detail: `action must be one of ${validActions.join(", ")}` }, 400);
  }

  try {
    const outcome = await withTenant(ctx.tenantId, async (sql) => {
      const memories = await loadMemoriesForTenant(sql, ctx.tenantId);
      const memory = memories.find((m) => m.memory_id === memoryId);
      if (!memory) return "not_found" as const;
      const accessible = await isMemoryAccessible(sql, ctx.tenantId, permissionScopes, memory.permissions.visible_to);
      if (!accessible) return "not_accessible" as const;
      await resolveMemory(sql, ctx.tenantId, memoryId, body.action as ResolutionAction, body.note ?? null, null);
      return "resolved" as const;
    });
    if (outcome === "not_found") return json({ detail: "Memory not found" }, 404);
    if (outcome === "not_accessible") return json({ detail: "Not accessible" }, 403);
  } catch (err) {
    if (err instanceof MemoryNotAccessibleError) return json({ detail: err.message }, 404);
    throw err;
  }

  return json({ memory_id: memoryId, action: body.action, resolved: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const path = url.pathname;

  const evidenceMatch = path.match(/\/memories\/([0-9a-f-]{36})\/evidence$/i);
  const resolveMatch = path.match(/\/memories\/([0-9a-f-]{36})\/resolve$/i);
  const relatedMatch = path.match(/\/entities\/([0-9a-f-]{36})\/related$/i);

  try {
    // Real-user routes: their own JWT check, not the service-role gate.
    if (path.endsWith("/memories") && req.method === "GET") {
      try {
        return await handleListMemories(req);
      } catch (err) {
        return json({ detail: err instanceof Error ? err.message : "Unauthorized" }, 401);
      }
    }
    if (evidenceMatch && req.method === "GET") {
      try {
        return await handleMemoryEvidence(req, evidenceMatch[1]);
      } catch (err) {
        return json({ detail: err instanceof Error ? err.message : "Unauthorized" }, 401);
      }
    }
    if (path.endsWith("/attention") && req.method === "GET") {
      try {
        return await handleAttention(req);
      } catch (err) {
        return json({ detail: err instanceof Error ? err.message : "Unauthorized" }, 401);
      }
    }
    if (resolveMatch && req.method === "POST") {
      try {
        return await handleResolveMemory(req, resolveMatch[1]);
      } catch (err) {
        return json({ detail: err instanceof Error ? err.message : "Unauthorized" }, 401);
      }
    }
    if (relatedMatch && req.method === "GET") {
      try {
        return await handleRelatedEntities(req, relatedMatch[1]);
      } catch (err) {
        return json({ detail: err instanceof Error ? err.message : "Unauthorized" }, 401);
      }
    }
    // Review-queue routes - real-user auth, scoped to the caller's own
    // tenant via ctx.tenantId, never a client-supplied tenant_id. Moved
    // here from the service-role block below: a real logged-in user's
    // session token, not the service role key, is what the review-queue
    // page actually has to call these with.
    if (path.endsWith("/entities/search") && req.method === "GET") {
      try {
        return await handleSearchEntities(req);
      } catch (err) {
        return json({ detail: err instanceof Error ? err.message : "Unauthorized" }, 401);
      }
    }
    if (path.endsWith("/entities/unresolved") && req.method === "GET") {
      try {
        return await handleListUnresolvedEntities(req);
      } catch (err) {
        return json({ detail: err instanceof Error ? err.message : "Unauthorized" }, 401);
      }
    }
    if (path.endsWith("/entities/confirm-new") && req.method === "POST") {
      try {
        return await handleConfirmNewEntity(req);
      } catch (err) {
        return json({ detail: err instanceof Error ? err.message : "Unauthorized" }, 401);
      }
    }
    if (path.endsWith("/entities/merge") && req.method === "POST") {
      try {
        return await handleMergeEntity(req);
      } catch (err) {
        return json({ detail: err instanceof Error ? err.message : "Unauthorized" }, 401);
      }
    }
    if (path.endsWith("/entities/dismiss") && req.method === "POST") {
      try {
        return await handleDismissUnresolvedEntity(req);
      } catch (err) {
        return json({ detail: err instanceof Error ? err.message : "Unauthorized" }, 401);
      }
    }

    // Everything else is admin/debug/fixture-loading - service-role only.
    const authError = requireServiceRole(req);
    if (authError) return authError;

    if (path.endsWith("/debug/tenants") && req.method === "GET") return await handleDebugTenants();
    if (path.endsWith("/debug/memories") && req.method === "GET") {
      const tenantId = url.searchParams.get("tenant_id");
      if (!tenantId) return json({ detail: "tenant_id query param required" }, 400);
      return await handleDebugMemories(tenantId);
    }
    if (path.endsWith("/debug/delete-memories") && req.method === "POST") return await handleDebugDeleteMemories(req);
    if (path.endsWith("/debug/test-zero-source-guard") && req.method === "POST") return await handleDebugZeroSourceTest(req);
    if (path.endsWith("/debug/entities") && req.method === "GET") {
      const tenantId = url.searchParams.get("tenant_id");
      if (!tenantId) return json({ detail: "tenant_id query param required" }, 400);
      const rows = await withTenant(tenantId, (sql) => sql`select entity_id, entity_type, canonical_name from public.entities where tenant_id = ${tenantId} order by canonical_name`);
      return json({ tenant_id: tenantId, count: rows.length, entities: rows });
    }
    // /entities/unresolved, /confirm-new, /merge, /dismiss now live above,
    // as real-user routes - see that block for why.
    if (path.endsWith("/audit/batch1-entities") && req.method === "POST") return await handleAuditBatch1Entities(req);
    if (path.endsWith("/audit/historical-duplicates") && req.method === "POST") return await handleAuditHistoricalDuplicates(req);
    if (path.endsWith("/eval/run") && req.method === "POST") return await handleRunGoldenEval();
    if (path.endsWith("/debug/test-reconciliation") && req.method === "POST") return await handleDebugTestReconciliation(req);
    if (path.endsWith("/debug/test-entity-merge-guard") && req.method === "POST") return await handleDebugTestEntityMergeGuard(req);
    if (path.endsWith("/debug/test-judgment-tier") && req.method === "POST") return await handleDebugTestJudgmentTier(req);
    if (path.endsWith("/debug/flag-entity-cluster") && req.method === "POST") return await handleDebugFlagEntityCluster(req);
    return json({ detail: "Not found" }, 404);
  } catch (err) {
    console.error("memory-api unhandled error:", err);
    return json({ detail: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});
