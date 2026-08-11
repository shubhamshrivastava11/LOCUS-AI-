import { useEffect, useState } from 'react'
import { ApiError, listDecisions, type DecisionOut } from '../lib/api'
import { decisionToMemoryRecord } from '../lib/memoryRecord'
import { MemoryRecordDetail, TYPE_STYLES } from './MemoryRecordDetail'

export function DashboardCaptures() {
  const [captures, setCaptures] = useState<DecisionOut[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    listDecisions(5, 0)
      .then((response) => {
        if (active) setCaptures(response.items)
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof ApiError ? err.message : 'Unable to load recent captures.')
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <section>
      <h2 className="mb-3 text-[11px] font-semibold tracking-[0.08em] text-[#9CA3AF] uppercase">
        Build Memory
      </h2>
      <div className="overflow-hidden rounded-2xl border border-[#E8E8ED] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
        {isLoading ? (
          <p className="px-4 py-6 text-center text-[13px] text-[#9CA3AF]">Loading...</p>
        ) : error ? (
          <p className="px-4 py-6 text-center text-[13px] text-[#B4232C]">{error}</p>
        ) : captures.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-[#9CA3AF]">No captures yet.</p>
        ) : (
          <ul>
            {captures.map((capture, i) => {
              const record = decisionToMemoryRecord(capture)
              const isExpanded = expandedId === capture.id
              return (
                <li
                  key={capture.id}
                  className={i < captures.length - 1 ? 'border-b border-[#F0F0F4]' : ''}
                >
                  {isExpanded ? (
                    <div className="bg-white px-4 py-4">
                      <MemoryRecordDetail record={record} onHeaderClick={() => setExpandedId(null)} />
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setExpandedId(capture.id)}
                      className="grid w-full grid-cols-[92px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-[#FAFAFB]"
                      aria-expanded={false}
                    >
                      <span
                        className={`inline-flex w-[92px] justify-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${TYPE_STYLES[record.type]}`}
                      >
                        {record.type}
                      </span>
                      <p className="min-w-0 truncate text-[14px] text-[#111827]">
                        {record.title}
                      </p>
                      <span className="shrink-0 text-[12px] text-[#9CA3AF]">{record.meta}</span>
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
