// Keeps OAuth refresh tokens encrypted at rest, and migrates the plaintext
// ones already stored.
//
// Finding 10 of the 14 Sep 2026 review, confirmed live: five connections -
// three Gmail, one Jira, one Confluence - held their refresh_token as plain
// text inside source_connections.cursor_state. The access token beside it was
// encrypted the whole time; only the longer-lived credential was not.
//
// It mattered because source_connections carries a SELECT policy for the
// authenticated role. The frontend only asks for a fixed column list that
// excludes cursor_state, but RLS is row-level, not column-level, so any
// signed-in member could have read the whole row - including a Google refresh
// token, which does not expire on its own.
//
// Migration is lazy rather than a one-off backfill script. encryptToken needs
// OAUTH_TOKEN_ENCRYPTION_KEY, which only exists inside an Edge Function, so a
// SQL backfill could not do it anyway - and every one of these connections
// refreshes on a five-minute poll, so reading through this helper converts
// them all within one cycle, with no extra tooling to write, run, and then
// remember to delete.

import { decryptToken, encryptToken } from "./tokenCrypto.ts";
import { withAdmin } from "./db.ts";

/**
 * Builds the cursor_state fragment for a refresh token, encrypted.
 *
 * Spread into the object a connector writes at connect time. It deliberately
 * also sets refresh_token to null, so a reconnect over a row that still holds
 * a plaintext value clears it rather than leaving both.
 */
export async function encryptedRefreshTokenFields(
  token: string | null | undefined,
): Promise<{ refresh_token_enc: string | null; refresh_token: null }> {
  return {
    refresh_token_enc: token ? await encryptToken(token) : null,
    refresh_token: null,
  };
}

/**
 * Returns a connection's refresh token in plaintext for immediate use,
 * encrypting it in place first if it was stored unencrypted.
 *
 * The migrating UPDATE removes the plaintext key and adds the encrypted one in
 * a single jsonb expression, so the rest of cursor_state - history_id,
 * cloud_id, site_url, channel registries - is preserved untouched, and the row
 * is never momentarily without a usable token.
 */
export async function readRefreshToken(
  connectionId: string,
  cursorState: Record<string, unknown> | null | undefined,
): Promise<string | null> {
  const encrypted = cursorState?.refresh_token_enc;
  if (typeof encrypted === "string" && encrypted.length > 0) {
    return await decryptToken(encrypted);
  }

  const plaintext = cursorState?.refresh_token;
  if (typeof plaintext !== "string" || plaintext.length === 0) return null;

  try {
    const enc = await encryptToken(plaintext);
    await withAdmin(async (sql) => {
      await sql`
        UPDATE public.source_connections
        SET cursor_state =
          (coalesce(cursor_state, '{}'::jsonb) - 'refresh_token')
          || jsonb_build_object('refresh_token_enc', ${enc}::text)
        WHERE id = ${connectionId}::uuid
      `;
    });
    console.log(`Migrated plaintext refresh_token to encrypted for connection ${connectionId}`);
  } catch (err) {
    // The token itself is still good, so returning it keeps the connection
    // working; the next poll will try the migration again. Failing the refresh
    // over a storage-hygiene problem would be the worse trade.
    console.error(`Could not encrypt refresh_token in place for ${connectionId}:`, err);
  }

  return plaintext;
}
