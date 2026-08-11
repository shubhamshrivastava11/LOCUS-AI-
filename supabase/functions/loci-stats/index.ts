// supabase/functions/loci-stats/index.ts
//
// Basic query analytics for Loci (per Rajith's MVP review feedback): daily
// message/session volume and daily token spend, both already captured by
// loci-chat's own tables (loci_conversations, loci_daily_usage) - this is
// just a read-only rollup over data that already exists, not new tracking.
//
// Admin-only: requires a valid Supabase key (default JWT verification, not
// deployed with --no-verify-jwt), same as admin-dedupe-decisions.

import { withAdmin } from "../_shared/db.ts";

const PRICE_PER_MTOK = { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? "14"), 1), 90);

  try {
    const result = await withAdmin(async (sql) => {
      const volumeRows = await sql`
        SELECT
          date_trunc('day', created_at)::date AS day,
          COUNT(*) FILTER (WHERE role = 'user') AS user_messages,
          COUNT(DISTINCT session_id) AS unique_sessions
        FROM public.loci_conversations
        WHERE created_at >= CURRENT_DATE - (${days}::int - 1)
        GROUP BY 1 ORDER BY 1 DESC
      `;

      const usageRows = await sql`
        SELECT usage_date, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, request_count
        FROM public.loci_daily_usage
        WHERE usage_date >= CURRENT_DATE - (${days}::int - 1)
        ORDER BY usage_date DESC
      `;

      const totals = await sql`
        SELECT
          (SELECT COUNT(*) FROM public.loci_conversations WHERE role = 'user') AS all_time_user_messages,
          (SELECT COUNT(DISTINCT session_id) FROM public.loci_conversations) AS all_time_unique_sessions
      `;

      return { volumeRows, usageRows, totals: totals[0] };
    });

    type UsageRow = {
      usage_date: string; input_tokens: number; output_tokens: number;
      cache_creation_input_tokens: number; cache_read_input_tokens: number; request_count: number;
    };
    const daily_usage = (result.usageRows as unknown as UsageRow[]).map((r) => ({
      date: r.usage_date,
      requests: r.request_count,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cache_read_input_tokens: r.cache_read_input_tokens,
      estimated_cost_usd: Number((
        (r.input_tokens / 1_000_000) * PRICE_PER_MTOK.input +
        (r.output_tokens / 1_000_000) * PRICE_PER_MTOK.output +
        (r.cache_creation_input_tokens / 1_000_000) * PRICE_PER_MTOK.cacheWrite +
        (r.cache_read_input_tokens / 1_000_000) * PRICE_PER_MTOK.cacheRead
      ).toFixed(4)),
    }));

    type VolumeRow = { day: string; user_messages: number; unique_sessions: number };
    const daily_volume = (result.volumeRows as unknown as VolumeRow[]).map((r) => ({
      date: r.day, user_messages: Number(r.user_messages), unique_sessions: Number(r.unique_sessions),
    }));

    return json({
      window_days: days,
      all_time: {
        user_messages: Number((result.totals as { all_time_user_messages: number }).all_time_user_messages),
        unique_sessions: Number((result.totals as { all_time_unique_sessions: number }).all_time_unique_sessions),
      },
      daily_volume,
      daily_usage,
    });
  } catch (err) {
    console.error("loci-stats failed:", err);
    return json({ error: String(err) }, 500);
  }
});
