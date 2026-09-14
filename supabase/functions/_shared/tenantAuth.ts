// supabase/functions/_shared/tenantAuth.ts
//
// Extracted out of api/index.ts (verifyTenantJwt/getCurrentTenant/
// resolvePermissionScopes lived only there) so memory-api's real-user-facing
// endpoints (Memory Timeline fetch, evidence drawer) authenticate the exact
// same way the live app already does - the app-issued tenant JWT from
// POST /auth/session, not a second auth scheme. A logged-in user's existing
// session token just works against memory-api with no new login flow.

import * as jose from "npm:jose@5";
import { withAdmin, withTenant } from "./db.ts";

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set - add it to Edge Function secrets`);
  return value;
}

const TENANT_JWT_ISSUER = "locus-ai";

export type TenantContext = { userId: string; tenantId: string; role: string };

export async function verifyTenantJwt(token: string): Promise<TenantContext> {
  const secret = new TextEncoder().encode(requireEnv("APP_SECRET_KEY"));
  const { payload } = await jose.jwtVerify(token, secret, { issuer: TENANT_JWT_ISSUER });
  if (!payload.tenant_id) throw new Error("JWT missing tenant_id claim");
  return {
    userId: String(payload.sub),
    tenantId: String(payload.tenant_id),
    role: String(payload.role ?? "member"),
  };
}

/**
 * Confirms the user is STILL a member of the tenant their token names.
 *
 * Tenant JWTs live 24 hours and carry tenant_id as a claim, so until now
 * removing somebody from a workspace did nothing to the token already in their
 * browser - team-invites deleted the membership row and they kept working for
 * up to a day on every route whose only authorization was tenant scope.
 *
 * A shorter TTL would have narrowed the window without closing it. This closes
 * it: one indexed lookup on (user_id, tenant_id), which is cheap next to the
 * work any of these routes goes on to do.
 */
export async function assertStillAMember(userId: string, tenantId: string): Promise<void> {
  const rows = await withAdmin(async (sql) => {
    return await sql`
      SELECT 1 FROM public.memberships
      WHERE user_id = ${userId}::uuid AND tenant_id = ${tenantId}::uuid
      LIMIT 1
    `;
  });
  if (rows.length === 0) {
    throw new Error("No longer a member of this workspace");
  }
}

export async function getCurrentTenant(req: Request): Promise<TenantContext> {
  const header = req.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error("Missing Authorization: Bearer token");
  const ctx = await verifyTenantJwt(match[1]);
  // The signature proves the token was issued to this person for this tenant.
  // It does not prove they are still in it.
  await assertStillAMember(ctx.userId, ctx.tenantId);
  return ctx;
}

/**
 * Same resolution api/index.ts's live /search and /digest already use:
 * every workspace this tenant has an active connector for, plus the
 * caller's own login email. Deliberately UNCHANGED here - the new memory
 * layer's fail-closed behavior lives in isMemoryAccessible() checking
 * source_scope_members, not in this function. This still only ever
 * returns workspace-level scopes and an email, never a real per-channel/
 * per-page membership - that's exactly the gap isMemoryAccessible closes
 * for the new layer, and what the separate live-isDecisionAccessible
 * retrofit closes for this one, once real membership data exists.
 */
/**
 * Sources that belong to ONE PERSON, not to the workspace.
 *
 * Slack, Notion, Jira, Teams and the rest are shared org resources: every
 * member of the workspace is expected to see them. A Gmail mailbox is not -
 * it is somebody's private correspondence, and the fact that they connected
 * it to a team workspace does not make it team property.
 *
 * Confirmed live before this existed: source_connections.external_workspace_id
 * for Gmail is literally the email address, and the query below handed every
 * member of a tenant every active connection's workspace id regardless of who
 * connected it. On a team plan that made one person's inbox readable by the
 * whole team.
 */
export const PERSONAL_SOURCES = ["gmail"] as const;

/**
 * `excludePersonalSources` drops personal-source scopes ENTIRELY, including
 * the caller's own, rather than the usual "everyone else's but mine".
 *
 * That distinction is the whole fix for the team digest. Normally a caller
 * should see their own Gmail; but content retrieved under one member's scopes
 * used to be written into a tenant-wide cache keyed (tenant_id, week_of) with
 * user_id NULL, and handed to every other member. The first person to open
 * Team Pulse published their own inbox to the team.
 *
 * A shared artefact has to be built only from what every recipient may see, so
 * the team path resolves scopes as though nobody had a personal source
 * connected at all. The email is withheld for the same reason: Gmail's
 * external_workspace_id IS the address, so returning it would put the scope
 * back by another route.
 */
/**
 * Narrows a set of record ids to those the caller may see under the
 * personal-source rule, dropping any that originate from somebody ELSE's
 * personal connection.
 *
 * Exists because the same predicate was written inline in api/index.ts's
 * listDecisions and getDecisionById and nowhere else, so every other route
 * that returns records - MCP, the export - simply did not have it. One
 * implementation, reusable, is the only way that stops drifting apart again.
 *
 * Same carve-out as the original: a connection predating connected_by cannot
 * be attributed to anyone, so its records stay visible rather than being
 * hidden from their own owner.
 */
export async function visibleRecordIds(
  tenantId: string,
  userId: string,
  recordIds: string[],
): Promise<Set<string>> {
  if (recordIds.length === 0) return new Set();
  const rows = await withAdmin(async (sql) => {
    return await sql`
      SELECT d.id
      FROM public.decisions d
      WHERE d.tenant_id = ${tenantId}::uuid
        AND d.id = ANY(${recordIds}::uuid[])
        AND NOT EXISTS (
          SELECT 1
          FROM public.raw_events pre
          JOIN public.source_connections psc
            ON psc.id = pre.connection_id AND psc.tenant_id = pre.tenant_id
          WHERE pre.id = d.origin_raw_event_id
            AND pre.tenant_id = d.tenant_id
            AND psc.source = ANY(${[...PERSONAL_SOURCES]}::text[])
            AND psc.connected_by IS NOT NULL
            AND psc.connected_by <> ${userId}::uuid
        )
    ` as unknown as { id: string }[];
  });
  return new Set(rows.map((r) => r.id));
}

export async function resolvePermissionScopes(
  userId: string, tenantId: string,
  options: { excludePersonalSources?: boolean } = {},
): Promise<{ scopes: string[]; email: string | null }> {
  const excludePersonal = options.excludePersonalSources === true;
  // Two separate connections (admin pool vs tenant pool) - genuinely
  // independent, safe to run concurrently rather than paying both
  // round-trip latencies back to back.
  const [email, connectedScopes] = await Promise.all([
    excludePersonal ? Promise.resolve(null) : withAdmin(async (sql) => {
      const rows = await sql`SELECT email FROM auth.users WHERE id = ${userId}`;
      return rows[0]?.email ?? null;
    }),
    withTenant(tenantId, async (sql) => {
      const rows = await sql`
        SELECT DISTINCT external_workspace_id FROM public.source_connections
        WHERE tenant_id = ${tenantId} AND status = 'active' AND external_workspace_id IS NOT NULL
          AND (
            source <> ALL(${[...PERSONAL_SOURCES]}::text[])
            -- On the shared path the OR branches below are skipped entirely,
            -- so no personal source qualifies for any reason.
            OR (${!excludePersonal}
            -- Rows predating connected_by cannot be attributed to anyone.
            -- Left visible deliberately: excluding them would hide their
            -- own owner's mail from them, which is a worse failure than
            -- the leak it would prevent. Confirmed against live data that
            -- every such row today sits in a single-member tenant, so this
            -- carve-out currently exposes nothing.
            AND (connected_by IS NULL OR connected_by = ${userId}::uuid))
          )
      `;
      return rows.map((r) => r.external_workspace_id as string);
    }),
  ]);

  const scopes = new Set<string>(connectedScopes);
  if (email) scopes.add(email);
  // Email returned alongside, not just folded into the set: the caller's
  // own address is the identifier source_scope_members matches on, and
  // there's no way to pick it back out of the flattened scope list.
  return { scopes: [...scopes], email };
}
