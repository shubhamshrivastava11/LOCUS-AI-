/**
 * Local "known accounts" registry - powers the account switcher in
 * DashboardNav. Supabase's client only keeps one active session at a time,
 * so switching accounts without a full re-login means holding onto every
 * account's own access/refresh token pair ourselves and calling
 * supabase.auth.setSession() to swap which one is active. This is the same
 * trust boundary the current session already lives in (browser
 * localStorage) - not a new class of exposure, just one entry per account
 * instead of one for "the" session.
 */
import type { Session } from '@supabase/supabase-js'

const KEY = 'locus:known_accounts'
const MAX_ACCOUNTS = 6

export type KnownAccount = {
  userId: string
  email: string
  name: string
  initials: string
  accessToken: string
  refreshToken: string
}

function getInitials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || '?'
  )
}

function readAll(): KnownAccount[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeAll(accounts: KnownAccount[]) {
  localStorage.setItem(KEY, JSON.stringify(accounts.slice(0, MAX_ACCOUNTS)))
}

/** Call whenever a real (non-demo) Supabase session resolves, so this
 * browser "remembers" the account for the switcher - refreshes the stored
 * tokens every time too, since access tokens expire and we want the
 * freshest refresh token on hand. */
export function rememberAccountFromSession(session: Session) {
  const user = session.user
  if (!user.email) return

  const name = String(
    user.user_metadata?.full_name ||
      user.user_metadata?.name ||
      user.user_metadata?.display_name ||
      user.email,
  )

  const account: KnownAccount = {
    userId: user.id,
    email: user.email,
    name,
    initials: getInitials(name),
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
  }

  const others = readAll().filter((a) => a.userId !== user.id)
  writeAll([account, ...others])
}

/** Every remembered account except the one currently active. */
export function listOtherAccounts(currentUserId: string | null): KnownAccount[] {
  return readAll().filter((a) => a.userId !== currentUserId)
}

export function forgetAccount(userId: string) {
  writeAll(readAll().filter((a) => a.userId !== userId))
}
