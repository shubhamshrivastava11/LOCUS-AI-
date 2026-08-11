import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { getDigest, listAllDecisions, type DecisionOut, type DecisionRecordType } from '../lib/api'
import { decisionToMemoryRecord } from '../lib/memoryRecord'
import { MemoryRecordDetail } from '../components/MemoryRecordDetail'
import { TEAM_PULSE_SEEN_EVENT, TEAM_PULSE_SEEN_KEY } from '../lib/sessionKeys'

type PulseSection = {
  count: number
  description: string
  items: DecisionOut[]
}

type TeamPulseData = {
  decisions: PulseSection
  actionItems: PulseSection
  blockers: PulseSection
}

const SECTION_LABELS: Record<DecisionRecordType, { singular: string; plural: string }> = {
  decision: { singular: 'decision', plural: 'decisions' },
  action_item: { singular: 'action item', plural: 'action items' },
  blocker: { singular: 'blocker', plural: 'blockers' },
}

function sectionDescription(type: DecisionRecordType, total: number, shown: number) {
  const { singular, plural } = SECTION_LABELS[type]
  if (total === 0) return `No ${plural} in this range`
  if (total <= shown) return `All ${total} ${total === 1 ? singular : plural} shown`
  return `Top ${shown} by confidence and recency, with ${total - shown} more not shown`
}

function buildSection(decisions: DecisionOut[], type: DecisionRecordType): PulseSection {
  const matches = decisions
    .filter((decision) => decision.record_type === type)
    .sort((a, b) => b.confidence - a.confidence)
  const shown = matches.slice(0, 3)
  return {
    count: matches.length,
    description: sectionDescription(type, matches.length, shown.length),
    items: shown,
  }
}

const DAY_IN_MS = 24 * 60 * 60 * 1000

function startOfWeek(date: Date) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const daysSinceMonday = (result.getDay() + 6) % 7
  result.setDate(result.getDate() - daysSinceMonday)
  return result
}

function addDays(date: Date, days: number) {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}

function toInputDate(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatNumericDate(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${month}-${day}-${date.getFullYear()}`
}

function formatWeekTitle(start: Date, end: Date) {
  const startText = start.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
  const endText = end.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
  return `${startText} to ${endText}`
}

function getIsoWeek(date: Date) {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNumber = target.getUTCDay() || 7
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber)
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1))
  return Math.ceil(((target.getTime() - yearStart.getTime()) / DAY_IN_MS + 1) / 7)
}

function PulseGroup({
  title,
  color,
  section,
}: {
  title: string
  color: string
  section: PulseSection
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  return (
    <section className="flex gap-3">
      <span
        className="mt-[7px] h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <h2 className="text-[14px] font-medium text-[#242334]">
          {title} <span className="font-normal text-[#8B91A1]">{section.count}</span>
        </h2>
        <p className="mt-0.5 text-[12px] leading-5 text-[#858B9B]">
          {section.description}
        </p>
        <ul className="mt-2 space-y-1.5">
          {section.items.map((decision) => {
            const record = decisionToMemoryRecord(decision)
            const isExpanded = expandedId === decision.id
            return (
              <li key={decision.id}>
                <button
                  type="button"
                  onClick={() =>
                    setExpandedId((current) =>
                      current === decision.id ? null : decision.id,
                    )
                  }
                  className={`flex w-full text-left text-[13px] leading-5 transition-colors ${
                    isExpanded
                      ? 'font-medium text-[#5143DB]'
                      : 'text-[#30303E] hover:text-[#5143DB]'
                  }`}
                  aria-expanded={isExpanded}
                >
                  <span className="mr-2.5 text-[#9197A5]" aria-hidden="true">
                    •
                  </span>
                  <span>{decision.decision_statement}</span>
                </button>
                {isExpanded ? (
                  <div className="mt-2 rounded-xl border border-[#E8E8ED] bg-[#FAFAFB] p-4">
                    <MemoryRecordDetail record={record} />
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}

function FeedbackIcon({ direction }: { direction: 'up' | 'down' }) {
  const transform = direction === 'down' ? 'rotate(180 12 12)' : undefined
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M7.5 10.5v9H4v-9h3.5Zm0 7.5h8.9c1 0 1.8-.7 2-1.7l1.1-5.3a2 2 0 0 0-2-2.5H14l.5-2.7c.2-1.1-.5-2.2-1.6-2.5L8.8 10.5H7.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        transform={transform}
      />
    </svg>
  )
}

export default function TeamPulse() {
  const currentWeekStart = useMemo(() => startOfWeek(new Date()), [])
  const currentWeekEnd = useMemo(() => addDays(currentWeekStart, 6), [currentWeekStart])
  const [rangeStart, setRangeStart] = useState(currentWeekStart)
  const [rangeEnd, setRangeEnd] = useState(currentWeekEnd)
  const [draftStart, setDraftStart] = useState(toInputDate(currentWeekStart))
  const [draftEnd, setDraftEnd] = useState(toInputDate(currentWeekEnd))
  const [isRangePickerOpen, setIsRangePickerOpen] = useState(false)
  const [pulse, setPulse] = useState<TeamPulseData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null)
  // The page's own copy promises "your week, synthesized" - previously
  // nothing on the page was actually synthesized, just a client-side
  // record_type/date filter over the raw decision list. GET /digest?scope=team
  // (real Claude-generated summary, persisted per ISO week in weekly_digests)
  // is only ever generated fresh for the current week server-side; any other
  // week is served strictly from whatever's already cached, since retrieval
  // isn't date-filtered. It's fetched alongside the existing per-item list
  // rather than replacing it - the items below still come from
  // listAllDecisions() so they keep full fidelity (real participant names,
  // clickable through to full memory detail) that the lighter digest
  // response doesn't carry.
  const [digestSummary, setDigestSummary] = useState('')
  const [isDigestLoading, setIsDigestLoading] = useState(false)

  // Was a static `badge: true` on the nav link, always on regardless of
  // whether Team Pulse had ever actually been opened - this is what marks
  // it seen, once, when the page is actually visited.
  useEffect(() => {
    if (localStorage.getItem(TEAM_PULSE_SEEN_KEY)) return
    localStorage.setItem(TEAM_PULSE_SEEN_KEY, 'true')
    window.dispatchEvent(new Event(TEAM_PULSE_SEEN_EVENT))
  }, [])

  const rangeDays = Math.round((rangeEnd.getTime() - rangeStart.getTime()) / DAY_IN_MS) + 1
  const isFullWeek = rangeDays === 7 && rangeStart.getDay() === 1
  const isCurrentWeek =
    toInputDate(rangeStart) === toInputDate(currentWeekStart) &&
    toInputDate(rangeEnd) === toInputDate(currentWeekEnd)
  const periodLabel = isCurrentWeek
    ? 'This Week'
    : isFullWeek
      ? 'Selected Week'
      : 'Selected Date Range'

  // Real backend has no per-range digest endpoint (GET /digest only covers
  // the current ISO week), so the actual per-item list - for any range,
  // including the current week - still pulls every decision the tenant has
  // via GET /api/v1/decisions and filters by record_type + created_at
  // client side, real data for whatever range the picker above selects.
  useEffect(() => {
    let active = true
    setIsLoading(true)
    setLoadError('')

    const rangeStartMs = rangeStart.getTime()
    const rangeEndMs = addDays(rangeEnd, 1).getTime()

    void listAllDecisions()
      .then((decisions) => {
        if (!active) return
        const inRange = decisions.filter((decision) => {
          const createdAt = new Date(decision.created_at).getTime()
          return createdAt >= rangeStartMs && createdAt < rangeEndMs
        })
        setPulse({
          decisions: buildSection(inRange, 'decision'),
          actionItems: buildSection(inRange, 'action_item'),
          blockers: buildSection(inRange, 'blocker'),
        })
      })
      .catch(() => {
        if (active) setLoadError('Unable to load Team Pulse data.')
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })

    return () => {
      active = false
    }
  }, [rangeEnd, rangeStart])

  // The actual synthesized summary. Only meaningful for a full Mon-Sun
  // week (a custom partial range from the date picker doesn't map to one
  // ISO week), and only ever generated fresh for the CURRENT week - the
  // backend serves any other week strictly from whatever's already cached
  // in weekly_digests, since retrieval isn't date-filtered and regenerating
  // for a past week would just mislabel today's top matches with an old
  // date range. That means: from here on, every week that gets visited
  // while it's current stays available when you navigate back to it later;
  // a week nobody opened Team Pulse during (including every week before
  // this existed) has nothing cached and correctly shows nothing.
  useEffect(() => {
    if (!isFullWeek) {
      setDigestSummary('')
      return
    }
    let active = true
    setIsDigestLoading(true)
    getDigest('team', false, toInputDate(rangeStart))
      .then((digest) => {
        if (active) setDigestSummary(digest.summary)
      })
      .catch(() => {
        // Fails quietly (also the expected path for a past week with no
        // cached digest, a plain 404) - the per-item breakdown below still
        // loads independently and is the more load-bearing part of the page.
        if (active) setDigestSummary('')
      })
      .finally(() => {
        if (active) setIsDigestLoading(false)
      })
    return () => {
      active = false
    }
  }, [isFullWeek, rangeStart])

  const moveRange = (amount: number) => {
    const dayOffset = amount * rangeDays
    const nextStart = addDays(rangeStart, dayOffset)
    const nextEnd = addDays(rangeEnd, dayOffset)
    setRangeStart(nextStart)
    setRangeEnd(nextEnd)
    setDraftStart(toInputDate(nextStart))
    setDraftEnd(toInputDate(nextEnd))
  }

  const openRangePicker = () => {
    setDraftStart(toInputDate(rangeStart))
    setDraftEnd(toInputDate(rangeEnd))
    setIsRangePickerOpen(true)
  }

  const applyRange = () => {
    const [startYear, startMonth, startDay] = draftStart.split('-').map(Number)
    const [endYear, endMonth, endDay] = draftEnd.split('-').map(Number)
    setRangeStart(new Date(startYear, startMonth - 1, startDay))
    setRangeEnd(new Date(endYear, endMonth - 1, endDay))
    setIsRangePickerOpen(false)
  }

  return (
    <main className="mx-auto max-w-[1064px] px-4 py-6 sm:px-8">
        <div className="mb-4">
          <h1 className="text-[24px] font-semibold leading-tight text-[#17171D]">Pulse</h1>
          <p className="mt-1 text-[14px] text-[#7C8392]">
            Your week, synthesized. New every Monday.
          </p>
        </div>

        <article className="rounded-[8px] border border-[#E2E4EA] bg-white">
          <header className="flex min-h-[98px] flex-col items-start justify-between gap-5 border-b border-[#E6E7EC] px-6 py-4 md:flex-row md:items-center md:gap-6">
            <div>
              <p className="text-[12px] font-medium text-[#7D8494]">
                {periodLabel}
              </p>
              <div className="mt-4 flex items-center gap-3">
                <h2 className="text-[22px] font-semibold leading-none text-[#17171D]">
                  {formatWeekTitle(rangeStart, rangeEnd)}
                </h2>
                <span className="rounded-full bg-[#E8E5FF] px-3 py-1 text-[11px] font-medium text-[#6254D9]">
                  {isFullWeek
                    ? `Q${Math.floor(rangeStart.getMonth() / 3) + 1} · W${getIsoWeek(rangeStart)}`
                    : `${rangeDays} days`}
                </span>
              </div>
            </div>

            <div className="flex w-full items-center gap-2 md:w-auto md:shrink-0">
              <button
                type="button"
                aria-label="Previous week"
                onClick={() => moveRange(-1)}
                className="flex h-8 w-8 items-center justify-center rounded-[7px] border border-[#E0E2E8] text-[20px] text-[#4A4F5B] hover:bg-[#F7F7FA]"
              >
                ‹
              </button>
              <div className="relative min-w-0 flex-1 md:min-w-[245px]">
                <button
                  type="button"
                  aria-label="Choose date range"
                  aria-expanded={isRangePickerOpen}
                  onClick={() => (isRangePickerOpen ? setIsRangePickerOpen(false) : openRangePicker())}
                  className="flex h-8 w-full items-center justify-center gap-2 rounded-[16px] border border-[#E0E2E8] px-2 text-[11px] text-[#3F424C] hover:bg-[#F7F7FA] sm:gap-3 sm:px-4 sm:text-[13px]"
                >
                  <span>{formatNumericDate(rangeStart)}</span>
                  <span className="text-[#8B91A0]">to</span>
                  <span>{formatNumericDate(rangeEnd)}</span>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                  </svg>
                </button>

                {isRangePickerOpen ? (
                  <div className="absolute right-0 top-10 z-30 w-[290px] rounded-[8px] border border-[#E0E2E8] bg-white p-4 shadow-[0_12px_30px_rgba(24,24,35,0.14)]">
                    <p className="text-[13px] font-semibold text-[#242334]">Select date range</p>
                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <label className="text-[11px] font-medium text-[#747B8A]">
                        Start date
                        <input
                          type="date"
                          value={draftStart}
                          max={draftEnd}
                          onInput={(event) => setDraftStart(event.currentTarget.value)}
                          className="mt-1 block h-9 w-full rounded-[6px] border border-[#DDE0E7] px-2 text-[12px] text-[#30303E] outline-none focus:border-[#6254D9]"
                        />
                      </label>
                      <label className="text-[11px] font-medium text-[#747B8A]">
                        End date
                        <input
                          type="date"
                          value={draftEnd}
                          min={draftStart}
                          onInput={(event) => setDraftEnd(event.currentTarget.value)}
                          className="mt-1 block h-9 w-full rounded-[6px] border border-[#DDE0E7] px-2 text-[12px] text-[#30303E] outline-none focus:border-[#6254D9]"
                        />
                      </label>
                    </div>
                    <div className="mt-4 flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setIsRangePickerOpen(false)}
                        className="h-8 px-3 text-[12px] font-medium text-[#6F7685]"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={!draftStart || !draftEnd || draftEnd < draftStart}
                        onClick={applyRange}
                        className="h-8 rounded-[6px] bg-[#5143DB] px-4 text-[12px] font-medium text-white hover:bg-[#4033C5] disabled:cursor-not-allowed disabled:bg-[#B7B3E8]"
                      >
                        Apply
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                aria-label="Next week"
                onClick={() => moveRange(1)}
                className="flex h-8 w-8 items-center justify-center rounded-[7px] border border-[#E0E2E8] text-[20px] text-[#4A4F5B] hover:bg-[#F7F7FA]"
              >
                ›
              </button>
            </div>
          </header>

          <div className="min-h-[405px] space-y-7 px-6 py-5">
            {isLoading ? (
              <p className="text-[14px] text-[#858B9B]">Loading Team Pulse…</p>
            ) : loadError ? (
              <p role="alert" className="text-[14px] text-[#B4232C]">
                {loadError}
              </p>
            ) : pulse ? (
              <>
                {isFullWeek ? (
                  isDigestLoading ? (
                    <p className="text-[13px] italic text-[#9CA3AF]">
                      {isCurrentWeek ? 'Synthesizing this week…' : 'Loading…'}
                    </p>
                  ) : digestSummary ? (
                    <p className="whitespace-pre-wrap rounded-[6px] bg-[#F7F7FB] p-4 text-[14px] leading-relaxed text-[#3F424C]">
                      {digestSummary}
                    </p>
                  ) : null
                ) : null}
                <PulseGroup title="Decisions" color="#5644DF" section={pulse.decisions} />
                <PulseGroup title="Action items" color="#9CDD24" section={pulse.actionItems} />
                <PulseGroup title="Blockers" color="#F3464B" section={pulse.blockers} />
              </>
            ) : null}
          </div>

          <footer className="flex h-[58px] items-center justify-between border-t border-[#E6E7EC] px-6">
            <div className="flex items-center gap-2 text-[13px] text-[#818897]">
              <span>Useful?</span>
              {(['up', 'down'] as const).map((direction) => (
                <button
                  key={direction}
                  type="button"
                  aria-label={direction === 'up' ? 'Helpful' : 'Not helpful'}
                  aria-pressed={feedback === direction}
                  onClick={() => setFeedback((current) => (current === direction ? null : direction))}
                  className={`flex h-7 w-7 items-center justify-center rounded-[7px] border transition-colors ${
                    feedback === direction
                      ? 'border-[#6254D9] bg-[#F0EEFF] text-[#6254D9]'
                      : 'border-[#E1E3E9] text-[#858C9B] hover:bg-[#F7F7FA]'
                  }`}
                >
                  <FeedbackIcon direction={direction} />
                </button>
              ))}
            </div>
            <Link
              to="/decision-log"
              className="text-[14px] font-medium text-[#5544E6] hover:text-[#4030CA]"
            >
              View full Memory Explorer
            </Link>
          </footer>
        </article>
      </main>
  )
}
