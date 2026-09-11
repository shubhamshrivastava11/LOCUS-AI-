// supabase/functions/discord-poller/index.ts
//
// Different shape from every other poller here in two real ways:
//
// 1. One global DISCORD_BOT_TOKEN (see discord-oauth/index.ts's header
//    comment for why), not a per-connection decrypted token - no refresh
//    logic needed at all, bot tokens don't expire.
// 2. Discord's own pagination is message-ID (snowflake) based, not
//    timestamp-based - there's no "updated since X" the way Jira/
//    Confluence/Notion have. cursor_state tracks the last-seen message id
//    PER CHANNEL (channel_cursors: {channelId: messageId}), and each
//    channel is paged with `after=<that id>` - first poll for a channel
//    has no cursor yet, bounded to the most recent 50 messages rather
//    than pulling a channel's entire history.
//
// permission_scope is deliberately left empty (workspace-wide visible,
// same convention as an unscoped decision already gets) rather than
// per-channel - Discord channel ids are numeric snowflakes, which
// isUnmappedScope's existing SLACK_CHANNEL_RE pattern doesn't recognize,
// and there's no Discord membership-sync equivalent to isMemoryAccessible
// built yet. Scoping per-channel with no real membership backing it would
// risk making every Discord-sourced decision invisible to everyone
// (falls through past isUnmappedScope, then needs a real permissionScopes
// match nobody has) - a real, disclosed simplification for v1, not an
// oversight.

import { withAdmin, withTenant } from "../_shared/db.ts";
import { enqueueEvent, IngestionEnvelope } from "../_shared/queue.ts";

console.log("Discord poller started!");

// Real bug found live: the first version fetched channels one at a time,
// no per-request timeout - a real server with several channels (or one
// slow/stalled request) ran past Supabase's own 150s idle-timeout limit
// and the whole poll died with nothing recorded, not even the channels
// that had already finished. Fixed two ways: a hard per-request timeout
// (a stuck request can no longer hang the entire run) and bounded
// concurrency across channels (CONCURRENCY_LIMIT at once, same shape
// ai-worker's own runBounded already uses elsewhere in this codebase).
const REQUEST_TIMEOUT_MS = 20_000;
const CONCURRENCY_LIMIT = 4;

async function fetchWithTimeout(url: string | URL, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const BOT_TOKEN = Deno.env.get("DISCORD_BOT_TOKEN");
const MAX_MESSAGES_PER_CHANNEL = 50;
// Discord channel type 0 = GUILD_TEXT. Threads/announcements/voice/
// category channels are skipped for v1 - real content, but a real second
// pass, not folded in here.
const GUILD_TEXT_CHANNEL_TYPE = 0;

interface DiscordChannel {
  id: string;
  type: number;
  name?: string;
}

interface DiscordMessage {
  id: string;
  content: string;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  timestamp: string;
}

Deno.serve(async (_req) => {
  if (!BOT_TOKEN) {
    return new Response(JSON.stringify({ message: "DISCORD_BOT_TOKEN not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sources = await withAdmin(async (sql) => {
    return await sql`
      select *
      from public.source_connections
      where source = 'discord'
        and status = 'active'
        and ingestion_mode = 'polling'
    `;
  });

  const results = [];

  for (const source of sources) {
    try {
      const guildId = source.external_workspace_id as string;
      const channelsResp = await fetchWithTimeout(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
        headers: { Authorization: `Bot ${BOT_TOKEN}` },
      }, REQUEST_TIMEOUT_MS);
      if (!channelsResp.ok) {
        const bodyText = await channelsResp.text();
        console.error(`Discord channels fetch failed for ${source.id}:`, bodyText);
        results.push({ source_id: source.id, error: `channels failed: ${channelsResp.status} ${bodyText}` });
        continue;
      }
      const channels: DiscordChannel[] = await channelsResp.json();
      const textChannels = channels.filter((c) => c.type === GUILD_TEXT_CHANNEL_TYPE);

      const channelCursors: Record<string, string> = { ...(source.cursor_state?.channel_cursors ?? {}) };
      let totalMessages = 0;

      // One channel per worker at a time, CONCURRENCY_LIMIT workers - same
      // bounded-concurrency shape as ai-worker's own runBounded, just
      // inlined here rather than shared (this is the only poller with a
      // one-connection-to-many-sub-resources shape so far).
      let nextIndex = 0;
      async function processChannel(channel: DiscordChannel): Promise<void> {
        const afterId = channelCursors[channel.id];
        const messagesUrl = new URL(`https://discord.com/api/v10/channels/${channel.id}/messages`);
        messagesUrl.searchParams.set("limit", String(MAX_MESSAGES_PER_CHANNEL));
        if (afterId) messagesUrl.searchParams.set("after", afterId);

        const messagesResp = await fetchWithTimeout(messagesUrl, {
          headers: { Authorization: `Bot ${BOT_TOKEN}` },
        }, REQUEST_TIMEOUT_MS);
        if (!messagesResp.ok) {
          // A single channel the bot can't see (permissions not granted
          // for that specific channel, despite the guild-level invite)
          // shouldn't abort the whole connection's poll - log and move on.
          console.error(`Discord messages fetch failed for channel ${channel.id}:`, await messagesResp.text());
          return;
        }
        // Discord returns newest-first; oldest-first is what every other
        // poller here already assumes when advancing a cursor to "the
        // last item processed".
        const messages: DiscordMessage[] = (await messagesResp.json()).reverse();
        if (messages.length === 0) return;

        for (const message of messages) {
          if (message.author.bot) continue; // never ingest our own/other bots' messages
          if (!message.content.trim()) continue; // embed-only/attachment-only messages have nothing to extract

          const envelope: IngestionEnvelope = {
            tenant_id: source.tenant_id,
            connection_id: source.id,
            source: "discord",
            source_id: message.id,
            actor: message.author.id,
            actor_display_name: message.author.global_name || message.author.username,
            thread_ref: channel.id,
            permission_scope: [],
            // Build Memory's toggle key for this source (see
            // capture_item_id in _shared/queue.ts).
            capture_item_id: channel.id,
            raw_content: {
              subject: channel.name ? `#${channel.name}` : "",
              body: message.content,
            },
            source_permalink: `https://discord.com/channels/${guildId}/${channel.id}/${message.id}`,
            received_at: new Date().toISOString(),
          };
          await enqueueEvent(envelope);
          totalMessages++;
        }

        channelCursors[channel.id] = messages[messages.length - 1].id;

        // Real bug found live: this used to be one batched cursor write
        // at the very end, after every channel finished. A real server
        // with enough history (819 messages queued from one real run)
        // can genuinely take longer than Supabase's 150s idle-timeout to
        // get through every channel - when the platform kills the
        // function mid-run, that end-of-run write never happens, and
        // every channel that WAS finished loses its progress entirely,
        // re-fetching the exact same messages (and re-enqueueing
        // duplicates ai-worker then has to dedup) on the next tick
        // instead of picking up where it left off. Persisting per-channel
        // as each one finishes means a mid-run kill only loses whatever
        // channel was in flight at that exact moment, not everything
        // already done - the run self-heals across successive 5-minute
        // cron ticks instead of restarting from zero every time.
        await withTenant(String(source.tenant_id), async (sql) => {
          await sql`
            update public.source_connections
            set cursor_state = ${sql.json({ ...source.cursor_state, channel_cursors: channelCursors })},
                last_synced_at = now()
            where id = ${source.id}
          `;
        });
      }

      async function worker(): Promise<void> {
        while (nextIndex < textChannels.length) {
          const channel = textChannels[nextIndex++];
          try {
            await processChannel(channel);
          } catch (err) {
            console.error(`Error processing Discord channel ${channel.id}:`, err);
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY_LIMIT, textChannels.length) }, worker));

      results.push({ source_id: source.id, channels_polled: textChannels.length, new_messages: totalMessages });
    } catch (err) {
      console.error(`Error polling Discord source ${source.id}:`, err);
      results.push({ source_id: source.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return new Response(JSON.stringify({ message: "Poll completed", results }), {
    headers: { "Content-Type": "application/json" },
  });
});
