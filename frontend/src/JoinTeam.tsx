import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { getAuthCallbackUrl } from './lib/appUrl'
import { PENDING_INVITE_TOKEN_KEY } from './lib/sessionKeys'
import { getSupabaseClient, isSupabaseConfigured } from './lib/supabase'
import { GoogleIcon } from '../landing-page/components/GoogleIcon'
import { LocusLogo } from '../landing-page/components/LocusLogo'

type LookupResult =
  | { state: 'loading' }
  | { state: 'invalid'; reason: string }
  | { state: 'valid'; tenantName: string; role: string }

/**
 * Public page a teammate lands on from an invite link/email - no sign-in
 * required to see what they're accepting. Mirrors WelcomePage.tsx's
 * Google sign-in call, but stashes the invite token in sessionStorage
 * first (see PENDING_INVITE_TOKEN_KEY's own comment for why) so
 * OAuthCallback.tsx can accept the invite right after the session is
 * established, before any normal onboarding/waitlist logic runs.
 */
export default function JoinTeam() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') ?? ''
  const [lookup, setLookup] = useState<LookupResult>({ state: 'loading' })
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) {
      setLookup({ state: 'invalid', reason: 'This invite link is missing its token.' })
      return
    }
    if (!isSupabaseConfigured()) {
      setLookup({ state: 'invalid', reason: 'Locus AI is not configured in this environment.' })
      return
    }

    let active = true
    getSupabaseClient()
      .functions.invoke('team-invites', { body: { action: 'lookup', token } })
      .then(({ data, error }) => {
        if (!active) return
        if (error || !data?.valid) {
          setLookup({ state: 'invalid', reason: data?.reason ?? error?.message ?? 'This invite is no longer valid.' })
          return
        }
        setLookup({ state: 'valid', tenantName: data.tenant_name, role: data.role })
      })
      .catch(() => {
        if (active) setLookup({ state: 'invalid', reason: 'Unable to check this invite right now.' })
      })
    return () => {
      active = false
    }
  }, [token])

  const handleAccept = async () => {
    setAuthError(null)
    setIsSigningIn(true)

    // Already signed in (e.g. re-opening the link in a tab with an active
    // session) - accept directly instead of detouring through Google again.
    const { data: sessionData } = await getSupabaseClient().auth.getSession()
    if (sessionData.session) {
      const { data, error } = await getSupabaseClient()
        .functions.invoke('team-invites', { body: { action: 'accept', token } })
      if (error || data?.error) {
        setAuthError(error?.message ?? String(data?.error) ?? 'Unable to accept this invite.')
        setIsSigningIn(false)
        return
      }
      window.location.href = '/dashboard'
      return
    }

    sessionStorage.setItem(PENDING_INVITE_TOKEN_KEY, token)
    try {
      const { data, error } = await getSupabaseClient().auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: getAuthCallbackUrl(),
          skipBrowserRedirect: false,
          queryParams: { prompt: 'select_account' },
        },
      })
      if (error) throw error
      if (!data.url) throw new Error('Google sign in could not be started.')
      // Browser navigates away via Supabase redirect.
    } catch (error) {
      sessionStorage.removeItem(PENDING_INVITE_TOKEN_KEY)
      setAuthError(error instanceof Error ? error.message : 'Unable to start Google sign in.')
      setIsSigningIn(false)
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-white px-6 text-center">
      <LocusLogo size={36} className="mb-8 gap-2.5" />

      {lookup.state === 'loading' ? (
        <p className="text-sm text-[#6B7280]">Checking your invite…</p>
      ) : lookup.state === 'invalid' ? (
        <div className="max-w-sm">
          <h1 className="text-[22px] font-bold text-[#111827]">This invite isn't valid</h1>
          <p className="mt-2 text-sm text-[#6B7280]">{lookup.reason}</p>
          <p className="mt-4 text-sm text-[#6B7280]">
            Ask whoever invited you to send a new link, or reach out if this seems wrong.
          </p>
        </div>
      ) : (
        <div className="max-w-sm">
          <h1 className="text-[22px] font-bold text-[#111827]">
            You've been invited to join <span className="text-[#4B38D1]">{lookup.tenantName}</span>
          </h1>
          <p className="mt-2 text-sm text-[#6B7280]">
            You'll join as a {lookup.role}, sharing this team's decision memory once you connect your own tools.
          </p>

          <button
            type="button"
            disabled={isSigningIn}
            onClick={() => void handleAccept()}
            className="mt-8 flex w-full items-center justify-center gap-2.5 rounded-full border border-[#E5E7EB] bg-white px-6 py-3 text-[15px] font-semibold text-[#111827] shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition-colors hover:bg-[#F9FAFB] disabled:cursor-wait disabled:opacity-70"
          >
            <GoogleIcon />
            {isSigningIn ? 'Redirecting…' : 'Accept & continue with Google'}
          </button>

          {authError ? (
            <p role="alert" className="mt-3 text-sm text-[#B4232C]">
              {authError}
            </p>
          ) : null}
        </div>
      )}
    </main>
  )
}
