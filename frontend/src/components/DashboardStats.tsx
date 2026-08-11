import { useEffect, useState, type ReactElement } from 'react'
import { listAllDecisions } from '../lib/api'

function GavelIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M14.5 4.5l5 5M4 20h8M13.2 6.8l-7.4 7.4 2.1 2.1 7.4-7.4-2.1-2.1z"
        stroke="#5A45FF"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 20h8"
        stroke="#5A45FF"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 13l4 4L16 7"
        stroke="#65A30D"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9 13l4 4L21 7"
        stroke="#65A30D"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function WarningIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3.5L21 20H3L12 3.5z"
        stroke="#DC2626"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M12 10v4" stroke="#DC2626" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="16.5" r="1" fill="#DC2626" />
    </svg>
  )
}

type StatKey = 'decision' | 'action_item' | 'blocker'

const STAT_META: { key: StatKey; label: string; valueClass: string; iconBg: string; icon: ReactElement }[] = [
  {
    key: 'decision',
    label: 'Decisions',
    valueClass: 'text-[#5A45FF]',
    iconBg: 'bg-[#EEEBFF]',
    icon: <GavelIcon />,
  },
  {
    key: 'action_item',
    label: 'Action Items',
    valueClass: 'text-[#111827]',
    iconBg: 'bg-[#ECFCCB]',
    icon: <CheckIcon />,
  },
  {
    key: 'blocker',
    label: 'Blockers',
    valueClass: 'text-[#DC2626]',
    iconBg: 'bg-[#FEE2E2]',
    icon: <WarningIcon />,
  },
]

export function DashboardStats() {
  const [counts, setCounts] = useState<Record<StatKey, number> | null>(null)

  useEffect(() => {
    let active = true

    void listAllDecisions()
      .then((decisions) => {
        if (!active) return
        const next: Record<StatKey, number> = { decision: 0, action_item: 0, blocker: 0 }
        for (const decision of decisions) {
          if (decision.record_type === 'decision' || decision.record_type === 'action_item' || decision.record_type === 'blocker') {
            next[decision.record_type] += 1
          }
        }
        setCounts(next)
      })
      .catch(() => {
        if (active) setCounts({ decision: 0, action_item: 0, blocker: 0 })
      })

    return () => {
      active = false
    }
  }, [])

  return (
    <section className="mb-8 grid grid-cols-3 gap-4">
      {STAT_META.map((stat) => (
        <div
          key={stat.key}
          className="rounded-2xl border border-[#E8E8ED] bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]"
        >
          <div className="mb-3 flex items-start justify-between">
            <span className="text-[13px] font-medium text-[#6B7280]">
              {stat.label}
            </span>
            <div
              className={`flex h-9 w-9 items-center justify-center rounded-lg ${stat.iconBg}`}
            >
              {stat.icon}
            </div>
          </div>
          <p className={`text-[40px] font-bold leading-none tracking-[-0.03em] ${stat.valueClass}`}>
            {counts === null ? '—' : counts[stat.key]}
          </p>
        </div>
      ))}
    </section>
  )
}
