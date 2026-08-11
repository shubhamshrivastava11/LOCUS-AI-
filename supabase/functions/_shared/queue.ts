// supabase/functions/_shared/queue.ts
//
// Every connector enqueues through this one path (INGESTION_CONTRACT.md).
// Uses DATABASE_URL / admin SQL so pgmq.send works without service_role
// table access on public.* tenant tables.

import { withAdmin } from "./db.ts";
import { redactFinancialInfoDeep } from "./financialRedaction.ts";

export interface IngestionEnvelope {
  tenant_id: string;
  source: "slack" | "gmail" | "notion";
  source_id: string;
  actor: string;
  thread_ref: string;
  // Matches the Python EventEnvelope model (backend/src/modules/ingestion/
  // envelope/schemas.py) that actually consumes these messages: a list of
  // permission identifiers, and the raw payload as an object, not a string.
  permission_scope: string[];
  raw_content: Record<string, unknown>;
  received_at: string; // ISO timestamp
  // A real deep link back to the original message/page. Read by
  // modules.ai.pipeline.service.process_and_persist_event() and written to
  // decision_sources - this is what "View Original" in the frontend opens.
  // No connector set this before, so the button was always disabled.
  source_permalink?: string;
  // A human-readable name for `actor`, when the connector can get one for
  // free from the message itself (Gmail's From header is usually
  // "Real Name" <email>, not just the address). Attached to the actors
  // table row for `actor` so participants show a real name instead of a
  // raw email/id - see ai-worker's handleIngestionMessageInner.
  actor_display_name?: string;
  // The source_connections row this event actually came from. When a
  // tenant has more than one connection for the same source (e.g. several
  // Gmail accounts), ai-worker previously had no way to know which one and
  // fell back to guessing "the oldest active connection for this
  // tenant+source" - which silently merged every connection's mail into
  // whichever was connected first. Set this when the connector already
  // knows its own source_connections.id (gmail-manual-sync does) so
  // ai-worker can attribute raw_events correctly instead of guessing.
  connection_id?: string;
  // Set when the connector can cheaply tell this is bulk/marketing mail
  // (e.g. Gmail's List-Unsubscribe header) before any AI call. ai-worker
  // skips triage+extraction entirely for these - $0 cost, not a discount.
  likely_bulk_mail?: boolean;
}

export async function enqueueEvent(envelope: IngestionEnvelope) {
  try {
    // Scrub card/account/routing numbers etc. out of raw_content before it
    // ever leaves this function - deterministically, not via AI triage
    // judgment - so a financial identifier never transits the queue, lands
    // in raw_events, or reaches the extraction model in the first place.
    const safeEnvelope: IngestionEnvelope = {
      ...envelope,
      raw_content: redactFinancialInfoDeep(envelope.raw_content),
    };
    await withAdmin(async (sql) => {
      // sql.json() wants postgres.js's own JSONValue type, which a plain
      // named interface never structurally satisfies (missing index
      // signature) regardless of field types — pre-existing gap, unrelated
      // to the envelope's actual field shapes. Cast, not a runtime change.
      await sql`select pgmq.send('ingestion', ${sql.json(safeEnvelope as any)}::jsonb)`;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to enqueue event: ${message}`);
  }
}
