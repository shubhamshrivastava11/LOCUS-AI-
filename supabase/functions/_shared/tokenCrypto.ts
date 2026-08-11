// supabase/functions/_shared/tokenCrypto.ts
//
// source_connections.oauth_token_ref stored real Slack/Gmail/Notion access
// tokens as plaintext (slack-oauth/index.ts even had a standing TODO
// acknowledging this - "meant to be a reference to a Vault secret, not the
// raw token"). Same AES-256-GCM approach ai-worker/index.ts already uses
// for raw_events.raw_content, adapted for a text column instead of bytea
// (base64-encoded) since oauth_token_ref is `text`, not `bytea`.
//
// decryptToken() passes a value through unchanged if it doesn't look like
// our encrypted format - real Slack/Gmail/Notion tokens have recognizable
// shapes (xoxb-..., ya29...., a UUID-ish secret) that never start with our
// magic prefix, so this is a safe way to keep already-connected accounts
// (written before this change shipped) working without a data migration.
// They re-encrypt automatically the next time their token is written
// (Gmail's hourly refresh; a fresh OAuth connect for Slack/Notion).

const MAGIC = new TextEncoder().encode("LOCUST1"); // 7 bytes - distinct from raw_events' "LOCUS1" so the two are never confused if ever compared
const NONCE_LEN = 12;

async function getAesKey(): Promise<CryptoKey> {
  const secret = Deno.env.get("OAUTH_TOKEN_ENCRYPTION_KEY")
    || Deno.env.get("RAW_EVENTS_ENCRYPTION_KEY")
    || Deno.env.get("APP_SECRET_KEY");
  if (!secret) {
    throw new Error("OAUTH_TOKEN_ENCRYPTION_KEY (or RAW_EVENTS_ENCRYPTION_KEY / APP_SECRET_KEY) is not set");
  }
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encrypts a token for storage in oauth_token_ref. Returns a base64 string. */
export async function encryptToken(plaintext: string): Promise<string> {
  const key = await getAesKey();
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new TextEncoder().encode(plaintext)),
  );
  const out = new Uint8Array(MAGIC.length + NONCE_LEN + ciphertext.length);
  out.set(MAGIC, 0);
  out.set(nonce, MAGIC.length);
  out.set(ciphertext, MAGIC.length + NONCE_LEN);
  return bytesToBase64(out);
}

/**
 * Decrypts a value read from oauth_token_ref. Returns it unchanged if it
 * isn't in our encrypted format (legacy plaintext row, or null/empty).
 */
export async function decryptToken(stored: string | null | undefined): Promise<string | null> {
  if (!stored) return stored ?? null;

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(stored);
  } catch {
    return stored; // not valid base64 at all - definitely legacy plaintext
  }

  if (bytes.length < MAGIC.length || !MAGIC.every((b, i) => bytes[i] === b)) {
    return stored; // no magic prefix - legacy plaintext
  }

  try {
    const key = await getAesKey();
    const nonce = bytes.slice(MAGIC.length, MAGIC.length + NONCE_LEN);
    const ciphertext = bytes.slice(MAGIC.length + NONCE_LEN);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch (err) {
    console.error("decryptToken: value looked encrypted but failed to decrypt:", err);
    return stored;
  }
}
