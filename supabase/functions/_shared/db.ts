// supabase/functions/_shared/db.ts
//
// Postgres access for Edge Functions that must obey row-level security.
// Mirrors backend database/tenant_context.py:
//   APP_DATABASE_URL  → locus_app (non-bypass) + set app.current_tenant_id
//   DATABASE_URL      → postgres (admin / cross-tenant lookup)
//
// Prefer this over getServiceClient() for public.* tenant table reads/writes.
// Keep getServiceClient() only where PostgREST service_role is still required
// (e.g. enqueue RPC until callers move fully to SQL).
//
// ── Connection reuse ────────────────────────────────────────────────────
// These clients are module-level singletons, created once per isolate and
// deliberately NEVER closed. The previous version opened a brand-new
// connection inside every withTenant()/withAdmin() call and ended it in a
// finally block, which meant a full TCP + TLS + auth handshake per query
// group. Real measurement from public.request_traces showed what that
// costs: a /search opens ~8 of them, and its "authorize" stage - a single
// indexed lookup returning at most a handful of rows from a 63-row table -
// took 2,708ms. The query is sub-millisecond; that time was almost
// entirely connection setup.
//
// Safe to share a pooled connection across requests because the tenant GUC
// is transaction-local: withTenant sets it with set_config(..., true)
// inside sql.begin(), so it is scoped to that transaction and cannot leak
// into another request that later borrows the same physical connection.
// withAdmin sets no GUC at all. This property is what makes pooling
// correct here - do not set app.current_tenant_id outside a transaction.

import postgres from "npm:postgres@3.4.5";

type Sql = ReturnType<typeof postgres>;

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`${name} is not set — add it to Edge Function secrets`);
  }
  return value;
}

// Kept small on purpose. The database is on a Micro instance with
// max_connections = 60 shared across every deployed function, so a large
// per-isolate pool would trade one failure mode (slow) for a worse one
// (connection exhaustion, which fails closed rather than degrading).
const POOL_MAX = 3;
const IDLE_TIMEOUT_SECONDS = 30;

function createSql(url: string): Sql {
  // prepare: false required for Supabase transaction-mode pooler
  return postgres(url, {
    prepare: false,
    max: POOL_MAX,
    idle_timeout: IDLE_TIMEOUT_SECONDS,
    connect_timeout: 10,
  });
}

let appSql: Sql | null = null;
let adminSql: Sql | null = null;

function getAppSql(): Sql {
  if (!appSql) appSql = createSql(requireEnv("APP_DATABASE_URL"));
  return appSql;
}

function getAdminSql(): Sql {
  if (!adminSql) {
    const url = Deno.env.get("DATABASE_URL") ?? Deno.env.get("SUPABASE_DB_URL");
    if (!url) {
      throw new Error(
        "DATABASE_URL or SUPABASE_DB_URL is not set — add it to Edge Function secrets",
      );
    }
    adminSql = createSql(url);
  }
  return adminSql;
}

/**
 * Run work as locus_app with app.current_tenant_id bound for this transaction.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (sql: Sql) => Promise<T>,
): Promise<T> {
  const sql = getAppSql();
  return await sql.begin(async (tx) => {
    await tx`select set_config('app.current_tenant_id', ${tenantId}, true)`;
    return await fn(tx as unknown as Sql);
  }) as T;
}

/**
 * Run work as DATABASE_URL (postgres / bypass).
 * Use only for cross-tenant scans or lookups before tenant_id is known.
 */
export async function withAdmin<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  return await fn(getAdminSql());
}
