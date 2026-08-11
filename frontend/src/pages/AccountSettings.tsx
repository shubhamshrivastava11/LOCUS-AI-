import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { User } from '@supabase/supabase-js'
import { getSupabaseClient, isSupabaseConfigured } from '../lib/supabase'
import { DEMO_EMAIL_KEY, WORKSPACES_DONE_KEY } from '../lib/sessionKeys'
import { clearBackendSession, createCheckoutSession, getTenantPlan } from '../lib/api'
import { PLANS } from '../../../supabase/functions/_shared/productFacts'

// Same source loci-chat's system prompt builds its pricing section from -
// a plan name/price change only needs to happen in that one file. The
// actual price figures shown further down this page are baked into the
// plan-header images and a mock invoice list, though, which can't pull
// from shared data since they're not text - those stay manual.
const PLAN_LABELS: Record<string, string> = Object.fromEntries(PLANS.map((p) => [p.id, p.name]))

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function FeatureCheckIcon() {
  return (
    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#4B3BD4] text-[12px] font-bold text-white">
      &#10003;
    </span>
  )
}

function RocketIcon() {
  return (
    <svg
      className="mt-0.5 h-5 w-5 shrink-0 text-[#4B3BD4]"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M14.5 5.5c2.3-2.3 4.7-2.5 5.8-2.4.1 1.1-.1 3.5-2.4 5.8l-5.8 5.8-3.4-3.4 5.8-5.8zM8.8 8.5l-3.7.7-2 2 4.3.8M14.9 14l-.7 3.7-2 2-.8-4.3M7.5 15.7l-2.8 2.8M6.2 14.4l-3 1.2M8.8 17l-1.2 3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

const CORE_PLAN_FEATURES = [
  'Own memory sources (Slack, Notion, and Gmail, with SharePoint/OneDrive/Teams on the roadmap)',
  'Own memory register (private, not shared)',
  'Context Search with saved search history',
  'Personal Pulse: weekly digest of your own organizational memory',
  'Catch-Up Brief: self-serve, parameterized by scope and time window',
  'Memory refresh rate: 6 hours',
  'MCP access: search_team_context, get_team_pulse, and get_onboarding_brief callable from Claude',
]

function PlanFeature({
  children,
  upcoming = false,
}: {
  children: string
  upcoming?: boolean
}) {
  return (
    <li className="flex items-start gap-3 text-[15px] leading-[1.45] text-[#202027]">
      {upcoming ? <RocketIcon /> : <FeatureCheckIcon />}
      <span>{children}</span>
    </li>
  )
}

function PlanPicker({ onClose, currentPlan }: { onClose: () => void; currentPlan: string }) {
  // Previously hardcoded: Individual's button was always a disabled
  // "Current" and Team's always called checkout for 'team' - correct only
  // for a tenant already on Individual. A tenant actually on Team saw a
  // "Current" badge on the plan they'd already left and an "Upgrade" button
  // for the one they already had.
  const [switchingTo, setSwitchingTo] = useState<'self_serve' | 'team' | null>(null)
  const [checkoutError, setCheckoutError] = useState('')

  const startCheckout = async (plan: 'self_serve' | 'team') => {
    setSwitchingTo(plan)
    setCheckoutError('')
    try {
      const { checkout_url } = await createCheckoutSession(plan)
      window.location.href = checkout_url
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : 'Unable to start checkout.')
      setSwitchingTo(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/25 p-3 sm:p-5"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="plan-picker-title"
        className="relative mx-auto h-full max-h-[calc(100vh-24px)] w-full max-w-[1440px] overflow-y-auto rounded-[18px] border border-[#E0E2E8] bg-[#F8F8FC] px-5 py-8 shadow-[0_24px_70px_rgba(20,24,35,0.22)] sm:max-h-[calc(100vh-40px)] sm:px-10 lg:px-12"
      >
        <button
          type="button"
          aria-label="Close plan selection"
          onClick={onClose}
          className="absolute top-4 right-5 flex h-10 w-10 items-center justify-center text-[38px] font-light leading-none text-[#4437D5] hover:text-[#2F259E]"
        >
          &times;
        </button>

        <h2
          id="plan-picker-title"
          className="pr-14 text-[30px] font-medium text-[#111116] sm:text-[34px]"
        >
          Find the right plan for you.
        </h2>

        <div className="mt-7 grid items-stretch gap-7 lg:grid-cols-2">
          <article className="flex min-h-[720px] flex-col overflow-hidden rounded-[18px] border border-[#DFE1E8] bg-white">
            <header className="relative aspect-[774/241] w-full shrink-0 overflow-hidden rounded-t-[17px] border-b border-[#E3E4E9]">
              <img
                src="/individual-plan-header.png"
                alt="Individual plan, $12 per month"
                className="block h-full w-full object-cover"
              />
              <img
                src="/individual-plan-art.png"
                alt=""
                aria-hidden="true"
                className="absolute inset-y-0 right-0 h-full w-[36%] rounded-tr-[17px] object-cover object-right"
                style={{
                  WebkitMaskImage:
                    'linear-gradient(to right, transparent 0%, black 18%)',
                  maskImage:
                    'linear-gradient(to right, transparent 0%, black 18%)',
                }}
              />
            </header>

            <div className="flex flex-1 flex-col px-8 pt-7 pb-5">
              <ul className="space-y-4">
                {CORE_PLAN_FEATURES.map((feature) => (
                  <PlanFeature key={feature}>{feature}</PlanFeature>
                ))}
                <PlanFeature>
                  Privacy controls, audit log, data export, cookie controls
                </PlanFeature>
              </ul>
              <div className="mt-auto border-t border-[#E0E2E8] pt-6">
                {currentPlan === 'self_serve' ? (
                  <button
                    type="button"
                    disabled
                    className="h-12 w-full rounded-[8px] border border-[#DEE1E8] bg-white text-[16px] font-medium text-[#4B3BD4]"
                  >
                    Current
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={switchingTo !== null}
                    onClick={() => void startCheckout('self_serve')}
                    className="h-12 w-full rounded-[8px] border border-[#DCE0E7] bg-white text-[16px] font-medium text-[#4B3BD4] disabled:cursor-not-allowed disabled:opacity-50 disabled:cursor-wait disabled:opacity-70"
                  >
                    {switchingTo === 'self_serve' ? 'Starting checkout...' : 'Switch to Individual'}
                  </button>
                )}
              </div>
            </div>
          </article>

          <article className="flex min-h-[720px] flex-col overflow-hidden rounded-[18px] border border-[#4B3BD4] bg-white">
            <header className="relative aspect-[774/241] w-full shrink-0 overflow-hidden rounded-t-[17px]">
              <img
                src="/team-plan-header.png"
                alt="Team plan, $15 per month"
                className="block h-full w-full object-cover"
              />
              <img
                src="/team-plan-art.png"
                alt=""
                aria-hidden="true"
                className="absolute -top-[7px] right-0 h-[calc(100%+7px)] w-[40%] object-cover object-right"
                style={{
                  WebkitMaskImage:
                    'linear-gradient(to right, transparent 0%, black 18%)',
                  maskImage:
                    'linear-gradient(to right, transparent 0%, black 18%)',
                }}
              />
            </header>

            <div className="flex flex-1 flex-col px-8 pt-7 pb-5">
              <ul className="space-y-4">
                {CORE_PLAN_FEATURES.map((feature) => (
                  <PlanFeature key={feature}>{feature}</PlanFeature>
                ))}
                <li className="border-t border-[#E0E2E8] pt-4">
                  <PlanFeature upcoming>
                    Privacy controls, audit log, data export, cookie controls
                  </PlanFeature>
                </li>
                <PlanFeature upcoming>
                  Privacy controls, audit log, data export, cookie controls
                </PlanFeature>
                <PlanFeature upcoming>
                  Privacy controls, audit log, data export, cookie controls
                </PlanFeature>
              </ul>
              <div className="mt-auto border-t border-[#E0E2E8] pt-6">
                {currentPlan === 'team' ? (
                  <button
                    type="button"
                    disabled
                    className="h-12 w-full rounded-[8px] border border-[#DEE1E8] bg-white text-[16px] font-medium text-[#4B3BD4]"
                  >
                    Current
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={switchingTo !== null}
                    onClick={() => void startCheckout('team')}
                    className="h-12 w-full rounded-[8px] bg-[#4B3BD4] text-[16px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 disabled:cursor-wait disabled:opacity-70"
                  >
                    {switchingTo === 'team' ? 'Starting checkout...' : 'Upgrade'}
                  </button>
                )}
                {checkoutError ? (
                  <p role="alert" className="mt-2 text-[13px] text-[#B4232C]">
                    {checkoutError}
                  </p>
                ) : null}
              </div>
            </div>
          </article>
        </div>
      </section>
    </div>
  )
}

function BillingInformation({
  onClose,
  onUpdate,
}: {
  onClose: () => void
  onUpdate: () => void
}) {
  const invoices = [
    { id: 'invoice-1', date: 'July 07, 2026', total: '$12', status: 'Paid' },
    { id: 'invoice-2', date: 'July 07, 2026', total: '$12', status: 'Paid' },
    { id: 'invoice-3', date: 'July 07, 2026', total: '$12', status: 'Paid' },
    { id: 'invoice-4', date: 'July 07, 2026', total: '$12', status: 'Paid' },
  ]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="billing-information-title"
        className="relative w-full max-w-[1180px] overflow-hidden rounded-[18px] border border-[#E0E2E8] bg-white shadow-[0_24px_70px_rgba(20,24,35,0.22)]"
      >
        <header className="flex min-h-[88px] items-center justify-between border-b border-[#E0E2E8] px-8">
          <h2
            id="billing-information-title"
            className="text-[20px] font-semibold text-[#202027]"
          >
            Billing
          </h2>
          <button
            type="button"
            aria-label="Close billing information"
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center text-[38px] font-light leading-none text-[#4437D5] hover:text-[#2F259E]"
          >
            &times;
          </button>
        </header>

        <div className="flex min-h-[104px] items-center justify-between gap-5 border-b border-[#E0E2E8] px-8 py-5">
          <p className="text-[17px] font-medium text-[#24242A]">Link by Stripe</p>
          <button
            type="button"
            onClick={onUpdate}
            className="h-11 rounded-[8px] border border-[#DEE1E8] bg-white px-8 text-[16px] font-medium text-[#4B3BD4] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Update
          </button>
        </div>

        <div className="px-8 pt-6">
          <h3 className="text-[17px] font-medium text-[#24242A]">Invoices</h3>
        </div>

        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[680px] border-collapse text-left">
            <thead>
              <tr className="border-b border-[#E0E2E8]">
                <th className="px-8 py-4 text-[16px] font-medium text-[#24242A]">Date</th>
                <th className="px-8 py-4 text-[16px] font-medium text-[#24242A]">Total</th>
                <th className="px-8 py-4 text-[16px] font-medium text-[#24242A]">Status</th>
                <th className="px-8 py-4 text-[16px] font-medium text-[#24242A]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr key={invoice.id} className="border-b border-[#E0E2E8] last:border-b-0">
                  <td className="px-8 py-5 text-[15px] text-[#24242A]">{invoice.date}</td>
                  <td className="px-8 py-5 text-[15px] text-[#24242A]">{invoice.total}</td>
                  <td className="px-8 py-5 text-[15px] text-[#24242A]">{invoice.status}</td>
                  <td className="px-8 py-5">
                    <button
                      type="button"
                      className="text-[15px] font-medium text-[#4B3BD4] hover:underline"
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function clearLocalSession() {
  sessionStorage.removeItem(DEMO_EMAIL_KEY)
  sessionStorage.removeItem(WORKSPACES_DONE_KEY)
  sessionStorage.removeItem('locus:connected-tools')
  clearBackendSession()
}

export default function AccountSettings() {
  const navigate = useNavigate()
  const [name, setName] = useState('Locus AI User')
  const [email, setEmail] = useState('No signed-in email')
  const [draftName, setDraftName] = useState(name)
  const [isEditing, setIsEditing] = useState(false)
  const [confirmation, setConfirmation] = useState<'logout' | 'delete' | null>(null)
  const [isPlanPickerOpen, setIsPlanPickerOpen] = useState(false)
  const [isBillingOpen, setIsBillingOpen] = useState(false)
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [isDeletingAccount, setIsDeletingAccount] = useState(false)
  const [accountActionError, setAccountActionError] = useState('')
  const [isExporting, setIsExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const [isSavingName, setIsSavingName] = useState(false)
  const [nameSaveError, setNameSaveError] = useState('')
  // Was a hardcoded "Free" literal in the JSX below, completely disconnected
  // from tenants.plan - it never changed no matter what plan the tenant was
  // actually on, or after actually completing checkout. Real values are
  // 'self_serve' ($12/mo, "Individual") or 'team' ($15/mo) - there is no
  // "Free" plan in the schema.
  const [plan, setPlan] = useState<string | null>(null)

  useEffect(() => {
    const demoEmail = sessionStorage.getItem(DEMO_EMAIL_KEY)
    if (demoEmail) {
      setName('Locus AI User')
      setEmail(demoEmail)
      return
    }

    if (!isSupabaseConfigured()) return

    const supabase = getSupabaseClient()

    const applyUser = (user: User | null) => {
      if (!user) {
        setName('Locus AI User')
        setEmail('No signed-in email')
        return
      }

      const userEmail = user.email ?? 'No signed-in email'
      const emailName =
        user.email
          ?.split('@')[0]
          .split(/[._-]+/)
          .filter(Boolean)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(' ') || 'Locus AI User'
      // Google OAuth sometimes only populates given_name/family_name and
      // leaves full_name/name/display_name empty - falling straight through
      // to the email-derived name in that case showed a name with no
      // relation to the account's real one. Combining the two Google fields
      // first still beats the email guess whenever either is present.
      const googleName = [user.user_metadata.given_name, user.user_metadata.family_name]
        .filter(Boolean)
        .join(' ')
      const displayName =
        user.user_metadata.full_name ||
        user.user_metadata.name ||
        user.user_metadata.display_name ||
        googleName ||
        emailName

      setName(String(displayName))
      setEmail(userEmail)
    }

    void supabase.auth.getSession().then(({ data }) => {
      applyUser(data.session?.user ?? null)
    })

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      applyUser(session?.user ?? null)
    })

    return () => data.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (sessionStorage.getItem(DEMO_EMAIL_KEY)) return
    if (!isSupabaseConfigured()) return
    getTenantPlan()
      .then(setPlan)
      .catch(() => {
        // No real backend session (not signed in, or the tenant-session
        // exchange failed) - leave plan null rather than showing a wrong
        // guess; the badge below just hides in that case.
      })
  }, [])

  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')

  const openEditor = () => {
    setDraftName(name)
    setNameSaveError('')
    setIsEditing(true)
  }

  const saveEditor = async () => {
    const nextName = draftName.trim()
    if (!nextName) return
    setNameSaveError('')

    // Previously only called setName() - a local state update with nothing
    // written back to Supabase, so the edit was lost on the next reload
    // (applyUser() re-derives the name from user_metadata, which never
    // changed) even though the UI showed the new name until then.
    if (isSupabaseConfigured()) {
      setIsSavingName(true)
      const { error } = await getSupabaseClient().auth.updateUser({ data: { full_name: nextName } })
      setIsSavingName(false)
      if (error) {
        setNameSaveError(error.message)
        return
      }
    }

    setName(nextName)
    setIsEditing(false)
  }

  const logOut = async () => {
    setIsSigningOut(true)
    setAccountActionError('')
    clearLocalSession()

    if (isSupabaseConfigured()) {
      const { error } = await getSupabaseClient().auth.signOut()
      if (error) {
        setAccountActionError(error.message)
        setIsSigningOut(false)
        return
      }
    }

    navigate('/', { replace: true })
  }

  const deleteAccount = async () => {
    setIsDeletingAccount(true)
    setAccountActionError('')

    if (!isSupabaseConfigured()) {
      clearLocalSession()
      navigate('/', { replace: true })
      return
    }

    const supabase = getSupabaseClient()
    const { data } = await supabase.auth.getSession()
    if (!data.session) {
      // Demo / local session path
      clearLocalSession()
      navigate('/', { replace: true })
      return
    }

    const { error } = await supabase.functions.invoke('delete-account', {
      body: {},
    })

    if (error) {
      setAccountActionError(error.message)
      setIsDeletingAccount(false)
      return
    }

    clearLocalSession()
    await supabase.auth.signOut({ scope: 'local' })
    navigate('/', { replace: true })
  }

  const exportData = async () => {
    setIsExporting(true)
    setExportError('')

    if (!isSupabaseConfigured()) {
      const demoPayload = {
        exportedAt: new Date().toISOString(),
        email,
        decisions: [],
        actionItems: [],
        blockers: [],
      }
      const file = new Blob([JSON.stringify(demoPayload, null, 2)], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(file)
      const link = document.createElement('a')
      link.href = url
      link.download = `locus-data-export-${new Date().toISOString().slice(0, 10)}.json`
      link.click()
      URL.revokeObjectURL(url)
      setIsExporting(false)
      return
    }

    const supabase = getSupabaseClient()
    const { data: sessionData } = await supabase.auth.getSession()
    if (!sessionData.session) {
      setExportError('Your session has expired. Please sign in again.')
      setIsExporting(false)
      return
    }

    const { data, error } = await supabase.functions.invoke('export-account-data', {
      body: {},
    })

    if (error || !data) {
      setExportError(error?.message ?? 'Unable to export account data.')
      setIsExporting(false)
      return
    }

    const file = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(file)
    const link = document.createElement('a')
    link.href = url
    link.download = `locus-data-export-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
    setIsExporting(false)
  }

  return (
    <>
      <h1 className="text-[28px] font-bold leading-tight text-[#17171D]">Account</h1>
      <p className="mt-1 text-[15px] text-[#7B8393]">Manage your account info.</p>

      <section className="mt-6 overflow-hidden rounded-[8px] border border-[#E1E3E9] bg-white">
        <div className="flex min-h-[100px] flex-col items-stretch justify-between gap-5 px-7 py-5 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-5">
            <div className="flex h-[60px] w-[60px] shrink-0 items-center justify-center rounded-full bg-[#F0EDFF] text-[17px] font-semibold text-[#5947DE]">
              {initials || 'LU'}
            </div>
            {isEditing ? (
              <div className="grid min-w-0 flex-1 grid-cols-[88px_minmax(0,360px)] items-center gap-x-3 gap-y-2.5">
                <label
                  htmlFor="account-name"
                  className="text-[15px] font-medium text-[#24242A]"
                >
                  Full Name
                </label>
                <input
                  id="account-name"
                  value={draftName}
                  placeholder="Please enter"
                  onChange={(event) => setDraftName(event.target.value)}
                  className="h-10 min-w-0 rounded-full border border-[#5947DE] px-4 text-[15px] text-[#25252B] outline-none focus:ring-2 focus:ring-[#5947DE]/15"
                  autoFocus
                />
                <span className="text-[15px] font-medium text-[#24242A]">Email</span>
                <span className="min-w-0 truncate text-[15px] text-[#7A8292]">{email}</span>
                {nameSaveError ? (
                  <p role="alert" className="col-span-2 text-[13px] text-[#B4232C]">
                    {nameSaveError}
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="min-w-0">
                <h2 className="truncate text-[16px] font-semibold text-[#24242A]">{name}</h2>
                <p className="mt-1 truncate text-[15px] text-[#7A8292]">{email}</p>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => void (isEditing ? saveEditor() : openEditor())}
            disabled={isSavingName || (isEditing && !draftName.trim())}
            className="h-11 w-full shrink-0 rounded-[8px] bg-[#4B3BD4] px-8 text-[15px] font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4B3BD4] disabled:cursor-wait disabled:opacity-70 sm:w-auto"
          >
            {isSavingName ? 'Saving...' : isEditing ? 'Save Edit' : 'Edit Info'}
          </button>
        </div>

        <div className="flex min-h-[84px] flex-col items-stretch justify-between gap-3 border-t border-[#E7E8ED] px-7 py-4 sm:flex-row sm:items-center">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-[15px] font-semibold text-[#24242A]">Subscription</h2>
              {plan ? (
                <span className="rounded-full bg-[#E8E9ED] px-2.5 py-1 text-[13px] font-medium text-[#7B8290]">
                  {PLAN_LABELS[plan] ?? plan}
                </span>
              ) : null}
            </div>
            <p className="mt-1.5 text-[14px] text-[#7A8292]">Learn our plans.</p>
          </div>
          <button
            type="button"
            disabled
            className="h-10 shrink-0 rounded-[8px] border border-[#DEE1E8] bg-white px-6 text-[14px] font-semibold text-[#4B3BD4] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Change Plan
          </button>
        </div>

        <div className="flex min-h-[84px] flex-col items-stretch justify-between gap-3 border-t border-[#E7E8ED] px-7 py-4 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-[15px] font-semibold text-[#24242A]">Billing</h2>
            <p className="mt-1.5 text-[14px] text-[#7A8292]">
              Manage your subscription and invoices.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setIsBillingOpen(true)}
            className="h-10 shrink-0 rounded-[8px] border border-[#DEE1E8] bg-white px-6 text-[14px] font-semibold text-[#4B3BD4] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Billing Information
          </button>
        </div>

        <div className="flex min-h-[84px] flex-col items-stretch justify-between gap-3 border-t border-[#E7E8ED] px-7 py-4 sm:flex-row sm:items-center">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-[#24242A]">Export Data</h2>
            <p className="mt-1.5 text-[14px] leading-5 text-[#7A8292]">
              Download all your organizational memory as JSON.
            </p>
            {exportError ? (
              <p role="alert" className="mt-1.5 text-[13px] text-[#B4232C]">
                {exportError}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            disabled={isExporting}
            onClick={() => void exportData()}
            className="h-10 shrink-0 rounded-[8px] border border-[#DEE1E8] bg-white px-6 text-[14px] font-semibold text-[#4B3BD4] disabled:cursor-not-allowed disabled:opacity-50 disabled:cursor-wait disabled:opacity-60"
          >
            {isExporting ? 'Exporting...' : 'Export'}
          </button>
        </div>

        <div className="flex min-h-[84px] flex-col items-stretch justify-between gap-3 border-t border-[#E7E8ED] px-7 py-4 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-[15px] font-semibold text-[#24242A]">Log Out</h2>
            <p className="mt-1.5 text-[14px] leading-5 text-[#7A8292]">
              Sign out of your account. You can log back in at any time.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setAccountActionError('')
              setConfirmation('logout')
            }}
            className="h-10 shrink-0 rounded-[8px] border border-[#DEE1E8] bg-white px-6 text-[14px] font-semibold text-[#4B3BD4] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Log Out
          </button>
        </div>

        <div className="flex min-h-[84px] flex-col items-stretch justify-between gap-3 border-t border-[#E7E8ED] px-7 py-4 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-[15px] font-semibold text-[#24242A]">Delete Account</h2>
            <p className="mt-1.5 text-[14px] leading-5 text-[#7A8292]">
              Permanently delete your account and all associated data. This cannot be
              undone.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setAccountActionError('')
              setConfirmation('delete')
            }}
            className="flex h-10 shrink-0 items-center gap-2 rounded-[8px] border border-[#F5C2C0] bg-white px-6 text-[14px] font-semibold text-[#B4232C] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <TrashIcon />
            Delete
          </button>
        </div>
      </section>

      {confirmation ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4"
          role="presentation"
          onMouseDown={(event) => {
            if (
              event.target === event.currentTarget &&
              !isSigningOut &&
              !isDeletingAccount
            ) {
              setConfirmation(null)
            }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-confirmation-title"
            className="relative w-full max-w-[500px] rounded-[8px] bg-white p-8 shadow-[0_20px_55px_rgba(17,24,39,0.22)]"
          >
            <button
              type="button"
              aria-label="Close dialog"
              disabled={isSigningOut || isDeletingAccount}
              onClick={() => setConfirmation(null)}
              className="absolute top-4 right-4 flex h-8 w-8 items-center justify-center text-[28px] font-light leading-none text-[#5042D7] hover:text-[#372AAE] disabled:opacity-50"
            >
              &times;
            </button>
            <div
              className={`flex h-12 w-12 items-center justify-center rounded-full ${
                confirmation === 'delete'
                  ? 'bg-[#FFF1F1] text-[#D93636]'
                  : 'bg-[#F0F8FF] text-[#4B3BD4]'
              }`}
            >
              {confirmation === 'delete' ? (
                <TrashIcon />
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M8 3h8M7 5h10v14H7zM9.5 12l1.7 1.7L15 9.8"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </div>
            <h2
              id="account-confirmation-title"
              className="mt-5 text-[20px] font-semibold text-[#202027]"
            >
              {confirmation === 'delete' ? 'Delete account?' : 'Log out of Locus AI?'}
            </h2>
            <p className="mt-3 text-[15px] leading-6 text-[#7A8292]">
              {confirmation === 'delete'
                ? 'This will permanently delete your account and all associated organizational memory and data. This action cannot be undone.'
                : "You'll be signed out of your account on this device. Your data and settings will be saved."}
            </p>
            {accountActionError ? (
              <p role="alert" className="mt-3 text-[14px] text-[#B4232C]">
                {accountActionError}
              </p>
            ) : null}
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                type="button"
                disabled={isSigningOut || isDeletingAccount}
                onClick={() => setConfirmation(null)}
                className="h-11 rounded-[7px] border border-[#DEE1E8] bg-white px-4 text-[15px] font-semibold text-[#4B3BD4] disabled:cursor-not-allowed disabled:opacity-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isSigningOut || isDeletingAccount}
                onClick={
                  confirmation === 'logout'
                    ? () => void logOut()
                    : () => void deleteAccount()
                }
                className={`h-11 rounded-[7px] px-5 text-[15px] font-semibold text-white disabled:cursor-wait disabled:opacity-60 ${
                  confirmation === 'delete'
                    ? 'bg-[#9D2A26] disabled:cursor-not-allowed disabled:opacity-50'
                    : 'bg-[#4B3BD4] disabled:cursor-not-allowed disabled:opacity-50'
                }`}
              >
                {confirmation === 'delete'
                  ? isDeletingAccount
                    ? 'Deleting account...'
                    : 'Yes, delete my account'
                  : isSigningOut
                    ? 'Logging out...'
                    : 'Log out'}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {isPlanPickerOpen ? (
        <PlanPicker onClose={() => setIsPlanPickerOpen(false)} currentPlan={plan ?? 'self_serve'} />
      ) : null}

      {isBillingOpen ? (
        <BillingInformation
          onClose={() => setIsBillingOpen(false)}
          onUpdate={() => {
            setIsBillingOpen(false)
            setIsPlanPickerOpen(true)
          }}
        />
      ) : null}
    </>
  )
}
