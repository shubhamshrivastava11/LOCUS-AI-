// Shared helpers for Slack / Notion / Gmail OAuth Edge Functions:
// - resolve tenant from /authorize?tenant_id=&access_token=
// - read tenant_id from OAuth state on /callback
// - return popup HTML that postMessages the opener and closes

import { withAdmin } from "./db.ts";
import { getServiceClient } from "./supabase.ts";

export type SourceKind = "slack" | "notion" | "gmail" | "jira" | "confluence" | "discord" | "github" | "monday" | "clickup" | "teams";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class OAuthTenantError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "OAuthTenantError";
    this.status = status;
  }
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Validate tenant_id + access_token on /authorize.
 * Verifies the Supabase Auth JWT and that the user is a member of the tenant.
 * Returns userId too (previously verified then discarded) so callers can
 * carry it through OAuth state and record who actually connected a source -
 * see createOAuthState/consumeOAuthState and source_connections.connected_by.
 */
export async function resolveTenantFromAuthorize(url: URL): Promise<{ tenantId: string; userId: string }> {
  const tenantId = url.searchParams.get("tenant_id")?.trim() ?? "";
  const accessToken = url.searchParams.get("access_token")?.trim() ?? "";

  if (!tenantId || !accessToken) {
    throw new OAuthTenantError("Missing tenant_id or access_token");
  }
  if (!isUuid(tenantId)) {
    throw new OAuthTenantError("Invalid tenant_id");
  }

  const userId = await verifyAccessToken(accessToken);
  await assertMembership(userId, tenantId);
  return { tenantId, userId };
}

async function verifyAccessToken(accessToken: string): Promise<string> {
  const supabase = getServiceClient();
  const { data, error } = await supabase.auth.getUser(accessToken);

  if (error || !data.user?.id) {
    throw new OAuthTenantError("Invalid or expired access_token", 401);
  }

  return data.user.id;
}

async function assertMembership(
  userId: string,
  tenantId: string,
): Promise<void> {
  const rows = await withAdmin(async (sql) => {
    return await sql`
      select 1
      from public.memberships
      where user_id = ${userId}::uuid
        and tenant_id = ${tenantId}::uuid
      limit 1
    `;
  });

  if (rows.length === 0) {
    throw new OAuthTenantError("User is not a member of this tenant", 403);
  }
}

const DEFAULT_FRONTEND_URL = Deno.env.get("FRONTEND_URL") ?? "http://localhost:5173";

// Comma-separated allowlist of frontend origins that are allowed to receive
// the OAuth popup redirect (Supabase secret ALLOWED_FRONTEND_ORIGINS). Every
// independent deployment (the team's shared Vercel app, a contributor's own
// fork's Vercel project, local dev) needs its origin listed here to complete
// the source-connect flow - this is a public redirect target, so an
// unvalidated caller-supplied origin would be an open redirect.
const ALLOWED_FRONTEND_ORIGINS = (Deno.env.get("ALLOWED_FRONTEND_ORIGINS") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Resolves which frontend origin the OAuth popup should redirect back to,
 * from the `redirect_origin` query param the frontend sends on /authorize
 * (see frontend/src/lib/sourceConnections.ts). Falls back to
 * FRONTEND_URL/localhost for any missing or non-allowlisted value rather
 * than failing outright, so an old cached link still lands somewhere valid.
 */
export function resolveRedirectOrigin(url: URL): string {
  const candidate = url.searchParams.get("redirect_origin")?.trim();
  if (candidate && ALLOWED_FRONTEND_ORIGINS.includes(candidate)) return candidate;
  return DEFAULT_FRONTEND_URL;
}

// "full" backfills everything a poller can see (the existing default -
// last_synced_at gets cleared so the next poll treats it as never-synced).
// "new" only picks up content from the moment of (re)connecting onward.
// Only meaningful for poll-based connectors (Notion, Gmail) - Slack is
// pure push/webhook with no backfill mechanism at all, so slack-oauth
// never reads this field even though it flows through the same state.
export type SyncMode = "full" | "new";

/**
 * Mints a single-use OAuth state handle and returns its id.
 *
 * State used to be `btoa(JSON.stringify({t, u, o}))` - unsigned, so anyone
 * could write one, and parseTenantState additionally accepted a BARE TENANT
 * UUID, so `?state=<tenant-uuid>` was enough. /authorize verifies the access
 * token and asserts membership, but none of that mattered: an attacker just
 * never visited /authorize, completed the provider flow with their own
 * account, and handed back a state naming somebody else's tenant. The
 * connection - their credentials, their cursor_state - landed in that
 * workspace.
 *
 * The handle now carries no information at all. It is a random uuid whose
 * meaning lives in public.oauth_states, so it cannot be forged, read, or
 * edited by whoever holds it.
 */
export async function createOAuthState(
  tenantId: string,
  userId: string,
  source: string,
  redirectOrigin: string,
  syncMode?: SyncMode,
): Promise<string> {
  return await withAdmin(async (sql) => {
    // Opportunistic sweep, so this needs no cron of its own. An hour is well
    // past the 15-minute consume window; anything older is abandoned.
    await sql`DELETE FROM public.oauth_states WHERE created_at < now() - interval '1 hour'`;

    const rows = await sql`
      INSERT INTO public.oauth_states (tenant_id, user_id, source, redirect_origin, sync_mode)
      VALUES (
        ${tenantId}::uuid,
        ${userId || null}::uuid,
        ${source},
        ${redirectOrigin},
        ${syncMode === "new" ? "new" : "full"}
      )
      RETURNING id
    ` as unknown as { id: string }[];
    return rows[0].id;
  });
}

/**
 * Redeems a state handle exactly once, or throws.
 *
 * Single-use by construction rather than by a check-then-act: the UPDATE's
 * own WHERE clause is the guard, so two callbacks racing the same handle
 * cannot both succeed - one updates the row, the other matches nothing.
 *
 * `source` is re-checked, so a handle minted for one provider is not
 * redeemable at another's callback. Membership is re-asserted too: the state
 * proves the flow started legitimately, not that the person is still entitled
 * to the tenant by the time the provider redirects back.
 */
export async function consumeOAuthState(
  state: string | null,
  source: string,
): Promise<{ tenantId: string; userId: string; redirectOrigin: string; syncMode: SyncMode }> {
  if (!state || !isUuid(state.trim())) {
    throw new OAuthTenantError("Missing or invalid OAuth state");
  }

  const rows = await withAdmin(async (sql) => {
    return await sql`
      UPDATE public.oauth_states
      SET consumed_at = now()
      WHERE id = ${state.trim()}::uuid
        AND source = ${source}
        AND consumed_at IS NULL
        AND created_at > now() - interval '15 minutes'
      RETURNING tenant_id, user_id, redirect_origin, sync_mode
    ` as unknown as {
      tenant_id: string;
      user_id: string | null;
      redirect_origin: string;
      sync_mode: string;
    }[];
  });

  if (rows.length === 0) {
    // Deliberately one message for every cause - unknown, already used,
    // expired, wrong provider. Telling the caller which would let them probe.
    throw new OAuthTenantError("OAuth state is invalid, expired, or already used");
  }

  const row = rows[0];
  const userId = row.user_id ?? "";
  if (userId) {
    await assertMembership(userId, row.tenant_id);
  }

  // Re-validated rather than trusted: the allowlist may have changed since
  // the state was minted, and this value is a redirect target.
  const redirectOrigin = ALLOWED_FRONTEND_ORIGINS.includes(row.redirect_origin)
    ? row.redirect_origin
    : DEFAULT_FRONTEND_URL;

  return {
    tenantId: row.tenant_id,
    userId,
    redirectOrigin,
    syncMode: row.sync_mode === "new" ? "new" : "full",
  };
}

/**
 * Redirects the OAuth popup back to a page on the frontend's own origin,
 * which reads the query params and does the postMessage(opener) + close().
 *
 * Supabase Edge Functions on the default *.supabase.co domain cannot serve
 * HTML at all — the gateway unconditionally rewrites any text/html response
 * to text/plain (confirmed live: the Response object here can set whatever
 * Content-Type it wants, the platform overrides it regardless), so an
 * inline <script> never executes and the popup never closes itself. This
 * redirects to the caller's own origin instead (resolved via
 * resolveRedirectOrigin/parseTenantState against ALLOWED_FRONTEND_ORIGINS),
 * where the page is a normal SPA route with no such restriction.
 */
export function popupCallbackResponse(
  source: SourceKind,
  options: { success: boolean; error?: string; status?: number },
  redirectOrigin: string = DEFAULT_FRONTEND_URL,
): Response {
  const redirectUrl = new URL("/oauth/source-callback", redirectOrigin);
  redirectUrl.searchParams.set("source", source);
  redirectUrl.searchParams.set("success", String(options.success));
  if (options.error) redirectUrl.searchParams.set("error", options.error);

  return Response.redirect(redirectUrl.toString(), 302);
}

export function authorizeErrorResponse(
  source: SourceKind,
  err: unknown,
  redirectOrigin: string = DEFAULT_FRONTEND_URL,
): Response {
  if (err instanceof OAuthTenantError) {
    return popupCallbackResponse(source, {
      success: false,
      error: err.message,
      status: err.status,
    }, redirectOrigin);
  }

  const message = err instanceof Error ? err.message : String(err);
  return popupCallbackResponse(source, {
    success: false,
    error: message,
    status: 500,
  }, redirectOrigin);
}
