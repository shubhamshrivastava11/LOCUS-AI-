import { useEffect, useState } from 'react'
import { fetchSourceConnections, type SourceId } from '../lib/sourceConnections'
import { SourceLogo, type SourceName } from './SourceLogo'

type SourceMeta = { id: SourceId; name: string; source: SourceName }

const SOURCE_META: SourceMeta[] = [
  { id: 'slack', name: 'Slack', source: 'Slack' },
  { id: 'notion', name: 'Notion', source: 'Notion' },
  { id: 'gmail', name: 'Gmail', source: 'Gmail' },
]

type ConnectionInfo = { status: string; lastSyncedAt: string | null } | null

function formatSync(info: ConnectionInfo) {
  if (!info || info.status !== 'active') return 'Not yet synced'
  if (!info.lastSyncedAt) return 'Not yet synced'

  const elapsedMs = Math.max(0, Date.now() - new Date(info.lastSyncedAt).getTime())
  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 1) return 'Synced just now'
  if (minutes < 60) return `Synced ${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Synced ${hours}h ago`
  return `Synced ${Math.floor(hours / 24)}d ago`
}

export function DashboardSources() {
  const [connections, setConnections] = useState<Record<SourceId, ConnectionInfo>>({
    slack: null,
    notion: null,
    gmail: null,
  })

  useEffect(() => {
    let active = true

    void fetchSourceConnections()
      .then((rows) => {
        if (!active) return
        setConnections((current) => {
          const next = { ...current }
          for (const row of rows) {
            next[row.source] = { status: row.status, lastSyncedAt: row.last_synced_at }
          }
          return next
        })
      })
      .catch(() => {
        // Leave sources showing "Disconnected" if the tenant/session lookup fails.
      })

    return () => {
      active = false
    }
  }, [])

  return (
    <section>
      <h2 className="mb-3 text-[11px] font-semibold tracking-[0.08em] text-[#9CA3AF] uppercase">
        Memory Sources
      </h2>
      <div className="overflow-hidden rounded-2xl border border-[#E8E8ED] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
        <ul>
          {SOURCE_META.map((source, i) => {
            const info = connections[source.id]
            const isActive = info?.status === 'active'
            return (
              <li
                key={source.id}
                className={`flex items-center gap-3 px-4 py-3.5 ${
                  i < SOURCE_META.length - 1 ? 'border-b border-[#F0F0F4]' : ''
                }`}
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#F7F7FA]">
                  <SourceLogo source={source.source} className="h-6 w-6" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold text-[#111827]">
                    {source.name}
                  </p>
                  <p className="text-[12px] text-[#9CA3AF]">{formatSync(info)}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      isActive ? 'bg-[#22C55E]' : 'bg-[#EF4444]'
                    }`}
                  />
                  <span
                    className={`text-[12px] font-medium ${
                      isActive ? 'text-[#16A34A]' : 'text-[#EF4444]'
                    }`}
                  >
                    {isActive ? 'Active' : 'Disconnected'}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
        <div className="border-t border-[#F0F0F4] p-3">
          <button
            type="button"
            className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-[#C7C7D1] py-2.5 text-[13px] font-semibold text-[#5A45FF] transition-colors hover:bg-[#F8F7FF]"
          >
            <span className="text-[16px] leading-none">+</span>
            Add Memory Source
          </button>
        </div>
      </div>
    </section>
  )
}
