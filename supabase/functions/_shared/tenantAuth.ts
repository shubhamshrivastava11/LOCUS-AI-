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

export async function getCurrentTenant(req: Request): Promise<TenantContext> {
  const header = req.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error("Missing Authorization: Bearer token");
  return await verifyTenantJwt(match[1]);
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

export async function resolvePermissionScopes(
  userId: string, tenantId: string,
): Promise<{ scopes: string[]; email: string | null }> {
  // Two separate connections (admin pool vs tenant pool) - genuinely
  // independent, safe to run concurrently rather than paying both
  // round-trip latencies back to back.
  const [email, connectedScopes] = await Promise.all([
    withAdmin(async (sql) => {
      const rows = await sql`SELECT email FROM auth.users WHERE id = ${userId}`;
      return rows[0]?.email ?? null;
    }),
    withTenant(tenantId, async (sql) => {
      const rows = await sql`
        SELECT DISTINCT external_workspace_id FROM public.source_connections
        WHERE tenant_id = ${tenantId} AND status = 'active' AND external_workspace_id IS NOT NULL
          AND (
            source <> ALL(${[...PERSONAL_SOURCES]}::text[])
            -- Rows predating connected_by cannot be attributed to anyone.
            -- Left visible deliberately: excluding them would hide their
            -- own owner's mail from them, which is a worse failure than
            -- the leak it would prevent. Confirmed against live data that
            -- every such row today sits in a single-member tenant, so this
            -- carve-out currently exposes nothing.
            OR connected_by IS NULL
            OR connected_by = ${userId}::uuid
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
