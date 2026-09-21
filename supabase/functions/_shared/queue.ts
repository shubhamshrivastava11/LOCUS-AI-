// supabase/functions/_shared/queue.ts
//
// Every connector enqueues through this one path (INGESTION_CONTRACT.md).
// Uses DATABASE_URL / admin SQL so pgmq.send works without service_role
// table access on public.* tenant tables.

import { withAdmin } from "./db.ts";
import { redactFinancialInfoDeep } from "./financialRedaction.ts";

export interface IngestionEnvelope {
  tenant_id: string;
  source: "slack" | "gmail" | "notion" | "jira" | "confluence" | "discord" | "github" | "monday" | "clickup" | "teams";
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
  /** Per-signal detail behind likely_bulk_mail, for measuring the filter. */
  filter_signals?: Record<string, unknown>;
  // Real, structured identities the connector already knows for this
  // event (an issue's creator + comment authors, a page's editors) -
  // distinct from `actor`/`actor_display_name`, which name only the ONE
  // primary sender/creator. Extraction identifies participants from the
  // event's own TEXT (an @mention, a name in a comment), which only ever
  // gives a name string, never a real account id - matched against this
  // list by name (case-insensitive) so a recognized participant gets
  // their real id/display_name instead of a garbage "account id" made
  // from whatever text the model happened to extract. An unmatched
  // mention still falls back to today's behavior (name stored as-is, no
  // display name) - this only improves the cases it can genuinely
  // resolve, never guesses. Generic, not Jira/Confluence-specific -
  // any connector with structured participant data can set this.
  known_actors?: { name: string; source_actor_id: string }[];
  // The id of the channel / project / space / label / board / repo this
  // event came from, in the SAME id space Build Memory lists and stores
  // rules against (capture_source_rules.item_id). ai-worker drops the
  // event when the tenant has switched that item off.
  //
  // Deliberately NOT permission_scope, which looks similar and is not:
  // permission_scope is load-bearing for search access control
  // (isDecisionAccessible), and most connectors put a workspace or account
  // id in it rather than the per-item id Build Memory shows. Overloading it
  // would couple a settings toggle to the security model.
  //
  // Optional on purpose - a connector that does not set it is captured
  // unconditionally, exactly as before this field existed.
  //
  // A list where one event genuinely belongs to several items at once:
  // a Gmail message carries every label applied to it, and the tenant may
  // have switched any one of them off. Single-item connectors pass a
  // string and behave identically.
  capture_item_id?: string | string[];
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
