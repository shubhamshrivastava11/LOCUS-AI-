import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getSupabaseClient } from './lib/supabase'
import { PENDING_INVITE_TOKEN_KEY } from './lib/sessionKeys'

export default function OAuthCallback() {
  const navigate = useNavigate()
  const [message, setMessage] = useState('Completing your Google sign in...')
  const hasStarted = useRef(false)

  useEffect(() => {
    if (hasStarted.current) return
    hasStarted.current = true

    const completeSignIn = async () => {
      try {
        const searchParams = new URLSearchParams(window.location.search)
        const oauthError =
          searchParams.get('error_description') ?? searchParams.get('error')

        if (oauthError) throw new Error(oauthError)

        const code = searchParams.get('code')
        const supabase = getSupabaseClient()

        if (code) {
          const { data, error } = await supabase.auth.exchangeCodeForSession(code)
          if (error) throw error
          if (!data.session) throw new Error('No session returned from Google sign in.')
        } else {
          // Hash/fragment or already-exchanged session
          const { data, error } = await supabase.auth.getSession()
          if (error) throw error
          if (!data.session) {
            throw new Error('Google did not return an authorization code.')
          }
        }

        // A pending team invite takes priority over normal onboarding -
        // JoinTeam.tsx stashed the token here right before starting this
        // sign-in. Always clear it, whether acceptance succeeds or fails,
        // so it never resurfaces on some later, unrelated sign-in.
        const inviteToken = sessionStorage.getItem(PENDING_INVITE_TOKEN_KEY)
        if (inviteToken) {
          sessionStorage.removeItem(PENDING_INVITE_TOKEN_KEY)
          const { data: acceptData, error: acceptError } = await supabase.functions.invoke('team-invites', {
            body: { action: 'accept', token: inviteToken },
          })
          if (acceptError || acceptData?.error) {
            setMessage(acceptError?.message ?? String(acceptData?.error) ?? 'Unable to accept this invite.')
            return
          }
          navigate('/dashboard', { replace: true })
          return
        }

        navigate('/connect-workspaces', { replace: true })
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unable to complete Google sign in.'
        setMessage(errorMessage)
      }
    }

    void completeSignIn()
  }, [navigate])

  return (
    <main className="flex min-h-screen items-center justify-center bg-white px-6 text-center text-[#111827]">
      <p className="text-sm">{message}</p>
    </main>
  )
}
