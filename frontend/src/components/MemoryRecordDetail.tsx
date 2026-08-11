import { useEffect, useState, type ReactNode } from 'react'
import { getDecision, type DecisionConflict, type ThreadMessage } from '../lib/api'

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
}: {
  onCancel: () => void
  onSubmit: (reason: FlagReason, note: string) => void
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

      <div className="mt-4 flex justify-end gap-2.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-[#E5E7EB] bg-white px-4 py-2 text-[13px] font-semibold text-[#5A45FF] transition-colors hover:bg-[#F8F7FF]"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!reason}
          onClick={() => {
            if (!reason) return
            onSubmit(reason, note)
          }}
          className="rounded-lg bg-[#5A45FF] px-4 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Submit Flag
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
        <DetailRow label="CONVERSATION">
          {threadError ? (
            <span className="text-[#9CA3AF]">{threadError}</span>
          ) : thread === null ? (
            <span className="text-[#9CA3AF]">Loading…</span>
          ) : thread.length === 0 ? (
            <span className="text-[#9CA3AF]">No prior messages found in this thread.</span>
          ) : (
            <ol className="flex flex-col gap-2.5">
              {thread.map((message, index) => (
                <li key={index} className="border-l-2 border-[#EEEBFF] pl-3">
                  <p className="text-[12px] font-semibold text-[#6B7280]">
                    {message.actor} ·{' '}
                    {new Date(message.at).toLocaleString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </p>
                  <TruncatedMessageText text={message.text} />
                </li>
              ))}
            </ol>
          )}
        </DetailRow>
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
          onSubmit={() => {
            setIsFlagging(false)
            setFlagSubmitted(true)
          }}
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
