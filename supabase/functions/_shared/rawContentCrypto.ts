// Reading raw_events.raw_content back out.
//
// ai-worker encrypts the whole ingestion envelope - not just the message
// body, but actor, thread_ref, permission_scope and all - into one
// AES-256-GCM blob with a "LOCUS1" magic prefix. That detail is what makes
// replay possible at all: the stored bytes are not a lossy copy of the
// message, they are the original envelope, so an event can be put back on
// the queue exactly as it first arrived.
//
// This lived privately inside api/index.ts. It moved here the moment a
// second caller needed it (admin-replay), rather than being copied - a
// duplicated decrypt routine is the kind that drifts silently and then
// fails on old rows only, long after anyone remembers there were two.

const LOCUS_MAGIC_LEN = 6; // "LOCUS1"
const NONCE_LEN = 12;

async function getAesKey(): Promise<CryptoKey> {
  const secret = Deno.env.get("RAW_EVENTS_ENCRYPTION_KEY") || Deno.env.get("APP_SECRET_KEY");
  if (!secret) throw new Error("RAW_EVENTS_ENCRYPTION_KEY or APP_SECRET_KEY is not set");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["decrypt"]);
}

/** postgres.js hands bytea back as either bytes or a `\x...` hex string. */
export function byteaToUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") {
    const hex = value.startsWith("\\x") ? value.slice(2) : value;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
  }
  return new Uint8Array(value as ArrayLike<number>);
}

export async function decryptRawContent(encrypted: Uint8Array): Promise<string> {
  const key = await getAesKey();
  const nonce = encrypted.slice(LOCUS_MAGIC_LEN, LOCUS_MAGIC_LEN + NONCE_LEN);
  const ciphertext = encrypted.slice(LOCUS_MAGIC_LEN + NONCE_LEN);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
