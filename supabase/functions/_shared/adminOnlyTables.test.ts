// Guards the class of bug that took production down on 16 Sep 2026.
//
// Locus reads its database on two lanes. withTenant() connects as locus_app,
// which is not BYPASSRLS and is governed by row-level security. withAdmin()
// connects as postgres and is not. Most tenant tables carry a
// tenant_isolation_* policy granted to `public`, so the locus_app lane can read
// them with the tenant GUC pinned - that is the normal path and the safe one.
//
// A handful of tables have RLS enabled and forced with NO policy applicable to
// that lane, either deliberately (operational tables with no tenant to scope
// to) or because their only policy targets the `authenticated` role for
// PostgREST. Reading one of those through withTenant does not error. It
// returns zero rows, silently, for every caller, always.
//
// That is what happened: loadCallerAuthz read public.memberships through
// withTenant, got nothing, resolved every caller to role level 0, and clearance
// 0 hides every record at Internal - which is the default classification. The
// whole product returned zero decisions to everyone for most of a day while
// every component reported healthy.
//
// The unit tests could not catch it because they were pure and the fault was
// which connection the query used. This test reads the source instead.
//
// The list below is derived, not guessed - it is every table in public with
// RLS enabled and no policy granted to `public`:
//
//   select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
//   where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
//     and not exists (
//       select 1 from pg_policies p
//       where p.schemaname = 'public' and p.tablename = c.relname
//         and 'public' = any(p.roles));
//
// Re-run that after any migration that adds a table or changes a policy. A
// table that gains a `public` policy can be removed from here; one that loses
// it must be added, or this test stops protecting it.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ADMIN_ONLY_TABLES = [
  "capture_source_rules",
  "early_access_allowlist",
  "health_canary_baseline",
  "health_checks",
  "health_events",
  "invites",
  "loci_conversations",
  "loci_daily_usage",
  "loci_rate_limits",
  "memberships",
  "oauth_states",
  "oauth_tokens",
  "pipeline_daily_usage",
  "search_history",
  "user_limits",
  "user_search_preferences",
];

/**
 * Every `withTenant(` region in a file, by balancing parentheses from the
 * opening one.
 *
 * Deliberately crude. A real parse would be more precise and much more code,
 * and the failure mode of crudeness here is a false positive - a loud, cheap,
 * five-second problem - rather than a missed one.
 */
function withTenantRegions(source: string): string[] {
  const regions: string[] = [];
  let index = source.indexOf("withTenant(");
  while (index !== -1) {
    let depth = 0;
    let i = index + "withTenant".length;
    const start = i;
    for (; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    regions.push(source.slice(start, i));
    index = source.indexOf("withTenant(", i);
  }
  return regions;
}

async function functionSources(): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  for await (const entry of Deno.readDir("supabase/functions")) {
    if (!entry.isDirectory) continue;
    const dir = `supabase/functions/${entry.name}`;
    for await (const file of Deno.readDir(dir)) {
      if (!file.isFile || !file.name.endsWith(".ts")) continue;
      if (file.name.endsWith(".test.ts")) continue;
      const path = `${dir}/${file.name}`;
      out.push({ path, text: await Deno.readTextFile(path) });
    }
  }
  return out;
}

Deno.test("no withTenant block reads a table the locus_app lane cannot see", async () => {
  const offenders: string[] = [];

  for (const { path, text } of await functionSources()) {
    for (const region of withTenantRegions(text)) {
      for (const table of ADMIN_ONLY_TABLES) {
        // Matches `public.memberships` and a bare `from memberships`, but not
        // `source_scope_members` or any other name that merely contains one.
        const pattern = new RegExp(`(?:public\\.|from\\s+|join\\s+|into\\s+|update\\s+)${table}\\b`, "i");
        if (pattern.test(region)) {
          offenders.push(
            `${path}: reads public.${table} inside withTenant - that lane sees zero rows. Use withAdmin.`,
          );
        }
      }
    }
  }

  assertEquals(offenders, [], "\n" + offenders.join("\n") + "\n");
});

Deno.test("the guard actually catches the bug it was written for", async () => {
  // Without this, a regex that silently stopped matching would leave the test
  // above passing forever while protecting nothing.
  const bug = `
    const membership = await withTenant(tenantId, async (sql) => {
      const rows = await sql\`select role from public.memberships where user_id = \${userId}\`;
      return rows[0] ?? null;
    });
  `;
  const regions = withTenantRegions(bug);
  assertEquals(regions.length, 1);
  assertEquals(/(?:public\.|from\s+)memberships\b/i.test(regions[0]), true);

  // And the correct form is not flagged.
  const fixed = bug.replace("withTenant(tenantId, ", "withAdmin(");
  assertEquals(withTenantRegions(fixed).length, 0);
});
