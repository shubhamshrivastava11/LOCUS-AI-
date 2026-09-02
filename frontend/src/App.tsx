import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom'
import LandingPage from '../landing-page/LandingPage'
import WelcomePage from '../landing-page/WelcomePage'
import HowItWorks from '../landing-page/HowItWorks'
import ConnectWorkspaces from './ConnectWorkspaces'
import OAuthCallback from './OAuthCallback'
import SourceOAuthCallback from './SourceOAuthCallback'
import { getSupabaseClient, isSupabaseConfigured } from './lib/supabase'
import { EARLY_ACCESS_WAITLIST_FORM_URL } from './lib/appUrl'
import { rememberAccountFromSession } from './lib/accountRegistry'
import { DEMO_EMAIL_KEY, WORKSPACES_DONE_KEY } from './lib/sessionKeys'
import { fetchSourceConnections } from './lib/sourceConnections'
import DecisionReady from './DecisionReady'
import { DashboardShell } from './components/DashboardShell'
import { TermsGateModal } from './components/TermsGateModal'
import MainDashboardEntry from './pages/MainDashboardEntry'
import DecisionLogPage from './pages/DecisionLogPage'
import MemoryTimelinePage from './pages/MemoryTimelinePage'
import TeamPulse from './pages/TeamPulse'
import SettingsPage from './pages/SettingsPage'
import TermsPage from './pages/TermsPage'
import { TERMS_VERSION } from './lib/termsContent'

/** Full marketing page: Get Started → How it works → Why Locus (scrollable). */
function HowItWorksMarketing() {
  return <LandingPage initialSection="how-it-works" />
}

function useAuthEmail() {
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [authReady, setAuthReady] = useState(false)
  // null = not yet checked. Early access is gated server-side (the
  // on_auth_user_created trigger only provisions a tenant for allowlisted
  // emails - see supabase/migrations/20260812000000_early_access_allowlist.sql),
  // so a signed-in user with zero memberships rows means "authenticated but
  // not yet granted access", not a broken account.
  const [hasTenant, setHasTenant] = useState<boolean | null>(null)
  // null = not yet checked. Backed by the signed-in user's own
  // user_metadata.terms_version (set by TermsGateModal on accept), so it
  // travels with the account across devices/sessions rather than living in
  // this tab's sessionStorage - re-prompts automatically if TERMS_VERSION
  // is ever bumped for a material terms change.
  const [hasAcceptedTerms, setHasAcceptedTerms] = useState<boolean | null>(null)

  useEffect(() => {
    const demoEmail = sessionStorage.getItem(DEMO_EMAIL_KEY)
    if (demoEmail) {
      setUserEmail(demoEmail)
      setHasTenant(true)
      setHasAcceptedTerms(true)
      setAuthReady(true)
      return
    }

    if (!isSupabaseConfigured()) {
      setHasTenant(true)
      setHasAcceptedTerms(true)
      setAuthReady(true)
      return
    }

    const supabase = getSupabaseClient()

    const applySession = async (session: Session | null) => {
      setUserEmail(session?.user.email ?? null)
      if (!session) {
        setHasTenant(null)
        setHasAcceptedTerms(null)
        setAuthReady(true)
        return
      }
      rememberAccountFromSession(session)
      setHasAcceptedTerms(session.user.user_metadata?.terms_version === TERMS_VERSION)
      const { data, error } = await supabase.from('memberships').select('tenant_id').limit(1)
      setHasTenant(!error && (data?.length ?? 0) > 0)
      setAuthReady(true)
    }

    void supabase.auth.getSession().then(({ data }) => void applySession(data.session))

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      void applySession(session)
    })

    return () => data.subscription.unsubscribe()
  }, [])

  return { userEmail, authReady, hasTenant, hasAcceptedTerms, markTermsAccepted: () => setHasAcceptedTerms(true) }
}

/** Shown to a real (non-demo) account that authenticated successfully but
 * has no tenant membership - i.e. their email isn't on the early access
 * allowlist yet. Distinct from "not signed in" (redirects to "/") and from
 * a real error - this is an expected, informative dead end. */
function WaitlistScreen({ email }: { email: string }) {
  const handleLogOut = () => {
    sessionStorage.removeItem(DEMO_EMAIL_KEY)
    sessionStorage.removeItem(WORKSPACES_DONE_KEY)
    if (isSupabaseConfigured()) {
      void getSupabaseClient().auth.signOut()
    }
    window.location.href = '/'
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-white px-6 text-center">
      <h1 className="text-[20px] font-bold text-[#111827]">Locus AI is invite-only right now</h1>
      <p className="max-w-[420px] text-[14px] text-[#6B7280]">
        {email} isn't on the early access list yet. Join the waitlist below and we'll let you
        know as soon as it opens up.
      </p>
      <a
        href={EARLY_ACCESS_WAITLIST_FORM_URL}
        target="_blank"
        rel="noreferrer"
        className="mt-3 rounded-full bg-[#4B3BD4] px-5 py-1.5 text-[14px] font-semibold text-white transition-colors hover:bg-[#3F30BC]"
      >
        Join the Early Access Waitlist
      </a>
      <button
        type="button"
        onClick={handleLogOut}
        className="mt-1 rounded-full border border-[#d1d5db] bg-white px-5 py-1.5 text-[14px] font-medium text-[#374151] transition-colors hover:bg-gray-50"
      >
        Log out
      </button>
    </main>
  )
}

/**
 * The WORKSPACES_DONE_KEY sessionStorage flag only covers the current tab's
 * session, so a returning real user in a fresh tab (new browser, reopened
 * window) would otherwise get sent through onboarding again even though
 * their account already has connections. For a real (non-demo) session,
 * once auth is ready this checks the real backend once as a fallback -
 * demo sessions keep using sessionStorage only, since they have no backend
 * account to check against.
 */
function useWorkspacesConnected(userEmail: string | null, authReady: boolean) {
  const [workspacesConnected, setWorkspacesConnected] = useState(
    () => sessionStorage.getItem(WORKSPACES_DONE_KEY) === '1',
  )
  const [checked, setChecked] = useState(
    () => sessionStorage.getItem(WORKSPACES_DONE_KEY) === '1',
  )

  useEffect(() => {
    if (!authReady || !userEmail || workspacesConnected) {
      if (authReady) setChecked(true)
      return
    }
    if (sessionStorage.getItem(DEMO_EMAIL_KEY)) {
      setChecked(true)
      return
    }

    let active = true
    fetchSourceConnections()
      .then((rows) => {
        if (!active) return
        if (rows.some((row) => row.status === 'active')) {
          sessionStorage.setItem(WORKSPACES_DONE_KEY, '1')
          setWorkspacesConnected(true)
        }
      })
      .catch(() => {
        // No existing connections (or a transient error) - fall through to
        // the normal connect-workspaces screen, same as before this check existed.
      })
      .finally(() => {
        if (active) setChecked(true)
      })

    return () => {
      active = false
    }
  }, [authReady, userEmail, workspacesConnected])

  const markConnected = () => {
    sessionStorage.setItem(WORKSPACES_DONE_KEY, '1')
    setWorkspacesConnected(true)
  }

  return { workspacesConnected, markConnected, checked }
}

/**
 * Every /dashboard/* route rendered <DashboardShell /> and its nav
 * unconditionally, with no check that anyone was actually signed in - a
 * logged-out visitor hitting /dashboard directly (bookmark, typed URL,
 * shared link) saw the full dashboard chrome instead of being sent to
 * /welcome. Wraps the whole DashboardShell route group with the same
 * demo-or-Supabase-session check every other protected route already uses.
 */
function RequireAuth() {
  const { userEmail, authReady, hasTenant, hasAcceptedTerms, markTermsAccepted } = useAuthEmail()

  if (!authReady) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-white text-sm text-[#6B7280]">
        Loading…
      </main>
    )
  }

  if (!userEmail) {
    // "/" (not "/welcome") on purpose - logging out from a protected page
    // (Settings, Dashboard, ...) fires this guard's own redirect the moment
    // userEmail clears, racing the logout button's own explicit
    // navigate('/', {replace:true}) call. Whichever one "wins" needs to
    // land on the same real marketing page AuthRoutes already shows a
    // logged-out visitor at "/" - not the bare "/welcome" sign-in screen,
    // which is where this race was actually ending up.
    return <Navigate to="/" replace />
  }

  if (hasTenant === false) {
    return <WaitlistScreen email={userEmail} />
  }

  if (hasAcceptedTerms === false) {
    return <TermsGateModal onAccepted={markTermsAccepted} />
  }

  return <Outlet />
}

function ConnectWorkspacesRoute() {
  const navigate = useNavigate()
  const { userEmail, authReady, hasTenant, hasAcceptedTerms, markTermsAccepted } = useAuthEmail()
  const { workspacesConnected, markConnected, checked } = useWorkspacesConnected(userEmail, authReady)

  if (!authReady || (userEmail && !checked)) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-white text-sm text-[#6B7280]">
        Loading…
      </main>
    )
  }

  if (!userEmail) {
    // "/" (not "/welcome") on purpose - logging out from a protected page
    // (Settings, Dashboard, ...) fires this guard's own redirect the moment
    // userEmail clears, racing the logout button's own explicit
    // navigate('/', {replace:true}) call. Whichever one "wins" needs to
    // land on the same real marketing page AuthRoutes already shows a
    // logged-out visitor at "/" - not the bare "/welcome" sign-in screen,
    // which is where this race was actually ending up.
    return <Navigate to="/" replace />
  }

  if (hasTenant === false) {
    return <WaitlistScreen email={userEmail} />
  }

  if (hasAcceptedTerms === false) {
    return <TermsGateModal onAccepted={markTermsAccepted} />
  }

  if (workspacesConnected) {
    return (
      <DecisionReady
        userEmail={userEmail}
        onGoToDashboard={() => navigate('/dashboard')}
        onOpenSettings={() => navigate('/settings')}
      />
    )
  }

  return <ConnectWorkspaces email={userEmail} onContinue={markConnected} />
}

function AuthRoutes() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { userEmail, authReady, hasTenant, hasAcceptedTerms, markTermsAccepted } = useAuthEmail()
  const { workspacesConnected, checked } = useWorkspacesConnected(userEmail, authReady)

  const isOAuthCallback =
    searchParams.has('auth_callback') ||
    searchParams.has('code') ||
    searchParams.has('error')

  if (isOAuthCallback) {
    return <OAuthCallback />
  }

  if (!authReady || (userEmail && !checked)) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-white text-sm text-[#6B7280]">
        Loading…
      </main>
    )
  }

  if (userEmail && hasTenant === false) {
    return <WaitlistScreen email={userEmail} />
  }

  if (userEmail && hasAcceptedTerms === false) {
    return <TermsGateModal onAccepted={markTermsAccepted} />
  }

  if (userEmail && !workspacesConnected) {
    return <Navigate to="/connect-workspaces" replace />
  }

  if (userEmail && workspacesConnected) {
    return (
      <DecisionReady
        userEmail={userEmail}
        onGoToDashboard={() => navigate('/dashboard')}
        onOpenSettings={() => navigate('/settings')}
      />
    )
  }

  return <LandingPage />
}

// The tab title was hardcoded in index.html ("LOCUS AI — Sign up"), which
// stuck around no matter which page you were actually on - a Memory
// Explorer tab and a Settings tab looked identical to each other, and to a
// user who hadn't even signed in yet. Labeled to match each page's own nav
// entry so the label in a browser's tab strip actually tells them apart.
const PAGE_TITLES: Record<string, string> = {
  '/welcome': 'Welcome · Locus AI',
  '/connect-workspaces': 'Connect Your Tools · Locus AI',
  '/how-it-works': 'How It Works · Locus AI',
  '/dashboard': 'Dashboard · Locus AI',
  '/decision-log': 'Memory Explorer · Locus AI',
  '/team-pulse': 'Team Pulse · Locus AI',
  '/settings': 'Settings · Locus AI',
  '/dashboard/how-it-works': 'How It Works · Locus AI',
  '/terms': 'Terms of Service · Locus AI',
}

function PageTitle() {
  const location = useLocation()
  useEffect(() => {
    document.title = PAGE_TITLES[location.pathname] ?? 'Locus AI - Sign up'
  }, [location.pathname])
  return null
}

function App() {
  return (
    <BrowserRouter>
      <PageTitle />
      <Routes>
        <Route path="/" element={<AuthRoutes />} />
        <Route path="/welcome" element={<WelcomePage />} />
        <Route path="/connect-workspaces" element={<ConnectWorkspacesRoute />} />

        {/* Full 3-section landing (Get Started + How it works + Why Locus) */}
        <Route path="/how-it-works" element={<HowItWorksMarketing />} />
        <Route path="/terms" element={<TermsPage />} />

        {/* Slack/Notion/Gmail OAuth popup lands here after the provider redirects back */}
        <Route path="/oauth/source-callback" element={<SourceOAuthCallback />} />

        {/* Dashboard pages share one shell / one localhost - and require a
            real (or demo) session before any of them render. */}
        <Route element={<RequireAuth />}>
          <Route element={<DashboardShell />}>
            <Route path="/dashboard" element={<MainDashboardEntry />} />
            <Route path="/decision-log" element={<DecisionLogPage />} />
            <Route path="/memory-timeline" element={<MemoryTimelinePage />} />
            {/* /review-queue removed: deterministic entity resolution (memory-explorer
                upgrade) means there's no merge-review queue to work anymore - entities
                are upserted by a real connector id, never guessed. */}
            <Route path="/team-pulse" element={<TeamPulse />} />
            <Route path="/settings" element={<SettingsPage />} />
            {/* In-app "How it works" — keeps the dashboard nav/session visible,
                unlike the marketing /how-it-works route which is the full
                pre-login landing page and would otherwise strand a logged-in
                user with no way back. */}
            <Route path="/dashboard/how-it-works" element={<HowItWorks />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
