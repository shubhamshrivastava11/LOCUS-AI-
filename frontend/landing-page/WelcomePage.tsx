import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getAuthCallbackUrl } from '../src/lib/appUrl'
import { DEMO_EMAIL_KEY } from '../src/lib/sessionKeys'
import { getSupabaseClient, isSupabaseConfigured } from '../src/lib/supabase'
import { GoogleIcon } from './components/GoogleIcon'
import { LocusLogo } from './components/LocusLogo'

const BENEFITS = [
  'Ask anything about your project history.',
  'Automatically captures memory.',
  'A weekly digest of everything that mattered.',
]

export default function WelcomePage() {
  const navigate = useNavigate()
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)

  useEffect(() => {
    if (sessionStorage.getItem(DEMO_EMAIL_KEY)) {
      navigate('/connect-workspaces', { replace: true })
      return
    }

    if (!isSupabaseConfigured()) return

    void getSupabaseClient()
      .auth.getSession()
      .then(({ data }) => {
        if (data.session?.user.email) {
          navigate('/connect-workspaces', { replace: true })
        }
      })
  }, [navigate])

  const handleContinueWithGoogle = async () => {
    setAuthError(null)
    setIsSigningIn(true)

    if (!isSupabaseConfigured()) {
      setIsSigningIn(false)
      setAuthError(
        'Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to frontend/.env to enable Google sign-in.',
      )
      return
    }

    try {
      // Same-window redirect so Google always returns to the Vercel app,
      // then OAuthCallback sends the user to Connect Workspaces.
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
      setIsSigningIn(false)
      setAuthError(
        error instanceof Error ? error.message : 'Unable to start Google sign in.',
      )
    }
  }

  return (
    <div className="flex min-h-screen w-full flex-col md:flex-row">
      <section className="flex w-full flex-col justify-center bg-[#18181b] px-10 py-16 md:w-1/2">
        <h1 className="text-[40px] font-extrabold leading-[1.12] tracking-[-0.03em] text-white sm:text-[48px]">
          <span className="block md:whitespace-nowrap">Run your projects like you</span>
          <span className="mt-3 block text-[#aadf2e] md:whitespace-nowrap">
            remember everything.
          </span>
        </h1>

        <ul className="mt-11 space-y-4">
          {BENEFITS.map((item) => (
            <li key={item} className="flex items-center gap-3 text-[16px] text-white">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#4338ca] text-[12px] font-bold text-[#18181b]">
                ✓
              </span>
              {item}
            </li>
          ))}
        </ul>
      </section>

      <section className="flex w-full flex-col items-center justify-center bg-white px-8 py-16 md:w-1/2">
        <LocusLogo size={36} />

        <div className="mt-16 w-full max-w-[520px] text-center">
          <h2 className="text-[32px] font-bold tracking-[-0.02em] text-[#18181b]">
            Welcome to Locus AI
          </h2>
          <p className="mt-3 text-[16px] leading-relaxed text-[#6b7280]">
            Connect your tools and never lose a memory again.
          </p>

          <button
            type="button"
            onClick={handleContinueWithGoogle}
            disabled={isSigningIn}
            className="mt-10 flex w-full items-center justify-center gap-3 rounded-[18px] bg-[#aadf2e] px-6 py-3.5 text-[16px] font-semibold text-[#18181b] transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-70"
          >
            <GoogleIcon />
            {isSigningIn ? 'Redirecting…' : 'Continue with Google'}
          </button>

          {authError && (
            <p role="alert" className="mt-3 text-[13px] text-red-600">
              {authError}
            </p>
          )}

          <p className="mt-5 text-[14px] leading-relaxed text-[#6b7280]">
            By clicking continue, you agree to our terms of service and private policy.
          </p>
        </div>
      </section>
    </div>
  )
}
