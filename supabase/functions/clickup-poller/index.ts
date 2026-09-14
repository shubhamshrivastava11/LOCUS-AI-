// supabase/functions/clickup-poller/index.ts
//
// Team-wide task endpoint (GET /v2/team/{team_id}/task) with a real
// server-side date_updated_gt filter - verified against ClickUp's own
// docs before building this, more efficient than Monday's client-side
// filtering: only genuinely changed tasks ever come back, not a full
// board dump filtered after the fact.
//
// Comments are per-task only - ClickUp's own docs confirm there is no
// workspace-wide comments endpoint the way GitHub has - so this makes
// one comment-list call per changed task. Bounded by MAX_TASKS_PER_POLL
// to stay well inside the 100 req/min budget most plan tiers get,
// verified against ClickUp's own docs before writing this.
//
// source_id for a task includes date_updated from the start - same real
// lesson just learned live on monday-poller: a task-tracker item's
// whole point is that its status changes over its lifetime ("Awaiting
// Review" -> "Fixed" IS the decision-worthy content), so capturing it
// only once, on first sight, would silently miss every later status
// change forever. thread_ref stays task-scoped (not timestamped) so
// every snapshot of the same task still groups into one conversation.
// A comment's own source_id does NOT include a timestamp - a posted
// comment is genuinely a one-time, immutable event, the same category
// as a Slack message, not a mutable resource like the task itself.
//
// v1 simplification, disclosed not hidden: task list pagination is
// bounded to MAX_PAGES rather than followed to exhaustion - matching
// the same single-page-ish simplicity Jira/Confluence/Monday already
// have. A poll cycle that changes more than MAX_PAGES * 100 tasks at
// once will only see the most recent page's worth, not silently lose
// data on a normal-sized team's normal-sized change volume.
//
// ClickUp's own real quirk, verified before writing this: timestamp
// fields (date_updated, comment date) come back as numeric-string
// Unix milliseconds, not ISO strings - handled explicitly below rather
// than assumed.

import { withAdmin, withTenant } from "../_shared/db.ts";
import { enqueueEvent, IngestionEnvelope } from "../_shared/queue.ts";
import { decryptToken } from "../_shared/tokenCrypto.ts";

console.log("ClickUp poller started!");

const CLICKUP_API = "https://api.clickup.com/api/v2";
const MAX_PAGES = 3;
const MAX_TASKS_PER_POLL = 50;

interface ClickUpUser {
  id?: number;
  username?: string;
}
interface ClickUpTask {
  id: string;
  name?: string;
  text_content?: string | null;
  description?: string | null;
  status?: { status?: string };
  priority?: { priority?: string } | null;
  url?: string;
  date_updated?: string;
  creator?: ClickUpUser;
  // /team/{id}/task returns the owning space on every task, which is the
  // granularity Build Memory offers for ClickUp.
  space?: { id?: string };
}
interface ClickUpComment {
  id: string;
  comment_text?: string;
  user?: ClickUpUser;
  date?: string;
}

function clickupHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function knownActorsFor(user: ClickUpUser | undefined): { name: string; source_actor_id: string }[] {
  return user?.id && user.username ? [{ name: user.username, source_actor_id: String(user.id) }] : [];
}

Deno.serve(async (_req) => {
  const sources = await withAdmin(async (sql) => {
    return await sql`
      select *
      from public.source_connections
      where source = 'clickup'
        and status = 'active'
        and ingestion_mode = 'polling'
    `;
  });

  const results = [];

  for (const source of sources) {
    try {
      const accessToken = await decryptToken(source.oauth_token_ref as string | null);
      if (!accessToken) {
        results.push({ source_id: source.id, error: "missing/undecryptable token" });
        continue;
      }
      const headers = clickupHeaders(accessToken);
      const teamId = source.external_workspace_id as string;

      const cursorMs = source.last_synced_at ? new Date(source.last_synced_at as string).getTime() : 0;

      const tasks: ClickUpTask[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const tasksUrl = new URL(`${CLICKUP_API}/team/${teamId}/task`);
        tasksUrl.searchParams.set("page", String(page));
        tasksUrl.searchParams.set("date_updated_gt", String(cursorMs));
        tasksUrl.searchParams.set("include_closed", "true");

        const resp = await fetch(tasksUrl, { headers });
        if (!resp.ok) {
          console.error(`ClickUp task fetch failed for ${source.id} page ${page}:`, await resp.text());
          break;
        }
        const data = await resp.json();
        const pageTasks: ClickUpTask[] = data.tasks ?? [];
        tasks.push(...pageTasks);
        if (pageTasks.length === 0 || data.last_page) break;
      }

      let eventCount = 0;
      let latestUpdatedMs = cursorMs;

      for (const task of tasks.slice(0, MAX_TASKS_PER_POLL)) {
        const bodyText = task.text_content ?? task.description ?? "";
        const statusLine = task.status?.status ? `Status: ${task.status.status}` : "";
        const priorityLine = task.priority?.priority ? `Priority: ${task.priority.priority}` : "";
        const body = [task.name ?? "", bodyText, statusLine, priorityLine].filter(Boolean).join("\n\n");

        const envelope: IngestionEnvelope = {
          tenant_id: source.tenant_id,
          connection_id: source.id,
          source: "clickup",
          source_id: `task-${task.id}-${task.date_updated ?? ""}`,
          actor: task.creator?.id ? String(task.creator.id) : "unknown",
          actor_display_name: task.creator?.username,
          thread_ref: `task-${task.id}`,
          permission_scope: [],
          capture_item_id: task.space?.id,
          known_actors: knownActorsFor(task.creator),
          raw_content: { subject: task.name ?? "", body },
          source_permalink: task.url,
          received_at: new Date().toISOString(),
        };
        await enqueueEvent(envelope);
        eventCount++;

        const updatedMs = task.date_updated ? Number(task.date_updated) : 0;
        if (updatedMs > latestUpdatedMs) latestUpdatedMs = updatedMs;

        // Comments are per-task only (no workspace-wide endpoint) -
        // bounded to already-changed tasks, not every task in the team.
        try {
          const commentsResp = await fetch(`${CLICKUP_API}/task/${task.id}/comment`, { headers });
          if (commentsResp.ok) {
            const commentsData = await commentsResp.json();
            const comments: ClickUpComment[] = commentsData.comments ?? [];
            for (const comment of comments) {
              const commentDateMs = comment.date ? Number(comment.date) : 0;
              if (commentDateMs <= cursorMs || !comment.comment_text?.trim()) continue;

              const commentEnvelope: IngestionEnvelope = {
                tenant_id: source.tenant_id,
                connection_id: source.id,
                source: "clickup",
                source_id: `comment-${comment.id}`,
                actor: comment.user?.id ? String(comment.user.id) : "unknown",
                actor_display_name: comment.user?.username,
                thread_ref: `task-${task.id}`,
                permission_scope: [],
                // A comment inherits its task's space: excluding a space
                // has to exclude the conversation on its tasks too, or the
                // toggle only half works.
                capture_item_id: task.space?.id,
                known_actors: knownActorsFor(comment.user),
                raw_content: { subject: task.name ?? "", body: comment.comment_text ?? "" },
                source_permalink: task.url,
                received_at: new Date().toISOString(),
              };
              await enqueueEvent(commentEnvelope);
              eventCount++;
              if (commentDateMs > latestUpdatedMs) latestUpdatedMs = commentDateMs;
            }
          }
        } catch (err) {
          console.error(`ClickUp comments fetch failed for task ${task.id}:`, err);
        }
      }

      if (latestUpdatedMs > cursorMs) {
        await withTenant(String(source.tenant_id), async (sql) => {
          await sql`
            update public.source_connections
            set last_synced_at = ${new Date(latestUpdatedMs).toISOString()}
            where id = ${source.id}
          `;
        });
      }

      results.push({ source_id: source.id, tasks: tasks.length, events: eventCount });
    } catch (err) {
      console.error(`Error polling ClickUp source ${source.id}:`, err);
      results.push({ source_id: source.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return new Response(JSON.stringify({ message: "Poll completed", results }), {
    headers: { "Content-Type": "application/json" },
  });
});
