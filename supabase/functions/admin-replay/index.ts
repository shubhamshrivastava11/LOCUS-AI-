// supabase/functions/admin-replay/index.ts
//
// Put already-ingested events back through the pipeline.
//
// WHY THIS EXISTS. Until now nothing could be re-processed. Every fix to
// extraction, classification or routing applied only to mail that had not
// arrived yet, and the 6,889 events already stored were frozen at whatever
// the pipeline did with them on the day. That is the wrong shape for the
// open question about Gmail: the model discards 98.8% of the mail it sees,
// and if the extraction prompt turns out to be tuned for team chat and
// wrong about inboxes, fixing it would recover nothing already ingested.
//
// Replay is possible because raw_content is the ENTIRE original envelope -
// actor, thread_ref, permission_scope and all - encrypted as one blob, not
// a lossy copy of the message body. An event can go back on the queue
// exactly as it first arrived.
//
// TWO THINGS MAKE THIS SAFE, AND BOTH ARE LOAD-BEARING.
//
// 1. It only replays events that produced NOTHING. ai-worker dedups on
//    (tenant, source, source_id) against pipeline_status='done', so a
//    replay has to reset that flag - which means a replayed event that
//    ALREADY yielded a decision would yield a second one, with the first
//    still sitting there. There is no uniqueness on decisions to catch it.
//    Rather than add superseding logic nobody asked for, this endpoint
//    refuses any event with a row in decisions.origin_raw_event_id. That is
//    also precisely the interesting set: the discards.
//
// 2. It costs money, so it asks first. Every replayed event is at least one
//    triage call, plus extraction for anything kept. Replaying all 4,551
//    discarded Gmail events in one go would be a real bill against a
//    project run on a one-dollar-a-day budget. So: preview is the default,
//    apply needs an explicit limit, and the limit is hard-capped. Reaching
//    the whole backlog is deliberately several decisions rather than one
//    button, because the first batch is the one that tells you whether the
//    prompt change actually worked.
//
//   ?mode=preview (default) - read-only. Reports how many events match and
//                             what a batch would cost.
//   ?mode=apply&limit=N     - re-queues the oldest N matching events.
//
// Query params: source, tenant_id, limit, since (ISO date), only.
//
// `only` matters more than it looks. The candidate set holds two populations
// that answer different questions:
//   only=filtered  - the prefilter dropped these before any model saw them.
//                    Replaying them is the only way to find out whether the
//                    bulk-mail rule is throwing away real decisions.
//   only=discarded - the model did see these and said no. Replaying them
//                    tells you nothing until the prompt changes; afterwards
//                    it tells you exactly what the change recovered.
//   only=unjudged   - reached the model but carries no verdict, so it never
//                     completed a triage pass. Usually a crash or a
//                     dead-letter, not a decision about the content.
// Mixing them produces a number that answers neither.
//
// 'discarded' reads triage_result, not "skip_reason is null". The first
// version used the latter and so quietly swept in uncertain rows, rows still
// pending, and anything that died mid-pipeline - which was defensible only
// while triage_result was a dead column reading 'pending' everywhere. The
// same commit that made that column real made this filter wrong, and the
// preview arithmetic inherited the conflation. Caught in review.

import { withAdmin } from "../_shared/db.ts";
import { requireInternalKey } from "../_shared/internalAuth.ts";
import { enqueueEvent, type IngestionEnvelope } from "../_shared/queue.ts";
import { byteaToUint8Array, decryptRawContent } from "../_shared/rawContentCrypto.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-region",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

// A ceiling, not a default. Picked so that one accidental apply cannot
// outspend a day's budget: a batch this size is a few cents of triage, and
// anything larger has to be a sequence of deliberate calls.
const MAX_BATCH = 200;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Operator auth, not user auth. The first version of this endpoint was
  // declared verify_jwt = true with no check in the body, and the config
  // comment claimed that was SAFER than a shared secret. That had it exactly
  // backwards, as Lam pointed out in review: the gateway's verify_jwt accepts
  // any valid Supabase JWT, so every signed-up user held the credential. This
  // handler runs on withAdmin, takes tenant_id as an OPTIONAL filter (so
  // omitting it spans every tenant), decrypts raw_content, and spends model
  // budget. A JWT proves someone signed up; it proves nothing about whether
  // they may re-queue another tenant's mail or spend the day's budget.
  //
  // Every sibling ops tool - admin-health, admin-pipeline-status,
  // admin-detect-channels - is verify_jwt = false plus requireInternalKey.
  // This now matches them. See _shared/internalAuth.ts.
  const unauthorized = await requireInternalKey(req);
  if (unauthorized) return unauthorized;

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") === "apply" ? "apply" : "preview";
  const source = url.searchParams.get("source");
  const tenantId = url.searchParams.get("tenant_id");
  const since = url.searchParams.get("since");
  const only = url.searchParams.get("only");
  const requested = Number(url.searchParams.get("limit") ?? "0");

  if (!source) {
    return json({ error: "source is required, e.g. ?source=gmail" }, 400);
  }
  if (only && !["filtered", "discarded", "unjudged"].includes(only)) {
    return json({ error: "only must be 'filtered', 'discarded' or 'unjudged'" }, 400);
  }
  if (mode === "apply" && (!Number.isInteger(requested) || requested < 1)) {
    // Deliberately no default. An apply with no limit is the call someone
    // makes by accident, and it is the expensive one.
    return json({ error: `apply requires an explicit &limit=N (1..${MAX_BATCH})` }, 400);
  }
  const limit = Math.min(requested || MAX_BATCH, MAX_BATCH);

  try {
    // The candidate set: this source, content still present, nothing ever
    // derived from it. Oldest first, so repeated batches walk the backlog
    // forward instead of re-reading the same head.
    // Only fetched for an apply. Preview used to run this too, pulling up to
    // 200 encrypted raw_content blobs across the wire and then returning
    // without touching one of them - pure I/O for a call whose whole purpose
    // is to be the cheap, read-only one. Flagged in review.
    const rows = mode === "preview" ? [] : await withAdmin(async (sql) => {
      return await sql`
        select e.id, e.tenant_id, e.source, e.source_id, e.thread_ref,
               e.permission_scope, e.raw_content, e.received_at,
               e.connection_id, e.skip_reason, e.triage_result
        from public.raw_events e
        where e.source = ${source}
          and e.raw_content is not null
          and not exists (
            select 1 from public.decisions d where d.origin_raw_event_id = e.id
          )
          and (${only}::text is null
               or (${only}::text = 'filtered'  and e.skip_reason is not null)
               or (${only}::text = 'discarded' and e.skip_reason is null
                     and e.triage_result = 'discarded')
               or (${only}::text = 'unjudged'  and e.skip_reason is null
                     and e.triage_result not in ('discarded', 'kept')))
          and (${tenantId}::uuid is null or e.tenant_id = ${tenantId}::uuid)
          and (${since}::timestamptz is null or e.received_at >= ${since}::timestamptz)
        order by e.received_at asc
        limit ${limit}
      `;
    });

    // The full size of the backlog, which the page of rows above cannot
    // show. Reported so a preview says "4,551 match" rather than "200".
    const totals = await withAdmin(async (sql) => {
      const r = await sql`
        select count(*)::int as matching,
               count(*) filter (where e.skip_reason is not null)::int as never_reached_model,
               count(*) filter (where e.skip_reason is null
                                and e.triage_result = 'discarded')::int as judged_and_discarded,
               count(*) filter (where e.skip_reason is null
                                and e.triage_result not in ('discarded', 'kept'))::int as unjudged
        from public.raw_events e
        where e.source = ${source}
          and e.raw_content is not null
          and not exists (
            select 1 from public.decisions d where d.origin_raw_event_id = e.id
          )
          and (${only}::text is null
               or (${only}::text = 'filtered'  and e.skip_reason is not null)
               or (${only}::text = 'discarded' and e.skip_reason is null
                     and e.triage_result = 'discarded')
               or (${only}::text = 'unjudged'  and e.skip_reason is null
                     and e.triage_result not in ('discarded', 'kept')))
          and (${tenantId}::uuid is null or e.tenant_id = ${tenantId}::uuid)
          and (${since}::timestamptz is null or e.received_at >= ${since}::timestamptz)
      `;
      return r[0];
    });

    if (mode === "preview") {
      return json({
        mode,
        source,
        matching: totals.matching,
        // Counted per verdict rather than inferred by subtraction. The old
        // `matching - never_reached_model` called everything that was not
        // prefiltered "discarded", which lumped in rows that never finished a
        // triage pass at all.
        never_reached_model: totals.never_reached_model,
        judged_and_discarded: totals.judged_and_discarded,
        unjudged: totals.unjudged,
        max_batch: MAX_BATCH,
        note:
          "These produced no decision, so replaying them cannot duplicate one. " +
          "Each costs at least one triage call. Re-run with " +
          "&mode=apply&limit=N to queue the oldest N.",
      });
    }

    const queued: string[] = [];
    const failed: { id: string; why: string }[] = [];

    for (const row of rows.slice(0, limit)) {
      try {
        const envelope = JSON.parse(
          await decryptRawContent(byteaToUint8Array(row.raw_content)),
        ) as Partial<IngestionEnvelope>;

        // Trust the stored envelope for content, the row for identity. The
        // envelope is what the connector sent; the row is what the pipeline
        // actually committed, and on the row's columns the two agree.
        const replayed: IngestionEnvelope = {
          ...(envelope as IngestionEnvelope),
          tenant_id: String(row.tenant_id),
          source: row.source,
          source_id: row.source_id,
          thread_ref: envelope.thread_ref ?? row.thread_ref ?? "",
          permission_scope: envelope.permission_scope ?? row.permission_scope ?? [],
          received_at: new Date(row.received_at).toISOString(),
          connection_id: envelope.connection_id ?? row.connection_id ?? undefined,
          // The whole point of a replay is to let the model look again.
          // Carrying the old bulk-mail flag forward would re-skip the event
          // before triage and make the replay a no-op that reports success.
          likely_bulk_mail: false,
        };

        // Reset the dedup flag immediately before enqueueing: ai-worker
        // drops anything already 'done', so without this the message is
        // accepted and silently discarded. Clearing the triage columns too,
        // so a replayed event that gets discarded again does not keep
        // reading as the verdict from its first pass.
        await withAdmin(async (sql) => {
          await sql`
            update public.raw_events
            set pipeline_status = 'pending',
                skip_reason = null,
                triage_result = 'pending',
                triage_reason = null,
                triage_at = null
            where id = ${row.id}
          `;
        });

        await enqueueEvent(replayed);
        queued.push(row.id);
      } catch (err) {
        // One undecryptable or malformed row must not end the batch - it is
        // exactly the row a replay is most likely to meet, and skipping it
        // loudly is better than stopping before the other 199.
        failed.push({ id: row.id, why: err instanceof Error ? err.message : String(err) });
      }
    }

    return json({
      mode,
      source,
      queued: queued.length,
      failed: failed.length,
      failures: failed.slice(0, 10),
      remaining_after_this_batch: Math.max(0, totals.matching - queued.length),
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
