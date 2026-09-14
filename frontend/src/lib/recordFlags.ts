import { getTenantId } from './api'
import { getSupabaseClient } from './supabase'

export const FLAG_REASONS = ['Inaccurate', 'Outdated', 'Other'] as const
export type FlagReason = (typeof FLAG_REASONS)[number]

/**
 * Persists a flag raised against one memory record.
 *
 * Before this existed the Flag panel collected a reason and a note, handed
 * both to its caller, and the caller threw them away - the button turned to
 * "Flagged" and nothing left the browser. Someone reporting a wrong
 * extraction was told it had worked.
 *
 * Written straight to the table rather than through the API on purpose: this
 * is the user's own feedback about their own tenant's record, and the
 * record_flags policies are narrow enough to make a route add nothing. INSERT
 * only, user_id pinned to auth.uid(), tenant_id checked against membership -
 * so a flag cannot be attributed to a colleague and, having no UPDATE or
 * DELETE policy, cannot be quietly retracted either.
 *
 * Throws on failure so the caller can keep showing the panel instead of
 * claiming a save that did not happen.
 */
export async function flagRecord(
  decisionId: string,
  reason: FlagReason,
  note: string,
): Promise<void> {
  const supabase = getSupabaseClient()
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError || !userData.user) {
    throw new Error('You need to be signed in to flag a record.')
  }

  const tenantId = await getTenantId()
  const trimmed = note.trim()

  const { error } = await supabase.from('record_flags').insert({
    tenant_id: tenantId,
    decision_id: decisionId,
    user_id: userData.user.id,
    reason,
    // Empty string and "no note" are the same thing to a reader; store the
    // second so a query for notes does not have to filter blanks out.
    note: trimmed.length > 0 ? trimmed : null,
  })

  if (error) throw new Error(error.message)
}
