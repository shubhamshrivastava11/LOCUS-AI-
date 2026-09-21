// supabase/functions/ai-worker/index.ts
//
// Deno port of the Python ingestion + embedding workers (backend/src/queues/
// workers/event_worker.py, embedding_worker.py, and the AI pipeline modules
// they call). Railway's worker service kept failing under resource
// starvation (see commit history around 2026-08-02) with the account nearly
// out of credits, and Vercel/Supabase Edge Functions can't run a
// continuously-looping process, so this runs the same pipeline as a short,
// bounded burst triggered by pg_cron every minute instead of an infinite
// while loop. Same pgmq read -> process -> delete-on-success contract, same
// tenant isolation (withTenant sets app.current_tenant_id, matching
// database.tenant_connection.tenant_conn on the Python side), same
// dedup/retry semantics (pipeline_status column, see migration 017 and
// modules.ingestion.dedup.ledger's docstring for why bare row-existence is
// never treated as "already processed").
//
// One invocation processes up to BATCH_SIZE ingestion messages and
// BATCH_SIZE embedding jobs, concurrently within each stage, then returns.
// No infinite loop - the cron interval is the poll loop.

import { withAdmin, withTenant } from "../_shared/db.ts";
import { sanitiseAttributes } from "../_shared/attributes.ts";
import {
  type ClassificationRule,
  planRouting,
  resolveClassification,
  type RoutingRule,
} from "../_shared/rules.ts";
import { decryptToken } from "../_shared/tokenCrypto.ts";
import { redactFinancialInfo } from "../_shared/financialRedaction.ts";
import { cleanDisplayText } from "../_shared/htmlText.ts";

const corsHeaders = { "Access-Control-Allow-Origin": "*" };

// ── Config ──────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
// One model for the merged triage+extraction call now that it's a single
// request; kept as ANTHROPIC_EXTRACT_MODEL rather than introducing a new
// env var name, so existing Supabase secrets don't need to change.
const EXTRACT_MODEL = Deno.env.get("ANTHROPIC_EXTRACT_MODEL") ?? "claude-haiku-4-5-20251001";
const VOYAGE_API_KEY = Deno.env.get("VOYAGE_API_KEY") ?? "";
const VOYAGE_MODEL = Deno.env.get("VOYAGE_EMBED_MODEL") ?? "voyage-4-large";
const VOYAGE_OUTPUT_DIMENSION = 1024;

const INGESTION_BATCH = 40;
const EMBEDDING_BATCH = 40;
const CONCURRENCY = 8;
const VISIBILITY_TIMEOUT_SECONDS = 60;
// How many times an embedding job may fail before it is abandoned. Bounded
// deliberately: unbounded retry is what once let a single poisonous message
// block a queue for 19 hours, and zero retry is what silently lost 62
// decisions from semantic search. See handleEmbeddingMessage's catch.
const MAX_EMBEDDING_ATTEMPTS = 5;
// Ingestion had no retry budget at all - it deleted on any error, so a
// single transient database blip lost the event permanently. Bounded at 3
// because a retry re-runs extraction, and extraction costs a Claude call:
// three is enough to ride out a blip and cheap enough that a genuinely
// poisoned message cannot run up a bill.
const MAX_INGESTION_ATTEMPTS = 3;

// ── Encryption (matches modules.security.encryption exactly) ─────────────
// AES-256-GCM, key = SHA-256(secret), blob = "LOCUS1" + 12-byte nonce +
// ciphertext(+16-byte GCM tag, which Web Crypto appends the same way
// Python's `cryptography` package does) - byte-for-byte compatible so rows
// written by this function decrypt fine in the Python backend and vice versa.

const MAGIC = new TextEncoder().encode("LOCUS1"); // 6 bytes
const NONCE_LEN = 12;

async function getAesKey(): Promise<CryptoKey> {
  const secret = Deno.env.get("RAW_EVENTS_ENCRYPTION_KEY") || Deno.env.get("APP_SECRET_KEY");
  if (!secret) {
    throw new Error("RAW_EVENTS_ENCRYPTION_KEY or APP_SECRET_KEY is not set");
  }
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptRawContent(plaintext: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const key = await getAesKey();
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext),
  );
  const out = new Uint8Array(MAGIC.length + NONCE_LEN + ciphertext.length);
  out.set(MAGIC, 0);
  out.set(nonce, MAGIC.length);
  out.set(ciphertext, MAGIC.length + NONCE_LEN);
  return out;
}

// ── fetch() with a hard timeout ───────────────────────────────────────────
// Plain fetch() never times out on its own - if Anthropic or Voyage ever
// stalls mid-request, an un-timed-out call hangs for the life of the
// invocation. Confirmed live: a handful of messages sat retrying for over
// 30 minutes with pgmq's visibility timeout (60s) repeatedly expiring mid-
// hang, letting overlapping invocations pile up on the same messages
// forever without any one of them ever finishing cleanly. The Python
// worker this replaced always set an explicit request timeout (15s triage,
// 30s extraction via the Anthropic SDK's `timeout` param) - this restores
// that same guarantee so a stalled call fails fast and leaves the message
// for pgmq's own retry instead of hanging indefinitely.
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Anthropic (forced tool-use, matches modules.ai.triage/extraction) ────

const CLAUDE_MAX_RETRIES = 3;

// Daily ceiling on what this pipeline may spend with Anthropic. loci-chat has
// had one of these since it shipped; the main pipeline, where nearly all the
// spend actually is, had none.
//
// Measured 14 Sep 2026 the steady state is about $0.15/day, so this is not a
// throttle on normal operation - it is a stop on a burst. The worker drains 40
// messages a minute on a one-minute cron, so a large backfill can put ~57,000
// events a day through extraction.
const DAILY_SPEND_CAP_USD = Number(Deno.env.get("AI_DAILY_SPEND_CAP_USD") ?? "1");

// Haiku 4.5, USD per million tokens. Same table loci-chat uses.
const PRICE_PER_MTOK = { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 };

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// Number() on every field, because these arrive from two different places with
// two different types. Straight off the Anthropic response they are numbers;
// read back out of pipeline_daily_usage they are bigint columns, which
// postgres.js returns as STRINGS to avoid losing precision. This expression
// happens to survive that because it multiplies each field before adding
// anything, and "10354" * 1 is 10354 while "10354" + "20236" is "1035420236".
// That is luck, not design - reordering these terms so two token counts are
// added first would silently report a spend three orders of magnitude too high
// and halt the pipeline. It cost a debugging session in admin-detect-channels,
// which did add first.
function estimateCostUsd(u: ClaudeUsage): number {
  const n = (v: unknown) => Number(v ?? 0) || 0;
  return (
    (n(u.input_tokens) * PRICE_PER_MTOK.input +
      n(u.output_tokens) * PRICE_PER_MTOK.output +
      n(u.cache_creation_input_tokens) * PRICE_PER_MTOK.cacheWrite +
      n(u.cache_read_input_tokens) * PRICE_PER_MTOK.cacheRead) / 1_000_000
  );
}

/** What this pipeline has spent with Anthropic so far today. */
async function todaysSpendUsd(): Promise<number> {
  try {
    const rows = await withAdmin(async (sql) => {
      return await sql`
        SELECT input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens
        FROM public.pipeline_daily_usage WHERE usage_date = CURRENT_DATE
      ` as unknown as ClaudeUsage[];
    });
    return rows.length === 0 ? 0 : estimateCostUsd(rows[0]);
  } catch (err) {
    // Fail OPEN, unlike the privacy settings. An accounting table that cannot
    // be read is a reason to keep working and shout, not to halt ingestion -
    // the cap protects a bill, and the bill is small enough that a few minutes
    // of unmetered work cannot hurt. Getting this backwards would mean one bad
    // query stopping the product.
    console.error("Cannot read pipeline_daily_usage, proceeding uncapped:", err);
    return 0;
  }
}

/** Adds one call's usage to today's running total. Never throws. */
async function recordUsage(usage: ClaudeUsage): Promise<void> {
  try {
    await withAdmin(async (sql) => {
      await sql`
        INSERT INTO public.pipeline_daily_usage AS u (
          usage_date, input_tokens, output_tokens,
          cache_creation_input_tokens, cache_read_input_tokens, request_count
        )
        VALUES (
          CURRENT_DATE, ${usage.input_tokens ?? 0}, ${usage.output_tokens ?? 0},
          ${usage.cache_creation_input_tokens ?? 0}, ${usage.cache_read_input_tokens ?? 0}, 1
        )
        ON CONFLICT (usage_date) DO UPDATE SET
          input_tokens = u.input_tokens + EXCLUDED.input_tokens,
          output_tokens = u.output_tokens + EXCLUDED.output_tokens,
          cache_creation_input_tokens = u.cache_creation_input_tokens + EXCLUDED.cache_creation_input_tokens,
          cache_read_input_tokens = u.cache_read_input_tokens + EXCLUDED.cache_read_input_tokens,
          request_count = u.request_count + 1
      `;
    });
  } catch (err) {
    console.error("Could not record pipeline usage (call already happened):", err);
  }
}

// cacheable=true marks the system prompt with cache_control so Anthropic
// reuses it across invocations instead of re-billing the full static
// instructions every single call - this is the biggest win for a pipeline
// that sends the same system prompt thousands of times a day. Only worth
// setting on prompts long enough to actually clear the model's minimum
// cacheable prefix (see TRIAGE_EXTRACTION_SYSTEM_PROMPT's comment) - below
// that floor cache_control is silently a no-op, not an error.
async function callClaude(
  system: string,
  userMessage: string,
  tool: Record<string, unknown>,
  toolName: string,
  maxTokens: number,
  model: string,
  timeoutMs: number,
  cacheable = false,
): Promise<Record<string, unknown>> {
  const systemParam = cacheable
    ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
    : system;

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= CLAUDE_MAX_RETRIES; attempt++) {
    let resp: Response;
    try {
      resp = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: 0,
          system: systemParam,
          messages: [{ role: "user", content: userMessage }],
          tools: [tool],
          tool_choice: { type: "tool", name: toolName },
        }),
      }, timeoutMs);
    } catch (err) {
      // Network-level failure (timeout, connection reset) - retryable, same
      // backoff as a 429/5xx.
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt === CLAUDE_MAX_RETRIES) throw lastErr;
      await sleep(backoffMs(attempt));
      continue;
    }

    if (resp.ok) {
      const data = await resp.json();
      // Log Anthropic usage so we can verify prompt caching actually fired
      // (Haiku 4.5 silently skips cache below the 4096-token prefix floor —
      // both cache_* fields stay 0 with no error).
      const usage = data.usage ?? {};
      console.log(JSON.stringify({
        event: "anthropic_usage",
        tool: toolName,
        model,
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      }));
      // The usage above was already being logged and thrown away. Persisting
      // it is what makes the daily cap possible at all. Awaited rather than
      // fire-and-forget: an un-awaited write can be cut off when the isolate
      // is torn down, which would undercount exactly when volume is highest.
      await recordUsage(usage as ClaudeUsage);

      const block = (data.content ?? []).find((b: { type?: string }) => b.type === "tool_use");
      if (!block) throw new Error(`Claude did not return a tool_use block for ${toolName}`);
      return block.input as Record<string, unknown>;
    }

    const bodyText = await resp.text();
    // Only 429 (rate limit) and 5xx (server-side, including 529 overloaded)
    // are transient - retrying a 400 (bad request, or the account's credit
    // balance being empty) just burns another failed call for nothing, so
    // those fail immediately instead of retrying blind.
    const retryable = resp.status === 429 || resp.status >= 500;
    lastErr = new Error(`Anthropic API error ${resp.status}: ${bodyText}`);
    if (!retryable || attempt === CLAUDE_MAX_RETRIES) throw lastErr;

    const retryAfterHeader = resp.headers.get("retry-after");
    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
    await sleep(retryAfterMs && Number.isFinite(retryAfterMs) ? retryAfterMs : backoffMs(attempt));
  }
  // Unreachable (the loop always returns or throws), but keeps TS satisfied.
  throw lastErr ?? new Error(`Anthropic API call failed for ${toolName}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exponential backoff with jitter: 500ms, 1000ms, 2000ms (+/- up to 25%) -
// bounded well under pgmq's 60s visibility timeout so a retried message
// still finishes (or genuinely fails) before another invocation could pick
// the same message up again.
function backoffMs(attempt: number): number {
  const base = 500 * Math.pow(2, attempt);
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.round(base + jitter);
}

// Combined triage+extraction: one call instead of two. Merged so we pay for
// the raw event text once and take one API round trip. For DISCARD, only
// triage fields are filled; for KEEP/UNCERTAIN, extraction fields are filled
// in the same response.
//
// Sized to ~4500 tokens (tools + system) so Haiku 4.5's 4096-token cache
// minimum is cleared with a small surplus. Extra length is useful contrastive
// rules and few-shots — not filler — so caching and capture quality improve
// together. Below 4096, cache_control is a silent no-op.
const TRIAGE_EXTRACTION_SYSTEM_PROMPT = `You are the triage-and-extraction stage of Locus AI, a decision-intelligence system that turns workplace communication (Slack, Gmail, Notion) into a durable record of decisions, action items, and blockers.

You will be given ONE event. Use only that event's text — no surrounding conversation or other context. In one response:

1. Classify as KEEP, UNCERTAIN, or DISCARD.
2. If KEEP or UNCERTAIN, extract exactly one record (decision, action_item, or blocker). If DISCARD, leave every extraction field null/empty.

## Step 1: classification

KEEP — the event contains at least one of:
  - a clear decision that was made
  - an action item with an identifiable owner or commitment
  - a blocker preventing progress
  - a confirmed change (plan, schedule, scope, or system)
  - an ownership assignment or deadline
  - an operational commitment ("we will...", "I'll have this done by...")
  - a clear actionable request to the team or a named person (e.g. RSVP / form) — treat as action_item

UNCERTAIN — might matter but incomplete alone:
  - tentative proposal not confirmed
  - explicitly awaiting approval or sign-off
  - ambiguous whether a decision was reached
  - relevance depends on missing context
  When unsure between KEEP and DISCARD, choose UNCERTAIN (never guess DISCARD). Use lower confidence when vague; downstream may hold out low-confidence UNCERTAIN from the feed.

DISCARD — clearly not decision-relevant:
  - greeting, thank-you, or social chatter
  - emoji / ack with no new content ("ok", "sounds good", "lgtm", "+1")
  - newsletter, digest, or marketing
  - FYI / logistics / scheduling with no plan commitment (e.g. "5 min late", "lunch?", room booking)
  - reminder or automated/bot notice, including a system reporting a routine transaction completed (payment processed, order shipped, build finished, PR merged) — "confirmed" means a person/team confirmed a plan, not a system reporting a transaction
  - spam or content unrelated to decisions, actions, or blockers

Do not keyword-match alone. Automated origin or words like "confirmed"/"completed" are not enough to KEEP — check who confirmed and whether anything was decided.

## Step 2: extraction (only when KEEP or UNCERTAIN)

Extract only what is explicitly present in the event text. Never invent owners, rationale, alternatives, or outcomes that are not stated.

### Record type (choose exactly one)

| record_type | Meaning | Must include |
|-------------|---------|--------------|
| decision | Committed choice (or clear reversal) | Outcome / chosen option; alternatives only if named |
| action_item | Concrete work or clear actionable request | Task verb; owner only if explicitly named |
| blocker | Something preventing progress | Obstacle + what is blocked |

Hard disambiguation:
  - "We should consider X" / "Maybe we look at X" → NOT decided (UNCERTAIN + proposed at most). "We're going with X" / "We chose X" → decision, status=decided.
  - Volunteering or assigning work → action_item, not decision, unless the event is mainly choosing among options.
  - Stuck on a dependency/approval/outage that stops progress → blocker. "Waiting on Sarah to sign" without saying work is blocked → often action_item (awaiting approval), not blocker.

### Statement style

  - decision_statement: one concise line in the event's own terms. Prefer past-tense outcome for decisions ("Chose X for Y"), imperative for action items ("Update the API docs by Friday"), obstacle-framed for blockers ("Blocked on legal sign-off before shipping ToS").
  - Do not add detail, context, or consequences that are not stated.
  - status: "decided" only if final/confirmed; "proposed" if tentative/awaiting approval; "superseded" only if the event says a prior decision was replaced/reversed.
  - rationale: stated reason only; null if none. Never invent.
  - alternatives_considered: options explicitly considered/rejected; empty if none.
  - actors: people explicitly named. "decided_by" (at most one) only if the event states they decided/own/resolve the blocker; else "mentioned". Empty if none named. Never invent an owner or guess from the envelope unless that person is named as owner in the event text. If only a display name appears with no provider id, actors=[].
  - confidence: 0-1 from how explicit the text is. Vague replies needing unseen context ≤ 0.5.
  - sensitivity: who inside the company should be able to read this. Default to 1 - the overwhelming majority of work is ordinary work, and marking routine records sensitive makes the memory useless to the people who need it. Go above 1 only when the text itself is about a person's pay, performance or employment, an unannounced commercial move, a security incident, or a legal matter. Judge the CONTENT, not where it was posted: a private channel is full of routine messages, and a public one can contain something that should not have been said there.

Call record_triage_and_extraction exactly once with classification, confidence, reason_code, and — when not DISCARD — the extracted record.

## Examples

Format: classification, confidence, reason_code, record_type, status, decision_statement, rationale, alternatives_considered, actors. DISCARD lines omit extraction.

1. "Team, we've decided to use PostgreSQL for the context layer instead of MongoDB, mainly because our schema is relational-heavy." (Slack)
-> KEEP, 0.95, EXPLICIT_DECISION, decision, decided, decision_statement="Chose PostgreSQL for the context layer instead of MongoDB", rationale="Schema is relational-heavy", alternatives_considered=["MongoDB"], actors=[]

2. "I'll have the API docs updated by Friday." (Slack, actor: U0123ABCD)
-> KEEP, 0.9, ACTION_ASSIGNED, action_item, decided, decision_statement="Update the API docs by Friday", rationale=null, alternatives_considered=[], actors=[{source_actor_id:"U0123ABCD", role:"decided_by"}]

3. "We're blocked on legal sign-off before we can ship the new terms of service." (Slack)
-> KEEP, 0.9, BLOCKER_IDENTIFIED, blocker, decided, decision_statement="Blocked on legal sign-off before shipping the new terms of service", rationale=null, alternatives_considered=[], actors=[]

4. "Moved the launch date from March 1 to March 15 to give QA more time." (Notion)
-> KEEP, 0.9, CONFIRMED_CHANGE, decision, decided, decision_statement="Moved the launch date from March 1 to March 15", rationale="Give QA more time", alternatives_considered=[], actors=[]

5. "Maybe we should consider switching to Redis for caching at some point?" (Slack)
-> UNCERTAIN, 0.6, TENTATIVE_PROPOSAL, decision, proposed, decision_statement="Consider switching to Redis for caching", rationale=null, alternatives_considered=[], actors=[]

6. "Submitted the budget request for the new hire, waiting on Sarah to sign off." (Gmail)
-> UNCERTAIN, 0.65, AWAITING_APPROVAL, action_item, proposed, decision_statement="Submit budget request for the new hire pending Sarah's sign-off", rationale=null, alternatives_considered=[], actors=[]

7. "Happy Friday everyone! Hope you all have a great weekend :tada:" (Slack)
-> DISCARD, 0.97, SOCIAL_CHATTER (no extraction)

8. "👍" (Slack)
-> DISCARD, 0.98, SOCIAL_CHATTER (no extraction)

9. Subject: "Charger Bands Weekly Newsletter - August 2" — multi-section digest with unsubscribe footer. (Gmail)
-> DISCARD, 0.95, AUTOMATED_NOTIFICATION (no extraction)

10. "Your pull request #123 was merged by github-actions[bot]." (Gmail, automated)
-> DISCARD, 0.95, AUTOMATED_NOTIFICATION (no extraction)

11. Subject: "Payment confirmation" — "Your invoice #4521 has been paid successfully. No action needed." (Gmail billing system)
-> DISCARD, 0.9, AUTOMATED_NOTIFICATION (no extraction) — system transaction report is not a team decision

12. "CONGRATULATIONS! You've been selected for a free cruise! Click here to claim your prize now!!!" (Gmail)
-> DISCARD, 0.9, UNRELATED_CONTENT (no extraction)

13. "Yeah let's go with that." (Slack, no prior message in this event)
-> UNCERTAIN, 0.4, INSUFFICIENT_CONTEXT, decision, proposed, decision_statement="Agreed to an unspecified option referenced in this message", rationale=null, alternatives_considered=[], actors=[]

14. "Alice will own the frontend migration, Bob will handle the backend piece." (Slack, U_ALICE, U_BOB)
-> KEEP, 0.9, ACTION_ASSIGNED, action_item, decided, decision_statement="Own the frontend migration (Alice); handle the backend migration (Bob)", rationale=null, alternatives_considered=[], actors=[{source_actor_id:"U_ALICE", role:"decided_by"}, {source_actor_id:"U_BOB", role:"mentioned"}]

15. "We chose Stripe over Braintree because their docs and webhook support are better." (Notion)
-> KEEP, 0.9, EXPLICIT_DECISION, decision, decided, decision_statement="Chose Stripe for payments over Braintree", rationale="Better docs and webhook support than Braintree", alternatives_considered=["Braintree"], actors=[]

16. "Correction: we are NOT moving to the new office next month, we're staying at the current location for now." (Slack)
-> KEEP, 0.85, CONFIRMED_CHANGE, decision, superseded, decision_statement="Staying at the current location; not moving to the new office next month", rationale=null, alternatives_considered=[], actors=[]

17. "Please RSVP for Parent Preview Night on Tuesday, August 4 at 6pm - one form per family." (Gmail)
-> KEEP, 0.8, ACTION_ASSIGNED, action_item, decided, decision_statement="Fill out the RSVP form for Parent Preview Night on Tuesday, August 4 at 6pm (one form per family)", rationale=null, alternatives_considered=[], actors=[]

18. "Let's block 12-1pm Eastern every weekday for the Project Status meeting going forward." (Slack)
-> KEEP, 0.85, CONFIRMED_CHANGE, decision, decided, decision_statement="Blocked 12pm-1pm Eastern every weekday for the Project Status meeting", rationale=null, alternatives_considered=[], actors=[]

19. "Abbas is replacing the previous backend lead to improve task follow-up and tracking." (Notion)
-> KEEP, 0.85, ACTION_ASSIGNED, decision, decided, decision_statement="Chose Abbas to replace the previous backend lead", rationale="Improve task follow-up and tracking", alternatives_considered=[], actors=[]

20. "Reminder: your subscription renews in 3 days." (Gmail, automated billing)
-> DISCARD, 0.9, AUTOMATED_NOTIFICATION (no extraction)

21. "Thanks so much for your help today, really appreciate it!" (Slack)
-> DISCARD, 0.95, SOCIAL_CHATTER (no extraction)

22. "We should consider adopting GraphQL for the public API next quarter." (Slack)
-> UNCERTAIN, 0.55, TENTATIVE_PROPOSAL, decision, proposed, decision_statement="Consider adopting GraphQL for the public API next quarter", rationale=null, alternatives_considered=[], actors=[]
   Hard negative: "consider" is not a committed decision.

23. "We're going with GraphQL for the public API starting next quarter." (Slack)
-> KEEP, 0.92, EXPLICIT_DECISION, decision, decided, decision_statement="Chose GraphQL for the public API starting next quarter", rationale=null, alternatives_considered=[], actors=[]

24. "ok sounds good" (Slack)
-> DISCARD, 0.95, SOCIAL_CHATTER (no extraction)

25. "I'll be ~10 minutes late to standup, traffic." (Slack)
-> DISCARD, 0.9, UNRELATED_CONTENT (no extraction) — logistics only

26. "Can someone book Conference Room B for Thursday 3pm?" (Slack)
-> DISCARD, 0.75, UNRELATED_CONTENT (no extraction) — pure logistics, no assigned owner

27. "Deploy is blocked until the staging cert is renewed; nothing ships until then." (Slack)
-> KEEP, 0.9, BLOCKER_IDENTIFIED, blocker, decided, decision_statement="Blocked on staging cert renewal before any deploy ships", rationale=null, alternatives_considered=[], actors=[]

28. "Priya owns rewriting the onboarding checklist by end of week." (Notion; display name only, no provider id)
-> KEEP, 0.9, ACTION_ASSIGNED, action_item, decided, decision_statement="Rewrite the onboarding checklist by end of week", rationale=null, alternatives_considered=[], actors=[]

29. "FYI: the vendor sent the signed MSA; no action needed from us." (Gmail)
-> DISCARD, 0.85, UNRELATED_CONTENT (no extraction)

30. "lgtm" (Slack, no quoted prior context)
-> DISCARD, 0.9, SOCIAL_CHATTER (no extraction)

31. "Parking lot: we might revisit the pricing tiers after Q3, nothing decided." (Slack)
-> UNCERTAIN, 0.5, TENTATIVE_PROPOSAL, decision, proposed, decision_statement="Might revisit pricing tiers after Q3", rationale=null, alternatives_considered=[], actors=[]

32. "Decision locked: keep the free tier at 3 seats; raise Pro to $49." (Slack)
-> KEEP, 0.95, EXPLICIT_DECISION, decision, decided, decision_statement="Kept free tier at 3 seats and raised Pro to $49", rationale=null, alternatives_considered=[], actors=[]

33. "Build #8842 failed on main — automated notification from CI." (Gmail)
-> DISCARD, 0.95, AUTOMATED_NOTIFICATION (no extraction)

34. "Sam is out sick Friday; Maya will cover the customer call." (Slack, Maya id: U_MAYA)
-> KEEP, 0.85, ACTION_ASSIGNED, action_item, decided, decision_statement="Cover the customer call on Friday (Maya)", rationale="Sam is out sick", alternatives_considered=[], actors=[{source_actor_id:"U_MAYA", role:"decided_by"}]

35. "Still waiting on design mocks before I can start the checkout UI." (Slack)
-> KEEP, 0.85, BLOCKER_IDENTIFIED, blocker, decided, decision_statement="Blocked on design mocks before starting the checkout UI", rationale=null, alternatives_considered=[], actors=[]

36. "Weekly product digest: top links, hiring shoutouts, and a poll about snacks." (Gmail newsletter)
-> DISCARD, 0.95, AUTOMATED_NOTIFICATION (no extraction)

37. "We debated Postgres vs MySQL and landed on Postgres for JSONB support." (Slack)
-> KEEP, 0.93, EXPLICIT_DECISION, decision, decided, decision_statement="Chose Postgres over MySQL for JSONB support", rationale="JSONB support", alternatives_considered=["MySQL"], actors=[]

38. "Hold shipping the mobile release until App Store review comes back — we are blocked." (Slack)
-> KEEP, 0.9, BLOCKER_IDENTIFIED, blocker, decided, decision_statement="Blocked shipping the mobile release until App Store review returns", rationale=null, alternatives_considered=[], actors=[]

39. "I propose we try Notion for the runbook; open to other tools." (Slack)
-> UNCERTAIN, 0.55, TENTATIVE_PROPOSAL, decision, proposed, decision_statement="Propose trying Notion for the runbook", rationale=null, alternatives_considered=[], actors=[]

40. "Action for Jordan: send the security questionnaire to the vendor by Thursday." (Slack, Jordan id: U_JORDAN)
-> KEEP, 0.9, ACTION_ASSIGNED, action_item, decided, decision_statement="Send the security questionnaire to the vendor by Thursday", rationale=null, alternatives_considered=[], actors=[{source_actor_id:"U_JORDAN", role:"decided_by"}]

41. "Syncing calendars for the offsite — no decision yet, just availability." (Slack)
-> DISCARD, 0.85, UNRELATED_CONTENT (no extraction) — logistics / availability only

42. "Final call: we are sticking with the current pricing page copy; no redesign this quarter." (Slack)
-> KEEP, 0.92, EXPLICIT_DECISION, decision, decided, decision_statement="Sticking with the current pricing page copy; no redesign this quarter", rationale=null, alternatives_considered=[], actors=[]

43. "Blocked on Legal reviewing the DPA before we can enable the EU region." (Slack)
-> KEEP, 0.9, BLOCKER_IDENTIFIED, blocker, decided, decision_statement="Blocked on Legal reviewing the DPA before enabling the EU region", rationale=null, alternatives_considered=[], actors=[]`;

// Low-confidence UNCERTAIN captures are recall noise more often than real
// memory. Persist UNCERTAIN only when the model is at least this sure;
// otherwise mark the raw event done without creating a decision (same
// outcomes path as DISCARD for the feed, without reclassifying the label).
const UNCERTAIN_MIN_CONFIDENCE = 0.7;

const TRIAGE_EXTRACTION_TOOL = {
  name: "record_triage_and_extraction",
  description:
    "Triage one event and, unless DISCARD, extract one decision, action_item, or blocker. Types: decision=committed choice; action_item=concrete work/request; blocker=obstacle blocking progress. Null extraction fields on DISCARD.",
  input_schema: {
    type: "object",
    properties: {
      decision: {
        type: "string",
        enum: ["KEEP", "UNCERTAIN", "DISCARD"],
        description: "KEEP=durable record; UNCERTAIN=incomplete/tentative; DISCARD=social/FYI/logistics/automated/unrelated.",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "How explicit the event text is (0-1). Vague context-dependent replies ≤ 0.5.",
      },
      reason_code: {
        type: "string",
        enum: [
          "EXPLICIT_DECISION", "ACTION_ASSIGNED", "BLOCKER_IDENTIFIED", "CONFIRMED_CHANGE",
          "TENTATIVE_PROPOSAL", "AWAITING_APPROVAL", "INSUFFICIENT_CONTEXT",
          "SOCIAL_CHATTER", "AUTOMATED_NOTIFICATION", "UNRELATED_CONTENT",
        ],
        description: "Single best triage reason.",
      },
      // Extraction fields - required by the schema so the tool call always
      // validates, but left null/empty by the model whenever decision is
      // DISCARD (see the prompt and the examples above).
      record_type: {
        type: ["string", "null"],
        enum: ["decision", "action_item", "blocker", null],
        description: "decision | action_item | blocker; null on DISCARD.",
      },
      status: {
        type: ["string", "null"],
        enum: ["proposed", "decided", "superseded", null],
        description: "decided if final; proposed if tentative; superseded if reversing a prior choice; null on DISCARD.",
      },
      decision_statement: {
        type: ["string", "null"],
        description: "One concise line (past-tense decision / imperative action / obstacle blocker). Null on DISCARD.",
      },
      rationale: {
        type: ["string", "null"],
        description: "Stated reason only; null if none.",
      },
      alternatives_considered: {
        type: "array",
        items: { type: "string" },
        description: "Explicitly named options considered/rejected; else empty.",
      },
      sensitivity: {
        type: ["integer", "null"],
        enum: [0, 1, 2, 3, null],
        description:
          "How sensitive the record is. 0=safe for anyone in the company. 1=ordinary work (DEFAULT - use this unless the text clearly says otherwise). 2=personnel, pay, unreleased commercial plans, security incidents. 3=legal exposure, acquisitions, named-individual performance. Null on DISCARD.",
      },
      attributes: {
        type: "object",
        description:
          "Structured facts the text ACTUALLY states, as a flat object. Omit a key " +
          "rather than guessing, and never infer one from context - a missing key is " +
          "correct and useful, an invented one is worse than nothing because it routes " +
          "this record to another team. Numbers as numbers, dates as YYYY-MM-DD. " +
          "Recognised keys, all optional: role_title, band, start_date, annualised_cost, " +
          "team, headcount_delta, effective_date, cost_centre, approved_amount, period, " +
          "cost_driver, estimated_monthly_cost, constraint, applies_to, severity, " +
          "affected_component, required_action, due_date, volume, account_segment, " +
          "committed_date, reason_code, ship_date, user_facing, acceptance_criteria, " +
          "metric, direction, measured_at. Anything else is discarded.",
        additionalProperties: { type: ["string", "number", "boolean"] },
      },
      actors: {
        type: "array",
        items: {
          type: "object",
          properties: {
            source_actor_id: {
              type: "string",
              minLength: 1,
              description: "Provider-native id from the event; never invent.",
            },
            role: {
              type: "string",
              enum: ["decided_by", "mentioned"],
              description: "decided_by at most once when ownership is explicit; else mentioned.",
            },
          },
          required: ["source_actor_id", "role"],
          additionalProperties: false,
        },
        description: "Explicitly named actors only; empty if none.",
      },
    },
    required: [
      "decision", "confidence", "reason_code", "record_type", "status",
      "decision_statement", "rationale", "alternatives_considered", "sensitivity", "actors",
    ],
    additionalProperties: false,
  },
};

// Gmail/Slack/Notion raw_content -> plain text. A private copy, same
// field-extraction rules as api/index.ts's own private extractEventText
// (Gmail's subject prefixed, Notion reads page properties, everything
// else falls back to the first populated text-shaped field) - this used
// to be a shared import from the memory layer's historicalReplay.ts, but
// that whole module was removed along with the rest of that layer, so
// this is its own copy now, matching api/index.ts's existing precedent of
// each caller owning its copy rather than a shared module built for one
// specific feature that no longer exists.
// deno-lint-ignore no-explicit-any
function notionPropertyText(prop: any): string | null {
  if (!prop || typeof prop !== "object") return null;
  switch (prop.type) {
    case "title":
    case "rich_text": {
      const parts = (prop[prop.type] ?? []).map((t: { plain_text?: string }) => t.plain_text).filter(Boolean);
      return parts.length > 0 ? parts.join("") : null;
    }
    case "select":
      return prop.select?.name ?? null;
    case "status":
      return prop.status?.name ?? null;
    case "date":
      return prop.date?.start ?? null;
    default:
      return null;
  }
}

// deno-lint-ignore no-explicit-any
function extractNotionPageText(page: any): string {
  const properties = page.properties ?? {};
  // deno-lint-ignore no-explicit-any
  const titleEntry = Object.entries(properties).find(([, p]: [string, any]) => p?.type === "title");
  const title = titleEntry ? notionPropertyText(titleEntry[1]) : null;
  const lines: string[] = [];
  if (title) lines.push(title);
  for (const [name, prop] of Object.entries(properties)) {
    if (titleEntry && name === titleEntry[0]) continue;
    const value = notionPropertyText(prop);
    if (value) lines.push(`${name}: ${value}`);
  }
  // body_text is the page's actual content, added by notion-poller. Without
  // it this returned title and properties only, so a decision written in the
  // body - which is where people write them - was invisible to extraction.
  // Older events have no body_text and behave exactly as before.
  const body = typeof page.body_text === "string" ? page.body_text.trim() : "";
  if (body) lines.push(body);
  return lines.length > 0 ? lines.join("\n") : (page.url ?? "Notion page");
}

function extractEventText(rawContent: unknown, source: string): string {
  if (!rawContent || typeof rawContent !== "object") return cleanDisplayText(String(rawContent ?? ""));
  const content = rawContent as Record<string, unknown>;
  if (source === "gmail") {
    const subject = typeof content.subject === "string" ? content.subject : "";
    const body = typeof content.body === "string" ? cleanDisplayText(content.body) : "";
    return subject ? `Subject: ${subject}\n${body}` : body;
  }
  if (source === "notion" && "properties" in content) {
    return cleanDisplayText(extractNotionPageText(content));
  }
  for (const field of ["text", "body", "content", "message", "description", "snippet"]) {
    const val = content[field];
    if (typeof val === "string" && val) return cleanDisplayText(val);
  }
  return cleanDisplayText(JSON.stringify(content));
}

// Deterministic DISCARD prefilter - catches the same "clearly not
// decision-relevant" categories the model's own triage step already lists
// (see TRIAGE_EXTRACTION_SYSTEM_PROMPT's DISCARD section: pure acks, emoji
// reactions, bare greetings) and skips the Claude call entirely for them -
// $0, not a discount, same treatment as the likely_bulk_mail prefilter
// below. Deliberately conservative: matches only the WHOLE normalized
// message against a fixed allowlist, never a substring or prefix, so "ok,
// let's go with Postgres" is never touched - only a message that IS
// entirely one of these phrases and nothing else. A false DISCARD here is
// silent and unrecoverable (the event never reaches the model at all), so
// this stays narrow by design; anything that isn't a clean match still
// goes to the model exactly as before.
const TRIVIAL_ACK_PHRASES = new Set([
  "ok", "okay", "k", "kk", "yep", "yup",
  "sounds good", "lgtm", "+1",
  "thanks", "thank you", "thx", "ty",
  "np", "no problem", "got it",
  "cool", "nice", "perfect", "awesome", "great",
  "hi", "hello", "hey", "morning", "good morning", "gm",
]);

// A message made up entirely of emoji/pictographic characters (plus
// whitespace, zero-width joiners, and variation selectors) - the other
// DISCARD example the prompt names explicitly ("emoji ack with no new
// content"). \p{Extended_Pictographic} is the real Unicode property for
// this (there is no \p{Emoji} property in ECMAScript regex).
const EMOJI_ONLY_RE = /^[\p{Extended_Pictographic}\u200d\ufe0f\s]+$/u;

// Gmail-specific: a reply almost always carries the entire prior thread
// quoted below the new content - Gmail's own "On <date>, <name> <email>
// wrote:" header, Outlook's "-----Original Message-----"/"From: ... Sent:
// ... To: ... Subject: ..." block, or a run of "> "-prefixed lines. The
// model is explicitly told to use only this event's own text, no
// surrounding conversation (see TRIAGE_EXTRACTION_SYSTEM_PROMPT's opening
// instruction) - so that quoted tail contributes zero extraction value
// while still being billed as full-price input tokens on every single
// reply in a thread. Gmail is the connector with the most reply-heavy
// traffic, so this is the single biggest per-event cost driver caching
// and the trivial-ack prefilter don't already touch.
//
// Conservative by construction: only cuts at a handful of highly
// distinctive boundary markers that essentially never occur inside a
// real, freshly-typed message. If none match, the body is returned
// completely unchanged.
const QUOTE_BOUNDARY_PATTERNS: RegExp[] = [
  /^[ \t]*On .{0,120} wrote:[ \t]*$/m, // Gmail/Apple Mail/most clients' own reply header
  /^[ \t]*-{2,}[ \t]*Original Message[ \t]*-{2,}/im, // Outlook
  /^[ \t]*From:[ \t].*\n[ \t]*Sent:[ \t].*\n[ \t]*To:[ \t].*\n[ \t]*Subject:[ \t]/im, // Outlook quoted header block
  /^[ \t]*_{10,}[ \t]*$/m, // Outlook's long separator line
  /(?:^[ \t]*>.*(?:\n|$)){3,}/m, // 3+ consecutive "> "-quoted lines (classic plain-text quoting; (?:\n|$) so the LAST quoted line still counts when it's also the last line in the body, with no trailing newline)
];

function trimGmailQuotedReplyChain(body: string): string {
  let cutAt = body.length;
  for (const pattern of QUOTE_BOUNDARY_PATTERNS) {
    const match = pattern.exec(body);
    if (match && match.index < cutAt) cutAt = match.index;
  }
  return body.slice(0, cutAt).trim();
}

function isTriviallyDiscardable(rawContent: unknown, source: string): boolean {
  const text = extractEventText(rawContent, source).trim();
  // Empty text isn't this prefilter's job - that's a different, existing
  // failure mode (decryption/extraction issue), not a trivial-content one.
  if (!text) return false;
  if (EMOJI_ONLY_RE.test(text)) return true;
  const normalized = text.toLowerCase().replace(/[!.?]+$/, "").trim();
  return TRIVIAL_ACK_PHRASES.has(normalized);
}

function buildEventUserMessage(event: {
  source: string; actor: string; thread_ref?: string | null;
  permission_scope: string[]; raw_content: unknown;
}): string {
  const threadRef = event.thread_ref || "(none)";
  return `source: ${event.source}\nactor: ${event.actor}\nthread_ref: ${threadRef}\npermission_scope: ${JSON.stringify(event.permission_scope)}\ncontent:\n${JSON.stringify(event.raw_content)}`;
}

// ── Voyage embeddings (matches modules.ai.embeddings.provider.embed_document) ──

async function embedDocument(text: string): Promise<number[]> {
  const resp = await fetchWithTimeout("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      input: [text],
      model: VOYAGE_MODEL,
      input_type: "document",
      output_dimension: VOYAGE_OUTPUT_DIMENSION,
      truncation: true,
    }),
  }, 30_000);
  if (!resp.ok) {
    throw new Error(`Voyage API error ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  const embedding = data.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length !== VOYAGE_OUTPUT_DIMENSION) {
    throw new Error(`Voyage returned an unexpected embedding shape`);
  }
  return embedding;
}

// ── Actor resolution (matches modules.decisions.pipeline_persistence) ────

const ACTOR_IDENTIFIER_COLUMN: Record<string, string> = {
  gmail: "email",
  slack: "slack_user_id",
  notion: "notion_user_id",
  // One shared column, not two - a user's Atlassian accountId is the same
  // identity across every product on one site, unlike Slack/Notion's
  // per-product ids.
  jira: "atlassian_account_id",
  confluence: "atlassian_account_id",
  discord: "discord_user_id",
  github: "github_user_id",
  monday: "monday_user_id",
  clickup: "clickup_user_id",
};

// deno-lint-ignore no-explicit-any
async function resolveActorId(
  sql: any, tenantId: string, source: string, sourceActorId: string, displayName?: string,
): Promise<string> {
  const column = ACTOR_IDENTIFIER_COLUMN[source];
  if (!column) throw new Error(`No actor identifier column for source=${source}`);

  if (column === "email") {
    // COALESCE keeps an existing real name rather than ever overwriting it
    // with null on a later message from the same sender that happens not
    // to carry a display name (e.g. a reply-only header, or a different
    // connector for the same address).
    const rows = await sql`
      INSERT INTO actors (tenant_id, email, display_name, kind)
      VALUES (${tenantId}, ${sourceActorId}, ${displayName ?? null}, 'internal')
      ON CONFLICT (tenant_id, email) DO UPDATE SET
        email = EXCLUDED.email,
        display_name = COALESCE(EXCLUDED.display_name, actors.display_name)
      RETURNING id
    `;
    return rows[0].id;
  }

  // Real bug found live: none of these three branches ever wrote
  // display_name at all, only the email branch above did - a Slack/
  // Notion/Jira/Confluence participant's real name was silently
  // discarded even when the caller passed one in, showing "Unknown" in
  // the UI regardless. No unique constraint on these columns (see the
  // migration comment that added atlassian_account_id), so this stays a
  // manual SELECT-then-INSERT/UPDATE rather than ON CONFLICT, matching
  // the shape this already had - just no longer dropping displayName on
  // the floor. Same COALESCE-preserve-existing-name pattern the email
  // branch already uses, so a later call with no name never blanks out
  // a real one already stored.
  const existing = column === "slack_user_id"
    ? await sql`SELECT id, display_name FROM actors WHERE tenant_id = ${tenantId} AND slack_user_id = ${sourceActorId}`
    : column === "notion_user_id"
    ? await sql`SELECT id, display_name FROM actors WHERE tenant_id = ${tenantId} AND notion_user_id = ${sourceActorId}`
    : column === "atlassian_account_id"
    ? await sql`SELECT id, display_name FROM actors WHERE tenant_id = ${tenantId} AND atlassian_account_id = ${sourceActorId}`
    : column === "discord_user_id"
    ? await sql`SELECT id, display_name FROM actors WHERE tenant_id = ${tenantId} AND discord_user_id = ${sourceActorId}`
    : column === "github_user_id"
    ? await sql`SELECT id, display_name FROM actors WHERE tenant_id = ${tenantId} AND github_user_id = ${sourceActorId}`
    : column === "monday_user_id"
    ? await sql`SELECT id, display_name FROM actors WHERE tenant_id = ${tenantId} AND monday_user_id = ${sourceActorId}`
    : await sql`SELECT id, display_name FROM actors WHERE tenant_id = ${tenantId} AND clickup_user_id = ${sourceActorId}`;
  if (existing.length > 0) {
    if (displayName && !existing[0].display_name) {
      await sql`UPDATE actors SET display_name = ${displayName} WHERE id = ${existing[0].id}`;
    }
    return existing[0].id;
  }

  const created = column === "slack_user_id"
    ? await sql`INSERT INTO actors (tenant_id, slack_user_id, display_name, kind) VALUES (${tenantId}, ${sourceActorId}, ${displayName ?? null}, 'internal') RETURNING id`
    : column === "notion_user_id"
    ? await sql`INSERT INTO actors (tenant_id, notion_user_id, display_name, kind) VALUES (${tenantId}, ${sourceActorId}, ${displayName ?? null}, 'internal') RETURNING id`
    : column === "atlassian_account_id"
    ? await sql`INSERT INTO actors (tenant_id, atlassian_account_id, display_name, kind) VALUES (${tenantId}, ${sourceActorId}, ${displayName ?? null}, 'internal') RETURNING id`
    : column === "discord_user_id"
    ? await sql`INSERT INTO actors (tenant_id, discord_user_id, display_name, kind) VALUES (${tenantId}, ${sourceActorId}, ${displayName ?? null}, 'internal') RETURNING id`
    : column === "github_user_id"
    ? await sql`INSERT INTO actors (tenant_id, github_user_id, display_name, kind) VALUES (${tenantId}, ${sourceActorId}, ${displayName ?? null}, 'internal') RETURNING id`
    : column === "monday_user_id"
    ? await sql`INSERT INTO actors (tenant_id, monday_user_id, display_name, kind) VALUES (${tenantId}, ${sourceActorId}, ${displayName ?? null}, 'internal') RETURNING id`
    : await sql`INSERT INTO actors (tenant_id, clickup_user_id, display_name, kind) VALUES (${tenantId}, ${sourceActorId}, ${displayName ?? null}, 'internal') RETURNING id`;
  return created[0].id;
}

// slack-webhook only had enough data to build a slack:// deep link (opens
// the desktop app, not something a browser's "View Original" button can do
// anything useful with - most browsers either no-op or prompt to open an
// app that may not be installed). Real https:// permalinks need
// chat.getPermalink, which needs a bot token - not worth calling for every
// raw event (most get discarded), so it only runs here, once per message
// that actually becomes a decision. Falls back to the slack:// link (still
// better than nothing) if the API call fails for any reason.
// deno-lint-ignore no-explicit-any
async function resolveSlackPermalink(
  sql: any, tenantId: string, channel: string, messageTs: string, fallback: string | null | undefined,
): Promise<string | null | undefined> {
  try {
    const connRows = await sql`
      SELECT oauth_token_ref FROM public.source_connections
      WHERE tenant_id = ${tenantId} AND source = 'slack' AND status = 'active'
      ORDER BY created_at ASC LIMIT 1
    `;
    const accessToken = await decryptToken(connRows[0]?.oauth_token_ref);
    if (!accessToken) return fallback;

    const resp = await fetchWithTimeout(
      `https://slack.com/api/chat.getPermalink?channel=${encodeURIComponent(channel)}&message_ts=${encodeURIComponent(messageTs)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      8_000,
    );
    const data = await resp.json();
    return data.ok && typeof data.permalink === "string" ? data.permalink : fallback;
  } catch (err) {
    console.error(`resolveSlackPermalink failed for channel=${channel} ts=${messageTs}:`, err);
    return fallback;
  }
}

// ── pgmq helpers (raw SQL, mirrors queues.pgmq.client) ────────────────────

type PgmqMsg = { msg_id: number; message: Record<string, unknown>; read_ct: number };

async function pgmqRead(queue: string, batch: number): Promise<PgmqMsg[]> {
  return await withAdmin(async (sql) => {
    // postgres.js returns its own opaque Row type, which no annotation on the
    // callback can satisfy - the shape has to be asserted on the result
    // instead. Same pattern as api/index.ts:1130. No runtime change.
    const rows = await sql`SELECT * FROM pgmq.read(${queue}, ${VISIBILITY_TIMEOUT_SECONDS}, ${batch})` as unknown as PgmqMsg[];
    return rows.map((r) => ({
      msg_id: r.msg_id, message: r.message, read_ct: r.read_ct,
    }));
  });
}

async function pgmqDelete(queue: string, msgId: number): Promise<void> {
  await withAdmin(async (sql) => {
    await sql`SELECT pgmq.delete(${queue}, ${msgId}::bigint)`;
  });
}

async function pgmqSend(queue: string, message: Record<string, unknown>): Promise<void> {
  await withAdmin(async (sql) => {
    // sql.json() wants postgres.js's own JSONValue type, which Record<string,
    // unknown> never structurally satisfies. Same cast as _shared/queue.ts:96.
    await sql`SELECT pgmq.send(${queue}, ${sql.json(message as any)}::jsonb)`;
  });
}

/**
 * Parks a message we are giving up on, with the reason, instead of destroying
 * it.
 *
 * pgmq.delete() does NOT archive - that is pgmq.archive(). Verified on
 * 14 Sep 2026: pgmq.a_ingestion and pgmq.a_embedding_queue were both empty
 * after months of traffic, so everything either queue had ever abandoned was
 * gone without trace.
 *
 * If the dead_letters insert fails, the message is deliberately left QUEUED
 * rather than deleted. That trades a visible backlog for invisible data loss,
 * which is the right way round: a growing queue shows up in
 * admin-pipeline-status, whereas a silently dropped event shows up nowhere
 * until someone goes looking for data that should have been there.
 */
async function deadLetter(
  queue: string,
  msg: PgmqMsg,
  err: unknown,
  attempts: number,
): Promise<void> {
  const payload = (msg.message ?? {}) as Record<string, unknown>;
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const tenantId = typeof payload.tenant_id === "string" ? payload.tenant_id : null;
  const source = typeof payload.source === "string" ? payload.source : null;
  const sourceId = typeof payload.source_id === "string" ? payload.source_id : null;

  try {
    await withAdmin(async (sql) => {
      await sql`
        insert into public.dead_letters
          (queue, msg_id, tenant_id, source, source_id, payload, error, attempts)
        values (
          ${queue}, ${msg.msg_id}::bigint, ${tenantId}::uuid,
          ${source}, ${sourceId},
          ${sql.json(payload as any)}::jsonb,
          ${detail.slice(0, 4000)}, ${attempts}
        )
      `;
    });
  } catch (writeErr) {
    console.error(
      `dead_letters insert failed for ${queue}/${msg.msg_id} - leaving it queued rather than losing it:`,
      writeErr,
    );
    return;
  }
  await pgmqDelete(queue, msg.msg_id);
  console.error(`Dead-lettered ${queue}/${msg.msg_id} after ${attempts} attempt(s):`, detail);
}

// ── Ingestion pipeline (mirrors event_worker._handle_message) ────────────

// Signals a failure that will NEVER succeed on retry (e.g. the tenant
// disconnected this source after the message was already queued) - distinct
// from a transient failure (Claude API hiccup, DB blip), which should stay
// in the queue for pgmq's normal visibility-timeout retry. Without this
// distinction a message like this retries forever: confirmed live, a single
// stale message from a tenant that disconnected Gmail was read and failed
// over 1000 times across ~19 hours, standing between every other queued
// message and ever being processed (Deno reads in msg_id order).
class NonRetryableIngestionError extends Error {}

async function handleIngestionMessage(msg: PgmqMsg): Promise<string> {
  try {
    return await handleIngestionMessageInner(msg);
  } catch (err) {
    // No active connection to attribute this to; retrying cannot change that.
    if (err instanceof NonRetryableIngestionError) {
      await deadLetter("ingestion", msg, err, msg.read_ct);
      return "abandoned_no_active_connection";
    }

    // This used to delete on ANY error, to stop a bad message retrying
    // forever and re-billing a Claude call each time. read_ct bounds that
    // properly instead, so a transient failure now recovers rather than
    // costing the event.
    if (msg.read_ct < MAX_INGESTION_ATTEMPTS) {
      console.error(
        `Ingestion error (attempt ${msg.read_ct}/${MAX_INGESTION_ATTEMPTS}), left queued for retry:`,
        err,
      );
      return "error_retrying";
    }

    await deadLetter("ingestion", msg, err, msg.read_ct);
    return "error_dead_lettered";
  }
}


/**
 * Whether the tenant has switched this specific item off in Build Memory.
 *
 * Absent row means included, matching the `?? true` default the
 * capture-source-rules list endpoint already shows people - a tenant who
 * has never touched a toggle has no rows at all.
 */
async function isCaptureExcluded(
  tenantId: string,
  source: string,
  itemIds: string[],
): Promise<boolean> {
  if (itemIds.length === 0) return false;
  try {
    // withAdmin, because public.capture_source_rules carries exactly one
    // policy and it is granted to `authenticated` for PostgREST. The locus_app
    // lane has none, so this read through withTenant returned zero rows for
    // every tenant, every time - which made this function always answer
    // "not excluded" and meant the per-item toggles in Settings > Build Memory
    // never actually stopped anything being captured.
    //
    // It did not error and the catch below never fired, so there was no signal
    // at all: an empty result is indistinguishable from "this tenant has not
    // set any rules", which is also the common case. Found by the
    // adminOnlyTables test, written after the same mistake in loadCallerAuthz
    // took the product down on 16 Sep 2026.
    //
    // tenant_id stays pinned in the WHERE clause, which is the Layer-2 scoping
    // this codebase uses wherever the admin connection is unavoidable.
    const rows = await withAdmin(async (sql) => {
      return await sql`
        SELECT included FROM public.capture_source_rules
        WHERE tenant_id = ${tenantId} AND source = ${source}
          AND item_id = ANY(${itemIds})
          AND included = false
        LIMIT 1
      `;
    });
    // ANY switched-off item excludes the event. For a Gmail message
    // carrying several labels that means one muted label is enough to keep
    // it out - the reading that honours an explicit "do not capture this",
    // rather than letting a second label quietly override it.
    return rows.length > 0;
  } catch (err) {
    // Fail open: a database blip must never silently stop capturing a
    // source the tenant believes is switched on. Losing data invisibly is
    // worse than capturing one event they meant to exclude.
    console.error("Capture rule lookup failed, defaulting to captured:", err);
    return false;
  }
}

/** One row of routing_audit, held until the tenant transaction releases. */
type RoutingAuditRow = {
  ruleId: string;
  ruleName: string;
  sourceDecisionId: string;
  derivedDecisionId: string;
  fromDepartment: string;
  toDepartment: string;
  purpose: string;
  sourceClassification: number;
  emittedClassification: number;
  carriedFields: string[];
  withheldFields: string[];
};

/**
 * Emits the derived records a routing rule calls for, and returns the audit
 * rows describing what crossed.
 *
 * Runs on the tenant lane inside the same transaction as the source record,
 * so a derived record cannot survive a source that rolled back. The audit
 * rows go back to the caller rather than being written here, because
 * routing_audit is admin-lane only.
 *
 * Note what does NOT cross: the derived record carries only the allowlisted
 * fields, and its permission_scope is the DESTINATION department's scopes,
 * not the source's. Copying the source scopes would hand the destination
 * department a record scoped to a channel they are not in, which reads as
 * invisible - a silent no-op that looks like the rule never fired.
 */
async function emitRoutedRecords(
  // deno-lint-ignore no-explicit-any
  sql: any,
  tenantId: string,
  record: {
    id: string;
    record_type: string;
    classification: number;
    departmentId: string;
    fields: Record<string, unknown>;
    isDerived: boolean;
    /** Mirrored onto the derived record. See the insert below. */
    status: string;
  },
  _sourceScopes: string[],
): Promise<RoutingAuditRow[]> {
  const ruleRows = await sql`
    SELECT r.id, r.name, r.from_department_id, r.to_department_id,
           r.when_record_type, r.when_min_classification, r.when_has_fields,
           r.emit_classification,
           r.carry_fields, r.purpose,
           df.name AS from_name, dt.name AS to_name
    FROM public.routing_rules r
    JOIN public.departments df ON df.id = r.from_department_id
    JOIN public.departments dt ON dt.id = r.to_department_id
    WHERE r.tenant_id = ${tenantId}
      AND r.enabled = true
      AND r.from_department_id = ${record.departmentId}
  `;
  if (ruleRows.length === 0) return [];

  const plans = planRouting(ruleRows as unknown as RoutingRule[], record);
  if (plans.length === 0) return [];

  const nameById = new Map<string, { from: string; to: string }>(
    ruleRows.map((r: Record<string, unknown>) => [
      r.id as string,
      { from: r.from_name as string, to: r.to_name as string },
    ]),
  );

  const audit: RoutingAuditRow[] = [];

  for (const plan of plans) {
    // The destination's own scopes, so the people in that department can
    // actually see what was routed to them.
    const destScopes = await sql`
      SELECT scope_id FROM public.department_scopes
      WHERE tenant_id = ${tenantId} AND department_id = ${plan.toDepartmentId}
    `;
    const scopes = destScopes.map((r: Record<string, unknown>) => r.scope_id as string);
    // A destination with no mapped scopes would produce a record nobody can
    // reach. Skipped rather than written, and visible in the logs.
    if (scopes.length === 0) {
      console.warn(
        `routing: "${plan.rule.name}" skipped, destination department has no mapped scopes`,
      );
      continue;
    }

    // The carried fields that are not columns belong in attributes, or the
    // destination gets a headline and no data. The audit row recorded that
    // four fields crossed while the record itself stored none of them - true
    // of the crossing, useless to Finance.
    const PROSE_COLUMNS = new Set([
      "decision_statement", "rationale", "alternatives_considered", "record_type", "status",
    ]);
    const derivedAttributes: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(plan.fields)) {
      if (!PROSE_COLUMNS.has(k)) derivedAttributes[k] = v;
    }

    const statement = typeof plan.fields.decision_statement === "string"
      ? plan.fields.decision_statement
      : `${record.record_type} routed from ${nameById.get(plan.rule.id)?.from ?? "another department"}`;

    const inserted = await sql`
      INSERT INTO public.decisions (
        tenant_id, record_type, decision_statement, rationale,
        alternatives_considered, status, scope, confidence, permission_scope,
        classification, classified_by, classified_at, attributes,
        source_decision_id, routed_purpose, routed_by_rule
      ) VALUES (
        ${tenantId}, ${record.record_type}, ${statement},
        ${typeof plan.fields.rationale === "string" ? plan.fields.rationale : null},
        ${Array.isArray(plan.fields.alternatives_considered) ? plan.fields.alternatives_considered : []},
        ${record.status},
        'team', 1.0, ${scopes},
        ${plan.classification}, 'routing_rule', now(),
        ${sql.json(derivedAttributes as any)}::jsonb,
        ${plan.sourceDecisionId}, ${plan.purpose}, ${plan.rule.id}
      ) RETURNING id
    `;

    const names = nameById.get(plan.rule.id);
    audit.push({
      ruleId: plan.rule.id,
      ruleName: plan.rule.name,
      sourceDecisionId: plan.sourceDecisionId,
      derivedDecisionId: inserted[0].id as string,
      fromDepartment: names?.from ?? "unknown",
      toDepartment: names?.to ?? "unknown",
      purpose: plan.purpose,
      sourceClassification: record.classification,
      emittedClassification: plan.classification,
      carriedFields: Object.keys(plan.fields).sort(),
      withheldFields: plan.withheldFields,
    });
  }

  return audit;
}

/** Writes the audit on the admin lane, after the tenant transaction closes. */
async function writeRoutingAudit(tenantId: string, rows: RoutingAuditRow[]): Promise<void> {
  await withAdmin(async (sql) => {
    for (const r of rows) {
      await sql`
        INSERT INTO public.routing_audit (
          tenant_id, rule_id, rule_name, source_decision_id, derived_decision_id,
          from_department, to_department, purpose,
          source_classification, emitted_classification,
          carried_fields, withheld_fields
        ) VALUES (
          ${tenantId}::uuid, ${r.ruleId}::uuid, ${r.ruleName},
          ${r.sourceDecisionId}::uuid, ${r.derivedDecisionId}::uuid,
          ${r.fromDepartment}, ${r.toDepartment}, ${r.purpose},
          ${r.sourceClassification}, ${r.emittedClassification},
          ${r.carriedFields}, ${r.withheldFields}
        )
      `;
    }
  });
}

async function handleIngestionMessageInner(msg: PgmqMsg): Promise<string> {
  const payload = msg.message as {
    tenant_id: string; source: string; source_id: string; actor: string;
    thread_ref?: string | null; permission_scope: string[]; raw_content: unknown;
    source_permalink?: string | null; received_at: string; actor_display_name?: string;
    connection_id?: string; likely_bulk_mail?: boolean;
    known_actors?: { name: string; source_actor_id: string }[];
    capture_item_id?: string | string[];
  };
  const tenantId = payload.tenant_id;

  // Settings > Build Memory > "Pause all learning" - real bug found live:
  // this control was pure local React state before this, no backend
  // connection at all. Checked first, before the dedup round trip or any
  // Claude call - a paused tenant's events are marked done and dropped
  // from the queue for $0, not silently retried forever (that would just
  // pile up in the queue) and not merely hidden from display (the UI's
  // own copy promises "stop Locus AI from reading new messages", a real
  // ingestion-level skip, not a display filter).
  const isPaused = await withTenant(tenantId, async (sql) => {
    const rows = await sql`SELECT learning_paused FROM public.tenants WHERE id = ${tenantId}`;
    // `rows.length > 0 && ...` used to be the whole test, which quietly turned
    // "I could not read the setting" into "the setting is off". It read zero
    // rows every time: tenants has RLS enabled and forced, locus_app has no
    // BYPASSRLS, and the table's only policy targeted the authenticated role,
    // so withTenant() could never see it. Pause all learning was rendered in
    // Settings and never once enforced.
    //
    // Fixed by 20260914030000_security_review_critical.sql, which adds the
    // locus_app policy. Failing closed here is what stops it regressing
    // silently: an unreadable setting now dead-letters the message with a
    // clear reason instead of being read as consent to process.
    if (rows.length === 0) {
      throw new Error(
        `Cannot read learning_paused for tenant ${tenantId} - refusing to process ` +
          `rather than assume it is off. Check the locus_app SELECT policy on public.tenants.`,
      );
    }
    return rows[0].learning_paused === true;
  });
  if (isPaused) {
    // No raw_events row written at all - nothing was learned, so there's
    // nothing to audit, and connection_id/raw_content are both NOT NULL
    // with no default (would need the full encrypt-and-resolve-connection
    // work the normal path does, exactly what pausing is meant to skip).
    // Safe to just drop the message: pollers advance their own cursors
    // independently of what ai-worker does with an enqueued message, so
    // this doesn't risk the same event getting silently lost forever -
    // it simply isn't captured while paused, matching "stop reading new
    // messages" literally.
    await pgmqDelete("ingestion", msg.msg_id);
    return "learning_paused";
  }

  // Settings > Build Memory's per-item include toggles. Same class of bug
  // as "Pause all learning" directly above, found the same way:
  // capture_source_rules was written by the Settings UI and read back by
  // it, but nothing in any ingestion path ever consulted it, so switching
  // a channel off changed what that page displayed and nothing else.
  //
  // Enforced here rather than in each connector so there is exactly one
  // enforcement point, keyed on capture_item_id - see that field's comment
  // in _shared/queue.ts for why it must not be permission_scope.
  //
  // Fails open in every direction: no capture_item_id, no rule row, or a
  // failed lookup all mean capture. A connector not yet wired to set
  // capture_item_id behaves exactly as it did before this existed, so
  // shipping this cannot silently stop any source being ingested.
  const captureItemIds = payload.capture_item_id === undefined
    ? []
    : (Array.isArray(payload.capture_item_id) ? payload.capture_item_id : [payload.capture_item_id]);
  if (captureItemIds.length > 0) {
    const excluded = await isCaptureExcluded(tenantId, payload.source, captureItemIds);
    if (excluded) {
      // Dropped for $0 before dedup, encryption or any Claude call, the
      // same way a paused tenant's events are.
      await pgmqDelete("ingestion", msg.msg_id);
      return "capture_rule_excluded";
    }
  }

  // is_duplicate(): only a row already marked pipeline_status='done' counts
  // as truly seen - a 'pending' row means a prior attempt crashed mid-flight
  // and deserves a real retry (see migration 017's docstring).
  const isDuplicate = await withTenant(tenantId, async (sql) => {
    const rows = await sql`
      SELECT 1 FROM public.raw_events
      WHERE tenant_id = ${tenantId} AND source = ${payload.source} AND source_id = ${payload.source_id}
        AND pipeline_status = 'done'
    `;
    return rows.length > 0;
  });
  if (isDuplicate) {
    await pgmqDelete("ingestion", msg.msg_id);
    return "duplicate_skipped";
  }

  // store_raw_event(): insert, or on conflict, return the existing id if
  // it's still pending (retry), only a truly-done row is a real duplicate.
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await encryptRawContent(plaintext);
  const metadata = JSON.stringify({ ingested_via: "ai-worker-deno", encrypted: true });

  const rawEventId = await withTenant(tenantId, async (sql) => {
    // Prefer the connection the connector actually knows it came from
    // (payload.connection_id) over guessing. A tenant with several
    // connections for the same source (e.g. multiple Gmail accounts) used
    // to have every single one's mail silently merged into whichever
    // connection happened to be connected first, since "oldest active
    // connection for this tenant+source" was the only signal available.
    // Still re-verified against tenant/status here rather than trusted
    // blindly, in case it was disconnected between enqueue and processing.
    let fallbackRows: { id: string }[];
    if (payload.connection_id) {
      // An envelope that names its connection must match THAT connection or
      // fail. It used to fall through to "oldest active connection for this
      // tenant and source" when the named one was gone, which meant
      // disconnecting Gmail account A while account B stayed active silently
      // re-filed A's queued mail under B. That is not just wrong
      // attribution: privacy for personal sources is decided by
      // source_connections.connected_by, so it also changed who could see
      // the mail, and it did so specifically when someone had just asked for
      // the opposite by disconnecting.
      fallbackRows = await sql`
        SELECT id FROM public.source_connections
        WHERE id = ${payload.connection_id} AND tenant_id = ${tenantId} AND status = 'active'
      ` as unknown as { id: string }[];
    } else {
      // No connection named at all - a legacy envelope from before
      // connectors attributed their events. Guessing is the only option
      // here, and it is bounded to the same tenant and source.
      fallbackRows = await sql`
        SELECT id FROM public.source_connections
        WHERE tenant_id = ${tenantId} AND source = ${payload.source} AND status = 'active'
        ORDER BY created_at ASC LIMIT 1
      ` as unknown as { id: string }[];
    }
    if (fallbackRows.length === 0) {
      // Non-retryable: this tenant no longer has an active connection for
      // this source (they disconnected it after this message was already
      // queued). It will never become active again on its own, so retrying
      // is pure waste - the caller deletes the message instead of leaving
      // it to retry forever.
      throw new NonRetryableIngestionError(
        payload.connection_id
          ? `Connection ${payload.connection_id} is gone or inactive for tenant=${tenantId} ` +
            `source=${payload.source}; refusing to re-file its events under another connection`
          : `No active source_connections row for tenant=${tenantId} source=${payload.source}`,
      );
    }
    const connectionId = fallbackRows[0].id;

    const inserted = await sql`
      INSERT INTO public.raw_events (
        tenant_id, connection_id, source, source_id, thread_ref,
        permission_scope, raw_content, metadata, triage_result, received_at
      ) VALUES (
        ${tenantId}, ${connectionId}, ${payload.source}, ${payload.source_id},
        ${payload.thread_ref ?? null}, ${payload.permission_scope ?? []},
        ${encrypted}, ${metadata}::jsonb, 'pending', ${payload.received_at}
      )
      ON CONFLICT (tenant_id, source, source_id) DO NOTHING
      RETURNING id
    `;
    if (inserted.length > 0) return inserted[0].id as string;

    const existing = await sql`
      SELECT id, pipeline_status FROM public.raw_events
      WHERE tenant_id = ${tenantId} AND source = ${payload.source} AND source_id = ${payload.source_id}
    `;
    if (existing.length > 0 && existing[0].pipeline_status === "pending") {
      return existing[0].id as string;
    }
    return null;
  });

  if (rawEventId === null) {
    await pgmqDelete("ingestion", msg.msg_id);
    return "duplicate_on_insert";
  }

  // Attaches a real display name to the sender's actors row whenever the
  // connector could get one for free (Gmail's From header), regardless of
  // whether this specific message ends up KEEP or DISCARD, or whether the
  // sender is ever named as a decision participant - "participants only
  // ever show a raw email" was a direct, reported gap, this is what fixes
  // it at the source instead of guessing a name later.
  if (payload.actor_display_name && ACTOR_IDENTIFIER_COLUMN[payload.source]) {
    try {
      await withTenant(tenantId, async (sql) => {
        await resolveActorId(sql, tenantId, payload.source, payload.actor, payload.actor_display_name);
      });
    } catch (err) {
      console.error(`Failed to attach display name for ${payload.actor}:`, err);
    }
  }

  // Trim Gmail's quoted reply chain before either prefilter or the
  // extraction call sees this event - see trimGmailQuotedReplyChain's
  // comment. Runs after the raw_events INSERT above, which already
  // persisted the full untrimmed body, so nothing is lost for
  // audit/evidence; only what's sent to Claude is reduced. This also
  // raises the trivial-ack prefilter's hit rate right below: a bare "ok"
  // reply is otherwise invisible to it, since the quoted chain underneath
  // makes the whole body fail the exact-match check.
  if (payload.source === "gmail" && payload.raw_content && typeof payload.raw_content === "object") {
    const content = payload.raw_content as Record<string, unknown>;
    if (typeof content.body === "string") {
      const trimmed = trimGmailQuotedReplyChain(content.body);
      // Never let trimming produce emptier content than triage would have
      // seen otherwise - an email that's entirely a forwarded/quoted block
      // with no new text above it is rare but real, and losing it outright
      // would be a quality regression, not a cost optimization.
      if (trimmed) content.body = trimmed;
    }
  }

  // Pre-filter: connectors that can cheaply tell this is bulk/marketing
  // mail (Gmail's List-Unsubscribe header) skip the Claude call entirely -
  // $0, not a discount. This is what should have caught the "Charger Bands
  // Newsletter" false-positive decision before it ever reached the model.
  if (payload.likely_bulk_mail) {
    await withTenant(tenantId, async (sql) => {
      await sql`UPDATE public.raw_events SET pipeline_status = 'done' WHERE id = ${rawEventId}`;
    });
    await pgmqDelete("ingestion", msg.msg_id);
    return "prefiltered_bulk_mail";
  }

  // Pre-filter: pure acks, emoji-only reactions, and bare greetings - the
  // same DISCARD categories the model would return anyway (see
  // isTriviallyDiscardable's comment), answered here for $0 instead of a
  // paid Haiku call. Every one of these currently still reaches the model
  // just to be told "no content here" - this is the actual cost driver
  // caching alone doesn't touch, since caching only discounts the shared
  // system prompt, not the per-event call itself.
  if (isTriviallyDiscardable(payload.raw_content, payload.source)) {
    await withTenant(tenantId, async (sql) => {
      await sql`UPDATE public.raw_events SET pipeline_status = 'done' WHERE id = ${rawEventId}`;
    });
    await pgmqDelete("ingestion", msg.msg_id);
    return "prefiltered_trivial_ack";
  }

  // Triage + extraction, merged into one call (see TRIAGE_EXTRACTION_SYSTEM_PROMPT's
  // comment for why) - one round trip, one transmission of the raw content,
  // cached system prompt across every invocation.
  const userMsg = buildEventUserMessage(payload as never);
  const result = await callClaude(
    TRIAGE_EXTRACTION_SYSTEM_PROMPT, userMsg, TRIAGE_EXTRACTION_TOOL, "record_triage_and_extraction",
    512, EXTRACT_MODEL, 30_000, true,
  ) as {
    decision: string; confidence: number; reason_code: string;
    record_type: string | null; status: string | null; decision_statement: string | null;
    rationale: string | null; alternatives_considered: string[]; sensitivity: number | null;
    attributes?: Record<string, unknown>;
    actors: { source_actor_id: string; role: string }[];
  };

  if (result.decision === "DISCARD") {
    await withTenant(tenantId, async (sql) => {
      await sql`UPDATE public.raw_events SET pipeline_status = 'done' WHERE id = ${rawEventId}`;
    });
    await pgmqDelete("ingestion", msg.msg_id);
    return "discarded";
  }

  // Hold low-confidence UNCERTAIN out of the feed (Improvement Plan Fix 1):
  // recall-biased triage still classifies them, but we do not persist a
  // decision unless confidence clears the gate.
  if (
    result.decision === "UNCERTAIN" &&
    (typeof result.confidence !== "number" || result.confidence < UNCERTAIN_MIN_CONFIDENCE)
  ) {
    console.log(JSON.stringify({
      event: "uncertain_held_out",
      reason_code: result.reason_code,
      confidence: result.confidence ?? null,
      threshold: UNCERTAIN_MIN_CONFIDENCE,
      raw_event_id: rawEventId,
    }));
    await withTenant(tenantId, async (sql) => {
      await sql`UPDATE public.raw_events SET pipeline_status = 'done' WHERE id = ${rawEventId}`;
    });
    await pgmqDelete("ingestion", msg.msg_id);
    return "uncertain_held_out";
  }

  const extraction = result as {
    record_type: string; status: string; decision_statement: string; rationale: string | null;
    alternatives_considered: string[]; actors: { source_actor_id: string; role: string }[];
    confidence: number; sensitivity: number | null;
  };
  extraction.confidence = result.confidence;

  // The model PROPOSES a level; it does not decide one. Anything outside 0-3,
  // or absent, falls back to Internal - the same default the column carries -
  // so a malformed or missing field can never make a record more visible than
  // the default, and never less visible by accident either.
  const proposedLevel = typeof result.sensitivity === "number" &&
      Number.isInteger(result.sensitivity) &&
      result.sensitivity >= 0 && result.sensitivity <= 3
    ? result.sensitivity
    : 1;

  // The model proposes keys; the server decides which survive. Anything not
  // on the whitelist, and anything of the wrong shape, is dropped rather
  // than coerced - a cost arriving as "about 145k" is not a number, and
  // storing it either way would make a corridor that reads it silently
  // wrong. Dropped means the corridor does not fire, which is correct for a
  // fact we do not actually have.
  const attributes = sanitiseAttributes(result.attributes);

  // Settings > Build Memory > "Core knowledge only" - real bug found live,
  // same as "Pause all learning": pure local React state before this, no
  // backend connection. Checked here, after extraction (the triage call
  // already ran either way - this does NOT reduce that call's own token
  // cost, matching the UI's own copy about volume/precision, not spend).
  // An action_item/blocker gets discarded exactly like a DISCARD/held-out
  // UNCERTAIN result - not persisted, raw_event still marked done so it's
  // never retried.
  if (extraction.record_type === "action_item" || extraction.record_type === "blocker") {
    const isCoreKnowledgeOnly = await withTenant(tenantId, async (sql) => {
      const rows = await sql`SELECT core_knowledge_only FROM public.tenants WHERE id = ${tenantId}`;
      // Same unreadable-means-off bug as learning_paused above, and the same
      // fix. One tenant has this switched on and had everything captured
      // anyway for as long as the setting has existed.
      if (rows.length === 0) {
        throw new Error(
          `Cannot read core_knowledge_only for tenant ${tenantId} - refusing to process ` +
            `rather than assume it is off. Check the locus_app SELECT policy on public.tenants.`,
        );
      }
      return rows[0].core_knowledge_only === true;
    });
    if (isCoreKnowledgeOnly) {
      await withTenant(tenantId, async (sql) => {
        await sql`UPDATE public.raw_events SET pipeline_status = 'done' WHERE id = ${rawEventId}`;
      });
      await pgmqDelete("ingestion", msg.msg_id);
      return "core_knowledge_only_filtered";
    }
  }

  // Second, independent redaction pass on the model's own output. The
  // source text was already scrubbed in queue.ts before extraction ever
  // ran, but this catches the case where the model reformats/paraphrases a
  // number (e.g. re-typing digits from an image description or quoting a
  // partially-redacted source) differently than it appeared in the input.
  extraction.decision_statement = redactFinancialInfo(extraction.decision_statement);
  extraction.rationale = extraction.rationale ? redactFinancialInfo(extraction.rationale) : extraction.rationale;
  extraction.alternatives_considered = (extraction.alternatives_considered ?? []).map(redactFinancialInfo);

  // Persist (decision + source + actors), mark done, enqueue embedding
  // (see emitRoutedRecords and writeRoutingAudit below)
  // Audit rows for anything routing emits. Collected inside the tenant
  // transaction and written afterwards, because routing_audit is admin-lane
  // only - it names source records the reader may have no clearance for, so
  // it carries no locus_app grant. Opening an admin connection from inside a
  // tenant transaction would contend for the same small pool that timed out
  // admin-health, so the write waits until this block has released its
  // connection.
  let pendingAudit: RoutingAuditRow[] = [];

  const decisionId = await withTenant(tenantId, async (sql) => {
    const existingDecision = await sql`
      SELECT id FROM public.decisions WHERE tenant_id = ${tenantId} AND origin_raw_event_id = ${rawEventId}
    `;
    if (existingDecision.length > 0) return existingDecision[0].id as string;

    // A Lead can set a floor for a scope, so everything out of a private HR
    // channel starts at Restricted whatever the model thought. The floor only
    // ever raises: max() of the proposal and the highest floor among the
    // record's scopes, so configuring one can never make anything more
    // visible than it already was.
    const floorRows = await sql`
      SELECT max(floor)::int AS floor FROM public.scope_classification_floors
      WHERE tenant_id = ${tenantId} AND scope_id = ANY(${payload.permission_scope ?? []}::text[])
    `;
    const scopeFloor = Number(floorRows[0]?.floor ?? 0);

    // Which department this record's scope belongs to, if any. Null for every
    // record until somebody maps a scope in department_scopes, and null is
    // the inert case: no department default applies and no routing rule can
    // fire. A tenant that has never touched departments behaves exactly as it
    // did before this code existed, which is the property that made it safe
    // to put on the hot path.
    const deptRows = await sql`
      SELECT d.id, d.default_classification
      FROM public.department_scopes ds
      JOIN public.departments d ON d.id = ds.department_id
      WHERE ds.tenant_id = ${tenantId}
        AND ds.scope_id = ANY(${payload.permission_scope ?? []}::text[])
      ORDER BY d.default_classification DESC
      LIMIT 1
    `;
    const departmentId = (deptRows[0]?.id as string | undefined) ?? null;
    const departmentDefault = Number(deptRows[0]?.default_classification ?? 0);

    const ruleRows = await sql`
      SELECT id, name, department_id, match_type, match_terms,
             set_classification, set_compartment, priority
      FROM public.classification_rules
      WHERE tenant_id = ${tenantId} AND enabled = true
      ORDER BY priority, id
    `;

    // The engine resolves a max() over every source that can raise the level.
    // Scope floors and the model proposal are unchanged inputs; departments
    // and rules are new ones. None of them can lower anything.
    const outcome = resolveClassification(
      ruleRows as unknown as ClassificationRule[],
      {
        // The SOURCE text as well as the extraction, and the source is the
        // load-bearing half.
        //
        // Matching the extraction alone missed a real case on the first live
        // run: a message saying "do not share the salary discussion" was
        // summarised to "Approved offer for Senior Engineer role at band 3",
        // and the compensation rule never saw the word that made the record
        // sensitive. The summariser is allowed to drop words; a rule reading
        // only its output inherits every omission, and each omission lands
        // on the side of too visible.
        text: [
          userMsg,
          extraction.decision_statement,
          extraction.rationale ?? "",
          ...(extraction.alternatives_considered ?? []),
        ].join("\n"),
        departmentId,
        proposedLevel,
        scopeFloor,
        departmentDefault,
      },
    );
    const classification = outcome.classification;
    // Which source decided the outcome, recorded so a later reviewer can tell
    // a deliberate policy from a model guess from an untouched default.
    const classifiedBy = outcome.decidedBy;

    const decisionRows = await sql`
      INSERT INTO public.decisions (
        tenant_id, record_type, decision_statement, rationale, alternatives_considered,
        status, scope, confidence, permission_scope, origin_raw_event_id,
        classification, classified_by, classified_at, attributes
      ) VALUES (
        ${tenantId}, ${extraction.record_type}, ${extraction.decision_statement}, ${extraction.rationale},
        ${extraction.alternatives_considered ?? []}, ${extraction.status}, 'team',
        ${extraction.confidence}, ${payload.permission_scope ?? []}, ${rawEventId},
        ${classification}, ${classifiedBy}, now(), ${sql.json(attributes as any)}::jsonb
      ) RETURNING id
    `;
    const newDecisionId = decisionRows[0].id as string;

    const permalink = payload.source === "slack" && payload.permission_scope?.[0]
      ? await resolveSlackPermalink(sql, tenantId, payload.permission_scope[0], payload.source_id, payload.source_permalink)
      : payload.source_permalink;

    if (permalink) {
      await sql`
        INSERT INTO public.decision_sources (tenant_id, decision_id, raw_event_id, permalink)
        VALUES (${tenantId}, ${newDecisionId}, ${rawEventId}, ${permalink})
        ON CONFLICT (decision_id, permalink) DO NOTHING
      `;
    }

    for (const actorRef of extraction.actors ?? []) {
      try {
        // Extraction identifies participants from the event's own TEXT (an
        // @mention, a name in a comment), which only ever gives a name
        // string - never a real account id. Matched against the
        // connector's own known_actors (real structured identities it
        // already had, e.g. an issue's creator + comment authors) by exact
        // case-insensitive name, so a recognized participant gets their
        // real id/name instead of a garbage "account id" made from
        // whatever text the model extracted. No match falls back to the
        // extracted text as-is, same as before this existed.
        const known = payload.known_actors?.find(
          (k) => k.name.toLowerCase() === actorRef.source_actor_id.toLowerCase(),
        );
        const actorId = known
          ? await resolveActorId(sql, tenantId, payload.source, known.source_actor_id, known.name)
          : await resolveActorId(sql, tenantId, payload.source, actorRef.source_actor_id);
        await sql`
          INSERT INTO public.decision_actors (tenant_id, decision_id, actor_id, role)
          VALUES (${tenantId}, ${newDecisionId}, ${actorId}, ${actorRef.role})
          ON CONFLICT (decision_id, actor_id, role) DO NOTHING
        `;
      } catch {
        // Unsupported actor source or resolution failure - skip this actor,
        // never fail the whole decision over one bad reference.
      }
    }

    // Cross-department routing. Emits NEW records into other departments;
    // it never touches this one, and it never widens anything. Inert for any
    // record whose scope is not mapped to a department, which is every
    // record until a tenant configures one.
    if (departmentId !== null) {
      pendingAudit = await emitRoutedRecords(sql, tenantId, {
        id: newDecisionId,
        record_type: extraction.record_type,
        classification,
        departmentId,
        fields: {
          decision_statement: extraction.decision_statement,
          rationale: extraction.rationale,
          alternatives_considered: extraction.alternatives_considered,
          record_type: extraction.record_type,
          // The structured facts are what corridors key on. Spread last so a
          // whitelisted attribute cannot shadow one of the four prose fields
          // above, which are the record itself rather than facts about it.
          ...attributes,
        },
        // Mirrors the source: a derived record is not more or less settled
        // than the decision it came from.
        status: extraction.status ?? "decided",
        // Records created here are always originals. A derived record is
        // written by emitRoutedRecords itself and never re-enters this path,
        // which is what keeps routing to a single hop.
        isDerived: false,
      }, payload.permission_scope ?? []);
    }

    await sql`UPDATE public.raw_events SET pipeline_status = 'done' WHERE id = ${rawEventId}`;
    return newDecisionId;
  });

  if (pendingAudit.length > 0) await writeRoutingAudit(tenantId, pendingAudit);

  await pgmqSend("embedding_queue", { tenant_id: tenantId, decision_id: decisionId });
  await pgmqDelete("ingestion", msg.msg_id);
  return "persisted";
}

// ── Embedding pipeline (mirrors embedding_worker._handle_message) ────────

function buildSearchableText(statement: string, rationale: string | null, alternatives: string[]): string {
  const lines = [`Decision: ${statement}`];
  if (rationale) lines.push(`Rationale: ${rationale}`);
  if (alternatives.length > 0) lines.push(`Alternatives considered: ${alternatives.join(", ")}`);
  return lines.join("\n");
}

// ── Decision conflict detection (differentiator: nothing else in this
// market automatically reasons about whether a new decision contradicts
// or duplicates an existing one - competitors either index content for
// search [Glean] or rely on a human manually verifying/flagging staleness
// [Guru]. This runs on every newly embedded decision, for free, using the
// same vector search /search already relies on. ─────────────────────────

const CONFLICT_CANDIDATE_LIMIT = 3;
// Cosine similarity floor before a candidate is even worth an LLM call -
// below this, two decisions just aren't about the same thing closely
// enough to plausibly conflict, and asking Claude would be pure noise
// (and pure cost) for an unrelated pair.
const CONFLICT_SIMILARITY_FLOOR = 0.72;
const CONFLICT_CONFIDENCE_FLOOR = 0.6;

const CONFLICT_TOOL = {
  name: "record_conflict_analysis",
  description: "Classify how a new decision relates to each existing candidate decision.",
  input_schema: {
    type: "object",
    properties: {
      classifications: {
        type: "array",
        items: {
          type: "object",
          properties: {
            candidate_number: { type: "integer" },
            relationship: { type: "string", enum: ["contradicts", "duplicates", "unrelated"] },
            reason: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["candidate_number", "relationship", "reason", "confidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["classifications"],
    additionalProperties: false,
  },
};

const CONFLICT_SYSTEM_PROMPT = `You compare one new decision against a short list of existing decisions from the same team's records, and classify how each candidate relates to the new one. Each decision is shown with its participants when known.

- "contradicts": the two decisions state genuinely incompatible conclusions about the same specific question, made by/about the same person or team (not merely related topics - e.g. "use Postgres" vs "use MongoDB" for the same system is a contradiction; "use Postgres for the context layer" and "use Redis for caching" is not, those are different questions).
- "duplicates": the two decisions state essentially the same conclusion about the same question, redundantly, by/about the same person or team.
- "unrelated": anything else, including decisions that are topically similar but don't actually make competing or repeated claims, OR concern different people/targets. Default to this when genuinely unsure - a false "contradicts" or "duplicates" flag is worse than a missed one.

Participants matter: if the two decisions are about different people (e.g. one participant decided something for themselves, and the candidate's participant is someone else, or targets a different person/team), that is NOT a conflict or duplicate even if the wording is nearly identical - classify it "unrelated". Only flag "contradicts" or "duplicates" when the decisions are actually about the same real-world person, team, or system.

Call record_conflict_analysis exactly once with one classification per candidate, in the order given.`;

type ConflictCandidate = {
  id: string;
  decision_statement: string;
  rationale: string | null;
  created_at: string;
  participants: string[];
};

// COALESCE order mirrors api/index.ts's guessActorName: a real name beats an
// email beats a raw platform id, so the LLM sees "Abbas Rahman" instead of a
// Slack/Notion user id it can't reason about.
async function getParticipantNames(
  // deno-lint-ignore no-explicit-any
  sql: any,
  tenantId: string,
  decisionIds: string[],
): Promise<Map<string, string[]>> {
  if (decisionIds.length === 0) return new Map();
  const rows = await sql`
    SELECT da.decision_id, COALESCE(a.display_name, a.email, a.slack_user_id, a.notion_user_id) AS name
    FROM public.decision_actors da
    LEFT JOIN public.actors a ON a.id = da.actor_id AND a.tenant_id = da.tenant_id
    WHERE da.decision_id = ANY(${decisionIds}) AND da.tenant_id = ${tenantId}
  `;
  const byDecision = new Map<string, string[]>();
  for (const r of rows as { decision_id: string; name: string | null }[]) {
    if (!r.name) continue;
    const list = byDecision.get(r.decision_id) ?? [];
    list.push(r.name);
    byDecision.set(r.decision_id, list);
  }
  return byDecision;
}

async function detectConflicts(
  tenantId: string,
  decisionId: string,
  statement: string,
  rationale: string | null,
  embedding: number[],
): Promise<void> {
  try {
    const vectorLiteral = "[" + embedding.join(",") + "]";
    const { candidates, newDecisionCreatedAt, newDecisionParticipants } = await withTenant(
      tenantId,
      async (sql) => {
        const rows = await sql`
          SELECT d.id, d.decision_statement, d.rationale, d.created_at,
                 1 - (de.embedding <=> ${vectorLiteral}::vector) AS similarity
          FROM public.decision_embeddings de
          JOIN public.decisions d ON d.id = de.decision_id AND d.tenant_id = de.tenant_id
          WHERE de.tenant_id = ${tenantId} AND de.decision_id != ${decisionId}
            AND 1 - (de.embedding <=> ${vectorLiteral}::vector) >= ${CONFLICT_SIMILARITY_FLOOR}
          ORDER BY de.embedding <=> ${vectorLiteral}::vector ASC
          LIMIT ${CONFLICT_CANDIDATE_LIMIT}
        ` as unknown as {
          id: string;
          decision_statement: string;
          rationale: string | null;
          created_at: string;
        }[];
        if (rows.length === 0) return { candidates: [], newDecisionCreatedAt: null, newDecisionParticipants: [] };

        const newRow = await sql`SELECT created_at FROM public.decisions WHERE id = ${decisionId} AND tenant_id = ${tenantId}`;
        const names = await getParticipantNames(sql, tenantId, [decisionId, ...rows.map((r) => r.id)]);

        const candidates = rows.map(
          (r) => ({
            id: r.id,
            decision_statement: r.decision_statement,
            rationale: r.rationale,
            created_at: r.created_at,
            participants: names.get(r.id) ?? [],
          }),
        );
        return {
          candidates,
          newDecisionCreatedAt: newRow[0]?.created_at ?? null,
          newDecisionParticipants: names.get(decisionId) ?? [],
        };
      },
    );

    if (candidates.length === 0) return;

    const participantsLabel = (names: string[]) => names.length > 0 ? ` [participants: ${names.join(", ")}]` : "";

    const userMessage = [
      `New decision:\n${statement}${rationale ? `\nReason: ${rationale}` : ""}${
        participantsLabel(newDecisionParticipants)
      }`,
      "",
      "Existing candidates:",
      ...candidates.map((c: ConflictCandidate, i: number) =>
        `${i + 1}. ${c.decision_statement}${c.rationale ? ` (reason: ${c.rationale})` : ""}${
          participantsLabel(c.participants)
        }`
      ),
    ].join("\n");

    const result = await callClaude(
      CONFLICT_SYSTEM_PROMPT, userMessage, CONFLICT_TOOL, "record_conflict_analysis", 512, EXTRACT_MODEL, 20_000,
    ) as { classifications: { candidate_number: number; relationship: string; reason: string; confidence: number }[] };

    const flagged = (result.classifications ?? []).filter(
      (c) => (c.relationship === "contradicts" || c.relationship === "duplicates") && c.confidence >= CONFLICT_CONFIDENCE_FLOOR,
    );
    if (flagged.length === 0) return;

    // "duplicates" is resolved automatically, not surfaced as a warning: the
    // older of the pair gets marked superseded by the newer one (same
    // superseded_by column /decisions already uses, so it just renders with
    // the existing "Superseded" badge instead of staying listed as current).
    // "contradicts" still needs a human to look at it - genuinely incompatible
    // conclusions aren't something to silently resolve either direction.
    const duplicates = flagged.filter((c) => c.relationship === "duplicates");
    const contradictions = flagged.filter((c) => c.relationship === "contradicts");

    await withTenant(tenantId, async (sql) => {
      for (const c of duplicates) {
        const candidate = candidates[c.candidate_number - 1];
        if (!candidate) continue;
        const candidateIsOlder = newDecisionCreatedAt
          ? new Date(candidate.created_at).getTime() <= new Date(newDecisionCreatedAt).getTime()
          : true;
        const [olderId, newerId] = candidateIsOlder ? [candidate.id, decisionId] : [decisionId, candidate.id];
        await sql`
          UPDATE public.decisions SET superseded_by = ${newerId}
          WHERE id = ${olderId} AND tenant_id = ${tenantId} AND superseded_by IS NULL
        `;
      }
      for (const c of contradictions) {
        const candidate = candidates[c.candidate_number - 1];
        if (!candidate) continue;
        await sql`
          INSERT INTO public.decision_conflicts (tenant_id, decision_id, related_decision_id, relationship, reason, confidence)
          VALUES (${tenantId}, ${decisionId}, ${candidate.id}, ${c.relationship}, ${c.reason}, ${c.confidence})
          ON CONFLICT (decision_id, related_decision_id) DO UPDATE SET
            relationship = EXCLUDED.relationship, reason = EXCLUDED.reason, confidence = EXCLUDED.confidence
        `;
      }
    });
  } catch (err) {
    // Fails open, same rule as everywhere else this session: conflict
    // detection is a quality enrichment, never a reason to fail the
    // embedding job that already succeeded.
    console.error(`detectConflicts failed for decision ${decisionId}:`, err);
  }
}

async function handleEmbeddingMessage(msg: PgmqMsg): Promise<string> {
  try {
    const job = msg.message as { tenant_id: string; decision_id: string };

    const row = await withTenant(job.tenant_id, async (sql) => {
      const rows = await sql`
        SELECT decision_statement, rationale, alternatives_considered
        FROM public.decisions WHERE id = ${job.decision_id} AND tenant_id = ${job.tenant_id}
      `;
      return rows[0] ?? null;
    });

    if (row === null) {
      // Non-retryable (decision was deleted after the job was enqueued) -
      // matches the Python worker leaving it for now rather than inventing
      // archive/DLQ infrastructure; delete here since there is nothing to retry.
      await pgmqDelete("embedding_queue", msg.msg_id);
      return "decision_not_found";
    }

    const text = buildSearchableText(row.decision_statement, row.rationale, row.alternatives_considered ?? []);
    const embedding = await embedDocument(text);
    const vectorLiteral = "[" + embedding.join(",") + "]";

    await withTenant(job.tenant_id, async (sql) => {
      await sql`
        INSERT INTO public.decision_embeddings (decision_id, tenant_id, embedding, embedding_model, embedded_at)
        VALUES (${job.decision_id}, ${job.tenant_id}, ${vectorLiteral}::vector, ${VOYAGE_MODEL}, now())
        ON CONFLICT (decision_id) DO UPDATE SET
          embedding = EXCLUDED.embedding, embedding_model = EXCLUDED.embedding_model, embedded_at = EXCLUDED.embedded_at
      `;
    });

    await detectConflicts(job.tenant_id, job.decision_id, row.decision_statement, row.rationale, embedding);

    await pgmqDelete("embedding_queue", msg.msg_id);
    return "embedded";
  } catch (err) {
    // Deleting on ANY error is how 62 Notion decisions ended up permanently
    // invisible to semantic search: one transient Voyage failure during a
    // single batch and every job in it was dropped for good. The decision
    // rows survived, their embeddings were never written, and nothing ever
    // retried - so they stayed keyword-searchable and vector-invisible,
    // silently, for a month.
    //
    // Leaving the message queued lets pgmq redeliver it after the
    // visibility timeout. read_ct bounds that, so the failure this delete
    // was originally guarding against - one bad message retrying forever
    // ahead of every other job - still cannot happen.
    if (msg.read_ct < MAX_EMBEDDING_ATTEMPTS) {
      console.error(
        `Embedding error (attempt ${msg.read_ct}/${MAX_EMBEDDING_ATTEMPTS}), left queued for retry:`,
        err,
      );
      return "error_retrying";
    }
    await deadLetter("embedding_queue", msg, err, msg.read_ct);
    return "error_dead_lettered";
  }
}

// ── Bounded concurrency runner ─────────────────────────────────────────

async function runBounded<T>(items: T[], concurrency: number, fn: (item: T) => Promise<string>) {
  const results: { status: string; error?: string }[] = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const item = items[i++];
      try {
        results.push({ status: await fn(item) });
      } catch (err) {
        results.push({ status: "error", error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ── Entrypoint ─────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Checked before reading either queue, deliberately. Stopping here leaves
  // every message untouched with its read_ct unchanged, so nothing ages toward
  // the dead-letter threshold while the pipeline is paused for budget - the
  // work resumes tomorrow exactly where it stopped. Bailing out mid-batch
  // instead would quietly convert a spending pause into data loss.
  const spentToday = await todaysSpendUsd();
  if (spentToday >= DAILY_SPEND_CAP_USD) {
    console.warn(
      `Daily spend cap reached: $${spentToday.toFixed(4)} of $${DAILY_SPEND_CAP_USD} - ` +
        `skipping this run. Queues are untouched and resume after midnight UTC.`,
    );
    return new Response(
      JSON.stringify({
        skipped: "daily_spend_cap_reached",
        spent_usd: Number(spentToday.toFixed(4)),
        cap_usd: DAILY_SPEND_CAP_USD,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // pgmq.read() sets each row's visibility timeout as a side effect of the
  // SQL call itself - if anything after that point throws (a parsing bug,
  // a network drop), the messages are already locked for VISIBILITY_TIMEOUT_
  // SECONDS with nothing to show for it, and an uncaught rejection here can
  // otherwise surface to the caller as an opaque empty-looking response
  // instead of a real error. Wrapping the whole handler guarantees the
  // caller always sees what actually happened.
  try {
    // The two queues are independent - an embedding job's tenant_id/
    // decision_id already exists in the DB by the time it was enqueued
    // (a prior invocation's ingestion pass, not this one), so reading and
    // processing embedding_queue never depends on anything THIS
    // invocation's ingestion pass does. They used to run fully
    // sequentially (embedding didn't even start until every ingestion
    // message finished), which meant an invocation with real work in both
    // queues paid for both durations back to back - the single biggest
    // per-invocation latency cost, and pure waste since neither stage was
    // ever waiting on the other. Running both stages concurrently doesn't
    // change what either one does, only their wall-clock overlap: worst
    // case this invocation's own newly-enqueued embedding jobs simply
    // aren't in the batch this embedding read snapshotted (they get picked
    // up next tick instead, ~60s later at most) - not a correctness
    // change, this already happens today in any bursty invocation.
    const [[ingestionMsgs, ingestionResults], [embeddingMsgs, embeddingResults]] = await Promise.all([
      (async (): Promise<[PgmqMsg[], { status: string; error?: string }[]]> => {
        const msgs = await pgmqRead("ingestion", INGESTION_BATCH);
        const results = await runBounded(msgs, CONCURRENCY, handleIngestionMessage);
        return [msgs, results];
      })(),
      (async (): Promise<[PgmqMsg[], { status: string; error?: string }[]]> => {
        const msgs = await pgmqRead("embedding_queue", EMBEDDING_BATCH);
        const results = await runBounded(msgs, CONCURRENCY, handleEmbeddingMessage);
        return [msgs, results];
      })(),
    ]);

    const summarize = (results: { status: string; error?: string }[]) => {
      const counts: Record<string, number> = {};
      for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
      const errors = results.filter((r) => r.status === "error").slice(0, 5).map((r) => r.error);
      return { counts, errors };
    };

    const ingestionSummary = summarize(ingestionResults);
    const embeddingSummary = summarize(embeddingResults);

    return new Response(
      JSON.stringify({
        ingestion: { read: ingestionMsgs.length, ...ingestionSummary.counts, sample_errors: ingestionSummary.errors },
        embedding: { read: embeddingMsgs.length, ...embeddingSummary.counts, sample_errors: embeddingSummary.errors },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error("ai-worker top-level failure:", message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
