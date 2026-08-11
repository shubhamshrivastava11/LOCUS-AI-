// supabase/functions/loci-chat/index.ts
//
// Backend for "Loci" (pronounced "Loki"), the support/FAQ chat widget for
// locusaiapp.com itself. Hosted in the same Locus AI Supabase project as
// the core pipeline; its tables (loci_*) carry no tenant_id since chat
// visitors aren't tenants - they're anonymous site visitors identified only
// by a client-generated session id. Reuses the same ANTHROPIC_API_KEY
// secret already configured in this project, so it draws from the same
// Anthropic billing/usage limit as the rest of Locus AI.
//
// Public-facing and reachable by anyone on the internet - unlike the
// internal Gmail/Slack/Notion pipeline, which only ever processes data from
// connectors the tenant controls. Rate limiting here is not optional.

import { withAdmin } from "../_shared/db.ts";
import {
  CONNECTORS, CORE_FEATURES, DATA_RESIDENCY, MEMORY_REFRESH_CYCLE_HOURS,
  PLANS, RAW_CONTENT_RETENTION_DAYS, TEAM_PLAN_UPCOMING_FEATURES,
} from "../_shared/productFacts.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("ANTHROPIC_LOCI_MODEL") ?? "claude-haiku-4-5-20251001";

// ── Rate limits ────────────────────────────────────────────────────────
// Two independent windows: per-session (a real visitor having a real
// conversation) and per-IP (catches someone cycling session ids to get
// around the session limit). Both are deliberately generous enough for a
// real conversation but nowhere near what a script hammering the endpoint
// would need.
const SESSION_LIMIT = 30; // messages
const SESSION_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const IP_LIMIT = 60; // messages
const IP_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_MESSAGE_CHARS = 2000; // guards against someone pasting a novel to inflate token cost per call

// ── Global daily spend cap ────────────────────────────────────────────
// Per-session/per-IP limits (above) stop any one visitor from running up
// cost, but say nothing about total traffic across every visitor combined.
// This is the backstop: track real Anthropic usage per UTC day and refuse
// to place new calls once the day's estimated spend clears the cap, rather
// than relying on the Anthropic account-wide limit (which would also take
// the core Locus AI pipeline down with it - see this session's Aug 4
// incident). Haiku 4.5 pricing: $1/$5 per MTok input/output; cache write
// (5-minute) ~1.25x base input, cache read ~0.1x base input.
const DAILY_SPEND_CAP_USD = Number(Deno.env.get("LOCI_DAILY_SPEND_CAP_USD") ?? "5");
const PRICE_PER_MTOK = { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 };

function estimateCostUsd(u: {
  input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number;
}): number {
  return (
    (u.input_tokens / 1_000_000) * PRICE_PER_MTOK.input +
    (u.output_tokens / 1_000_000) * PRICE_PER_MTOK.output +
    (u.cache_creation_input_tokens / 1_000_000) * PRICE_PER_MTOK.cacheWrite +
    (u.cache_read_input_tokens / 1_000_000) * PRICE_PER_MTOK.cacheRead
  );
}

// deno-lint-ignore no-explicit-any
async function ensureSchema(sql: any) {
  await sql`
    CREATE TABLE IF NOT EXISTS public.loci_conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id text NOT NULL,
      role text NOT NULL CHECK (role IN ('user', 'assistant')),
      content text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS loci_conversations_session_idx
      ON public.loci_conversations (session_id, created_at)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS public.loci_rate_limits (
      key text PRIMARY KEY,
      window_start timestamptz NOT NULL DEFAULT now(),
      request_count int NOT NULL DEFAULT 0
    )
  `;
  // One row per UTC day. request_count here is successful Claude calls only
  // (rate-limited/rejected requests never reach the point this is updated),
  // which is what basic query-volume analytics also wants to read.
  await sql`
    CREATE TABLE IF NOT EXISTS public.loci_daily_usage (
      usage_date date PRIMARY KEY,
      input_tokens bigint NOT NULL DEFAULT 0,
      output_tokens bigint NOT NULL DEFAULT 0,
      cache_creation_input_tokens bigint NOT NULL DEFAULT 0,
      cache_read_input_tokens bigint NOT NULL DEFAULT 0,
      request_count int NOT NULL DEFAULT 0
    )
  `;
}

// deno-lint-ignore no-explicit-any
async function todaysSpendUsd(sql: any): Promise<number> {
  const rows = await sql`
    SELECT input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens
    FROM public.loci_daily_usage WHERE usage_date = CURRENT_DATE
  `;
  if (rows.length === 0) return 0;
  return estimateCostUsd(rows[0] as {
    input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number;
  });
}

// deno-lint-ignore no-explicit-any
async function recordUsage(sql: any, usage: {
  input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number;
}) {
  await sql`
    INSERT INTO public.loci_daily_usage (usage_date, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, request_count)
    VALUES (CURRENT_DATE, ${usage.input_tokens ?? 0}, ${usage.output_tokens ?? 0}, ${usage.cache_creation_input_tokens ?? 0}, ${usage.cache_read_input_tokens ?? 0}, 1)
    ON CONFLICT (usage_date) DO UPDATE SET
      input_tokens = public.loci_daily_usage.input_tokens + EXCLUDED.input_tokens,
      output_tokens = public.loci_daily_usage.output_tokens + EXCLUDED.output_tokens,
      cache_creation_input_tokens = public.loci_daily_usage.cache_creation_input_tokens + EXCLUDED.cache_creation_input_tokens,
      cache_read_input_tokens = public.loci_daily_usage.cache_read_input_tokens + EXCLUDED.cache_read_input_tokens,
      request_count = public.loci_daily_usage.request_count + 1
  `;
}

// Fixed-window check-and-increment. Returns true if the request is allowed.
// deno-lint-ignore no-explicit-any
async function checkRateLimit(sql: any, key: string, limit: number, windowMs: number): Promise<boolean> {
  const rows = await sql`SELECT window_start, request_count FROM public.loci_rate_limits WHERE key = ${key}`;
  const now = Date.now();

  if (rows.length === 0) {
    await sql`INSERT INTO public.loci_rate_limits (key, window_start, request_count) VALUES (${key}, now(), 1)`;
    return true;
  }

  const windowStart = new Date(rows[0].window_start as string).getTime();
  const count = rows[0].request_count as number;

  if (now - windowStart > windowMs) {
    // Window elapsed - reset.
    await sql`UPDATE public.loci_rate_limits SET window_start = now(), request_count = 1 WHERE key = ${key}`;
    return true;
  }

  if (count >= limit) return false;

  await sql`UPDATE public.loci_rate_limits SET request_count = request_count + 1 WHERE key = ${key}`;
  return true;
}

// ── System prompt, built from Locus AI's own real product/app content ───
// Explicitly told what it does NOT know (anything account-specific) so it
// never invents a decision, a connector status, or a reply it has no
// access to - this is the FAQ/product/signup guide, not a logged-in
// account assistant.
//
// Connectors, core features, and pricing are generated below from
// _shared/productFacts.ts rather than hand-typed here, so a real change to
// those facts only has to happen in one file - deploying loci-chat after
// editing productFacts.ts is the entire sync step, since Supabase bundles
// that import into the function automatically like any other _shared file.
const liveConnectors = CONNECTORS.filter((c) => c.status === "live").map((c) => c.name);
const roadmapConnectors = CONNECTORS.filter((c) => c.status === "roadmap").map((c) => c.name);
const connectorsSection = `Live today: ${liveConnectors.join(", ")}. Read-only OAuth - Locus never writes back to a connected workspace. ${roadmapConnectors.join(", ")} ${roadmapConnectors.length === 1 ? "is" : "are"} on the roadmap, not shipped yet - if asked about a connector not in this list, say it isn't supported yet rather than guessing a timeline.`;

const coreFeaturesSection = CORE_FEATURES.map((f) => `- ${f.title} - ${f.description}`).join("\n")
  + `\n- Memory refreshes on a ${MEMORY_REFRESH_CYCLE_HOURS}-hour cycle.`;

const pricingSection = PLANS.map((p) => {
  const base = `- ${p.name}: $${p.priceUsdPerMonth}/month - ${p.features.join(", ")}.`;
  if (p.id !== "team" || TEAM_PLAN_UPCOMING_FEATURES.length === 0) return base;
  return `${base} ${TEAM_PLAN_UPCOMING_FEATURES.join(", ")} ${TEAM_PLAN_UPCOMING_FEATURES.length === 1 ? "is" : "are"} marked "upcoming" on the Team plan (not live yet).`;
}).join("\n") + "\n- There is no free tier or trial in the product today - do not tell anyone there is one.";

const SYSTEM_PROMPT = `You are Loci (pronounced "Loki"), the support and product assistant on locusaiapp.com's chat widget. You help visitors understand Locus AI and get started - you do not have access to any individual user's account, connected sources, or data.

## What Locus AI is

Locus AI is an MCP-native context layer that watches where teams decide - Slack, Gmail, and Notion - and continuously turns scattered conversation into a structured, queryable decision register. Tagline: "Run your projects like you remember everything." It connects to a team's existing tools and keeps a searchable memory so decisions, action items, and blockers never get lost in chat history or email threads.

## Connectors

${connectorsSection}

## Core features

${coreFeaturesSection}

## The app itself (what a logged-in user actually sees)

Top nav, present on every logged-in page: How it works, Dashboard, Memory Explorer, Team Pulse, Settings, plus an account menu (shows the signed-in email, lets someone sign into another Google account, and sign out).

- Dashboard (home page after signing in): a greeting header, a search bar for asking questions across everything Locus has ingested (this is Context Search - type a question or just a topic/keyword and it answers from the team's real memory, with citations back to the source), a short "Recent Search" list, three metric cards showing counts of Decisions / Action Items / Blockers, a "Memory Sources" panel listing each connected source with its sync status and an "Add Memory Source" button, and a "Build Memory" panel showing the most recent captures (each tagged Decision/Blocker/Action item, click one to expand its full detail).
- Memory Explorer: the full log of everything Locus has captured, filterable by type (Decision / Action Item / Blocker) and by source (Slack / Gmail / Notion). Click any row to expand it into full detail: a plain-language summary, who was involved, which source and when, current status (Current or Superseded, if a later decision replaced it), the reconstructed conversation it was drawn from, a "View Original" button linking back to the real source message, and a "Flag" button for reporting something wrong with it.
- Team Pulse (page header says "Pulse", tagline "Your week, synthesized"): an AI-generated narrative summary of the current week's decisions grouped by theme, plus three breakdown sections (Decisions, Action items, Blockers) each showing the top few by confidence and recency. Has previous/next week navigation and a custom date-range picker, plus a helpful/not-helpful feedback control. The narrative summary is only available for the current week and any week that's already been viewed once while it was current - it does not exist for weeks nobody has opened Team Pulse during yet.
- Settings: manage connected sources here - connect or disconnect Gmail, Slack, and Notion. A tenant can have more than one connection per source (e.g. two Gmail accounts), each shown separately with its own real account or workspace name and last-synced time.

Locus does not have a widget, browser extension, or Slack app that posts back into a workspace - only the dashboard above and the read-only connectors listed earlier.

## Privacy

Locus reads messages to build structured memory, then permanently deletes the raw content within ${RAW_CONTENT_RETENTION_DAYS} days - only the extracted context summary is kept, never the full message thread. Connectors are read-only (Locus never posts, edits, or deletes anything in a connected Slack/Notion/Gmail). No training on workspace data. Data residency is ${DATA_RESIDENCY}.

## Pricing (monthly)

${pricingSection}

## How to behave

- Be direct and concise - most answers should be a few sentences, not an essay. Default to a single short paragraph even when the topic has multiple parts (e.g. "what's on the dashboard") - pick the 2-3 most relevant parts rather than listing every one in its own paragraph. This is a chat bubble, not a document - never structure an answer as a document either.
- Plain conversational text only - never use markdown (no #/## headings, no **bold**, no bullet lists with -/*). The widget renders your reply as plain text, so markdown syntax shows up as literal stray characters instead of formatting. Write the way you'd actually say it out loud.
- Never use an em dash (—) or double hyphen (--). Use a period, comma, colon, or "and"/"but" to join or separate clauses instead.
- You have NO access to any specific user's account, connected sources, decision log, or data. If asked something account-specific ("why isn't my Gmail syncing", "why don't I see decisions from last week"), say plainly that you can't see account details from this chat, and point them to their in-app Settings or the app's own support/contact option for anything account-specific.
- Never invent a fact about Locus AI that isn't in this prompt - this applies even when a plausible-sounding answer would be easy to infer. If something isn't explicitly stated above (specific integrations beyond Gmail/Slack/Notion, security certifications, team size limits, uptime guarantees, anything not written out in this prompt), say you don't have that specific information rather than reasoning your way to a guess, and point them to the app's support/contact option. A confident-sounding wrong answer is worse than "I don't know, but here's who can tell you."
- If someone seems ready to sign up, point them at the sign-up flow on locusaiapp.com and mention the two plans (Individual $12/mo, Team $15/mo) as the natural next step.`;

function buildCorsResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return buildCorsResponse(405, { error: "Method not allowed" });
  }

  let body: { session_id?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return buildCorsResponse(400, { error: "Invalid JSON body" });
  }

  const sessionId = (body.session_id ?? "").trim();
  const message = (body.message ?? "").trim();
  if (!sessionId || !message) {
    return buildCorsResponse(400, { error: "session_id and message are required" });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return buildCorsResponse(400, { error: `message too long (max ${MAX_MESSAGE_CHARS} characters)` });
  }

  // Cloudflare/most proxies set this; falls back to the direct connection
  // info Deno exposes if not present (e.g. local testing).
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("cf-connecting-ip")
    || "unknown";

  try {
    const result = await withAdmin(async (sql) => {
      await ensureSchema(sql);

      const sessionOk = await checkRateLimit(sql, `session:${sessionId}`, SESSION_LIMIT, SESSION_WINDOW_MS);
      if (!sessionOk) return { rateLimited: "session" as const };

      const ipOk = await checkRateLimit(sql, `ip:${ip}`, IP_LIMIT, IP_WINDOW_MS);
      if (!ipOk) return { rateLimited: "ip" as const };

      const spentToday = await todaysSpendUsd(sql);
      if (spentToday >= DAILY_SPEND_CAP_USD) {
        console.warn(JSON.stringify({ event: "loci_daily_cap_reached", spent_usd: spentToday, cap_usd: DAILY_SPEND_CAP_USD }));
        return { budgetExceeded: true as const };
      }

      // Last 10 turns of real history for this session - enough for a
      // coherent conversation without unboundedly growing the prompt.
      const history = await sql`
        SELECT role, content FROM public.loci_conversations
        WHERE session_id = ${sessionId}
        ORDER BY created_at DESC LIMIT 10
      `;
      const messages = (history as unknown as { role: string; content: string }[])
        .reverse()
        .map((m) => ({ role: m.role, content: m.content }));
      messages.push({ role: "user", content: message });

      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 400,
          temperature: 0.3,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          messages,
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        return { error: `Anthropic API error ${resp.status}: ${errText}` };
      }

      const data = await resp.json();
      const textBlock = (data.content ?? []).find((b: { type?: string }) => b.type === "text");
      const replyText = textBlock?.text ?? "Sorry, I couldn't generate a response - try again in a moment.";

      await recordUsage(sql, data.usage ?? {});
      await sql`INSERT INTO public.loci_conversations (session_id, role, content) VALUES (${sessionId}, 'user', ${message})`;
      await sql`INSERT INTO public.loci_conversations (session_id, role, content) VALUES (${sessionId}, 'assistant', ${replyText})`;

      return { reply: replyText };
    });

    if (result.rateLimited) {
      return buildCorsResponse(429, {
        error: result.rateLimited === "session"
          ? "You've sent a lot of messages - give it a bit and try again."
          : "Too many requests from this network - give it a bit and try again.",
      });
    }
    if (result.budgetExceeded) {
      return buildCorsResponse(503, {
        error: "Loci has reached its usage budget for today - please try again tomorrow, or contact support directly.",
      });
    }
    if (result.error) {
      console.error("loci-chat: Anthropic call failed:", result.error);
      return buildCorsResponse(502, { error: "Something went wrong generating a response. Try again shortly." });
    }
    return buildCorsResponse(200, { reply: result.reply });
  } catch (err) {
    console.error("loci-chat: unexpected error:", err);
    return buildCorsResponse(500, { error: "Unexpected server error." });
  }
});
