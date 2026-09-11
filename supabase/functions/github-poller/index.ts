// supabase/functions/github-poller/index.ts
//
// Polls every active GitHub source_connection - each row is one
// installation (see github-oauth/index.ts's header for why there's no
// per-tenant token here). Same bounded-concurrency + per-repo
// incremental cursor persistence shape as discord-poller, applying the
// same real lesson learned there rather than waiting to relearn it: an
// installation with many repos could exceed Supabase's function timeout,
// and only persisting cursors in one batch at the end would lose every
// repo's progress, not just the unfinished one.
//
// Two content sources per repo, both using GitHub's own `since=<ISO8601>`
// cursor (unlike Discord's snowflake-id pagination, which has no such
// concept):
// 1. GET /repos/{owner}/{repo}/issues?since=...&state=all - newly
//    created/updated issues AND pull requests (GitHub's issues endpoint
//    returns both; a PR carries its own `pull_request` key, kept here
//    only to label the subject line, not to filter anything out).
// 2. GET /repos/{owner}/{repo}/issues/comments?since=... - every comment
//    across every issue/PR in the repo in one call, sorted by update
//    time. Deliberately not polling comments per-issue (would be N+1
//    requests per repo, one per issue) - this repo-wide endpoint is the
//    efficient path GitHub itself provides for exactly this.
//
// thread_ref is `owner/repo#number` - one real issue/PR conversation,
// the same tight-scope precedent as Jira's issue.key, not Discord's
// mistake of scoping to an entire channel (see api/index.ts's
// buildThreadContext header for that story).
//
// permission_scope is left empty (repo-wide visible, not per-repo) for
// the same reason as Discord: no real GitHub team/collaborator
// membership sync exists yet. A disclosed v1 simplification, not an
// oversight.
//
// Same known limitation as every other poller inherits from raw_events'
// (tenant_id, source, source_id) uniqueness: an issue/comment edited
// again after its first capture won't be re-ingested.

import { withAdmin, withTenant } from "../_shared/db.ts";
import { enqueueEvent, IngestionEnvelope } from "../_shared/queue.ts";
import { githubApiHeaders, mintInstallationToken } from "../_shared/githubAuth.ts";

console.log("GitHub poller started!");

const REQUEST_TIMEOUT_MS = 20_000;
const CONCURRENCY_LIMIT = 4;
const PER_PAGE = 50;

async function fetchWithTimeout(url: string | URL, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface GithubUser {
  login?: string;
  id?: number;
}
interface GithubIssue {
  id: number;
  number: number;
  title?: string;
  body?: string | null;
  updated_at: string;
  user?: GithubUser;
  html_url?: string;
  pull_request?: unknown;
}
interface GithubComment {
  id: number;
  body?: string | null;
  updated_at: string;
  user?: GithubUser;
  html_url?: string;
  issue_url?: string;
}
interface GithubRepo {
  full_name: string;
}

function knownActorsFor(user: GithubUser | undefined): { name: string; source_actor_id: string }[] {
  return user?.id && user.login ? [{ name: user.login, source_actor_id: String(user.id) }] : [];
}

Deno.serve(async (_req) => {
  const sources = await withAdmin(async (sql) => {
    return await sql`
      select *
      from public.source_connections
      where source = 'github'
        and status = 'active'
        and ingestion_mode = 'polling'
    `;
  });

  const results = [];

  for (const source of sources) {
    try {
      const installationId = source.cursor_state?.installation_id;
      if (!installationId) {
        results.push({ source_id: source.id, error: "missing installation_id" });
        continue;
      }

      const token = await mintInstallationToken(String(installationId));
      const headers = githubApiHeaders(token);

      const reposResp = await fetchWithTimeout(
        "https://api.github.com/installation/repositories",
        { headers },
        REQUEST_TIMEOUT_MS,
      );
      if (!reposResp.ok) {
        results.push({ source_id: source.id, error: `repos failed: ${reposResp.status} ${await reposResp.text()}` });
        continue;
      }
      const reposData = await reposResp.json();
      const repos: GithubRepo[] = reposData.repositories ?? [];

      const repoCursors: Record<string, string> = { ...(source.cursor_state?.repo_cursors ?? {}) };
      let totalEvents = 0;

      let nextIndex = 0;
      async function processRepo(repo: GithubRepo): Promise<void> {
        const since = repoCursors[repo.full_name] || new Date(0).toISOString();
        let latestSeen = since;

        const issuesUrl = new URL(`https://api.github.com/repos/${repo.full_name}/issues`);
        issuesUrl.searchParams.set("since", since);
        issuesUrl.searchParams.set("state", "all");
        issuesUrl.searchParams.set("sort", "updated");
        issuesUrl.searchParams.set("direction", "asc");
        issuesUrl.searchParams.set("per_page", String(PER_PAGE));

        const issuesResp = await fetchWithTimeout(issuesUrl, { headers }, REQUEST_TIMEOUT_MS);
        if (issuesResp.ok) {
          const issues: GithubIssue[] = await issuesResp.json();
          for (const issue of issues) {
            if (!issue.body || !issue.body.trim()) continue;
            const kind = issue.pull_request ? "PR" : "Issue";
            const envelope: IngestionEnvelope = {
              tenant_id: source.tenant_id,
              connection_id: source.id,
              source: "github",
              source_id: `issue-${issue.id}`,
              actor: issue.user?.id ? String(issue.user.id) : "unknown",
              actor_display_name: issue.user?.login,
              thread_ref: `${repo.full_name}#${issue.number}`,
              permission_scope: [],
              // Build Memory's toggle key for this source (see
              // capture_item_id in _shared/queue.ts).
              capture_item_id: repo.full_name,
              known_actors: knownActorsFor(issue.user),
              raw_content: {
                subject: `${repo.full_name} #${issue.number}: ${kind} - ${issue.title ?? ""}`,
                body: issue.body,
              },
              source_permalink: issue.html_url,
              received_at: new Date().toISOString(),
            };
            await enqueueEvent(envelope);
            totalEvents++;
            if (issue.updated_at > latestSeen) latestSeen = issue.updated_at;
          }
        } else {
          console.error(`GitHub issues fetch failed for ${repo.full_name}:`, await issuesResp.text());
        }

        const commentsUrl = new URL(`https://api.github.com/repos/${repo.full_name}/issues/comments`);
        commentsUrl.searchParams.set("since", since);
        commentsUrl.searchParams.set("sort", "updated");
        commentsUrl.searchParams.set("direction", "asc");
        commentsUrl.searchParams.set("per_page", String(PER_PAGE));

        const commentsResp = await fetchWithTimeout(commentsUrl, { headers }, REQUEST_TIMEOUT_MS);
        if (commentsResp.ok) {
          const comments: GithubComment[] = await commentsResp.json();
          for (const comment of comments) {
            if (!comment.body || !comment.body.trim()) continue;
            const issueNumberMatch = comment.issue_url?.match(/\/issues\/(\d+)$/);
            const issueNumber = issueNumberMatch ? issueNumberMatch[1] : "?";
            const envelope: IngestionEnvelope = {
              tenant_id: source.tenant_id,
              connection_id: source.id,
              source: "github",
              source_id: `comment-${comment.id}`,
              actor: comment.user?.id ? String(comment.user.id) : "unknown",
              actor_display_name: comment.user?.login,
              thread_ref: `${repo.full_name}#${issueNumber}`,
              permission_scope: [],
              // Build Memory's toggle key for this source (see
              // capture_item_id in _shared/queue.ts).
              capture_item_id: repo.full_name,
              known_actors: knownActorsFor(comment.user),
              raw_content: {
                subject: `${repo.full_name} #${issueNumber}`,
                body: comment.body,
              },
              source_permalink: comment.html_url,
              received_at: new Date().toISOString(),
            };
            await enqueueEvent(envelope);
            totalEvents++;
            if (comment.updated_at > latestSeen) latestSeen = comment.updated_at;
          }
        } else {
          console.error(`GitHub comments fetch failed for ${repo.full_name}:`, await commentsResp.text());
        }

        repoCursors[repo.full_name] = latestSeen;

        // Per-repo incremental persistence - the real fix learned from
        // discord-poller's live 150s-timeout bug, applied here from the
        // start instead of waiting to hit the same failure mode again.
        await withTenant(String(source.tenant_id), async (sql) => {
          await sql`
            update public.source_connections
            set cursor_state = jsonb_set(coalesce(cursor_state, '{}'::jsonb), '{repo_cursors}', ${sql.json(repoCursors)})
            where id = ${source.id}
          `;
        });
      }

      async function worker(): Promise<void> {
        while (nextIndex < repos.length) {
          const repo = repos[nextIndex++];
          await processRepo(repo);
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY_LIMIT, repos.length) }, () => worker()),
      );

      results.push({ source_id: source.id, repos: repos.length, events: totalEvents });
    } catch (err) {
      console.error(`Error polling GitHub source ${source.id}:`, err);
      results.push({ source_id: source.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return new Response(JSON.stringify({ message: "Poll completed", results }), {
    headers: { "Content-Type": "application/json" },
  });
});
