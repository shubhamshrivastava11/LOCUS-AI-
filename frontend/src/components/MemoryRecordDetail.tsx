import { useEffect, useState, type ReactNode } from 'react'
import { getDecision, type DecisionConflict, type ThreadMessage } from '../lib/api'
import { flagRecord } from '../lib/recordFlags'

export type MemoryRecordType = 'Decision' | 'Blocker' | 'Action Item'
export type MemoryStatus = 'Current' | 'Superseded'

export type MemoryRecord = {
  id: string
  type: MemoryRecordType
  title: string
  meta: string
  summary: string
  participants: string
  source: string
  status: MemoryStatus
  date?: string
  listSource?: string
  /** Real source URL (Slack permalink, Gmail/Notion link) - "View Original" opens this when present. */
  sourceLink?: string
  /** Exact source timestamp (not the relative "3h ago" already in `meta`). */
  exactTime?: string
}

export const TYPE_STYLES: Record<MemoryRecordType, string> = {
  Decision: 'bg-[#EEEBFF] text-[#5A45FF]',
  Blocker: 'bg-[#FEE2E2] text-[#DC2626]',
  'Action Item': 'bg-[#ECFCCB] text-[#4D7C0F]',
}

export const STATUS_STYLES: Record<MemoryStatus, string> = {
  Current: 'bg-[#EEEBFF] text-[#5A45FF]',
  Superseded: 'bg-[#F3F4F6] text-[#6B7280]',
}

const FLAG_REASONS = ['Inaccurate', 'Outdated', 'Other'] as const
type FlagReason = (typeof FLAG_REASONS)[number]

function FlagIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} aria-hidden="true">
      <path
        d="M5 21V4h9l-.8 3.2L14 10.5H5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function DetailRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="grid grid-cols-[110px_minmax(0,1fr)] items-start gap-3 py-2.5">
      <span className="pt-0.5 text-[11px] font-semibold tracking-[0.06em] text-[#9CA3AF]">
        {label}
      </span>
      <div className="min-w-0 text-[14px] leading-relaxed text-[#111827]">{children}</div>
    </div>
  )
}

// Every source (a Gmail HTML email, a Slack message, a Notion page) arrives
// with its own idea of formatting, or none at all - the backend only cleans
// it up and marks structure (§§heading, • bullet); this is what actually
// turns that into one consistent, Locus-styled presentation instead of each
// source's own layout bleeding through. Used for SUMMARY and every
// CONVERSATION message alike, so a one-line Claude summary and a
// reconstructed multi-paragraph email read as the same visual language.
const HEADING_MARKER = '§§'

function FormattedText({ text }: { text: string }) {
  if (!text) return null
  const blocks = text.split(/\n{2,}/).filter(Boolean)

  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block, i) => {
        if (block.startsWith(HEADING_MARKER)) {
          return (
            <p key={i} className="text-[13px] font-semibold text-[#111827]">
              {block.slice(HEADING_MARKER.length)}
            </p>
          )
        }

        const lines = block.split('\n').filter(Boolean)
        const isList = lines.length > 0 && lines.every((line) => line.startsWith('• '))
        if (isList) {
          return (
            <ul key={i} className="flex flex-col gap-1.5">
              {lines.map((line, j) => (
                <li key={j} className="flex items-start gap-2 text-[13px] leading-relaxed text-[#111827]">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[#5A45FF]" />
                  <span>{line.slice(2)}</span>
                </li>
              ))}
            </ul>
          )
        }

        return (
          <p key={i} className="whitespace-pre-wrap text-[13px] leading-relaxed text-[#111827]">
            {block}
          </p>
        )
      })}
    </div>
  )
}

// A long real email (a full GitHub 2FA policy notice, a job-tracker update
// packed with tracking links) isn't corrupted the way stray HTML/CSS was -
// it's genuinely long. Dumping it in full made every such message
// dominate the thread and buried the shorter, more relevant ones around
// it. Collapses by default rather than trimming - nothing is lost, it's
// one click away.
const TRUNCATE_AT = 420

// Same initials rule as accountRegistry.ts's own getInitials - first
// letter of the first two words, kept local rather than imported since
// that module is scoped to the account-switcher's own concerns.
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

type ThreadGroup = { actor: string; messages: ThreadMessage[] }

// A raw flat list repeats the sender's name and timestamp above every
// single short message ("yes", "sure i will update the tasks by
// evening") - noisy for exactly the kind of quick back-and-forth a
// Discord/Slack channel actually looks like. Consecutive messages from
// the same person collapse under one avatar/name header instead, the way
// every real chat client already does this.
function groupConsecutive(messages: ThreadMessage[]): ThreadGroup[] {
  const groups: ThreadGroup[] = []
  for (const message of messages) {
    const last = groups[groups.length - 1]
    if (last && last.actor === message.actor) {
      last.messages.push(message)
    } else {
      groups.push({ actor: message.actor, messages: [message] })
    }
  }
  return groups
}

function formatMessageTime(at: string): string {
  return new Date(at).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function ConversationPanel({
  thread,
  threadError,
}: {
  thread: ThreadMessage[] | null
  threadError: string
}) {
  if (threadError) {
    return <p className="text-[13px] text-[#9CA3AF]">{threadError}</p>
  }
  if (thread === null) {
    return <p className="text-[13px] text-[#9CA3AF]">Loading…</p>
  }
  if (thread.length === 0) {
    return <p className="text-[13px] text-[#9CA3AF]">No prior messages found in this thread.</p>
  }

  const groups = groupConsecutive(thread)

  return (
    <div className="max-h-[440px] overflow-y-auto rounded-xl border border-[#F0F0F4] bg-[#FAFAFC] p-3.5">
      <ol className="flex flex-col gap-4">
        {groups.map((group, groupIndex) => (
          <li key={groupIndex} className="flex gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#EEEBFF] text-[11px] font-semibold text-[#5A45FF]">
              {getInitials(group.actor)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-semibold text-[#374151]">
                {group.actor}
                <span className="ml-1.5 font-normal text-[#9CA3AF]">
                  {formatMessageTime(group.messages[0].at)}
                </span>
              </p>
              <div className="mt-1.5 flex flex-col gap-1.5">
                {group.messages.map((message, messageIndex) => (
                  <div
                    key={messageIndex}
                    className={`rounded-lg px-3 py-2 ${
                      message.is_source
                        ? 'border border-[#DDD6FE] bg-white shadow-[0_1px_2px_rgba(90,69,255,0.08)]'
                        : 'bg-white/70'
                    }`}
                  >
                    {message.is_source ? (
                      <span className="mb-1.5 inline-flex items-center gap-1 rounded-full bg-[#EEEBFF] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em] text-[#5A45FF]">
                        Source
                      </span>
                    ) : null}
                    <TruncatedMessageText text={message.text} />
                  </div>
                ))}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

function TruncatedMessageText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const isLong = text.length > TRUNCATE_AT
  const shown = isLong && !expanded ? `${text.slice(0, TRUNCATE_AT).trimEnd()}…` : text

  return (
    <>
      <div className="mt-0.5">
        <FormattedText text={shown} />
      </div>
      {isLong ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 text-[12px] font-semibold text-[#5A45FF] hover:underline"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </>
  )
}

export function FlagPanel({
  onCancel,
  onSubmit,
  isSaving = false,
  error = '',
}: {
  onCancel: () => void
  onSubmit: (reason: FlagReason, note: string) => void
  isSaving?: boolean
  error?: string
}) {
  const [reason, setReason] = useState<FlagReason | null>(null)
  const [note, setNote] = useState('')

  return (
    <div className="mt-4 rounded-2xl border border-[#E5E7EB] bg-white p-5">
      <p className="text-[15px] font-semibold text-[#111827]">Why are you flagging this?</p>

      <div className="mt-3.5 flex flex-wrap gap-2.5">
        {FLAG_REASONS.map((option) => {
          const selected = reason === option
          return (
            <button
              key={option}
              type="button"
              onClick={() => setReason(option)}
              className={`rounded-full border px-4 py-2 text-[13px] font-medium transition-colors ${
                selected
                  ? 'border-[#5A45FF] bg-[#F5F3FF] text-[#5A45FF]'
                  : 'border-[#E5E7EB] bg-white text-[#6B7280] hover:bg-[#F9FAFB]'
              }`}
            >
              {option}
            </button>
          )
        })}
      </div>

      <input
        type="text"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Optional Note"
        className="mt-3.5 h-11 w-full rounded-full border border-[#E5E7EB] px-4 text-[14px] text-[#111827] outline-none placeholder:text-[#9CA3AF] focus:border-[#5A45FF]"
      />

      {error ? (
        <p role="alert" className="mt-3 text-[13px] text-[#B42318]">
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex justify-end gap-2.5">
        <button
          type="button"
          onClick={onCancel}
          disabled={isSaving}
          className="rounded-lg border border-[#E5E7EB] bg-white px-4 py-2 text-[13px] font-semibold text-[#5A45FF] transition-colors hover:bg-[#F8F7FF] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!reason || isSaving}
          onClick={() => {
            if (!reason || isSaving) return
            onSubmit(reason, note)
          }}
          className="rounded-lg bg-[#5A45FF] px-4 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSaving ? 'Saving...' : 'Submit Flag'}
        </button>
      </div>
    </div>
  )
}

export function MemoryRecordDetail({
  record,
  compactHeader = false,
  onHeaderClick,
}: {
  record: MemoryRecord
  compactHeader?: boolean
  onHeaderClick?: () => void
}) {
  const [isFlagging, setIsFlagging] = useState(false)
  const [flagSubmitted, setFlagSubmitted] = useState(false)
  const [flagError, setFlagError] = useState('')
  const [isSavingFlag, setIsSavingFlag] = useState(false)
  const [thread, setThread] = useState<ThreadMessage[] | null>(null)
  const [threadError, setThreadError] = useState('')
  const [conflicts, setConflicts] = useState<DecisionConflict[]>([])

  // Only fetches when actually expanded (this component is only mounted
  // then) - the thread reconstruction decrypts and walks every raw_event
  // sharing the source's thread_ref, too expensive to include on every row
  // of a list.
  useEffect(() => {
    let active = true
    getDecision(record.id)
      .then((detail) => {
        if (!active) return
        setThread(detail.thread_context)
        setConflicts(detail.conflicts)
      })
      .catch(() => {
        if (active) setThreadError('Unable to load the conversation that led here.')
      })
    return () => {
      active = false
    }
  }, [record.id])

  return (
    <div>
      {!compactHeader ? (
        <button
          type="button"
          onClick={onHeaderClick}
          className="mb-4 flex w-full items-start gap-3 text-left"
        >
          <span
            className={`mt-0.5 shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${TYPE_STYLES[record.type]}`}
          >
            {record.type}
          </span>
          <p className="min-w-0 flex-1 text-[15px] font-semibold leading-snug text-[#111827]">
            {record.title}
          </p>
          <span className="shrink-0 text-[12px] text-[#9CA3AF]">{record.meta}</span>
        </button>
      ) : null}

      {conflicts.length > 0 ? (
        <div className="mb-4 flex flex-col gap-2">
          {conflicts.map((conflict) => (
            <div
              key={conflict.decision_id}
              className={`rounded-lg border p-3 ${
                conflict.relationship === 'contradicts'
                  ? 'border-[#F3D6D6] bg-[#FFF7F7]'
                  : 'border-[#F5E6C8] bg-[#FFFBF0]'
              }`}
            >
              <p
                className={`text-[13px] font-semibold ${
                  conflict.relationship === 'contradicts' ? 'text-[#B4232C]' : 'text-[#946C00]'
                }`}
              >
                {conflict.relationship === 'contradicts'
                  ? 'May conflict with another decision'
                  : 'May duplicate another decision'}
              </p>
              <p className="mt-1 text-[13px] leading-relaxed text-[#374151]">
                <span className="font-medium">{conflict.decision_statement}</span>: {conflict.reason}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      <div className="border-t border-[#F0F0F4] pt-1">
        <DetailRow label="SUMMARY">
          <FormattedText text={record.summary} />
        </DetailRow>
        <DetailRow label="PARTICIPANTS">
          <span className="text-[#5A45FF]">{record.participants}</span>
        </DetailRow>
        <DetailRow label="SOURCE">
          {record.source}
          {record.exactTime ? <span className="text-[#9CA3AF]"> · {record.exactTime}</span> : null}
        </DetailRow>
        <DetailRow label="STATUS">
          <span
            className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${STATUS_STYLES[record.status]}`}
          >
            {record.status}
          </span>
        </DetailRow>
      </div>

      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-semibold tracking-[0.06em] text-[#9CA3AF]">CONVERSATION</span>
          {thread && thread.length > 0 ? (
            <span className="text-[11px] text-[#9CA3AF]">
              {thread.length} message{thread.length === 1 ? '' : 's'}
            </span>
          ) : null}
        </div>
        <ConversationPanel thread={thread} threadError={threadError} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          disabled={!record.sourceLink}
          onClick={() => {
            if (record.sourceLink) window.open(record.sourceLink, '_blank', 'noopener,noreferrer')
          }}
          className="rounded-lg border border-[#5A45FF] bg-white px-4 py-2 text-[13px] font-semibold text-[#5A45FF] transition-colors hover:bg-[#F8F7FF] disabled:cursor-not-allowed disabled:border-[#E5E7EB] disabled:text-[#9CA3AF] disabled:hover:bg-white"
        >
          View Original
        </button>
        <button
          type="button"
          onClick={() => {
            setIsFlagging((open) => !open)
            setFlagSubmitted(false)
          }}
          className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-[13px] font-semibold transition-colors ${
            flagSubmitted
              ? 'border border-[#FECACA] bg-white text-[#DC2626] hover:bg-[#FEF2F2]'
              : 'bg-[#5A45FF] text-white hover:opacity-90'
          }`}
        >
          <FlagIcon filled={flagSubmitted} />
          {flagSubmitted ? 'Flagged' : 'Flag'}
        </button>
      </div>

      {isFlagging ? (
        <FlagPanel
          onCancel={() => setIsFlagging(false)}
          // This used to ignore both arguments and just flip the label to
          // "Flagged". The reason and note were collected and discarded, so a
          // report of a wrong extraction was confirmed to the user and never
          // stored. The panel now stays open on failure rather than claiming a
          // save that did not happen.
          onSubmit={(reason, note) => {
            setIsSavingFlag(true)
            setFlagError('')
            void flagRecord(record.id, reason, note)
              .then(() => {
                setIsFlagging(false)
                setFlagSubmitted(true)
              })
              .catch((err: unknown) => {
                setFlagError(
                  err instanceof Error ? err.message : 'Could not save that flag. Try again.',
                )
              })
              .finally(() => setIsSavingFlag(false))
          }}
          isSaving={isSavingFlag}
          error={flagError}
        />
      ) : null}
    </div>
  )
}

export function createDefaultMemoryRecord(
  partial: Partial<MemoryRecord> & Pick<MemoryRecord, 'id' | 'title'>,
): MemoryRecord {
  return {
    type: 'Decision',
    meta: 'Slack · 3h ago',
    summary:
      'Adopt PostgreSQL for the context layer persistence over vector-only stores',
    participants: '@jwest, @priya, @mtanaka',
    source: 'Notion · #product-planning · Mar 12, 9:41am',
    status: 'Current',
    listSource: 'Slack #engineering',
    date: 'Aug 24, 2026',
    ...partial,
  }
}
