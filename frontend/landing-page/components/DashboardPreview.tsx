import { LocusLogo } from './LocusLogo'

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="4.25" stroke="#9ca3af" strokeWidth="1.4" />
      <path d="M9.2 9.2L12 12" stroke="#9ca3af" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function DecisionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5.5" stroke="#5b52e8" strokeWidth="1.4" />
      <path d="M4.5 7.2L6.2 8.8L9.5 5.2" stroke="#5b52e8" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ActionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="9" height="9" rx="1.5" stroke="#84cc16" strokeWidth="1.4" />
      <path d="M5 7h4M7 5v4" stroke="#84cc16" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function BlockerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5.5" stroke="#ef4444" strokeWidth="1.4" />
      <path d="M4.8 4.8l4.4 4.4M9.2 4.8l-4.4 4.4" stroke="#ef4444" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function SourceIcon({ label }: { label: string }) {
  const colors: Record<string, string> = {
    Slack: 'bg-[#4A154B]',
    Notion: 'bg-[#111827]',
    Gmail: 'bg-[#EA4335]',
  }
  return (
    <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white ${colors[label] ?? 'bg-gray-700'}`}>
      {label[0]}
    </div>
  )
}

const NAV_ITEMS = ['How it works', 'Dashboard', 'Memory Explorer', 'Pulse', 'Settings']

const RECENT_SEARCHES = [
  'What do we know about the onboarding flow?',
  'Who owns the legal sign-off blocker?',
  'What context exists around pricing changes?',
]

const SOURCES = ['Slack', 'Notion', 'Gmail']

const CAPTURES = [
  { tag: 'Decision', tagClass: 'bg-[#eee8ff] text-[#5b52e8]', text: 'Adopt PostgreSQL for the context layer' },
  { tag: 'Blocker', tagClass: 'bg-[#fee2e2] text-[#ef4444]', text: 'Legal sign-off blocking onboarding copy' },
  { tag: 'Action item', tagClass: 'bg-[#ecfccb] text-[#65a30d]', text: 'Notify client services of revised launch date' },
  { tag: 'Decision', tagClass: 'bg-[#eee8ff] text-[#5b52e8]', text: 'Ship v2 without custom fields feature' },
]

export function DashboardPreview() {
  return (
    <div className="relative flex flex-1 items-start justify-end pt-1">
      <div
        className="relative w-full max-w-[560px] shrink-0 overflow-hidden rounded-[14px] border border-[#e8e8ee] bg-white"
        style={{
          boxShadow:
            '0 20px 40px -10px rgba(91, 82, 232, 0.18), 0 10px 20px -8px rgba(17, 24, 39, 0.08)',
        }}
      >
        {/* Dashboard chrome header */}
        <div className="flex items-center justify-between border-b border-[#f0f0f4] px-4 py-2.5">
          <LocusLogo className="scale-[0.85] origin-left" />
          <nav className="flex items-center gap-3.5">
            {NAV_ITEMS.map((item) => (
              <span
                key={item}
                className={`relative text-[10.5px] ${
                  item === 'Dashboard'
                    ? 'font-semibold text-[#5b52e8] after:absolute after:-bottom-[11px] after:left-0 after:right-0 after:h-[2px] after:rounded-full after:bg-[#5b52e8]'
                    : 'font-medium text-[#9ca3af]'
                }`}
              >
                {item}
              </span>
            ))}
          </nav>
        </div>

        <div className="px-4 pb-4 pt-3">
          <h3 className="text-[15px] font-bold text-[#111827]">Good morning, Jun</h3>

          {/* Search */}
          <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-[#e5e7eb] bg-[#fafafa] px-3 py-2">
            <SearchIcon />
            <span className="text-[11.5px] text-[#9ca3af]">
              Ask anything your organization already knows.
            </span>
          </div>

          {/* Suggestion pills */}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[0, 1].map((i) => (
              <span
                key={i}
                className="rounded-full border border-[#e5e7eb] bg-white px-2.5 py-1 text-[10px] text-[#6b7280]"
              >
                What does our org already know about the Q3 timeline?
              </span>
            ))}
          </div>

          {/* Recent search */}
          <div className="mt-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[#9ca3af]">
              Recent Search
            </p>
            <ul className="mt-1.5 space-y-1">
              {RECENT_SEARCHES.map((item, index) => (
                <li key={`${item}-${index}`} className="flex items-center gap-1.5 text-[11px] text-[#6b7280]">
                  <SearchIcon />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          {/* Metric cards */}
          <div className="mt-3 grid grid-cols-3 gap-2">
            <div className="rounded-lg border border-[#e8e8ee] px-2.5 py-2">
              <div className="flex items-center gap-1">
                <DecisionIcon />
                <span className="text-[9.5px] font-medium uppercase tracking-wide text-[#9ca3af]">
                  Decisions
                </span>
              </div>
              <p className="mt-1 text-[22px] font-bold leading-none text-[#5b52e8]">7</p>
            </div>
            <div className="rounded-lg border border-[#e8e8ee] px-2.5 py-2">
              <div className="flex items-center gap-1">
                <ActionIcon />
                <span className="text-[9.5px] font-medium uppercase tracking-wide text-[#9ca3af]">
                  Action Items
                </span>
              </div>
              <p className="mt-1 text-[22px] font-bold leading-none text-[#84cc16]">7</p>
            </div>
            <div className="rounded-lg border border-[#e8e8ee] px-2.5 py-2">
              <div className="flex items-center gap-1">
                <BlockerIcon />
                <span className="text-[9.5px] font-medium uppercase tracking-wide text-[#9ca3af]">
                  Blockers
                </span>
              </div>
              <p className="mt-1 text-[22px] font-bold leading-none text-[#ef4444]">7</p>
            </div>
          </div>

          {/* Bottom panels */}
          <div className="mt-3 grid grid-cols-2 gap-2.5">
            <div className="rounded-lg border border-[#e8e8ee] p-2.5">
              <p className="text-[9.5px] font-semibold uppercase tracking-[0.06em] text-[#9ca3af]">
                Memory Sources
              </p>
              <ul className="mt-2 space-y-2">
                {SOURCES.map((source) => (
                  <li key={source} className="flex items-center gap-2">
                    <SourceIcon label={source} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-semibold text-[#111827]">{source}</p>
                      <p className="text-[9.5px] text-[#9ca3af]">Synced today 9:00 am</p>
                    </div>
                    <span className="flex items-center gap-1 text-[9.5px] font-medium text-[#16a34a]">
                      <span className="h-1.5 w-1.5 rounded-full bg-[#16a34a]" />
                      Active
                    </span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="mt-2.5 text-[10.5px] font-medium text-[#5b52e8]"
              >
                + Add Memory Source
              </button>
            </div>

            <div className="rounded-lg border border-[#e8e8ee] p-2.5">
              <p className="text-[9.5px] font-semibold uppercase tracking-[0.06em] text-[#9ca3af]">
                Build Memory
              </p>
              <ul className="mt-2 space-y-2">
                {CAPTURES.map((capture, index) => (
                  <li
                    key={`${capture.tag}-${index}`}
                    className="grid grid-cols-[58px_minmax(0,1fr)] items-start gap-2"
                  >
                    <span
                      className={`inline-flex w-[58px] justify-center rounded px-1.5 py-0.5 text-[8.5px] font-semibold ${capture.tagClass}`}
                    >
                      {capture.tag}
                    </span>
                    <span className="text-[10.5px] leading-snug text-[#374151]">
                      {capture.text}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
