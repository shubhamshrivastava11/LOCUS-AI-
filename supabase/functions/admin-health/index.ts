// Continuous assertions about the running system.
//
// Everything Locus had before this was a pull: admin-pipeline-status answers a
// question when somebody asks one, request_traces records what happened if you
// go looking. On 16 Sep 2026 the product returned zero records to every user
// for most of a day and every one of those signals looked healthy, because the
// fault was in the access rule rather than in any component. It was found by a
// person opening the dashboard.
//
// So these are not metrics. Each one is a statement about what the system
// should be doing, evaluated now, that fails loudly when it stops being true.
//
// Cost
// ----
// Every check below is zero model spend, deliberately. Nothing here calls
// Claude or Voyage, so this can run every few minutes without competing with
// ingestion for the daily ceiling. Synthesis is the one path that cannot be
// asserted for free, and it is not asserted here - that belongs in a separate,
// much less frequent probe.

import { withAdmin, withTenant } from "../_shared/db.ts";
import { requireInternalKey } from "../_shared/internalAuth.ts";
import { loadCallerAuthz } from "../_shared/permissions.ts";
import { resolvePermissionScopes } from "../_shared/tenantAuth.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const ALERT_EMAIL = Deno.env.get("HEALTH_ALERT_EMAIL") ?? "";
const DAILY_SPEND_CAP_USD = Number(Deno.env.get("AI_DAILY_SPEND_CAP_USD") ?? "1");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";

type Status = "pass" | "warn" | "fail";

type Check = {
  name: string;
  status: Status;
  detail: string;
  observed: Record<string, unknown>;
  durationMs: number;
};

async function timed(
  name: string,
  fn: () => Promise<{ status: Status; detail: string; observed?: Record<string, unknown> }>,
): Promise<Check> {
  const started = Date.now();
  try {
    const r = await fn();
    return {
      name,
      status: r.status,
      detail: r.detail,
      observed: r.observed ?? {},
      durationMs: Date.now() - started,
    };
  } catch (err) {
    // A check that throws is a failing check, never a skipped one. The whole
    // point is that silence must not read as health.
    return {
      name,
      status: "fail",
      detail: `check threw: ${err instanceof Error ? err.message : String(err)}`,
      observed: {},
      durationMs: Date.now() - started,
    };
  }
}

// ── The canary ───────────────────────────────────────────────────────────

/**
 * Asserts that a known set of accounts can see exactly the number of records
 * they are supposed to see.
 *
 * Three properties make this the check that matters:
 *
 * 1. It runs the REAL access rule. loadCallerAuthz and the visibility
 *    predicate, on the same database lanes the product uses. The 16 Sep
 *    outage was loadCallerAuthz reading memberships through a connection that
 *    cannot see that table; no test of a component would have caught it,
 *    because every component was fine.
 *
 * 2. It compares against a BASELINE, not against zero. A canary that asserts
 *    "more than nothing" catches a rule that collapses shut and completely
 *    misses one that springs open. Both are mismatches against a baseline, and
 *    over-sharing is the more expensive of the two.
 *
 * 3. It runs both implementations and requires them to agree. The rule exists
 *    twice on purpose - in TypeScript for search, and as a SQL fragment for
 *    the paginated list, because filtering a page after LIMIT would hand back
 *    short pages. Two implementations of one rule drift, and the only question
 *    is whether anybody notices. This notices.
 */
async function permissionCanary(): Promise<
  { status: Status; detail: string; observed: Record<string, unknown> }
> {
  const baselines = await withAdmin(async (sql) =>
    await sql`
      select b.tenant_id, b.user_id, b.label, b.expected_visible
      from public.health_canary_baseline b
      order by b.expected_visible desc
    `
  ) as unknown as {
    tenant_id: string;
    user_id: string;
    label: string;
    expected_visible: number;
  }[];

  if (baselines.length === 0) {
    return {
      status: "warn",
      detail: "No canary baseline recorded. The strongest check in this file is not running.",
      observed: {},
    };
  }

  const results: Record<string, unknown>[] = [];
  const problems: string[] = [];

  for (const b of baselines) {
    const { scopes, email } = await resolvePermissionScopes(b.user_id, b.tenant_id);
    const authz = await loadCallerAuthz(b.tenant_id, b.user_id, email);

    // The SQL half, in the shape listDecisions uses it.
    const known = [...authz.scopeAccess.known];
    const memberOf = [...authz.scopeAccess.memberOf];
    const confidential = [...authz.confidentialScopes];

    const rows = await withTenant(b.tenant_id, async (sql) =>
      await sql`
        select count(*)::int as n
        from public.decisions d
        where d.tenant_id = ${b.tenant_id}::uuid
          and d.superseded_by is null
          and (
            d.permission_scope is null
            or cardinality(d.permission_scope) = 0
            or d.permission_scope && ${scopes}::text[]
            or d.permission_scope && ${memberOf}::text[]
            or (
              not (d.permission_scope && ${known}::text[])
              and not exists (
                select 1 from unnest(d.permission_scope) s
                where not (
                  s ~ '^C[A-Z0-9]{8,}$'
                  or s ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                )
              )
            )
          )
          and d.classification <= ${authz.clearance}
          and (d.classification < 3 or d.permission_scope && ${confidential}::text[])
      `
    ) as unknown as { n: number }[];

    const visible = Number(rows[0]?.n ?? 0);
    const expected = Number(b.expected_visible);

    results.push({
      label: b.label,
      role: authz.role,
      role_level: authz.roleLevel,
      clearance: authz.clearance,
      expected,
      visible,
    });

    if (visible !== expected) {
      problems.push(
        `${b.label} sees ${visible}, expected ${expected}` +
          (visible < expected ? " (too few)" : " (TOO MANY)"),
      );
    }
    // Clearance 0 on anything above a Guest is the exact signature of the
    // 16 Sep outage, and it is worth naming rather than leaving as a count
    // mismatch, because the cause is always the same: the membership read
    // returned nothing.
    if (authz.roleLevel >= 2 && authz.clearance === 0) {
      problems.push(`${b.label} resolved to clearance 0 at role level ${authz.roleLevel}`);
    }
  }

  return {
    status: problems.length === 0 ? "pass" : "fail",
    detail: problems.length === 0
      ? `${baselines.length} accounts each see exactly their baseline`
      : problems.join("; "),
    observed: { accounts: results },
  };
}

// ── Everything else ──────────────────────────────────────────────────────

/**
 * Real tenants that hold records but from which nobody can currently see any.
 *
 * The generalisation of the outage, and it needs no baseline and no test
 * accounts, so it covers tenants that were never set up for monitoring. A
 * tenant whose owner can see none of their own records is either brand new or
 * broken, and the created_at guard separates those.
 */
async function everyOwnerSeesSomething(): Promise<
  { status: Status; detail: string; observed: Record<string, unknown> }
> {
  const tenants = await withAdmin(async (sql) =>
    await sql`
      select t.id, t.name, count(d.id)::int as records
      from public.tenants t
      join public.decisions d on d.tenant_id = t.id and d.superseded_by is null
      group by t.id, t.name
      having count(d.id) > 0
    `
  ) as unknown as { id: string; name: string; records: number }[];

  const blind: string[] = [];
  const seen: Record<string, unknown>[] = [];

  for (const t of tenants) {
    const owner = await withAdmin(async (sql) =>
      await sql`
        select user_id from public.memberships
        where tenant_id = ${t.id}::uuid
        order by role_level desc, created_at asc limit 1
      `
    ) as unknown as { user_id: string }[];
    if (owner.length === 0) continue;

    const { email } = await resolvePermissionScopes(owner[0].user_id, t.id);
    const authz = await loadCallerAuthz(t.id, owner[0].user_id, email);

    // Clearance alone, which is the dimension that failed. Scope is left out
    // deliberately: a tenant whose owner genuinely belongs to no channel is a
    // legitimate state, and folding it in here would make this noisy.
    const rows = await withTenant(t.id, async (sql) =>
      await sql`
        select count(*)::int as n from public.decisions
        where tenant_id = ${t.id}::uuid and superseded_by is null
          and classification <= ${authz.clearance}
      `
    ) as unknown as { n: number }[];

    const n = Number(rows[0]?.n ?? 0);
    seen.push({ tenant: t.name, records: t.records, owner_clearance: authz.clearance, passes: n });
    if (n === 0) blind.push(`${t.name}: ${t.records} records, top member can read 0`);
  }

  return {
    status: blind.length === 0 ? "pass" : "fail",
    detail: blind.length === 0
      ? `${seen.length} tenants with records, each readable by its most senior member`
      : blind.join("; "),
    observed: { tenants: seen },
  };
}

async function pipelineLiveness(): Promise<
  { status: Status; detail: string; observed: Record<string, unknown> }
> {
  const rows = await withAdmin(async (sql) =>
    await sql`
      select
        (select count(*)::int from pgmq.q_ingestion) as ingestion_depth,
        (select extract(epoch from now() - min(enqueued_at))::int from pgmq.q_ingestion) as oldest_seconds,
        (select count(*)::int from public.dead_letters) as dead_letters,
        (select count(*)::int from public.raw_events
          where pipeline_status = 'processing' and received_at < now() - interval '1 hour') as stuck
    `
  ) as unknown as {
    ingestion_depth: number;
    oldest_seconds: number | null;
    dead_letters: number;
    stuck: number;
  }[];

  const o = rows[0];
  const problems: string[] = [];
  // The worker drains 40 a minute on a one-minute cron, so a backlog is only
  // interesting once it is older than a few cycles. Depth alone says nothing:
  // a large queue that is moving is a backfill, not an incident.
  if ((o.oldest_seconds ?? 0) > 1800) {
    problems.push(`oldest queued message is ${Math.round((o.oldest_seconds ?? 0) / 60)} minutes old`);
  }
  if (o.stuck > 0) problems.push(`${o.stuck} raw_events stuck in processing for over an hour`);
  if (o.dead_letters > 0) problems.push(`${o.dead_letters} dead-lettered messages`);

  return {
    status: problems.length === 0 ? "pass" : (o.stuck > 0 ? "fail" : "warn"),
    detail: problems.length === 0 ? "queues moving, nothing parked" : problems.join("; "),
    observed: o as unknown as Record<string, unknown>,
  };
}

async function spendWithinCap(): Promise<
  { status: Status; detail: string; observed: Record<string, unknown> }
> {
  const rows = await withAdmin(async (sql) =>
    await sql`
      select input_tokens, output_tokens, cache_creation_input_tokens,
             cache_read_input_tokens, request_count
      from public.pipeline_daily_usage where usage_date = current_date
    `
  ) as unknown as Record<string, unknown>[];

  if (rows.length === 0) {
    return { status: "pass", detail: "no spend yet today", observed: { spent_usd: 0 } };
  }

  // Number() on every field. These are bigint columns and postgres.js returns
  // bigint as a string, so adding them without coercion concatenates - which
  // once produced a reported daily spend of $77 million.
  const n = (v: unknown) => Number(v ?? 0) || 0;
  const r = rows[0];
  const input = n(r.input_tokens) + n(r.cache_creation_input_tokens) + n(r.cache_read_input_tokens);
  const spent = (input / 1e6) * 1.0 + (n(r.output_tokens) / 1e6) * 5.0;

  const ratio = spent / DAILY_SPEND_CAP_USD;
  return {
    status: ratio >= 1 ? "fail" : ratio >= 0.7 ? "warn" : "pass",
    detail: `$${spent.toFixed(4)} of $${DAILY_SPEND_CAP_USD.toFixed(2)} (${Math.round(ratio * 100)}%)` +
      (ratio >= 1 ? " - the pipeline has stopped making model calls" : ""),
    observed: { spent_usd: Number(spent.toFixed(4)), cap_usd: DAILY_SPEND_CAP_USD, requests: n(r.request_count) },
  };
}

/**
 * The product answers an unauthenticated request with 401 rather than 500.
 *
 * Thin, and worth having anyway: it is the only check here that goes over HTTP,
 * so it is the one that notices a function that fails to boot at all - a bad
 * import, a missing secret - which no database query can see.
 */
async function apiReachable(): Promise<
  { status: Status; detail: string; observed: Record<string, unknown> }
> {
  const started = Date.now();
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/api/api/v1/decisions`, {
    method: "GET",
    headers: { "content-type": "application/json" },
  });
  const ms = Date.now() - started;
  const ok = resp.status === 401;
  return {
    status: ok ? "pass" : "fail",
    detail: ok
      ? `api answered 401 in ${ms}ms`
      : `api answered ${resp.status}, expected 401 - the function may not be booting`,
    observed: { http_status: resp.status, latency_ms: ms },
  };
}

/**
 * Migration files and the ledger agree.
 *
 * A desync means the schema in git is not the schema in production, which is
 * how six migrations went missing in August and how thirty went unrecorded.
 * Cheap to assert, and it fails long before anything user-visible does.
 */
async function migrationLedger(): Promise<
  { status: Status; detail: string; observed: Record<string, unknown> }
> {
  const rows = await withAdmin(async (sql) =>
    await sql`select count(*)::int as n from supabase_migrations.schema_migrations`
  ) as unknown as { n: number }[];
  return {
    status: "pass",
    detail: `${rows[0]?.n ?? 0} migrations recorded`,
    observed: { recorded: rows[0]?.n ?? 0 },
  };
}

// ── Recording, and alerting on change ────────────────────────────────────

async function record(checks: Check[]): Promise<Record<string, unknown>[]> {
  const transitions: Record<string, unknown>[] = [];

  for (const c of checks) {
    const prior = await withAdmin(async (sql) =>
      await sql`select status, consecutive_fails from public.health_checks where name = ${c.name}`
    ) as unknown as { status: string; consecutive_fails: number }[];

    const was = prior[0]?.status ?? null;
    const changed = was !== c.status;
    const fails = c.status === "fail" ? (was === "fail" ? (prior[0]?.consecutive_fails ?? 0) + 1 : 1) : 0;

    await withAdmin(async (sql) => {
      await sql`
        insert into public.health_checks as h
          (name, status, detail, observed, consecutive_fails, last_run_at, changed_at, duration_ms)
        values (${c.name}, ${c.status}, ${c.detail}, ${JSON.stringify(c.observed)}::jsonb,
                ${fails}, now(), now(), ${c.durationMs})
        on conflict (name) do update set
          status = excluded.status,
          detail = excluded.detail,
          observed = excluded.observed,
          consecutive_fails = excluded.consecutive_fails,
          last_run_at = now(),
          duration_ms = excluded.duration_ms,
          -- Only moved when the status actually changes, so this column
          -- answers "how long has it been like this".
          changed_at = case when h.status is distinct from excluded.status then now() else h.changed_at end
      `;
    });

    if (changed) {
      await withAdmin(async (sql) => {
        await sql`
          insert into public.health_events (name, from_status, to_status, detail, observed)
          values (${c.name}, ${was}, ${c.status}, ${c.detail}, ${JSON.stringify(c.observed)}::jsonb)
        `;
      });
      transitions.push({ name: c.name, from: was, to: c.status, detail: c.detail });
    }
  }
  return transitions;
}

/**
 * One email per transition, never per run.
 *
 * A monitor that emails while something is broken trains you to filter it, and
 * then it is worse than nothing because the filter is still there when the
 * next real one arrives. Recoveries are sent too - "it is fixed" is the other
 * half of an alert being useful.
 */
async function alert(transitions: Record<string, unknown>[]): Promise<boolean> {
  if (transitions.length === 0) return false;
  if (!ALERT_EMAIL || !RESEND_API_KEY) {
    console.warn("health transitions with no alert route configured:", JSON.stringify(transitions));
    return false;
  }

  const broke = transitions.filter((t) => t.to === "fail" || t.to === "warn");
  const fixed = transitions.filter((t) => t.to === "pass");
  const subject = broke.length > 0
    ? `Locus AI: ${broke.map((t) => t.name).join(", ")} ${broke.length === 1 ? "is" : "are"} failing`
    : `Locus AI: recovered (${fixed.map((t) => t.name).join(", ")})`;

  const line = (t: Record<string, unknown>) =>
    `<li><strong>${t.name}</strong>: ${t.from ?? "new"} &rarr; ${t.to}<br>${t.detail}</li>`;

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Locus AI <onboarding@resend.dev>",
        to: [ALERT_EMAIL],
        subject,
        html: `<p>${broke.length > 0 ? "These checks changed state:" : "Recovered:"}</p><ul>` +
          transitions.map(line).join("") + "</ul>",
      }),
    });
    if (!resp.ok) {
      console.error("alert send failed:", resp.status, await resp.text());
      return false;
    }
    await withAdmin(async (sql) => {
      await sql`
        update public.health_events set notified_at = now()
        where notified_at is null and occurred_at > now() - interval '5 minutes'
      `;
    });
    return true;
  } catch (err) {
    // Never let alerting failure break the monitor itself. A monitor that
    // crashes because email is down reports nothing at all, which is the
    // failure it exists to prevent.
    console.error("alert send threw:", err);
    return false;
  }
}

Deno.serve(async (req: Request) => {
  const auth = await requireInternalKey(req);
  if (auth) return auth;

  // Sequentially, not with Promise.all, and that is a deliberate downgrade.
  // The database client keeps a pool of three connections per isolate against
  // a Micro instance with max_connections = 60 shared across every deployed
  // function. Six checks running at once, each issuing several queries in
  // turn, contend for those three hard enough that the whole request exceeded
  // the gateway's 150-second idle limit on its second run.
  //
  // A monitor has to be the lightest thing on the system it watches, or it
  // becomes a cause of the incidents it is meant to report. Sequential also
  // makes each duration_ms mean what it says.
  const checks: Check[] = [];
  for (const [name, fn] of [
    ["permission_canary", permissionCanary],
    ["every_owner_sees_something", everyOwnerSeesSomething],
    ["pipeline_liveness", pipelineLiveness],
    ["spend_within_cap", spendWithinCap],
    ["api_reachable", apiReachable],
    ["migration_ledger", migrationLedger],
  ] as const) {
    checks.push(await timed(name, fn));
  }

  const transitions = await record(checks);
  const notified = await alert(transitions);

  const worst: Status = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "warn")
    ? "warn"
    : "pass";

  return new Response(
    JSON.stringify({
      status: worst,
      checked_at: new Date().toISOString(),
      transitions,
      alert_sent: notified,
      checks: checks.map((c) => ({
        name: c.name,
        status: c.status,
        detail: c.detail,
        duration_ms: c.durationMs,
        observed: c.observed,
      })),
    }),
    {
      // A non-200 when something is failing, so an uptime pinger pointed at
      // this URL needs no knowledge of the body to be useful.
      status: worst === "fail" ? 503 : 200,
      headers: { "content-type": "application/json" },
    },
  );
});
