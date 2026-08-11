// supabase/functions/_shared/sourceConnectionSchema.ts
//
// source_connections.external_workspace_id is the OAuth-stable identity key
// (a Slack team id, a Notion workspace UUID, a Gmail address) used in the
// unique constraint - not something to change casually. display_name is a
// separate, purely cosmetic column for what a human should actually see:
// Gmail's external_workspace_id already IS the real email, but Slack/Notion
// store opaque ids there, so without this a user could never tell which of
// two Slack connections was which, or whether the Slack workspace they
// meant to connect is actually the one that's connected.
//
// Idempotent ALTER via withAdmin (DDL needs more than the locus_app role's
// grants) instead of a tracked migration file - this project's migrations
// folder isn't reliably applied against the live Supabase project (see
// purge-raw-events/loci-chat for the same pattern used earlier), so schema
// changes that need to reach production go through code that bootstraps
// itself on first real use.

import { withAdmin } from "./db.ts";

export async function ensureSourceConnectionDisplayNameColumn(): Promise<void> {
  await withAdmin(async (sql) => {
    await sql`ALTER TABLE public.source_connections ADD COLUMN IF NOT EXISTS display_name text`;
  });
}
