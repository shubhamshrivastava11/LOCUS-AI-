// supabase/functions/admin-pipeline-status/index.ts
//
// Read-only health check: queue depths (is there a backlog about to drain
// expensively now that credits are back?), cron job state, and recent
// pipeline activity - checked before letting the pipeline run freely again
// after a credit outage.
//
// Source/content-size breakdowns are sampled (last 1000 by msg_id, an
// indexed scan), not full-table GROUP BY - a full jsonb scan across ~118k
// rows timed out repeatedly against this project's compute. A sample is
// precise enough for a cost estimate; it doesn't need to be exact.

import { withAdmin } from "../_shared/db.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const pauseAiWorker = url.searchParams.get("pause_ai_worker") === "true";
  const resumeAiWorker = url.searchParams.get("resume_ai_worker") === "true";

  try {
    if (pauseAiWorker || resumeAiWorker) {
      await withAdmin(async (sql) => {
        await sql`SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'ai-worker-every-minute'), active := ${!pauseAiWorker})`;
      });
    }

    const result = await withAdmin(async (sql) => {
      const ingestionQueue = await sql`SELECT COUNT(*)::int AS n FROM pgmq.q_ingestion`;
      // gmail-manual-sync doesn't dedupe before enqueueing - it relies on
      // ai-worker's own raw_events ON CONFLICT check, which only runs once
      // a message is actually pulled and processed. With ai-worker unable
      // to run, every 5-minute sync cycle re-enqueued the same backfill
      // window again, so queue depth alone hugely overstates real distinct
      // message volume. Counted over the same fast 1000-row sample.
      const uniqueInSample = await sql`
        SELECT COUNT(DISTINCT (message->>'source', message->>'source_id'))::int AS unique_n, COUNT(*)::int AS total_n
        FROM (SELECT message FROM pgmq.q_ingestion ORDER BY msg_id DESC LIMIT 1000) s
      `;
      const embeddingQueue = await sql`SELECT COUNT(*)::int AS n FROM pgmq.q_embedding_queue`;
      const ingestionAgeRange = await sql`
        SELECT MIN(enqueued_at) AS oldest, MAX(enqueued_at) AS newest FROM pgmq.q_ingestion
      `;
      const ingestionByDay = await sql`
        SELECT date_trunc('day', enqueued_at)::date AS day, COUNT(*)::int AS n
        FROM pgmq.q_ingestion GROUP BY 1 ORDER BY 1
      `;

      // Indexed (msg_id), fast - the same 1000-row slice backs both the
      // source mix and the content-size estimate below.
      const sampleRows = await sql`
        SELECT
          message->>'source' AS source,
          (message->>'likely_bulk_mail')::boolean AS likely_bulk_mail,
          LENGTH(COALESCE(message->'raw_content'->>'body', message->'raw_content'->>'text', (message->'raw_content')::text)) AS body_len
        FROM pgmq.q_ingestion
        ORDER BY msg_id DESC LIMIT 1000
      `;

      const rawEventPipelineStatus = await sql`
        SELECT triage_result, COUNT(*)::int AS n
        FROM public.raw_events
        WHERE received_at > now() - interval '2 hours'
        GROUP BY triage_result
      `;

      const recentDecisions = await sql`
        SELECT COUNT(*)::int AS n FROM public.decisions WHERE created_at > now() - interval '2 hours'
      `;

      // triage_at is when a raw_event actually got processed by Claude -
      // unlike received_at (when the original message arrived, which for
      // this backlog is mostly 4+ days old regardless of when it was
      // finally triaged), this is the real signal for "did the brief
      // working window actually process anything, and how much."
      const recentlyTriaged = await sql`
        SELECT triage_result, COUNT(*)::int AS n
        FROM public.raw_events
        WHERE triage_at > now() - interval '24 hours'
        GROUP BY triage_result
      `;
      const triagedTimeRange = await sql`
        SELECT MIN(triage_at) AS first, MAX(triage_at) AS last, COUNT(*)::int AS n
        FROM public.raw_events WHERE triage_at > now() - interval '24 hours'
      `;
      const decisionsLast24h = await sql`
        SELECT id, record_type, confidence, created_at FROM public.decisions
        WHERE created_at > now() - interval '24 hours' ORDER BY created_at ASC
      `;
      // triage_at turns out to never be set on the KEEP/UNCERTAIN path (only
      // pipeline_status='done' is - a real, separate gap from what this
      // check was originally looking for) - pgmq's own archive table is the
      // only remaining reliable "when did this actually get worked" signal,
      // since ai-worker calls pgmq.delete() (moves to archive with a real
      // archived_at) on every completed message regardless of outcome.
      let archiveRows: unknown[] = [];
      try {
        archiveRows = await sql`
          SELECT COUNT(*)::int AS n, MIN(archived_at) AS first, MAX(archived_at) AS last
          FROM pgmq.a_ingestion WHERE archived_at > now() - interval '24 hours'
        ` as unknown as unknown[];
      } catch (err) {
        archiveRows = [{ error: String(err) }];
      }

      // Reconciling a much smaller number the user saw elsewhere (likely
      // Supabase's dashboard queue view, which shows messages actually
      // ready to be read right now) against this function's plain
      // COUNT(*) (every row regardless of state) - pgmq marks a message
      // invisible (vt in the future) while a read is in flight, and a
      // crashed/timed-out invocation leaves it stuck invisible without
      // ever deleting it. If most of this queue is sitting invisible, the
      // dashboard's "ready now" count and this table's real row count will
      // legitimately disagree by a lot.
      const visibility = await sql`
        SELECT
          COUNT(*) FILTER (WHERE vt <= now())::int AS visible_now,
          COUNT(*) FILTER (WHERE vt > now())::int AS locked_invisible,
          COUNT(*)::int AS total
        FROM pgmq.q_ingestion
      `;

      const cronJobs = await sql`SELECT jobname, schedule, active FROM cron.job ORDER BY jobname`;

      // Checking a real user report: Notion's "View Original" showed as
      // disabled (no sourceLink) for at least one decision. sourceLink only
      // exists when a decision_sources row was actually written - if that
      // never happened for a given source, the frontend correctly disables
      // the button (nothing to link to), so this checks whether that's
      // systemic across Notion decisions or an isolated case.
      const notionSourceLinkCoverage = await sql`
        SELECT
          COUNT(*)::int AS total_notion_decisions,
          COUNT(*) FILTER (WHERE ds.decision_id IS NOT NULL)::int AS with_source_link
        FROM public.decisions d
        JOIN public.raw_events re ON re.id = d.origin_raw_event_id AND re.tenant_id = d.tenant_id
        LEFT JOIN public.decision_sources ds ON ds.decision_id = d.id AND ds.tenant_id = d.tenant_id
        WHERE re.source = 'notion'
      `;
      // Sample a few of the raw_events actually missing a decision_sources
      // row, undecrypted metadata only (received_at, whether the row is old
      // enough to predate a given fix) - enough to date the gap without
      // needing to decrypt raw_content for this check.
      const missingNotionLinksSample = await sql`
        SELECT re.id AS raw_event_id, re.received_at, d.id AS decision_id, d.created_at AS decision_created_at
        FROM public.decisions d
        JOIN public.raw_events re ON re.id = d.origin_raw_event_id AND re.tenant_id = d.tenant_id
        LEFT JOIN public.decision_sources ds ON ds.decision_id = d.id AND ds.tenant_id = d.tenant_id
        WHERE re.source = 'notion' AND ds.decision_id IS NULL
        ORDER BY re.received_at DESC LIMIT 10
      `;
      // Is this an ongoing bug (spread across time, including today) or a
      // one-time historical/test-data batch (tightly clustered)?
      const missingNotionLinksByDay = await sql`
        SELECT date_trunc('day', d.created_at)::date AS day, COUNT(*)::int AS n
        FROM public.decisions d
        JOIN public.raw_events re ON re.id = d.origin_raw_event_id AND re.tenant_id = d.tenant_id
        LEFT JOIN public.decision_sources ds ON ds.decision_id = d.id AND ds.tenant_id = d.tenant_id
        WHERE re.source = 'notion' AND ds.decision_id IS NULL
        GROUP BY 1 ORDER BY 1
      `;

      type SampleRow = { source: string | null; likely_bulk_mail: boolean | null; body_len: number | null };
      const samples = sampleRows as unknown as SampleRow[];
      const bySource: Record<string, { n: number; bulk_mail_n: number; total_chars: number }> = {};
      for (const s of samples) {
        const key = s.source ?? "unknown";
        const bucket = bySource[key] ?? { n: 0, bulk_mail_n: 0, total_chars: 0 };
        bucket.n += 1;
        if (s.likely_bulk_mail) bucket.bulk_mail_n += 1;
        bucket.total_chars += s.body_len ?? 0;
        bySource[key] = bucket;
      }
      const sampleSummary = Object.fromEntries(
        Object.entries(bySource).map(([source, b]) => [
          source,
          {
            sample_count: b.n,
            bulk_mail_fraction: b.n > 0 ? Number((b.bulk_mail_n / b.n).toFixed(3)) : 0,
            avg_body_chars: b.n > 0 ? Math.round(b.total_chars / b.n) : 0,
          },
        ]),
      );

      return {
        ingestion_queue_depth: ingestionQueue[0]?.n ?? 0,
        visibility: visibility[0] ?? null,
        unique_vs_total_in_sample: uniqueInSample[0] ?? null,
        ingestion_age_range: ingestionAgeRange[0] ?? null,
        ingestion_by_day: ingestionByDay,
        sample_size: samples.length,
        sample_summary_by_source: sampleSummary,
        embedding_queue_depth: embeddingQueue[0]?.n ?? 0,
        cron_jobs: cronJobs,
        notion_source_link_coverage: notionSourceLinkCoverage[0] ?? null,
        missing_notion_links_sample: missingNotionLinksSample,
        missing_notion_links_by_day: missingNotionLinksByDay,
        raw_events_last_2h_by_status: rawEventPipelineStatus,
        decisions_created_last_2h: recentDecisions[0]?.n ?? 0,
        actually_processed_last_24h: {
          triage_result_counts: recentlyTriaged,
          time_range: triagedTimeRange[0] ?? null,
          decisions: decisionsLast24h,
        },
      };
    });

    return json(result);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
