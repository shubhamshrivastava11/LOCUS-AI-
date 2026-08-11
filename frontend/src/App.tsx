import { useEffect, useState } from 'react'
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
import { rememberAccountFromSession } from './lib/accountRegistry'
import { DEMO_EMAIL_KEY, WORKSPACES_DONE_KEY } from './lib/sessionKeys'
import { fetchSourceConnections } from './lib/sourceConnections'
import DecisionReady from './DecisionReady'
import { DashboardShell } from './components/DashboardShell'
import MainDashboardEntry from './pages/MainDashboardEntry'
import DecisionLogPage from './pages/DecisionLogPage'
import TeamPulse from './pages/TeamPulse'
import SettingsPage from './pages/SettingsPage'

/** Full marketing page: Get Started → How it works → Why Locus (scrollable). */
function HowItWorksMarketing() {
  return <LandingPage initialSection="how-it-works" />
}

function useAuthEmail() {
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [authReady, setAuthReady] = useState(false)

  useEffect(() => {
    const demoEmail = sessionStorage.getItem(DEMO_EMAIL_KEY)
    if (demoEmail) {
      setUserEmail(demoEmail)
      setAuthReady(true)
      return
    }

    if (!isSupabaseConfigured()) {
      setAuthReady(true)
      return
    }

    const supabase = getSupabaseClient()

    void supabase.auth.getSession().then(({ data }) => {
      setUserEmail(data.session?.user.email ?? null)
      setAuthReady(true)
      if (data.session) rememberAccountFromSession(data.session)
    })

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserEmail(session?.user.email ?? null)
      setAuthReady(true)
      if (session) rememberAccountFromSession(session)
    })

    return () => data.subscription.unsubscribe()
  }, [])

  return { userEmail, authReady }
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
  const { userEmail, authReady } = useAuthEmail()

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

  return <Outlet />
}

function ConnectWorkspacesRoute() {
  const navigate = useNavigate()
  const { userEmail, authReady } = useAuthEmail()
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
  const { userEmail, authReady } = useAuthEmail()
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

        {/* Slack/Notion/Gmail OAuth popup lands here after the provider redirects back */}
        <Route path="/oauth/source-callback" element={<SourceOAuthCallback />} />

        {/* Dashboard pages share one shell / one localhost - and require a
            real (or demo) session before any of them render. */}
        <Route element={<RequireAuth />}>
          <Route element={<DashboardShell />}>
            <Route path="/dashboard" element={<MainDashboardEntry />} />
            <Route path="/decision-log" element={<DecisionLogPage />} />
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
