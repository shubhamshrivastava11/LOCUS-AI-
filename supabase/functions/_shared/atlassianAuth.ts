// supabase/functions/_shared/atlassianAuth.ts
//
// Shared by jira-poller and confluence-poller (both connect through the
// same Atlassian OAuth app - see jira-oauth/index.ts's header comment).
// Atlassian access tokens expire in ~1h, unlike Notion's (which never
// expire) - a poller running on any real interval needs to refresh
// before every call, not just react to a 401 after the fact, since the
// token could expire mid-poll-cycle for a tenant with many issues/pages.
//
// Atlassian ALWAYS rotates the refresh_token on every use (the old one
// stops working the moment a new one is issued) - the new one from every
// response gets stored back, never the one this call started with.

import { withTenant } from "./db.ts";
import { encryptToken } from "./tokenCrypto.ts";
import { encryptedRefreshTokenFields, readRefreshToken } from "./refreshToken.ts";

const CLIENT_ID = Deno.env.get("ATLASSIAN_CLIENT_ID");
const CLIENT_SECRET = Deno.env.get("ATLASSIAN_CLIENT_SECRET");

export interface AtlassianConnection {
  id: string;
  tenant_id: string;
  oauth_token_ref: string | null;
  cursor_state: { refresh_token?: string | null; cloud_id?: string; site_url?: string } | null;
}

/**
 * Refreshes an Atlassian connection's access token unconditionally (not
 * gated on an expiry check - the poller calls this once per connection
 * per run, cheap compared to the alternative of tracking exact expiry
 * timestamps and still needing a fallback for clock drift). Returns the
 * fresh access token and cloud_id needed for every subsequent API call
 * this run. Returns null and marks the connection 'error' if the refresh
 * itself fails (refresh_token revoked/expired - the user needs to
 * reconnect, nothing this function can recover from).
 */
export async function refreshAtlassianAccess(
  connection: AtlassianConnection,
): Promise<{ accessToken: string; cloudId: string } | null> {
  // Reads the encrypted copy, converting a legacy plaintext one in place on
  // the way past - see refreshToken.ts.
  const refreshToken = await readRefreshToken(connection.id, connection.cursor_state);
  const cloudId = connection.cursor_state?.cloud_id;
  if (!refreshToken || !cloudId) {
    console.error(`Connection ${connection.id} missing refresh_token or cloud_id in cursor_state`);
    return null;
  }

  try {
    const resp = await fetch("https://auth.atlassian.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: refreshToken,
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.access_token) {
      console.error(`Atlassian token refresh failed for connection ${connection.id}:`, JSON.stringify(data));
      await withTenant(connection.tenant_id, async (sql) => {
        await sql`UPDATE public.source_connections SET status = 'error' WHERE id = ${connection.id}`;
      });
      return null;
    }

    const encryptedToken = await encryptToken(data.access_token);
    await withTenant(connection.tenant_id, async (sql) => {
      await sql`
        UPDATE public.source_connections
        SET oauth_token_ref = ${encryptedToken},
            cursor_state = ${sql.json({
              ...connection.cursor_state,
              // Always the NEW refresh_token - the old one is now dead,
              // storing it back would break the next refresh cycle. Written
              // encrypted, and this clears any plaintext left on the row.
              ...(await encryptedRefreshTokenFields(data.refresh_token ?? refreshToken)),
            })}
        WHERE id = ${connection.id}
      `;
    });

    return { accessToken: data.access_token, cloudId };
  } catch (err) {
    console.error(`Atlassian token refresh threw for connection ${connection.id}:`, err);
    return null;
  }
}

