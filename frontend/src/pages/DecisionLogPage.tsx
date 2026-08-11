import { Fragment, useEffect, useState } from 'react'
import {
  ApiError,
  listDecisions,
  type DecisionOut,
  type DecisionRecordType,
} from '../lib/api'
import { decisionToMemoryRecord } from '../lib/memoryRecord'
import {
  MemoryRecordDetail,
  STATUS_STYLES,
  TYPE_STYLES,
  type MemoryRecordType,
} from '../components/MemoryRecordDetail'

type FilterType = 'All Types' | DecisionRecordType
type SourceFilter = 'All Sources' | 'slack' | 'gmail' | 'notion'

const FILTERS: { id: FilterType; label: string }[] = [
  { id: 'All Types', label: 'All Types' },
  { id: 'decision', label: 'Decision' },
  { id: 'action_item', label: 'Action Item' },
  { id: 'blocker', label: 'Blocker' },
]

const SOURCE_FILTERS: { id: SourceFilter; label: string }[] = [
  { id: 'All Sources', label: 'All Sources' },
  { id: 'slack', label: 'Slack' },
  { id: 'gmail', label: 'Gmail' },
  { id: 'notion', label: 'Notion' },
]

const TYPE_LABELS: Record<DecisionRecordType, MemoryRecordType> = {
  decision: 'Decision',
  action_item: 'Action Item',
  blocker: 'Blocker',
}

const PAGE_SIZE = 12

function isKnownRecordType(value: string): value is DecisionRecordType {
  return value === 'decision' || value === 'action_item' || value === 'blocker'
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

const PLATFORM_LABELS: Record<string, string> = {
  gmail: 'Gmail',
  slack: 'Slack',
  notion: 'Notion',
}

function SourceCell({ sourceLinks, sourcePlatforms }: { sourceLinks: string[]; sourcePlatforms: string[] }) {
  const platformLabel = sourcePlatforms[0] ? PLATFORM_LABELS[sourcePlatforms[0]] ?? sourcePlatforms[0] : null

  if (sourceLinks.length === 0) {
    return <span className="text-[14px] text-[#9CA3AF]">{platformLabel ?? '—'}</span>
  }
  // The column header already says "Source" - repeating "View source
  // (Gmail)" on every single row was redundant with itself, not just the
  // header, since it read the same way whether the row was Gmail, Slack, or
  // Notion the same way every time. The platform name alone, linked, says
  // everything the longer phrasing did.
  return (
    <a
      href={sourceLinks[0]}
      target="_blank"
      rel="noreferrer"
      className="text-[14px] font-medium text-[#5A45FF] hover:underline"
    >
      {platformLabel ?? 'View source'}
    </a>
  )
}

export default function DecisionLogPage() {
  const [selectedType, setSelectedType] = useState<FilterType>('All Types')
  const [selectedSource, setSelectedSource] = useState<SourceFilter>('All Sources')
  const [currentPage, setCurrentPage] = useState(1)
  const [entries, setEntries] = useState<DecisionOut[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const loadPage = (page: number, isManualRefresh = false) => {
    if (isManualRefresh) setIsRefreshing(true)
    else setIsLoading(true)
    setError('')

    const offset = (page - 1) * PAGE_SIZE
    const recordType = selectedType === 'All Types' ? undefined : selectedType
    const source = selectedSource === 'All Sources' ? undefined : selectedSource
    return listDecisions(PAGE_SIZE, offset, recordType, source)
      .then((response) => {
        setEntries(response.items)
        setTotal(response.total)
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : 'Unable to load the decision log.')
      })
      .finally(() => {
        if (isManualRefresh) setIsRefreshing(false)
        else setIsLoading(false)
      })
  }

  useEffect(() => {
    void loadPage(currentPage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, selectedType, selectedSource])

  // Filtering by type and source now happens server-side (see loadPage), so
  // `entries` already reflects the current filter across the whole archive,
  // not just whatever page happened to be loaded first.
  const filteredEntries = entries

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <main className="mx-auto max-w-[1120px] px-8 py-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[32px] font-bold leading-tight tracking-[-0.02em] text-[#111827]">
            Memory Explorer
          </h1>
          <p className="mt-2 text-[15px] text-[#6B7280]">
            Every captured decision, action item, and blocker is searchable and cited.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadPage(currentPage, true)}
          disabled={isRefreshing || isLoading}
          aria-label="Refresh"
          className="mt-1 flex shrink-0 items-center gap-2 rounded-full border border-[#E5E7EB] bg-white px-4 py-2 text-[13px] font-semibold text-[#374151] transition-colors hover:bg-[#F9FAFB] disabled:cursor-not-allowed disabled:opacity-60"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            className={isRefreshing ? 'animate-spin' : ''}
          >
            <path
              d="M4 4v6h6M20 20v-6h-6M4.5 15a8 8 0 0 0 14.6 2.5M19.5 9A8 8 0 0 0 4.9 6.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {isRefreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div
        className="mt-6 flex flex-wrap gap-2.5"
        role="radiogroup"
        aria-label="Filter by type"
      >
        {FILTERS.map((filter) => {
          const isSelected = selectedType === filter.id
          return (
            <button
              key={filter.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => {
                setSelectedType(filter.id)
                setCurrentPage(1)
              }}
              className={`rounded-full px-4 py-2 text-[13px] font-semibold transition-colors ${
                isSelected
                  ? 'bg-[#5A45FF] text-white'
                  : 'border border-[#E5E7EB] bg-white text-[#374151] hover:bg-[#F9FAFB]'
              }`}
            >
              {filter.label}
            </button>
          )
        })}
      </div>

      <div
        className="mt-2.5 flex flex-wrap gap-2.5"
        role="radiogroup"
        aria-label="Filter by source"
      >
        {SOURCE_FILTERS.map((filter) => {
          const isSelected = selectedSource === filter.id
          return (
            <button
              key={filter.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => {
                setSelectedSource(filter.id)
                setCurrentPage(1)
              }}
              className={`rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition-colors ${
                isSelected
                  ? 'bg-[#111827] text-white'
                  : 'border border-[#E5E7EB] bg-white text-[#6B7280] hover:bg-[#F9FAFB]'
              }`}
            >
              {filter.label}
            </button>
          )
        })}
      </div>

      {error ? (
        <p role="alert" className="mt-4 text-[14px] text-[#B4232C]">
          {error}
        </p>
      ) : null}

      <div className="mt-6 overflow-hidden rounded-2xl border border-[#E8E8ED] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-[#F0F0F4]">
              {['Type', 'Summary', 'Source', 'Date', 'Status'].map((heading) => (
                <th
                  key={heading}
                  className="px-5 py-3.5 text-[12px] font-semibold tracking-[0.02em] text-[#9CA3AF]"
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={5} className="px-5 py-12 text-center text-[14px] text-[#6B7280]">
                  Loading decisions...
                </td>
              </tr>
            ) : filteredEntries.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-12 text-center text-[14px] text-[#6B7280]">
                  No entries match that filter.
                </td>
              </tr>
            ) : (
              filteredEntries.map((entry, index) => {
                const recordType = isKnownRecordType(entry.record_type)
                  ? entry.record_type
                  : 'decision'
                const isSuperseded = Boolean(entry.superseded_by)
                const isExpanded = expandedId === entry.id
                return (
                  <Fragment key={entry.id}>
                    <tr
                      onClick={() =>
                        setExpandedId((current) => (current === entry.id ? null : entry.id))
                      }
                      className={`cursor-pointer transition-colors hover:bg-[#FAFAFB] ${
                        isExpanded ? 'bg-[#FAFAFB]' : ''
                      } ${
                        index < filteredEntries.length - 1 || isExpanded
                          ? 'border-b border-[#F0F0F4]'
                          : ''
                      }`}
                      aria-expanded={isExpanded}
                    >
                      <td className="px-5 py-3.5">
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${TYPE_STYLES[TYPE_LABELS[recordType]]}`}
                        >
                          {TYPE_LABELS[recordType]}
                        </span>
                      </td>
                      <td className="max-w-[360px] truncate px-5 py-3.5 text-[14px] text-[#111827]">
                        {entry.decision_statement}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3.5">
                        <SourceCell sourceLinks={entry.source_links} sourcePlatforms={entry.source_platforms} />
                      </td>
                      <td className="whitespace-nowrap px-5 py-3.5 text-[14px] text-[#6B7280]">
                        {formatDate(entry.created_at)}
                      </td>
                      <td className="px-5 py-3.5">
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                            STATUS_STYLES[isSuperseded ? 'Superseded' : 'Current']
                          }`}
                        >
                          {isSuperseded ? 'Superseded' : 'Current'}
                        </span>
                      </td>
                    </tr>
                    {isExpanded ? (
                      <tr className="border-b border-[#F0F0F4]">
                        <td colSpan={5} className="bg-[#F7F7F9] px-5 py-5">
                          <MemoryRecordDetail record={decisionToMemoryRecord(entry)} compactHeader />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-5 flex items-center justify-between">
        <p className="text-[13px] text-[#9CA3AF]">
          {total > 0
            ? `Showing ${(currentPage - 1) * PAGE_SIZE + 1} to ${Math.min(currentPage * PAGE_SIZE, total)} of ${total} results`
            : isLoading
              ? 'Loading...'
              : 'No results'}
        </p>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label="Previous page"
            disabled={currentPage <= 1}
            className="flex h-8 w-8 items-center justify-center rounded-full text-[#6B7280] hover:bg-[#F3F4F6] disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M15 6l-6 6 6 6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          <span className="px-2 text-[13px] font-medium text-[#374151]">
            Page {currentPage} of {totalPages}
          </span>

          <button
            type="button"
            aria-label="Next page"
            disabled={currentPage >= totalPages}
            className="flex h-8 w-8 items-center justify-center rounded-full text-[#6B7280] hover:bg-[#F3F4F6] disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M9 6l6 6-6 6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
    </main>
  )
}
