import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import AccountSettings from './AccountSettings'
import { getSupabaseClient } from '../lib/supabase'
import { DEMO_EMAIL_KEY, WORKSPACES_DONE_KEY } from '../lib/sessionKeys'
import { SourceLogo, type SourceName } from '../components/SourceLogo'
import {
  connectSource,
  disconnectSource,
  fetchSourceConnections,
  type SourceConnectionRow,
  type SourceId,
  type SyncMode,
} from '../lib/sourceConnections'

type SettingsSection =
  | 'Account'
  | 'Team'
  | 'Connected Sources'
  | 'Build Memory'
  | 'Privacy'
  | 'Search'
  | 'Notifications'

type CaptureMode = 'decisions-actions' | 'decisions-only'
type SourceFilter = 'All' | 'Gmail' | 'Notion' | 'Slack' | 'Jira' | 'Confluence' | 'Discord' | 'GitHub' | 'Monday' | 'ClickUp' | 'Teams'
type CaptureSource = 'slack' | 'notion' | 'gmail' | 'jira' | 'confluence' | 'discord' | 'github' | 'monday' | 'clickup' | 'teams'

type ChannelRow = {
  id: string
  name: string
  included: boolean
  app: SourceFilter
  source: CaptureSource
  itemId: string
}

const SOURCE_APP_LABELS: Record<CaptureSource, Exclude<SourceFilter, 'All'>> = {
  slack: 'Slack',
  notion: 'Notion',
  gmail: 'Gmail',
  jira: 'Jira',
  confluence: 'Confluence',
  discord: 'Discord',
  github: 'GitHub',
  monday: 'Monday',
  clickup: 'ClickUp',
  teams: 'Teams',
}

type SearchHistoryItem = {
  id: string
  query: string
  result_count: number
  searched_at: string
}

const SIDEBAR_ITEMS: { id: SettingsSection; label: string }[] = [
  { id: 'Account', label: 'Account' },
  { id: 'Team', label: 'Team' },
  { id: 'Connected Sources', label: 'Connected Sources' },
  { id: 'Build Memory', label: 'Build Memory' },
  { id: 'Privacy', label: 'Privacy' },
  { id: 'Search', label: 'Search' },
  { id: 'Notifications', label: 'Notifications' },
]

const SOURCE_FILTERS: SourceFilter[] = ['All', 'Gmail', 'Notion', 'Slack', 'Jira', 'Confluence', 'Discord', 'GitHub', 'Monday', 'ClickUp']

function AccountIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M5 19.5c0-3.6 3.1-6 7-6s7 2.4 7 6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}

function LightningIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M13 2L4 14h7l-1 8 10-14h-7l0-6z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function PeopleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="9" cy="8" r="3" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3.5 20c0-3.3 2.5-6 5.5-6s5.5 2.7 5.5 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M16 8.2a2.8 2.8 0 010 5.5M18.5 20c0-2.9-1.9-5.3-4.4-5.9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function HashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9 4L7 20M17 4l-2 16M4 9h16M3 15h16"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}

function ShieldIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function BellIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 10a6 6 0 1112 0c0 4 1.5 5.5 1.5 5.5H4.5S6 14 6 10z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M10 19a2 2 0 004 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 4v10M8 10l4 4 4-4M5 18h14"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function TrashIcon({ color = 'currentColor' }: { color?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 7h16M9 7V5h6v2M8 7l1 12h6l1-12"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8" stroke="#5A45FF" strokeWidth="1.8" />
      <path d="M12 8v4.5l3 2" stroke="#5A45FF" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: () => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
        checked ? 'bg-[#5A45FF]' : 'bg-[#D1D5DB]'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  )
}

const SIDEBAR_ICONS: Record<SettingsSection, ReactNode> = {
  Account: <AccountIcon />,
  Team: <PeopleIcon />,
  'Connected Sources': <LightningIcon />,
  'Build Memory': <HashIcon />,
  Privacy: <ShieldIcon />,
  Search: <SearchIcon />,
  Notifications: <BellIcon />,
}

function formatSearchAge(searchedAt: string, now = Date.now()) {
  const elapsedMs = Math.max(0, now - new Date(searchedAt).getTime())
  const hours = Math.max(1, Math.floor(elapsedMs / 3_600_000))

  if (elapsedMs < 86_400_000) {
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  }

  const days = Math.floor(elapsedMs / 86_400_000)
  if (days < 7) return `${days} ${days === 1 ? 'day' : 'days'} ago`

  const weeks = Math.floor(days / 7)
  if (days < 30) return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`

  const months = Math.floor(days / 30)
  if (days < 365) {
    return `${months} ${months === 1 ? 'month' : 'months'} ago`
  }

  const years = Math.floor(days / 365)
  return `${years} ${years === 1 ? 'year' : 'years'} ago`
}

function SearchSettings() {
  const [items, setItems] = useState<SearchHistoryItem[]>([])
  const [total, setTotal] = useState(0)
  const [saveHistory, setSaveHistory] = useState(true)
  const [isLoading, setIsLoading] = useState(true)
  const [isUpdating, setIsUpdating] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true

    const loadHistory = async () => {
      const supabase = getSupabaseClient()
      const { data: sessionData } = await supabase.auth.getSession()
      if (!sessionData.session) {
        if (active) {
          setError('Your session has expired. Please sign in again.')
          setIsLoading(false)
        }
        return
      }

      const { data, error: historyError } = await supabase.functions.invoke(
        'search-history',
        { body: { action: 'list' } },
      )

      if (!active) return
      if (historyError) {
        setError(historyError.message)
      } else {
        setItems((data?.items ?? []) as SearchHistoryItem[])
        setTotal(Number(data?.total ?? 0))
        setSaveHistory(data?.saveHistory !== false)
      }
      setIsLoading(false)
    }

    void loadHistory()
    return () => {
      active = false
    }
  }, [])

  const toggleHistory = async () => {
    const nextValue = !saveHistory
    setIsUpdating(true)
    setError('')

    const { error: toggleError } = await getSupabaseClient().functions.invoke(
      'search-history',
      { body: { action: 'toggle', enabled: nextValue } },
    )

    if (toggleError) {
      setError(toggleError.message)
    } else {
      setSaveHistory(nextValue)
    }
    setIsUpdating(false)
  }

  const clearHistory = async () => {
    setIsUpdating(true)
    setError('')

    const { error: clearError } = await getSupabaseClient().functions.invoke(
      'search-history',
      { body: { action: 'clear' } },
    )

    if (clearError) {
      setError(clearError.message)
    } else {
      setItems([])
      setTotal(0)
    }
    setIsUpdating(false)
  }

  const downloadHistory = async () => {
    setIsDownloading(true)
    setError('')

    const { data, error: downloadError } =
      await getSupabaseClient().functions.invoke('search-history', {
        body: { action: 'download' },
      })

    if (downloadError || !data) {
      setError(downloadError?.message ?? 'Unable to download search history.')
      setIsDownloading(false)
      return
    }

    const file = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(file)
    const link = document.createElement('a')
    link.href = url
    link.download = `locus-search-history-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
    setIsDownloading(false)
  }

  return (
    <>
      <h1 className="text-[28px] font-bold tracking-[-0.02em] text-[#111827]">
        Search
      </h1>
      <p className="mt-1 text-[14px] text-[#6B7280]">
        Ask anything your organization already knows
      </p>

      <div className="mt-8 rounded-2xl border border-[#E8E8ED] bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[15px] font-semibold text-[#111827]">
              Save search history
            </p>
            <p className="mt-1 max-w-[560px] text-[13px] leading-relaxed text-[#6B7280]">
              Store your searches so you can revisit and download your history.
            </p>
          </div>
          <Toggle
            checked={saveHistory}
            onChange={() => void toggleHistory()}
            label="Save search history"
          />
        </div>
        {isUpdating ? null : null}
      </div>

      <section className="mt-8">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-[11px] font-semibold tracking-[0.08em] text-[#9CA3AF] uppercase">
              Recent Searches
            </h3>
            <p className="mt-1 text-[13px] font-semibold text-[#5A45FF]">
              Showing {Math.min(total, 20)} Recent {total === 1 ? 'Query' : 'Queries'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={isLoading || isDownloading || total === 0}
              onClick={() => void downloadHistory()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#DEE1E8] bg-white px-3 py-1.5 text-[13px] font-semibold text-[#4B3BD4] transition-colors hover:bg-[#F8F7FF] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <DownloadIcon />
              {isDownloading ? 'Downloading...' : 'Download Log'}
            </button>
            <button
              type="button"
              disabled={isLoading || isUpdating || total === 0}
              onClick={() => void clearHistory()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#FECACA] bg-white px-3 py-1.5 text-[13px] font-semibold text-[#DC2626] transition-colors hover:bg-[#FEF2F2]"
            >
              <TrashIcon color="#DC2626" />
              Clear All
            </button>
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-[#E8E8ED] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
          <div className="grid grid-cols-[1fr_auto] gap-4 border-b border-[#F0F0F4] px-5 py-3">
            <p className="text-[12px] font-semibold text-[#9CA3AF]">Query</p>
            <p className="text-[12px] font-semibold text-[#9CA3AF]">results</p>
          </div>
          {isLoading ? (
            <p className="px-5 py-8 text-[14px] text-[#6B7280]">Loading search history...</p>
          ) : items.length === 0 ? (
            <p className="px-5 py-8 text-[14px] text-[#6B7280]">No recent searches.</p>
          ) : (
            items.slice(0, 20).map((item, index) => (
              <div
                key={item.id}
                className={`grid grid-cols-[1fr_auto] items-center gap-4 px-5 py-4 ${
                  index < Math.min(items.length, 20) - 1 ? 'border-b border-[#F0F0F4]' : ''
                }`}
              >
                <div>
                  <p className="text-[14px] font-semibold text-[#111827]">{item.query}</p>
                  <p className="mt-1 text-[12px] text-[#9CA3AF]">{formatSearchAge(item.searched_at)}</p>
                </div>
                <p className="text-[14px] text-[#111827]">
                  <span className="font-bold">{item.result_count}</span> results
                </p>
              </div>
            ))
          )}
        </div>

        {error ? (
          <p role="alert" className="mt-3 text-[13px] text-[#B4232C]">
            {error}
          </p>
        ) : null}
      </section>
    </>
  )
}

const CONNECTED_SOURCE_META: { id: SourceId; name: SourceName; description: string }[] = [
  {
    id: 'slack',
    name: 'Slack',
    description: "Capture decisions from channels and threads you're already in.",
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Capture decisions from docs, wikis, and databases.',
  },
  {
    id: 'gmail',
    name: 'Gmail',
    description: 'Capture decisions from email threads and replies.',
  },
  {
    id: 'jira',
    name: 'Jira',
    description: 'Capture decisions from issues and comments.',
  },
  {
    id: 'confluence',
    name: 'Confluence',
    description: 'Capture decisions from pages and spaces.',
  },
  {
    id: 'discord',
    name: 'Discord',
    description: 'Capture decisions from server channels.',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Capture decisions from issues, pull requests, and comments.',
  },
  {
    id: 'monday',
    name: 'Monday',
    description: 'Capture decisions from boards, items, and updates.',
  },
  {
    id: 'clickup',
    name: 'ClickUp',
    description: 'Capture decisions from tasks and comments.',
  },
  {
    id: 'teams',
    name: 'Teams',
    description: 'Capture decisions from channel conversations. A Microsoft 365 admin must approve this once for your organisation.',
  },
]

function formatConnectedSourceSync(info: { status: string; last_synced_at: string | null }) {
  if (info.status !== 'active') return 'Not connected'
  if (!info.last_synced_at) return 'Connected, not yet synced'

  const elapsedMs = Math.max(0, Date.now() - new Date(info.last_synced_at).getTime())
  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 1) return 'Synced just now'
  if (minutes < 60) return `Synced ${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Synced ${hours}h ago`
  return `Synced ${Math.floor(hours / 24)}d ago`
}

// Gmail's external_workspace_id already IS the real email, so display_name
// duplicates it - fine either way. Slack/Notion connected before display_name
// existed have no label at all here, since the OAuth response's team/
// workspace name was never captured or stored anywhere for those rows.
function connectionLabel(row: SourceConnectionRow): string | null {
  return row.display_name ?? row.external_workspace_id ?? null
}

/**
 * Roles are ordered, and the order is what the UI has to test against.
 *
 * Checks here used to read `role !== 'member'`, which was an exhaustive test
 * of "is this person privileged" when member was the only unprivileged role.
 * With Guest added it silently stopped being one - a contractor is not
 * 'member', so they would have been shown the whole management surface. Level
 * comparisons do not rot that way when a role is added.
 */
const ROLE_LEVELS: Record<string, number> = { owner: 5, admin: 4, lead: 3, member: 2, guest: 1 }
const LEVEL_MEMBER = 2

function levelOf(member: TeamMember | undefined): number {
  if (!member) return 0
  return member.role_level ?? ROLE_LEVELS[member.role] ?? 0
}

type TeamMember = {
  membership_id: string
  user_id: string
  email: string | null
  display_name: string | null
  role: string
  role_level?: number
  can_manage_connectors?: boolean
  can_view_audit?: boolean
  expires_at?: string | null
  expired?: boolean
  joined_at: string
  is_self: boolean
}
type PendingInvite = { id: string; email: string; role: string; created_at: string }

async function invokeTeamInvites<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<{ data?: T; error?: string }> {
  const { data, error } = await getSupabaseClient().functions.invoke('team-invites', { body })
  if (error) return { error: error.message }
  if (data?.error) return { error: String(data.error) }
  return { data }
}

/**
 * Settings > Team - lets a workspace owner/admin invite a teammate into
 * this SAME tenant (not a new solo one - see supabase/functions/
 * team-invites/index.ts's own header for why every signup used to get its
 * own tenant with no way to join an existing one). Structure mirrors
 * ConnectedSourcesSettings just below: rounded-2xl card, per-row
 * border-b, icon/name left + status/action right, same dialog shape for
 * the invite modal.
 */
function TeamSettings() {
  const navigate = useNavigate()
  const [members, setMembers] = useState<TeamMember[]>([])
  const [invites, setInvites] = useState<PendingInvite[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  const [isInviteOpen, setIsInviteOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'guest' | 'member' | 'lead' | 'admin'>('member')
  const [isInviting, setIsInviting] = useState(false)
  const [inviteError, setInviteError] = useState('')
  const [inviteResult, setInviteResult] = useState<{ url: string; emailSent: boolean } | null>(null)
  const [copied, setCopied] = useState(false)

  const [removeTarget, setRemoveTarget] = useState<TeamMember | null>(null)
  const [isRemoving, setIsRemoving] = useState(false)
  const [removeError, setRemoveError] = useState('')

  const [isLeaveOpen, setIsLeaveOpen] = useState(false)
  const [isLeaving, setIsLeaving] = useState(false)
  const [leaveError, setLeaveError] = useState('')

  // Real gap this closes: handle_new_user() names every new tenant after
  // the founder's own personal name/email ("Abbas Rahman", not a company
  // name) - fine for a solo signup, not once other people join it.
  const [workspaceName, setWorkspaceName] = useState('')
  const [isEditingName, setIsEditingName] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const [isSavingName, setIsSavingName] = useState(false)
  const [nameError, setNameError] = useState('')

  // Real, server-enforced distinction (team-invites' create action rejects
  // invites outright when this isn't 'team'), not just a UI nicety - an
  // individual (self_serve) workspace genuinely can never invite anyone,
  // chosen once on ChooseWorkspaceScreen and never upgraded afterward.
  const [workspacePlan, setWorkspacePlan] = useState<string | null>(null)

  const loadTeam = () =>
    Promise.all([
      invokeTeamInvites<{ members: TeamMember[]; workspace_name: string | null; workspace_plan: string | null }>({ action: 'members' }),
      invokeTeamInvites<{ invites: PendingInvite[] }>({ action: 'list' }),
    ]).then(([membersResult, invitesResult]) => {
      if (membersResult.error) throw new Error(membersResult.error)
      if (invitesResult.error) throw new Error(invitesResult.error)
      setMembers(membersResult.data?.members ?? [])
      setInvites(invitesResult.data?.invites ?? [])
      setWorkspaceName(membersResult.data?.workspace_name ?? '')
      setWorkspacePlan(membersResult.data?.workspace_plan ?? null)
    })

  useEffect(() => {
    let active = true
    loadTeam()
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Unable to load your team.')
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const canManage = levelOf(members.find((m) => m.is_self)) > LEVEL_MEMBER
  const canInvite = canManage && workspacePlan === 'team'

  const openEditName = () => {
    setNameInput(workspaceName)
    setNameError('')
    setIsEditingName(true)
  }

  const handleSaveName = async () => {
    const trimmed = nameInput.trim()
    if (!trimmed) {
      setNameError('Enter a workspace name.')
      return
    }
    setIsSavingName(true)
    setNameError('')

    const result = await invokeTeamInvites<{ name: string }>({ action: 'rename_workspace', name: trimmed })
    if (result.error || !result.data) {
      setNameError(result.error ?? 'Unable to rename workspace.')
      setIsSavingName(false)
      return
    }
    setWorkspaceName(result.data.name)
    setIsEditingName(false)
    setIsSavingName(false)
  }

  const openInvite = () => {
    setInviteEmail('')
    setInviteRole('member')
    setInviteError('')
    setInviteResult(null)
    setCopied(false)
    setIsInviteOpen(true)
  }

  const handleInvite = async () => {
    if (!inviteEmail.trim()) {
      setInviteError('Enter an email address.')
      return
    }
    setIsInviting(true)
    setInviteError('')

    const result = await invokeTeamInvites<{ invite_url: string; email_sent: boolean }>({
      action: 'create', email: inviteEmail.trim(), role: inviteRole,
    })
    if (result.error || !result.data) {
      setInviteError(result.error ?? 'Unable to send invite.')
      setIsInviting(false)
      return
    }
    setInviteResult({ url: result.data.invite_url, emailSent: result.data.email_sent })
    await loadTeam().catch(() => {
      // Invite still succeeded even if this refresh fails - not worth
      // surfacing a second error on top of a successful action.
    })
    setIsInviting(false)
  }

  const handleRevoke = async (inviteId: string) => {
    setInvites((current) => current.filter((i) => i.id !== inviteId))
    const result = await invokeTeamInvites({ action: 'revoke', invite_id: inviteId })
    if (result.error) {
      setError(result.error)
      await loadTeam().catch(() => undefined)
    }
  }

  const handleRemoveMember = async () => {
    if (!removeTarget) return
    setIsRemoving(true)
    setRemoveError('')

    const result = await invokeTeamInvites({ action: 'remove_member', membership_id: removeTarget.membership_id })
    if (result.error) {
      setRemoveError(result.error)
      setIsRemoving(false)
      return
    }
    setMembers((current) => current.filter((m) => m.membership_id !== removeTarget.membership_id))
    setRemoveTarget(null)
    setIsRemoving(false)
  }

  const handleLeaveTeam = async () => {
    setIsLeaving(true)
    setLeaveError('')

    const result = await invokeTeamInvites({ action: 'leave_team' })
    if (result.error) {
      setLeaveError(result.error)
      setIsLeaving(false)
      return
    }
    // Same signOut + redirect shape SettingsPage's own logout handler
    // uses - simplest, already-proven way to land back on a clean
    // sign-in state rather than lean on WaitlistScreen's "pending
    // approval" wording, which doesn't really fit "you just left".
    sessionStorage.removeItem(DEMO_EMAIL_KEY)
    sessionStorage.removeItem(WORKSPACES_DONE_KEY)
    sessionStorage.removeItem('locus:connected-tools')
    await getSupabaseClient().auth.signOut()
    navigate('/', { replace: true })
  }

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-[#9CA3AF]">Team workspace</p>
          {isEditingName ? (
            <div className="mt-1">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={nameInput}
                  onChange={(event) => setNameInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void handleSaveName()
                    if (event.key === 'Escape') setIsEditingName(false)
                  }}
                  autoFocus
                  maxLength={80}
                  className="min-w-0 flex-1 rounded-lg border border-[#5A45FF] px-3 py-1.5 text-[24px] font-bold tracking-[-0.02em] text-[#111827] outline-none"
                />
                <button
                  type="button"
                  onClick={() => void handleSaveName()}
                  disabled={isSavingName}
                  className="shrink-0 rounded-lg bg-[#4B3BD4] px-3 py-2 text-[13px] font-semibold text-white hover:bg-[#3F2FBF] disabled:cursor-wait disabled:opacity-70"
                >
                  {isSavingName ? 'Saving...' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => setIsEditingName(false)}
                  disabled={isSavingName}
                  className="shrink-0 rounded-lg border border-[#DEE1E8] bg-white px-3 py-2 text-[13px] font-semibold text-[#374151] hover:bg-[#F9FAFB]"
                >
                  Cancel
                </button>
              </div>
              {nameError ? <p role="alert" className="mt-1.5 text-[13px] text-[#B4232C]">{nameError}</p> : null}
            </div>
          ) : (
            <div className="mt-0.5 flex items-center gap-2">
              <h1 className="truncate text-[28px] font-bold tracking-[-0.02em] text-[#111827]">
                {workspaceName || 'Untitled workspace'}
              </h1>
              {canManage ? (
                <button
                  type="button"
                  onClick={openEditName}
                  className="shrink-0 rounded-md px-2 py-1 text-[13px] font-medium text-[#4B3BD4] hover:bg-[#F8F7FF]"
                >
                  Edit
                </button>
              ) : null}
            </div>
          )}
          <p className="mt-1 text-[14px] text-[#6B7280]">
            Everyone here shares this workspace's decisions, blockers, and action items - each person connects their own tools.
          </p>
          {canManage && workspacePlan === 'self_serve' ? (
            <p className="mt-1 text-[13px] text-[#9CA3AF]">
              This is an individual account - it can't invite teammates. Create a separate team account to do that.
            </p>
          ) : null}
        </div>
        {canInvite ? (
          <button
            type="button"
            onClick={openInvite}
            className="shrink-0 rounded-lg bg-[#4B3BD4] px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[#3F2FBF]"
          >
            Invite teammate
          </button>
        ) : null}
      </div>

      <div className="mt-8 overflow-hidden rounded-2xl border border-[#E8E8ED] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
        {isLoading ? (
          <p className="px-5 py-12 text-center text-[14px] text-[#6B7280]">Loading team...</p>
        ) : (
          members.map((member, index) => (
            <div
              key={member.membership_id}
              className={`flex items-center justify-between gap-3 px-5 py-4 ${
                index < members.length - 1 || invites.length > 0 ? 'border-b border-[#F0F0F4]' : ''
              }`}
            >
              <div className="min-w-0">
                <p className="truncate text-[14px] font-semibold text-[#111827]">
                  {member.display_name ?? member.email ?? 'Team member'}
                  {member.is_self ? <span className="ml-1.5 text-[13px] font-normal text-[#9CA3AF]">(you)</span> : null}
                </p>
                {member.display_name && member.email ? (
                  <p className="truncate text-[13px] text-[#9CA3AF]">{member.email}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="rounded-full bg-[#F3F4F6] px-2.5 py-1 text-[12px] font-medium capitalize text-[#4B5563]">
                  {member.role}
                </span>
                {/* A guest past their window keeps their row but sees nothing
                    above Public, so the list has to say so rather than showing
                    them as an ordinary member. */}
                {member.expired ? (
                  <span className="rounded-full bg-[#FEF2F2] px-2.5 py-1 text-[12px] font-medium text-[#B4232C]">
                    Expired
                  </span>
                ) : member.expires_at ? (
                  <span className="rounded-full bg-[#FFF7ED] px-2.5 py-1 text-[12px] font-medium text-[#9A5B08]">
                    Until {new Date(member.expires_at).toLocaleDateString()}
                  </span>
                ) : null}
                {/* You may only act on someone below you. An Owner can now
                    remove a co-Owner - the server still refuses to remove the
                    last one - where before nobody could remove an Owner at
                    all and a co-Owner was effectively permanent. */}
                {canManage && !member.is_self &&
                    levelOf(members.find((m) => m.is_self)) > levelOf(member) ? (
                  <button
                    type="button"
                    onClick={() => {
                      setRemoveTarget(member)
                      setRemoveError('')
                    }}
                    className="rounded-lg border border-[#DEE1E8] bg-white px-3 py-1.5 text-[13px] font-semibold text-[#DC2626] transition-colors hover:bg-[#FEF2F2]"
                  >
                    Remove
                  </button>
                ) : null}
                {member.is_self && member.role !== 'owner' ? (
                  <button
                    type="button"
                    onClick={() => {
                      setIsLeaveOpen(true)
                      setLeaveError('')
                    }}
                    className="rounded-lg border border-[#DEE1E8] bg-white px-3 py-1.5 text-[13px] font-semibold text-[#DC2626] transition-colors hover:bg-[#FEF2F2]"
                  >
                    Leave
                  </button>
                ) : null}
              </div>
            </div>
          ))
        )}

        {invites.map((invite, index) => (
          <div
            key={invite.id}
            className={`flex items-center justify-between gap-3 px-5 py-4 ${
              index < invites.length - 1 ? 'border-b border-[#F0F0F4]' : ''
            }`}
          >
            <div className="min-w-0">
              <p className="truncate text-[14px] font-semibold text-[#111827]">{invite.email}</p>
              <p className="text-[13px] text-[#9CA3AF]">Invited, not yet accepted</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="rounded-full bg-[#FEF3C7] px-2.5 py-1 text-[12px] font-medium capitalize text-[#92400E]">
                Pending · {invite.role}
              </span>
              {canManage ? (
                <button
                  type="button"
                  onClick={() => void handleRevoke(invite.id)}
                  className="rounded-lg border border-[#DEE1E8] bg-white px-3 py-1.5 text-[13px] font-semibold text-[#DC2626] transition-colors hover:bg-[#FEF2F2]"
                >
                  Revoke
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      {error ? (
        <p role="alert" className="mt-3 text-[13px] text-[#B4232C]">
          {error}
        </p>
      ) : null}

      {isInviteOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !isInviting) setIsInviteOpen(false)
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="invite-teammate-title"
            className="w-full max-w-[440px] rounded-[12px] bg-white p-6 shadow-[0_20px_55px_rgba(17,24,39,0.22)]"
          >
            <h2 id="invite-teammate-title" className="text-[18px] font-semibold text-[#111827]">
              Invite a teammate
            </h2>

            {inviteResult ? (
              <>
                <p className="mt-2 text-[14px] leading-5 text-[#6B7280]">
                  {inviteResult.emailSent
                    ? `Invite sent to ${inviteEmail.trim()}. You can also share this link directly:`
                    : "Couldn't send the email automatically - copy this link and send it yourself:"}
                </p>
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-[#DEE1E8] bg-[#FAFAFB] px-3 py-2">
                  <code className="min-w-0 flex-1 truncate text-[12px] text-[#111827]">{inviteResult.url}</code>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(inviteResult.url)
                      setCopied(true)
                    }}
                    className="shrink-0 rounded-md border border-[#DEE1E8] bg-white px-2.5 py-1 text-[12px] font-semibold text-[#4B3BD4] hover:bg-[#F8F7FF]"
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setIsInviteOpen(false)}
                  className="mt-5 w-full rounded-lg bg-[#4B3BD4] px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-[#3F2FBF]"
                >
                  Done
                </button>
              </>
            ) : (
              <>
                <p className="mt-2 text-[14px] leading-5 text-[#6B7280]">
                  They'll join this workspace and share everything already captured here.
                </p>

                <label className="mt-4 block text-[13px] font-medium text-[#374151]">
                  Email
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={(event) => setInviteEmail(event.target.value)}
                    placeholder="teammate@company.com"
                    className="mt-1.5 w-full rounded-lg border border-[#DEE1E8] px-3 py-2 text-[14px] text-[#111827] outline-none focus:border-[#5A45FF]"
                  />
                </label>

                <label className="mt-3 block text-[13px] font-medium text-[#374151]">
                  Role
                  <select
                    value={inviteRole}
                    onChange={(event) =>
                      setInviteRole(event.target.value as 'guest' | 'member' | 'lead' | 'admin')}
                    className="mt-1.5 w-full rounded-lg border border-[#DEE1E8] px-3 py-2 text-[14px] text-[#111827] outline-none focus:border-[#5A45FF]"
                  >
                    {/* Ordered least to most, so the safe choice reads first
                        and Admin is a deliberate scroll rather than the
                        neighbour of the default. Owner is absent on purpose:
                        ownership is transferred, never sent in a link. */}
                    <option value="guest">Guest &middot; read-only, expires</option>
                    <option value="member">Member &middot; search and read</option>
                    <option value="lead">Lead &middot; owns scopes, team digest</option>
                    <option value="admin">Admin &middot; members and connectors</option>
                  </select>
                  <p className="mt-1.5 text-[12px] leading-4 text-[#9CA3AF]">
                    {inviteRole === 'guest'
                      ? 'Sees only public records in the scopes you grant, and loses access after 30 days.'
                      : inviteRole === 'member'
                      ? 'Sees ordinary records in the channels and pages they belong to.'
                      : inviteRole === 'lead'
                      ? 'Everything a member sees, plus sensitive records in their own scopes.'
                      : 'Manages people, connectors and policy. Sensitive records in their own scopes only.'}
                  </p>
                </label>

                {inviteError ? (
                  <p role="alert" className="mt-2 text-[13px] text-[#B4232C]">
                    {inviteError}
                  </p>
                ) : null}

                <div className="mt-5 grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => setIsInviteOpen(false)}
                    disabled={isInviting}
                    className="rounded-lg border border-[#DEE1E8] bg-white px-4 py-2.5 text-[14px] font-semibold text-[#374151] hover:bg-[#F9FAFB] disabled:opacity-60"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleInvite()}
                    disabled={isInviting}
                    className="rounded-lg bg-[#4B3BD4] px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-[#3F2FBF] disabled:cursor-wait disabled:opacity-70"
                  >
                    {isInviting ? 'Sending...' : 'Send invite'}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      ) : null}

      {removeTarget ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !isRemoving) setRemoveTarget(null)
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="remove-member-title"
            className="w-full max-w-[400px] rounded-[12px] bg-white p-6 shadow-[0_20px_55px_rgba(17,24,39,0.22)]"
          >
            <h2 id="remove-member-title" className="text-[18px] font-semibold text-[#111827]">
              Remove {removeTarget.display_name ?? removeTarget.email}?
            </h2>
            <p className="mt-2 text-[14px] leading-5 text-[#6B7280]">
              They'll lose access to this workspace immediately. Anything they connected stays unless disconnected separately.
            </p>
            {removeError ? (
              <p role="alert" className="mt-2 text-[13px] text-[#B4232C]">
                {removeError}
              </p>
            ) : null}
            <div className="mt-5 grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => setRemoveTarget(null)}
                disabled={isRemoving}
                className="rounded-lg border border-[#DEE1E8] bg-white px-4 py-2.5 text-[14px] font-semibold text-[#374151] hover:bg-[#F9FAFB] disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleRemoveMember()}
                disabled={isRemoving}
                className="rounded-lg bg-[#DC2626] px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-[#B91C1C] disabled:cursor-wait disabled:opacity-70"
              >
                {isRemoving ? 'Removing...' : 'Remove'}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {isLeaveOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !isLeaving) setIsLeaveOpen(false)
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="leave-team-title"
            className="w-full max-w-[400px] rounded-[12px] bg-white p-6 shadow-[0_20px_55px_rgba(17,24,39,0.22)]"
          >
            <h2 id="leave-team-title" className="text-[18px] font-semibold text-[#111827]">
              Leave {workspaceName || 'this workspace'}?
            </h2>
            <p className="mt-2 text-[14px] leading-5 text-[#6B7280]">
              You'll lose access immediately. Anything you personally connected (Gmail, Slack, etc.) will be
              disconnected too - what's already been captured stays as the team's shared history.
            </p>
            {leaveError ? (
              <p role="alert" className="mt-2 text-[13px] text-[#B4232C]">
                {leaveError}
              </p>
            ) : null}
            <div className="mt-5 grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => setIsLeaveOpen(false)}
                disabled={isLeaving}
                className="rounded-lg border border-[#DEE1E8] bg-white px-4 py-2.5 text-[14px] font-semibold text-[#374151] hover:bg-[#F9FAFB] disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleLeaveTeam()}
                disabled={isLeaving}
                className="rounded-lg bg-[#DC2626] px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-[#B91C1C] disabled:cursor-wait disabled:opacity-70"
              >
                {isLeaving ? 'Leaving...' : 'Leave'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  )
}

function ConnectedSourcesSettings() {
  // Every real row for a source type, not just one - a tenant's own login
  // account and a connector account are already two separate things at the
  // data level (auth.users/memberships vs. source_connections), but the UI
  // used to collapse multiple connections of the same provider into a
  // single slot, silently keeping only whichever the last fetch happened to
  // overwrite - so a second Gmail account was invisible, with no way to
  // tell it apart from the first even though the backend already supported
  // (and even relied on, elsewhere - see capture-source-rules) more than
  // one per source.
  const [connections, setConnections] = useState<Record<SourceId, SourceConnectionRow[]>>({
    slack: [],
    notion: [],
    gmail: [],
    jira: [],
    confluence: [],
    discord: [],
    github: [],
    monday: [],
    clickup: [],
    teams: [],
  })
  const [isLoading, setIsLoading] = useState(true)
  const [connectingId, setConnectingId] = useState<SourceId | null>(null)
  const [error, setError] = useState('')

  const [disconnectTarget, setDisconnectTarget] = useState<SourceConnectionRow | null>(null)
  const [deleteHistoryChoice, setDeleteHistoryChoice] = useState(false)
  const [isDisconnecting, setIsDisconnecting] = useState(false)
  const [disconnectError, setDisconnectError] = useState('')

  // Only Notion's poller actually has a real backfill mechanism to choose
  // between (see lib/sourceConnections.ts's SyncMode doc) - Gmail and Slack
  // skip straight to handleConnect with no choice prompt.
  const [syncModeTarget, setSyncModeTarget] = useState<SourceId | null>(null)
  const [sharedWorkspaceWarningTarget, setSharedWorkspaceWarningTarget] = useState<SourceId | null>(null)

  // Real bug this closes: without this, every connection in the tenant
  // looked identical regardless of who actually connected it - a teammate's
  // Gmail read as if it were yours, with a working Disconnect button on it.
  // Keyed by user_id (source_connections.connected_by), built from the same
  // team-invites 'members' action TeamSettings above already uses.
  const [memberMap, setMemberMap] = useState<Record<string, { name: string; isSelf: boolean }>>({})
  const [canManageAll, setCanManageAll] = useState(false)

  const loadConnections = () =>
    Promise.all([
      fetchSourceConnections(),
      invokeTeamInvites<{ members: TeamMember[] }>({ action: 'members' }),
    ]).then(([rows, membersResult]) => {
      const next: Record<SourceId, SourceConnectionRow[]> = { slack: [], notion: [], gmail: [], jira: [], confluence: [], discord: [], github: [], monday: [], clickup: [], teams: [] }
      for (const row of rows) {
        if (row.status === 'active') next[row.source].push(row)
      }
      setConnections(next)

      // A solo/demo tenant with no real team-invites backing (or a
      // transient failure loading it) shouldn't break the whole page -
      // attribution just falls back to blank labels and every Disconnect
      // button stays visible, same as before this feature existed.
      const members = membersResult.data?.members ?? []
      const map: Record<string, { name: string; isSelf: boolean }> = {}
      for (const m of members) {
        map[m.user_id] = { name: m.display_name ?? m.email ?? 'a teammate', isSelf: m.is_self }
      }
      setMemberMap(map)
      setCanManageAll(levelOf(members.find((m) => m.is_self)) > LEVEL_MEMBER)
    })

  useEffect(() => {
    let active = true
    loadConnections()
      .catch(() => {
        if (active) setError('Unable to load connected sources.')
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const handleConnect = async (sourceId: SourceId, syncMode?: SyncMode) => {
    if (connectingId) return
    setConnectingId(sourceId)
    setError('')
    setSyncModeTarget(null)

    const result = await connectSource(sourceId, syncMode)
    if (result.success) {
      // Re-fetch rather than optimistically patch local state - a new
      // connection needs its real id/display_name from the database, which
      // the popup flow's success signal doesn't carry.
      await loadConnections().catch(() => setError('Connected, but could not refresh the list.'))
    } else {
      setError(result.error ?? 'Connection failed.')
    }
    setConnectingId(null)
  }

  const openConnect = (sourceId: SourceId) => {
    // Real risk this guards against: for every source except Gmail,
    // external_workspace_id is the TEAM's shared identity (one Slack
    // workspace, one ClickUp team), not a personal one - if this source
    // already has an active connection and whoever's connecting now lands
    // in that same external workspace, the unique(tenant_id, source,
    // external_workspace_id) constraint means their reconnect silently
    // takes over the existing row (new token, connected_by reassigned) with
    // no warning to either person. Locus AI can't know in advance which
    // exact workspace they'll land in - the provider only reveals that
    // after OAuth completes - so this is a heads-up, not a precise
    // per-workspace check. Gmail's identity IS the connecting email, so two
    // people's own accounts never collide here - no warning needed.
    if (sourceId !== 'gmail' && connections[sourceId].length > 0) {
      setSharedWorkspaceWarningTarget(sourceId)
      return
    }
    // Every connect and reconnect asks what to read, for every source, not
    // just Notion reconnects - "I just connected Gmail, why isn't my old
    // mail here" was a real, repeated confusion (Gmail's connector only
    // ever grabbed the 10 most recent messages with no way to ask for
    // more). Slack and Gmail both now support a real one-time backfill on
    // "full" (see slack-oauth's backfillSlackHistory and gmail-manual-
    // sync's first-sync batch), so the same choice applies everywhere.
    setSyncModeTarget(sourceId)
  }

  const openDisconnectConfirm = (row: SourceConnectionRow) => {
    setDisconnectTarget(row)
    setDeleteHistoryChoice(false)
    setDisconnectError('')
  }

  const handleDisconnect = async () => {
    if (!disconnectTarget) return
    setIsDisconnecting(true)
    setDisconnectError('')

    const result = await disconnectSource(disconnectTarget.id, deleteHistoryChoice)
    if (result.success) {
      setConnections((current) => ({
        ...current,
        [disconnectTarget.source]: current[disconnectTarget.source].filter((c) => c.id !== disconnectTarget.id),
      }))
      setDisconnectTarget(null)
    } else {
      setDisconnectError(result.error ?? 'Unable to disconnect.')
    }
    setIsDisconnecting(false)
  }

  const disconnectTargetMeta = disconnectTarget
    ? CONNECTED_SOURCE_META.find((s) => s.id === disconnectTarget.source)
    : undefined
  const disconnectTargetLabel = disconnectTarget ? connectionLabel(disconnectTarget) : null

  return (
    <>
      <h1 className="text-[28px] font-bold tracking-[-0.02em] text-[#111827]">
        Connected Sources
      </h1>
      <p className="mt-1 text-[14px] text-[#6B7280]">
        Manage the tools Locus AI reads to build organizational memory.
      </p>

      <div className="mt-8 overflow-hidden rounded-2xl border border-[#E8E8ED] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
        {isLoading ? (
          <p className="px-5 py-12 text-center text-[14px] text-[#6B7280]">
            Loading connected sources...
          </p>
        ) : (
          CONNECTED_SOURCE_META.map((source, index) => {
            const rows = connections[source.id]
            return (
              <div
                key={source.id}
                className={`flex flex-col gap-4 px-5 py-5 ${
                  index < CONNECTED_SOURCE_META.length - 1 ? 'border-b border-[#F0F0F4]' : ''
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[#E5E7EB] bg-white">
                    <SourceLogo source={source.name} className="h-7 w-7" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-[15px] font-semibold text-[#111827]">{source.name}</h3>
                    <p className="mt-1 text-[13px] text-[#9CA3AF]">{source.description}</p>
                  </div>
                </div>

                {/* Every real connection as its own row, distinguished by
                    its own account/workspace identity - a tenant with two
                    Gmail accounts connected sees two rows here, each with
                    its own status and its own Disconnect button, not one
                    row silently standing in for both. */}
                {rows.length > 0 ? (
                  <div className="ml-14 flex flex-col gap-2">
                    {rows.map((row) => {
                      const label = connectionLabel(row)
                      // null connected_by is every row from before this
                      // column existed - stays unlabeled and manageable by
                      // anyone, same as before this feature shipped.
                      const owner = row.connected_by ? memberMap[row.connected_by] : undefined
                      const canManageThis = !row.connected_by || owner?.isSelf || canManageAll
                      return (
                        <div
                          key={row.id}
                          className="flex flex-col gap-2 rounded-xl border border-[#F0F0F4] bg-[#FAFAFB] px-3.5 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="min-w-0 truncate text-[13px] font-medium text-[#111827]">
                              {label ?? 'Connected account'}
                            </span>
                            <span className="shrink-0 rounded-full bg-[#DCFCE7] px-2.5 py-1 text-[12px] font-medium text-[#16A34A]">
                              {formatConnectedSourceSync(row)}
                            </span>
                            {owner ? (
                              <span className="shrink-0 text-[12px] text-[#9CA3AF]">
                                Connected by {owner.isSelf ? 'you' : owner.name}
                              </span>
                            ) : null}
                          </div>
                          {canManageThis ? (
                            <button
                              type="button"
                              onClick={() => openDisconnectConfirm(row)}
                              className="shrink-0 self-start rounded-lg border border-[#DEE1E8] bg-white px-3 py-1.5 text-[13px] font-semibold text-[#DC2626] transition-colors hover:bg-[#FEF2F2] sm:self-auto"
                            >
                              Disconnect
                            </button>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <p className="ml-14 text-[13px] text-[#9CA3AF]">Not connected</p>
                )}

                <div className="ml-14">
                  <button
                    type="button"
                    disabled={connectingId === source.id}
                    onClick={() => openConnect(source.id)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[#DEE1E8] bg-white px-3 py-1.5 text-[13px] font-semibold text-[#4B3BD4] transition-colors hover:bg-[#F8F7FF] disabled:cursor-wait disabled:opacity-60"
                  >
                    {connectingId === source.id
                      ? 'Connecting...'
                      : rows.length > 0
                        ? 'Connect another account'
                        : 'Connect'}
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>

      {error ? (
        <p role="alert" className="mt-3 text-[13px] text-[#B4232C]">
          {error}
        </p>
      ) : null}

      {disconnectTarget && disconnectTargetMeta ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !isDisconnecting) setDisconnectTarget(null)
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="disconnect-source-title"
            className="w-full max-w-[440px] rounded-[12px] bg-white p-6 shadow-[0_20px_55px_rgba(17,24,39,0.22)]"
          >
            <h2 id="disconnect-source-title" className="text-[18px] font-semibold text-[#111827]">
              Disconnect {disconnectTargetMeta.name}
              {disconnectTargetLabel ? ` (${disconnectTargetLabel})` : ''}?
            </h2>
            <p className="mt-2 text-[14px] leading-5 text-[#6B7280]">
              Locus AI will stop reading new content from this {disconnectTargetMeta.name} account.
              {' '}Choose what happens to the decisions already captured from it.
            </p>

            <div className="mt-4 flex flex-col gap-2">
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[#DEE1E8] p-3 has-[:checked]:border-[#5A45FF] has-[:checked]:bg-[#F8F7FF]">
                <input
                  type="radio"
                  name="disconnect-history-choice"
                  checked={!deleteHistoryChoice}
                  onChange={() => setDeleteHistoryChoice(false)}
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-[14px] font-semibold text-[#111827]">Keep the history</span>
                  <span className="block text-[13px] text-[#6B7280]">
                    Disconnect but keep everything already captured from this account.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[#DEE1E8] p-3 has-[:checked]:border-[#B4232C] has-[:checked]:bg-[#FFF7F7]">
                <input
                  type="radio"
                  name="disconnect-history-choice"
                  checked={deleteHistoryChoice}
                  onChange={() => setDeleteHistoryChoice(true)}
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-[14px] font-semibold text-[#B4232C]">Delete the history</span>
                  <span className="block text-[13px] text-[#6B7280]">
                    Permanently delete every decision captured from this account. This cannot be
                    undone.
                  </span>
                </span>
              </label>
            </div>

            {disconnectError ? (
              <p role="alert" className="mt-3 text-[13px] text-[#B4232C]">
                {disconnectError}
              </p>
            ) : null}

            <div className="mt-5 grid grid-cols-2 gap-3">
              <button
                type="button"
                disabled={isDisconnecting}
                onClick={() => setDisconnectTarget(null)}
                className="h-10 rounded-lg border border-[#DEE1E8] bg-white px-6 text-[14px] font-semibold text-[#4B3BD4] hover:bg-[#F8F7FF] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isDisconnecting}
                onClick={() => void handleDisconnect()}
                className="h-10 rounded-lg bg-[#B4232C] text-[14px] font-semibold text-white hover:bg-[#981D24] disabled:cursor-wait disabled:opacity-60"
              >
                {isDisconnecting ? 'Disconnecting...' : 'Disconnect'}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {sharedWorkspaceWarningTarget ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSharedWorkspaceWarningTarget(null)
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="shared-workspace-warning-title"
            className="w-full max-w-[440px] rounded-[12px] bg-white p-6 shadow-[0_20px_55px_rgba(17,24,39,0.22)]"
          >
            <h2 id="shared-workspace-warning-title" className="text-[18px] font-semibold text-[#111827]">
              Already connected
            </h2>
            <p className="mt-2 text-[14px] leading-5 text-[#6B7280]">
              This source already has an active connection for your team. If you're connecting the same {' '}
              {CONNECTED_SOURCE_META.find((s) => s.id === sharedWorkspaceWarningTarget)?.name}, continuing will take
              over as the one managing it - the previous connection's access is replaced, not added to.
            </p>
            <p className="mt-2 text-[13px] leading-5 text-[#9CA3AF]">
              Connecting a genuinely different workspace/account is fine - this warning shows either way, since we
              can't tell which one you'll land in until after you sign in.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => setSharedWorkspaceWarningTarget(null)}
                className="rounded-lg border border-[#DEE1E8] bg-white px-4 py-2.5 text-[14px] font-semibold text-[#374151] hover:bg-[#F9FAFB]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const sourceId = sharedWorkspaceWarningTarget
                  setSharedWorkspaceWarningTarget(null)
                  if (sourceId) setSyncModeTarget(sourceId)
                }}
                className="rounded-lg bg-[#4B3BD4] px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-[#3F2FBF]"
              >
                Continue
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {syncModeTarget ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSyncModeTarget(null)
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="sync-mode-title"
            className="w-full max-w-[440px] rounded-[12px] bg-white p-6 shadow-[0_20px_55px_rgba(17,24,39,0.22)]"
          >
            <h2 id="sync-mode-title" className="text-[18px] font-semibold text-[#111827]">
              Connecting {CONNECTED_SOURCE_META.find((s) => s.id === syncModeTarget)?.name}
            </h2>
            <p className="mt-2 text-[14px] leading-5 text-[#6B7280]">
              What should Locus AI read on this connection?
            </p>

            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => syncModeTarget && void handleConnect(syncModeTarget, 'full')}
                className="flex flex-col items-start gap-1 rounded-lg border border-[#DEE1E8] p-3 text-left hover:border-[#5A45FF] hover:bg-[#F8F7FF]"
              >
                <span className="text-[14px] font-semibold text-[#111827]">Full history</span>
                <span className="text-[13px] text-[#6B7280]">
                  {syncModeTarget === 'slack'
                    ? 'Read recent history from every channel Locus AI can see, not just new messages.'
                    : 'Read everything Locus AI can see again, from the beginning.'}
                </span>
              </button>
              <button
                type="button"
                onClick={() => syncModeTarget && void handleConnect(syncModeTarget, 'new')}
                className="flex flex-col items-start gap-1 rounded-lg border border-[#DEE1E8] p-3 text-left hover:border-[#5A45FF] hover:bg-[#F8F7FF]"
              >
                <span className="text-[14px] font-semibold text-[#111827]">From now on</span>
                <span className="text-[13px] text-[#6B7280]">
                  Only capture what arrives after this connection.
                </span>
              </button>
            </div>

            <button
              type="button"
              onClick={() => setSyncModeTarget(null)}
              className="mt-4 h-10 w-full rounded-lg border border-[#DEE1E8] bg-white px-6 text-[14px] font-semibold text-[#4B3BD4] hover:bg-[#F8F7FF]"
            >
              Cancel
            </button>
          </section>
        </div>
      ) : null}
    </>
  )
}

function CaptureControlsSettings() {
  const [pauseCapture, setPauseCapture] = useState(false)
  const [captureMode, setCaptureMode] = useState<CaptureMode>('decisions-actions')
  const [memoryModeError, setMemoryModeError] = useState('')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('All')
  const [channels, setChannels] = useState<ChannelRow[]>([])
  const [isLoadingChannels, setIsLoadingChannels] = useState(true)
  const [channelsError, setChannelsError] = useState('')

  // Real bug found live: both controls below used to be pure local state,
  // no backend connection at all - clicking either one just changed which
  // button looked selected, with zero actual effect on ai-worker. Loads
  // the tenant's real, persisted setting on mount.
  useEffect(() => {
    let active = true
    getSupabaseClient()
      .functions.invoke('capture-source-rules', { body: { action: 'get_memory_mode' } })
      .then(({ data, error }) => {
        if (!active || error) return
        setPauseCapture(Boolean(data?.learning_paused))
        setCaptureMode(data?.core_knowledge_only ? 'decisions-only' : 'decisions-actions')
      })
      .catch(() => {
        // Leave the defaults (unpaused, full context) if this fails to load.
      })
    return () => {
      active = false
    }
  }, [])

  const togglePauseCapture = async () => {
    const next = !pauseCapture
    setPauseCapture(next)
    setMemoryModeError('')
    const { error } = await getSupabaseClient().functions.invoke('capture-source-rules', {
      body: { action: 'set_memory_mode', learning_paused: next },
    })
    if (error) {
      setPauseCapture(!next)
      setMemoryModeError(error.message)
    }
  }

  const changeCaptureMode = async (mode: CaptureMode) => {
    const previous = captureMode
    setCaptureMode(mode)
    setMemoryModeError('')
    const { error } = await getSupabaseClient().functions.invoke('capture-source-rules', {
      body: { action: 'set_memory_mode', core_knowledge_only: mode === 'decisions-only' },
    })
    if (error) {
      setCaptureMode(previous)
      setMemoryModeError(error.message)
    }
  }

  useEffect(() => {
    let active = true

    getSupabaseClient()
      .functions.invoke('capture-source-rules', { body: { action: 'list' } })
      .then(({ data, error }) => {
        if (!active) return
        if (error) {
          setChannelsError(error.message)
          return
        }
        const items = (data?.items ?? []) as {
          source: CaptureSource
          item_id: string
          item_name: string
          included: boolean
        }[]
        setChannels(
          items.map((item) => ({
            id: `${item.source}:${item.item_id}`,
            name: item.item_name,
            included: item.included,
            app: SOURCE_APP_LABELS[item.source],
            source: item.source,
            itemId: item.item_id,
          })),
        )
      })
      .catch(() => {
        if (active) setChannelsError('Unable to load channels.')
      })
      .finally(() => {
        if (active) setIsLoadingChannels(false)
      })

    return () => {
      active = false
    }
  }, [])

  const visibleChannels = useMemo(() => {
    if (sourceFilter === 'All') return channels
    return channels.filter((channel) => channel.app === sourceFilter)
  }, [channels, sourceFilter])

  const includedCount = channels.filter((channel) => channel.included).length
  const excludedCount = channels.length - includedCount

  const toggleChannel = async (channel: ChannelRow) => {
    const nextIncluded = !channel.included
    setChannels((current) =>
      current.map((c) => (c.id === channel.id ? { ...c, included: nextIncluded } : c)),
    )

    const { error } = await getSupabaseClient().functions.invoke('capture-source-rules', {
      body: {
        action: 'toggle',
        source: channel.source,
        item_id: channel.itemId,
        item_name: channel.name,
        included: nextIncluded,
      },
    })

    if (error) {
      setChannels((current) =>
        current.map((c) => (c.id === channel.id ? { ...c, included: channel.included } : c)),
      )
      setChannelsError(error.message)
    }
  }

  return (
    <>
      <h1 className="text-[28px] font-bold tracking-[-0.02em] text-[#111827]">
        Build Memory
      </h1>
      <p className="mt-1 text-[14px] text-[#6B7280]">
        Control what Locus AI learns from, from where, and when.
      </p>

      <section className="mt-8">
        <h3 className="mb-3 text-[11px] font-semibold tracking-[0.08em] text-[#9CA3AF] uppercase">
          Memory Mode
        </h3>
        {memoryModeError ? (
          <p className="mb-3 text-[13px] text-[#DC2626]">{memoryModeError}</p>
        ) : null}

        <div className="rounded-2xl border border-[#E8E8ED] bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[15px] font-semibold text-[#111827]">
                Pause all learning
              </p>
              <p className="mt-1 max-w-[520px] text-[13px] leading-relaxed text-[#6B7280]">
                Temporarily stop Locus AI from reading new messages. All
                existing memory is preserved and search remains
                available.
              </p>
            </div>
            <Toggle
              checked={pauseCapture}
              onChange={() => void togglePauseCapture()}
              label="Pause all learning"
            />
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => void changeCaptureMode('decisions-actions')}
            className={`rounded-2xl border bg-white p-4 text-left transition-colors ${
              captureMode === 'decisions-actions'
                ? 'border-[#5A45FF]'
                : 'border-[#DEE1E8] hover:border-[#C7C7D1]'
            }`}
          >
            <div className="mb-2 flex items-center gap-2">
              <span
                className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                  captureMode === 'decisions-actions'
                    ? 'border-[#5A45FF]'
                    : 'border-[#D1D5DB]'
                }`}
              >
                {captureMode === 'decisions-actions' ? (
                  <span className="h-2 w-2 rounded-full bg-[#5A45FF]" />
                ) : null}
              </span>
              <span className="text-[14px] font-semibold text-[#111827]">
                Full context
              </span>
            </div>
            <p className="text-[13px] leading-relaxed text-[#6B7280]">
              Also learn action items and blockers. Recommended for
              full team understanding.
            </p>
          </button>

          <button
            type="button"
            onClick={() => void changeCaptureMode('decisions-only')}
            className={`rounded-2xl border bg-white p-4 text-left transition-colors ${
              captureMode === 'decisions-only'
                ? 'border-[#5A45FF]'
                : 'border-[#DEE1E8] hover:border-[#C7C7D1]'
            }`}
          >
            <div className="mb-2 flex items-center gap-2">
              <span
                className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                  captureMode === 'decisions-only'
                    ? 'border-[#5A45FF]'
                    : 'border-[#D1D5DB]'
                }`}
              >
                {captureMode === 'decisions-only' ? (
                  <span className="h-2 w-2 rounded-full bg-[#5A45FF]" />
                ) : null}
              </span>
              <span className="text-[14px] font-semibold text-[#111827]">
                Core knowledge only
              </span>
            </div>
            <p className="text-[13px] leading-relaxed text-[#6B7280]">
              Only learn explicit conclusions and agreements. Lower
              volume, higher precision.
            </p>
          </button>
        </div>
      </section>

      <section className="mt-8">
        <h3 className="mb-3 text-[11px] font-semibold tracking-[0.08em] text-[#9CA3AF] uppercase">
          Channels & Memory Source Rules
        </h3>

        <div className="mb-3 flex flex-wrap gap-2">
          {SOURCE_FILTERS.map((filter) => {
            const isActive = sourceFilter === filter
            return (
              <button
                key={filter}
                type="button"
                onClick={() => setSourceFilter(filter)}
                className={`rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition-colors ${
                  isActive
                    ? 'bg-[#5A45FF] text-white'
                    : 'border border-[#DEE1E8] bg-white text-[#4B3BD4] hover:bg-[#F8F7FF]'
                }`}
              >
                {filter}
              </button>
            )
          })}
        </div>

        <p className="mb-3 text-[13px]">
          <span className="font-semibold text-[#5A45FF]">
            {includedCount} Included
          </span>
          <span className="mx-2 text-[#9CA3AF]">{excludedCount} Excluded</span>
        </p>

        <div className="overflow-hidden rounded-2xl border border-[#E8E8ED] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-[#F0F0F4]">
                <th className="w-12 px-4 py-3" />
                <th className="px-4 py-3 text-[12px] font-semibold text-[#9CA3AF]">
                  Channel/Page Name
                </th>
                <th className="px-4 py-3 text-[12px] font-semibold text-[#9CA3AF]">
                  Status
                </th>
                <th className="px-4 py-3 text-[12px] font-semibold text-[#9CA3AF]">
                  App
                </th>
              </tr>
            </thead>
            <tbody>
              {isLoadingChannels ? (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-[14px] text-[#6B7280]">
                    Loading channels...
                  </td>
                </tr>
              ) : visibleChannels.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-[14px] text-[#6B7280]">
                    No channels found for this filter.
                  </td>
                </tr>
              ) : (
                visibleChannels.map((channel, index) => (
                  <tr
                    key={channel.id}
                    className={
                      index < visibleChannels.length - 1
                        ? 'border-b border-[#F0F0F4]'
                        : ''
                    }
                  >
                    <td className="px-4 py-3.5">
                      <button
                        type="button"
                        aria-label={
                          channel.included
                            ? `Exclude ${channel.name}`
                            : `Include ${channel.name}`
                        }
                        onClick={() => void toggleChannel(channel)}
                        className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                          channel.included
                            ? 'border-[#5A45FF]'
                            : 'border-[#D1D5DB]'
                        }`}
                      >
                        {channel.included ? (
                          <span className="h-2 w-2 rounded-full bg-[#5A45FF]" />
                        ) : null}
                      </button>
                    </td>
                    <td className="px-4 py-3.5 text-[14px] font-medium text-[#111827]">
                      {channel.name}
                    </td>
                    <td className="px-4 py-3.5">
                      {channel.included ? (
                        <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[#16A34A]">
                          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[#DCFCE7] text-[10px]">
                            ✓
                          </span>
                          Included
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[#9CA3AF]">
                          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[#F3F4F6] text-[10px]">
                            ×
                          </span>
                          Excluded
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-[14px] text-[#6B7280]">
                      {channel.app}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {channelsError ? (
          <p role="alert" className="mt-3 text-[13px] text-[#B4232C]">
            {channelsError}
          </p>
        ) : null}
      </section>
    </>
  )
}

export default function SettingsPage() {
  const navigate = useNavigate()
  const [activeSection, setActiveSection] = useState<SettingsSection>('Account')
  const [blockCookies, setBlockCookies] = useState(false)
  const [excludePrivate, setExcludePrivate] = useState(false)
  const [excludeDms, setExcludeDms] = useState(false)
  const [weeklyPulse, setWeeklyPulse] = useState(true)
  const [emailNotifications, setEmailNotifications] = useState(true)
  const [inAppNotifications, setInAppNotifications] = useState(true)
  const [signedInEmail, setSignedInEmail] = useState('')

  useEffect(() => {
    const demoEmail = sessionStorage.getItem(DEMO_EMAIL_KEY)
    if (demoEmail) {
      setSignedInEmail(demoEmail)
      return
    }
    void getSupabaseClient()
      .auth.getSession()
      .then(({ data }) => setSignedInEmail(data.session?.user.email ?? ''))
  }, [])

  const clearCookies = async () => {
    // "Clear cookies" promises an immediate logout - it only reset a local
    // toggle before and never touched the real session, so the button did
    // not do what its own label said.
    setBlockCookies(false)
    sessionStorage.removeItem(DEMO_EMAIL_KEY)
    sessionStorage.removeItem(WORKSPACES_DONE_KEY)
    sessionStorage.removeItem('locus:connected-tools')
    await getSupabaseClient().auth.signOut()
    navigate('/', { replace: true })
  }

  return (
    <div className="mx-auto flex max-w-[1120px] gap-8 px-8 py-8">
      <aside className="w-[220px] shrink-0">
        <h2 className="mb-4 text-[18px] font-bold text-[#111827]">Settings</h2>
        <nav className="flex flex-col gap-1">
          {SIDEBAR_ITEMS.map((item) => {
            const isActive = activeSection === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveSection(item.id)}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[14px] font-medium transition-colors ${
                  isActive
                    ? 'bg-[#EEEBFF] text-[#5A45FF]'
                    : 'text-[#4B5563] hover:bg-[#F3F4F6]'
                }`}
              >
                <span className={isActive ? 'text-[#5A45FF]' : 'text-[#6B7280]'}>
                  {SIDEBAR_ICONS[item.id]}
                </span>
                {item.label}
              </button>
            )
          })}
        </nav>
      </aside>

      <main className="min-w-0 flex-1">
        {activeSection === 'Account' ? (
          <AccountSettings />
        ) : activeSection === 'Team' ? (
          <TeamSettings />
        ) : activeSection === 'Connected Sources' ? (
          <ConnectedSourcesSettings />
        ) : activeSection === 'Build Memory' ? (
          <CaptureControlsSettings />
        ) : activeSection === 'Privacy' ? (
          <>
            <h1 className="text-[28px] font-bold tracking-[-0.02em] text-[#111827]">
              Privacy
            </h1>
            <p className="mt-1 text-[14px] text-[#6B7280]">
              Control what Locus AI can read and how long data is kept.
            </p>

            <div className="mt-8 rounded-2xl border border-[#E8E8ED] bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
              <div className="flex items-start gap-3">
                <ClockIcon />
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-semibold text-[#111827]">
                    Raw message retention: 30 days
                  </p>
                  <p className="mt-1 text-[13px] leading-relaxed text-[#6B7280]">
                    Locus AI reads messages to build structured memory, then
                    permanently deletes the raw content within 30 days. Only the
                    extracted context summary is stored, never
                    the full message thread.
                  </p>
                  <div className="mt-5">
                    <div className="h-1.5 overflow-hidden rounded-full bg-[#EDE9FE]">
                      <div className="h-full w-2/3 rounded-full bg-gradient-to-r from-[#5A45FF] to-[#C4B5FD]" />
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[12px] font-medium text-[#6B7280]">
                      <span>Ingested</span>
                      <span className="text-[#C7C7D1]">→</span>
                      <span>Extracted</span>
                      <span className="text-[#C7C7D1]">→</span>
                      <span>Deleted</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <section className="mt-8">
              <h3 className="mb-3 text-[11px] font-semibold tracking-[0.08em] text-[#9CA3AF] uppercase">
                Cookie Controls
              </h3>
              <div className="overflow-hidden rounded-2xl border border-[#E8E8ED] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
                <div className="flex items-start justify-between gap-4 border-b border-[#F0F0F4] px-5 py-4">
                  <div className="min-w-0">
                    <p className="text-[15px] font-semibold text-[#111827]">
                      Block non-essential cookies
                    </p>
                    <p className="mt-1 max-w-[560px] text-[13px] leading-relaxed text-[#6B7280]">
                      Only keeps the cookies strictly required for Locus AI to
                      function, such as your login session and security tokens.
                      Turning this on may mean your preferences and filter
                      settings won&apos;t be remembered between visits.
                    </p>
                  </div>
                  <Toggle
                    checked={blockCookies}
                    onChange={() => setBlockCookies((value) => !value)}
                    label="Block non-essential cookies"
                  />
                </div>
                <div className="flex items-start justify-between gap-4 px-5 py-4">
                  <div className="min-w-0">
                    <p className="text-[15px] font-semibold text-[#111827]">
                      Clear cookies
                    </p>
                    <p className="mt-1 max-w-[560px] text-[13px] leading-relaxed text-[#6B7280]">
                      Clears all stored cookies and session data from your
                      browser. You&apos;ll be logged out immediately and will
                      need to sign in again.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void clearCookies()}
                    className="shrink-0 rounded-lg border border-[#DEE1E8] bg-white px-3.5 py-2 text-[13px] font-semibold text-[#4B3BD4] transition-colors hover:bg-[#F8F7FF]"
                  >
                    Clear Cookies
                  </button>
                </div>
              </div>
            </section>

            <section className="mt-8">
              <h3 className="mb-3 text-[11px] font-semibold tracking-[0.08em] text-[#9CA3AF] uppercase">
                Message Scope
              </h3>
              <div className="overflow-hidden rounded-2xl border border-[#E8E8ED] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
                <div className="flex items-start justify-between gap-4 border-b border-[#F0F0F4] px-5 py-4">
                  <div className="min-w-0">
                    <p className="text-[15px] font-semibold text-[#111827]">
                      Exclude private channels
                    </p>
                    <p className="mt-1 max-w-[560px] text-[13px] leading-relaxed text-[#6B7280]">
                      Locus AI will skip private Slack channels entirely, even if
                      you&apos;re a member and have granted access.
                    </p>
                  </div>
                  <Toggle
                    checked={excludePrivate}
                    onChange={() => setExcludePrivate((value) => !value)}
                    label="Exclude private channels"
                  />
                </div>
                <div className="flex items-start justify-between gap-4 px-5 py-4">
                  <div className="min-w-0">
                    <p className="text-[15px] font-semibold text-[#111827]">
                      Exclude direct messages
                    </p>
                    <p className="mt-1 max-w-[560px] text-[13px] leading-relaxed text-[#6B7280]">
                      DMs and group DMs are never read or captured, regardless of
                      content.
                    </p>
                  </div>
                  <Toggle
                    checked={excludeDms}
                    onChange={() => setExcludeDms((value) => !value)}
                    label="Exclude direct messages"
                  />
                </div>
              </div>
            </section>

            <div className="mt-8 rounded-2xl border border-[#E8E8ED] bg-white px-5 py-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[15px] font-semibold text-[#111827]">
                  Data processing region
                </p>
                <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[#16A34A]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#22C55E]" />
                  US · West
                </span>
              </div>
              <p className="mt-1 text-[13px] text-[#6B7280]">
                Your data is processed and stored in US-West (California,
                USA).
              </p>
            </div>

            <section className="mt-8">
              <h3 className="mb-3 text-[11px] font-semibold tracking-[0.08em] text-[#9CA3AF] uppercase">
                Our Commitments
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  {
                    id: 'readonly-oauth',
                    icon: <ShieldIcon />,
                    text: 'Read-only OAuth. Locus AI never writes to Slack, Notion, or Gmail.',
                  },
                  {
                    id: 'raw-deleted',
                    icon: <ClockIcon />,
                    // Matches the real enforced retention (raw_events.expires_at
                    // = 30 days, purged by a real daily job) - this card
                    // previously said "24 hours", contradicting the Privacy tab's
                    // own "Raw message retention: 30 days" a click away.
                    text: 'Raw messages deleted within 30 days of ingestion.',
                  },
                  {
                    id: 'no-training',
                    icon: (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <circle cx="12" cy="12" r="8" stroke="#5A45FF" strokeWidth="1.8" />
                        <path d="M9 9l6 6M15 9l-6 6" stroke="#5A45FF" strokeWidth="1.8" strokeLinecap="round" />
                      </svg>
                    ),
                    text: 'We never train AI models on your workspace data.',
                  },
                  {
                    id: 'sensitive-filtering',
                    icon: (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="#5A45FF" strokeWidth="1.8" strokeLinejoin="round" />
                        <path d="M8 11l3 3 5-5" stroke="#5A45FF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ),
                    text: 'Sensitive/private information will never be exposed. The app automatically filters financial identifiers before processing and again before saving decisions: Credit/debit cards (Luhn-valid), IBANs, Dashed SSNs, 9+ digit runs (routing/account numbers, etc.).',
                  },
                ].map((item) => (
                  <div
                    key={item.id}
                    className="flex items-start gap-3 rounded-2xl border border-[#E8E8ED] bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)]"
                  >
                    <span className="mt-0.5 text-[#5A45FF]">{item.icon}</span>
                    <p className="text-[13px] leading-relaxed text-[#4B5563]">
                      {item.text}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          </>
        ) : activeSection === 'Search' ? (
          <SearchSettings />
        ) : activeSection === 'Notifications' ? (
          <>
            <h1 className="text-[28px] font-bold tracking-[-0.02em] text-[#111827]">
              Notifications
            </h1>
            <p className="mt-1 text-[14px] text-[#6B7280]">
              Control how and when Locus AI reaches you.
            </p>

            <div className="mt-8 rounded-2xl border border-[#E8E8ED] bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[15px] font-semibold text-[#111827]">
                    Send Weekly Pulse
                  </p>
                  <p className="mt-1 text-[13px] leading-relaxed text-[#6B7280]">
                    Receive your Pulse summary on a recurring schedule.
                  </p>
                </div>
                <Toggle
                  checked={weeklyPulse}
                  onChange={() => setWeeklyPulse((value) => !value)}
                  label="Send Weekly Pulse"
                />
              </div>
            </div>

            <section className="mt-8">
              <h3 className="mb-3 text-[11px] font-semibold tracking-[0.08em] text-[#9CA3AF] uppercase">
                Delivery Channels
              </h3>
              <div className="overflow-hidden rounded-2xl border border-[#E8E8ED] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
                <div className="flex items-start justify-between gap-4 border-b border-[#F0F0F4] px-5 py-4">
                  <div className="min-w-0">
                    <p className="text-[15px] font-semibold text-[#111827]">Email</p>
                    <p className="mt-1 text-[13px] leading-relaxed text-[#6B7280]">
                      Send digest and system alerts to{' '}
                      <span className="text-[#6B7280]">{signedInEmail || 'your account email'}</span>.
                    </p>
                  </div>
                  <Toggle
                    checked={emailNotifications}
                    onChange={() => setEmailNotifications((value) => !value)}
                    label="Email notifications"
                  />
                </div>
                <div className="flex items-start justify-between gap-4 px-5 py-4">
                  <div className="min-w-0">
                    <p className="text-[15px] font-semibold text-[#111827]">In App</p>
                    <p className="mt-1 max-w-[560px] text-[13px] leading-relaxed text-[#6B7280]">
                      Show a notification badge in the Locus AI dashboard when new
                      captures arrive.
                    </p>
                  </div>
                  <Toggle
                    checked={inAppNotifications}
                    onChange={() => setInAppNotifications((value) => !value)}
                    label="In app notifications"
                  />
                </div>
              </div>
            </section>
          </>
        ) : (
          <div className="rounded-2xl border border-[#E8E8ED] bg-white p-8">
            <h1 className="text-[28px] font-bold text-[#111827]">
              {activeSection}
            </h1>
            <p className="mt-2 text-[14px] text-[#6B7280]">
              This settings section will be available soon.
            </p>
          </div>
        )}
      </main>
    </div>
  )
}
