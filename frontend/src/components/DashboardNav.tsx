import { useEffect, useRef, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { getSupabaseClient, isSupabaseConfigured } from '../lib/supabase'
import { getAuthCallbackUrl } from '../lib/appUrl'
import {
  forgetAccount,
  listOtherAccounts,
  rememberAccountFromSession,
  type KnownAccount,
} from '../lib/accountRegistry'
import {
  DEMO_EMAIL_KEY,
  TEAM_PULSE_SEEN_EVENT,
  TEAM_PULSE_SEEN_KEY,
  WORKSPACES_DONE_KEY,
} from '../lib/sessionKeys'

const NAV_LINKS = [
  { label: 'How it works', to: '/dashboard/how-it-works' },
  { label: 'Dashboard', to: '/dashboard' },
  { label: 'Memory Explorer', to: '/decision-log' },
  { label: 'Team Pulse', to: '/team-pulse' },
  { label: 'Settings', to: '/settings' },
] as const

type ProfileUser = {
  userId: string | null
  name: string
  email: string
  initials: string
}

function clearLocalSession() {
  sessionStorage.removeItem(DEMO_EMAIL_KEY)
  sessionStorage.removeItem(WORKSPACES_DONE_KEY)
  sessionStorage.removeItem('locus:connected-tools')
}

function getInitials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
}

function getNameFromEmail(email: string) {
  const emailName = email.split('@')[0]?.replace(/[._-]+/g, ' ').trim()
  if (!emailName) return 'Locus AI User'

  return emailName.replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function DashboardNav() {
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [profile, setProfile] = useState<ProfileUser>({
    userId: null,
    name: 'Locus AI User',
    email: '',
    initials: 'LU',
  })
  const [otherAccounts, setOtherAccounts] = useState<KnownAccount[]>([])
  const [switching, setSwitching] = useState<string | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const isDemo = Boolean(sessionStorage.getItem(DEMO_EMAIL_KEY))
  // Was `badge: true` hardcoded on the Team Pulse nav link - the dot never
  // cleared no matter how many times the page had been viewed. Mirrors
  // TeamPulse's own mount effect: 'true' present means seen.
  const [pulseUnseen, setPulseUnseen] = useState(() => !localStorage.getItem(TEAM_PULSE_SEEN_KEY))

  useEffect(() => {
    const markSeen = () => setPulseUnseen(false)
    window.addEventListener(TEAM_PULSE_SEEN_EVENT, markSeen)
    // Also covers Team Pulse being marked seen in another tab.
    window.addEventListener('storage', markSeen)
    return () => {
      window.removeEventListener(TEAM_PULSE_SEEN_EVENT, markSeen)
      window.removeEventListener('storage', markSeen)
    }
  }, [])

  useEffect(() => {
    const demoEmail = sessionStorage.getItem(DEMO_EMAIL_KEY)
    if (demoEmail) {
      setProfile({
        userId: null,
        name: 'Locus AI User',
        email: demoEmail,
        initials: 'LU',
      })
      setOtherAccounts(listOtherAccounts(null))
      return
    }

    if (!isSupabaseConfigured()) return

    const supabase = getSupabaseClient()
    void supabase.auth.getSession().then(({ data }) => {
      const session = data.session
      const user = session?.user
      if (!user || !session) return
      const email = user.email ?? ''
      const name = String(
        user.user_metadata.full_name ||
          user.user_metadata.name ||
          user.user_metadata.display_name ||
          getNameFromEmail(email),
      )
      setProfile({ userId: user.id, name, email, initials: getInitials(name) || 'LU' })
      rememberAccountFromSession(session)
      setOtherAccounts(listOtherAccounts(user.id))
    })
  }, [])

  useEffect(() => {
    if (!menuOpen) return

    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  const logOut = async () => {
    clearLocalSession()
    if (isSupabaseConfigured()) {
      await getSupabaseClient().auth.signOut()
    }
    setMenuOpen(false)
    navigate('/', { replace: true })
  }

  const switchToAccount = async (account: KnownAccount) => {
    if (!isSupabaseConfigured()) return
    setSwitchError(null)
    setSwitching(account.userId)
    try {
      const { error } = await getSupabaseClient().auth.setSession({
        access_token: account.accessToken,
        refresh_token: account.refreshToken,
      })
      if (error) throw error
      clearLocalSession()
      // Full reload rather than client-side nav - every dashboard page's
      // in-memory state (decisions, source connections, profile) was built
      // for the account we're leaving, not the one we're switching to.
      window.location.href = '/dashboard'
    } catch {
      // Most likely cause: the stored refresh token was revoked (e.g. that
      // account signed out elsewhere) - it can't be switched to silently,
      // so drop it from the list instead of leaving a dead entry behind.
      forgetAccount(account.userId)
      setOtherAccounts((accounts) => accounts.filter((a) => a.userId !== account.userId))
      setSwitchError(`Couldn't switch to ${account.email} - try signing in again.`)
      setSwitching(null)
    }
  }

  const removeAccount = (userId: string) => {
    forgetAccount(userId)
    setOtherAccounts((accounts) => accounts.filter((a) => a.userId !== userId))
  }

  const addAnotherAccount = async () => {
    if (!isSupabaseConfigured()) return
    setSwitchError(null)
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
      // Browser navigates away via Supabase redirect - the account signed
      // into right now is already saved in the registry (recorded on every
      // session resolve), so it'll be waiting in "Other Accounts" once the
      // new one finishes signing in.
    } catch (error) {
      setSwitchError(
        error instanceof Error ? error.message : 'Unable to start Google sign in.',
      )
    }
  }

  return (
    <header className="relative sticky top-0 z-20 border-b border-[#E8E8ED] bg-white">
      <div className="relative mx-auto flex min-h-[56px] w-full flex-wrap items-center justify-between px-4 py-3 md:h-[56px] md:flex-nowrap md:px-16 md:py-0">
        <NavLink
          to="/dashboard"
          className="flex items-center gap-2.5"
          aria-label="Locus AI dashboard"
        >
          <img src="/locus-mark.png" alt="" className="h-7 w-7 shrink-0 rounded-[5px]" />
          <span className="whitespace-nowrap text-[16px] font-bold text-[#111117]">
            LOCUS <span className="text-[#5b52e8]">AI</span>
          </span>
        </NavLink>

        <nav className="order-3 mt-2 flex h-10 w-full items-center gap-5 overflow-x-auto md:absolute md:left-1/2 md:top-0 md:order-none md:mt-0 md:h-full md:w-auto md:-translate-x-1/2 md:gap-4 md:overflow-visible lg:gap-8">
          {NAV_LINKS.map((link) => (
            <NavLink
              key={link.label}
              to={link.to}
              className={({ isActive }) =>
                `relative flex h-full shrink-0 items-center whitespace-nowrap text-[13px] font-medium transition-colors md:text-[12px] lg:text-[13px] ${
                  isActive
                    ? 'text-[#5A45FF]'
                    : 'text-[#6B7280] hover:text-[#111827]'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <span className="relative">
                    {link.label}
                    {link.label === 'Team Pulse' && pulseUnseen ? (
                      <span className="absolute -right-2.5 top-0 h-[6px] w-[6px] rounded-full bg-[#5A45FF]" />
                    ) : null}
                  </span>
                  {isActive ? (
                    <span className="absolute inset-x-0 bottom-0 h-[2px] bg-[#5A45FF]" />
                  ) : null}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="relative" ref={menuRef}>
          <button
            type="button"
            aria-label="User profile"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            className="flex h-7 w-7 items-center justify-center rounded-full border border-[#B8BFCC] bg-white"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <circle cx="12" cy="8" r="3.5" fill="#9CA3AF" />
              <path
                d="M5 19.5c0-3.6 3.1-6 7-6s7 2.4 7 6"
                stroke="#9CA3AF"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>

          {menuOpen ? (
            <div
              role="menu"
              className="absolute right-0 z-50 mt-3 w-[280px] overflow-hidden rounded-[20px] border border-[#E8E8ED] bg-white shadow-[0_18px_50px_rgba(17,24,39,0.18)]"
            >
              <div className="flex flex-col items-center px-5 pt-6 pb-5">
                <div className="flex h-16 w-16 items-center justify-center rounded-full border border-[#E5E7EB] bg-[#F3F4F6]">
                  <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle cx="12" cy="8" r="3.5" fill="#9CA3AF" />
                    <path
                      d="M5 19.5c0-3.6 3.1-6 7-6s7 2.4 7 6"
                      stroke="#9CA3AF"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
                <p className="mt-3 text-[16px] font-bold text-[#111827]">{profile.name}</p>
                {profile.email ? (
                  <p className="mt-0.5 text-[13px] text-[#6B7280]">{profile.email}</p>
                ) : null}
              </div>

              {otherAccounts.length > 0 || !isDemo ? (
                <div className="border-t border-[#E8E8ED] px-4 pt-3 pb-2">
                  <p className="px-1 text-[14px] font-bold text-[#111827]">Other Accounts</p>
                  {switchError ? (
                    <p className="mt-1 px-1 text-[12px] text-red-600">{switchError}</p>
                  ) : null}
                  {otherAccounts.length > 0 ? (
                    <ul className="mt-2">
                      {otherAccounts.map((account, index) => (
                        <li
                          key={account.userId}
                          className={`group flex items-center gap-3 py-3 pl-1 pr-1 ${
                            index < otherAccounts.length - 1 ? 'border-b border-[#F0F0F4]' : ''
                          }`}
                        >
                          <button
                            type="button"
                            role="menuitem"
                            disabled={switching !== null}
                            onClick={() => void switchToAccount(account)}
                            className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:opacity-50"
                          >
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#EEEBFF] text-[12px] font-semibold text-[#5A45FF]">
                              {account.initials}
                            </div>
                            <div className="min-w-0">
                              <p className="truncate text-[14px] font-semibold text-[#111827]">
                                {switching === account.userId ? 'Switching…' : account.name}
                              </p>
                              <p className="truncate text-[12px] text-[#6B7280]">{account.email}</p>
                            </div>
                          </button>
                          <button
                            type="button"
                            aria-label={`Remove ${account.email}`}
                            onClick={() => removeAccount(account.userId)}
                            className="shrink-0 rounded-full px-2 py-1 text-[12px] text-[#9CA3AF] opacity-0 transition-opacity hover:text-[#111827] group-hover:opacity-100"
                          >
                            ✕
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void addAnotherAccount()}
                    className="mt-1 w-full rounded-lg px-1 py-2.5 text-left text-[13px] font-semibold text-[#5A45FF] hover:bg-[#F7F7FA]"
                  >
                    + Add another account
                  </button>
                </div>
              ) : null}

              <div className="border-t border-[#E8E8ED] p-4">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void logOut()}
                  className="h-11 w-full rounded-xl bg-[#4338CA] text-[15px] font-semibold text-white transition-colors hover:bg-[#3730A3]"
                >
                  Log Out
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  )
}
