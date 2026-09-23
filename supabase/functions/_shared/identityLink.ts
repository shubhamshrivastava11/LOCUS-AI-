// One person, several email addresses - recorded automatically.
//
// THE BUG THIS CLOSES. Scope membership is matched by email string, and a
// person's address in a connected tool is frequently not their Locus login.
// Lam's was lam.dao@cstu.edu on Locus and dnlamvhit@gmail.com on Slack, so
// he matched none of his own channels and saw 0 of his 7 live records, on a
// dashboard that looked like the product had lost his data.
//
// public.user_identities fixed the COMPARISON. It did not fix the data:
// until this module there was exactly one row in that table, typed in by
// hand after someone noticed a blank screen. Anyone else with a mismatched
// address hit the same wall silently, and would keep hitting it.
//
// WHY OAUTH CALLBACKS ARE THE RIGHT PLACE. A link is only trustworthy if
// both halves come from an authoritative source, and the callback is the one
// moment they are both present: who clicked Connect (carried in the signed
// OAuth state, not a form field the browser could edit) and which account in
// the external tool authorised it (the provider's own token response, proven
// by the fact that they just signed in to it). Nowhere later in the pipeline
// are those two facts in the same place again - the ingest worker sees an
// address with no idea whose it is.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It links the person who CONNECTS a
// source, which is one person per workspace for Slack. Their teammates'
// addresses are still unlinked, and nothing available proves those links:
// Slack's member list gives us an address with no indication of which Locus
// account it belongs to. Guessing from name similarity would be a privilege
// escalation dressed as convenience. Those remaining links need someone to
// assert them - the person or an admin - and that is a UI, not a heuristic.

import { withAdmin } from "./db.ts";

export type IdentityLinkOutcome =
  | "linked"
  | "already_linked"
  | "conflict"
  | "no_email"
  | "failed";

/**
 * Record `email` as belonging to `userId` within `tenantId`.
 *
 * Never throws. A failure here costs the person a mapping an admin can add
 * by hand; throwing would cost them the connection itself, at a point where
 * the provider has already issued a token we have already stored.
 */
export async function linkSourceIdentity(
  tenantId: string,
  userId: string | null | undefined,
  email: string | null | undefined,
  source: string,
): Promise<IdentityLinkOutcome> {
  const address = String(email ?? "").trim();
  if (!tenantId || !userId || !address) return "no_email";

  try {
    // withAdmin, not withTenant: locus_app is granted select on this table
    // and nothing else, on purpose - the lane that reads someone's
    // identities should not be able to mint them.
    const inserted = await withAdmin(async (sql) => {
      return await sql`
        insert into public.user_identities (tenant_id, user_id, email, source)
        values (${tenantId}::uuid, ${userId}::uuid, ${address}, ${source})
        on conflict do nothing
        returning user_id
      `;
    });

    if (inserted.length > 0) {
      console.log(`[identity] linked ${source} address for user ${userId}`);
      return "linked";
    }

    // Nothing inserted, and there are two very different reasons why.
    // Either this exact link already exists - a reconnect, the common case,
    // entirely fine - or uq_user_identities_one_owner rejected it because a
    // DIFFERENT account in this tenant already claims this address.
    //
    // The second case stays a conflict rather than becoming an update. An
    // upsert here would silently move the mapping and hand one account
    // another account's channel access. It needs a human decision. From the
    // user's side both outcomes look identical ("my dashboard is empty"),
    // so the log has to say which one happened.
    const owner = await withAdmin(async (sql) => {
      const r = await sql`
        select user_id from public.user_identities
        where tenant_id = ${tenantId}::uuid and lower(email) = lower(${address})
      `;
      return r[0]?.user_id ? String(r[0].user_id) : null;
    });

    if (owner && owner !== userId) {
      console.warn(
        `[identity] ${source} address NOT linked: it already belongs to ` +
          `another account in this tenant - needs a human decision, not an overwrite`,
      );
      return "conflict";
    }
    return "already_linked";
  } catch (err) {
    console.warn(
      `[identity] ${source} link failed:`,
      err instanceof Error ? err.message : String(err),
    );
    return "failed";
  }
}
