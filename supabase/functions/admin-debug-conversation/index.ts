// supabase/functions/admin-debug-conversation/index.ts
//
// One-off diagnostic: finds a raw_event by a subject-line substring match
// and returns both the raw stored envelope.raw_content.body and what the
// currently-deployed cleanDisplayText() produces for it, to tell apart "the
// fix isn't actually deployed" from "the browser is just showing a stale
// fetch from before the deploy."

import { withAdmin } from "../_shared/db.ts";
import { cleanDisplayText } from "../_shared/htmlText.ts";

const LOCUS_MAGIC = new TextEncoder().encode("LOCUS1");
const NONCE_LEN = 12;

async function getAesKey(): Promise<CryptoKey> {
  const secret = Deno.env.get("RAW_EVENTS_ENCRYPTION_KEY") || Deno.env.get("APP_SECRET_KEY");
  if (!secret) throw new Error("RAW_EVENTS_ENCRYPTION_KEY or APP_SECRET_KEY is not set");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["decrypt"]);
}

async function decryptRawContent(encrypted: Uint8Array): Promise<string> {
  const key = await getAesKey();
  const nonce = encrypted.slice(LOCUS_MAGIC.length, LOCUS_MAGIC.length + NONCE_LEN);
  const ciphertext = encrypted.slice(LOCUS_MAGIC.length + NONCE_LEN);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

function byteaToUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") {
    const hex = value.startsWith("\\x") ? value.slice(2) : value;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
  }
  return new Uint8Array(value as ArrayLike<number>);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "Monthly Claude API Spend";

  try {
    const result = await withAdmin(async (sql) => {
      const rows = await sql`
        SELECT id, tenant_id, raw_content, received_at
        FROM public.raw_events
        WHERE source = 'gmail'
        ORDER BY received_at DESC
        LIMIT 300
      `;
      const matches: unknown[] = [];
      for (const row of rows as unknown as { id: string; tenant_id: string; raw_content: unknown; received_at: string }[]) {
        try {
          const bytes = byteaToUint8Array(row.raw_content);
          const plaintext = await decryptRawContent(bytes);
          const envelope = JSON.parse(plaintext) as { raw_content?: { subject?: string; body?: string } };
          const subject = envelope.raw_content?.subject ?? "";
          if (!subject.includes(q)) continue;
          const body = envelope.raw_content?.body ?? "";
          matches.push({
            id: row.id,
            received_at: row.received_at,
            subject,
            raw_body_preview: body.slice(0, 400),
            cleaned_output: cleanDisplayText(body),
          });
        } catch {
          continue;
        }
      }
      return matches;
    });

    return json({ count: result.length, matches: result });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
