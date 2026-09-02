import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ApiError,
  getMemoryEvidence,
  getRelatedEntities,
  listMemories,
  type CanonicalMemory,
  type EntityType,
  type MemoryEvidence,
  type MemoryStatus,
  type MemoryType,
  type RelatedEntity,
} from '../lib/api'
import { getStateAsOf } from '../lib/memoryTemporal'
import { computeEntityActivity, entityDescription, isActiveThisWeek, relativeRecencyLabel, type EntityActivity } from '../lib/entityActivity'

// Wider status set than MemoryRecordDetail's STATUS_STYLES (Current/
// Superseded only, for the old decisions table) - the memory layer has six
// real states, and superseded/contradicted/unresolved need to read as
// visually distinct from each other, not just "not current", per the plan's
// Checkpoint C requirement.
const STATUS_STYLES: Record<MemoryStatus, string> = {
  proposed: 'bg-[#F3F4F6] text-[#6B7280]',
  current: 'bg-[#EEEBFF] text-[#5A45FF]',
  stale: 'bg-[#FEF3C7] text-[#92400E]',
  superseded: 'bg-[#F3F4F6] text-[#6B7280]',
  contradicted: 'bg-[#FEE2E2] text-[#DC2626]',
  unresolved: 'bg-[#FEE2E2] text-[#DC2626]',
}

const STATUS_LABELS: Record<MemoryStatus, string> = {
  proposed: 'Proposed',
  current: 'Current',
  stale: 'Stale',
  superseded: 'Superseded',
  contradicted: 'Contradicted',
  unresolved: 'Unresolved conflict',
}

const FRESHNESS_STYLES: Record<string, string> = {
  fresh: 'bg-[#ECFCCB] text-[#4D7C0F]',
  aging: 'bg-[#FEF3C7] text-[#92400E]',
  stale: 'bg-[#FEE2E2] text-[#DC2626]',
}

const ALL_TYPES = 'All Types'
const ALL_SOURCES = 'All Sources'
const ALL_STATUSES = 'All Statuses'

type TypeFilter = typeof ALL_TYPES | MemoryType
type SourceFilter = typeof ALL_SOURCES | string
type StatusFilter = typeof ALL_STATUSES | MemoryStatus

// Browse mode's grouping, narrowed to the memory-explorer upgrade's 3
// relational entity types. Systems/Topics/Products/Customers are no longer
// entities at all (see EntityType's comment) - they're memory.tags now,
// so there's no shelf for them here; a tag isn't a thing you recenter the
// timeline on the way an entity is.
const ENTITY_GROUPS: { label: string; types: EntityType[] }[] = [
  { label: 'People', types: ['Person'] },
  { label: 'Projects', types: ['Project'] },
  { label: 'Teams', types: ['Team'] },
]

const ALL_GROUPS = 'All Types'
const ALL_SOURCES_PICKER = 'All Sources'

// One color per type, reused identically for the section-header badge and
// the jump-chip row, so it's learned once ("blue = Projects") rather than
// two different visual languages for the same grouping.
const GROUP_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  People: { bg: 'bg-[#F3E8FF]', text: 'text-[#7C3AED]', dot: 'bg-[#7C3AED]' },
  Projects: { bg: 'bg-[#DBEAFE]', text: 'text-[#2563EB]', dot: 'bg-[#2563EB]' },
  Teams: { bg: 'bg-[#DCFCE7]', text: 'text-[#16A34A]', dot: 'bg-[#16A34A]' },
  'Systems & Topics': { bg: 'bg-[#F1F5F9]', text: 'text-[#475569]', dot: 'bg-[#475569]' },
  Customers: { bg: 'bg-[#FEF3C7]', text: 'text-[#B45309]', dot: 'bg-[#B45309]' },
}

const PREVIEW_CARD_COUNT = 4

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// One visual per card, not a chart plus a number plus a trend arrow - 7
// bars, one per week, height scaled by that week's memory count.
function ActivitySparkline({ weeklyCounts }: { weeklyCounts: number[] }) {
  const max = Math.max(1, ...weeklyCounts)
  return (
    <div className="flex h-4 items-end gap-[2px]" aria-hidden="true">
      {weeklyCounts.map((count, i) => (
        <div
          key={i}
          className={`w-[3px] rounded-sm ${count > 0 ? 'bg-[#5A45FF]' : 'bg-[#E5E7EB]'}`}
          style={{ height: `${Math.max(15, (count / max) * 100)}%` }}
        />
      ))}
    </div>
  )
}

function EntityCard({
  id,
  name,
  description,
  activity,
  flagged,
  onSelect,
}: {
  id: string
  name: string
  description: string | null
  activity: EntityActivity
  flagged: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      className="flex flex-col gap-2 rounded-xl border border-[#E5E7EB] bg-white p-3.5 text-left transition-colors hover:border-[#C7C2FF] hover:bg-[#FAFAFF]"
    >
      <div className="flex items-start justify-between gap-2">
        {/* line-clamp instead of truncate - a name wraps to a second line
            instead of being cut off mid-word. */}
        <p className="min-w-0 text-[13px] font-semibold leading-snug text-[#111827] line-clamp-2">{name}</p>
        {flagged ? (
          <span
            title="Possible duplicate - pending review"
            className="shrink-0 rounded-full bg-[#FEF3C7] px-1.5 py-0.5 text-[10px] font-semibold text-[#92400E]"
          >
            ⚠
          </span>
        ) : null}
      </div>
      {description ? (
        <p className="line-clamp-2 text-[12px] leading-snug text-[#6B7280]">{description}</p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <ActivitySparkline weeklyCounts={activity.weeklyCounts} />
        <span className="shrink-0 text-[11px] text-[#9CA3AF]">{relativeRecencyLabel(activity.lastActiveAt)}</span>
      </div>
    </button>
  )
}

function BrowseMode({
  memories,
  query,
  groupFilter,
  sourceFilter,
  onSelect,
}: {
  memories: CanonicalMemory[]
  query: string
  groupFilter: string
  sourceFilter: string
  onSelect: (id: string) => void
}) {
  const now = useMemo(() => new Date(), [])
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [activeSection, setActiveSection] = useState<string | null>(null)
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  const entities = useMemo(() => {
    const byId = new Map<string, { name: string; type: EntityType; flagged: boolean }>()
    for (const m of memories) {
      for (const e of m.entities) byId.set(e.entity_id, { name: e.canonical_name, type: e.entity_type, flagged: e.flagged })
    }
    const allowedTypes = groupFilter === ALL_GROUPS ? null : ENTITY_GROUPS.find((g) => g.label === groupFilter)?.types ?? []
    return [...byId.entries()]
      .map(([id, v]) => ({ id, ...v, activity: computeEntityActivity(memories, id, now), description: entityDescription(memories, id) }))
      .filter((e) => e.name.toLowerCase().includes(query.toLowerCase()))
      .filter((e) => !allowedTypes || allowedTypes.includes(e.type))
      .filter((e) => sourceFilter === ALL_SOURCES_PICKER || memories.some((m) => m.entities.some((me) => me.entity_id === e.id) && m.source_events.some((se) => se.source === sourceFilter)))
  }, [memories, query, groupFilter, sourceFilter, now])

  const activeThisWeek = useMemo(
    () => entities.filter((e) => isActiveThisWeek(e.activity, now)).sort((a, b) => (b.activity.lastActiveAt ?? '').localeCompare(a.activity.lastActiveAt ?? '')),
    [entities, now],
  )

  const sections = useMemo(
    () =>
      ENTITY_GROUPS.map((group) => ({
        group,
        inGroup: entities.filter((e) => group.types.includes(e.type)).sort((a, b) => a.name.localeCompare(b.name)),
      })).filter((s) => s.inGroup.length > 0),
    [entities],
  )

  // Highlights whichever section is currently scrolled to the top of the
  // viewport - not just "which chip was clicked last." Re-observes
  // whenever the set of rendered sections changes (filters, expand/
  // collapse don't move section boundaries, but a filter change can).
  useEffect(() => {
    const observer = new IntersectionObserver(
      (observedEntries) => {
        const visible = observedEntries.filter((en) => en.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible.length > 0) setActiveSection(visible[0].target.getAttribute('data-section'))
      },
      { rootMargin: '-116px 0px -70% 0px', threshold: 0 },
    )
    for (const el of sectionRefs.current.values()) observer.observe(el)
    return () => observer.disconnect()
  }, [sections])

  if (entities.length === 0) {
    return <p className="mt-4 text-[13px] text-[#9CA3AF]">No entities found yet.</p>
  }

  const jumpTo = (label: string) => {
    sectionRefs.current.get(label)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="mt-4 flex flex-col gap-6">
      {sections.length > 1 ? (
        <div className="sticky top-14 z-10 -mx-5 flex gap-1.5 overflow-x-auto border-b border-[#F0F0F4] bg-white px-5 py-2.5">
          {sections.map(({ group, inGroup }) => {
            const color = GROUP_COLORS[group.label]
            const isActive = activeSection === group.label
            return (
              <button
                key={group.label}
                type="button"
                onClick={() => jumpTo(group.label)}
                className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                  isActive ? `${color.bg} ${color.text} border-transparent` : 'border-[#E5E7EB] bg-white text-[#6B7280] hover:bg-[#F9FAFB]'
                }`}
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${color.dot}`} />
                {group.label} {inGroup.length}
              </button>
            )
          })}
        </div>
      ) : null}

      {activeThisWeek.length > 0 ? (
        <div>
          <p className="mb-2 text-[11px] font-semibold tracking-[0.06em] text-[#9CA3AF]">ACTIVE THIS WEEK</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
            {activeThisWeek.map((e) => (
              <EntityCard key={e.id} id={e.id} name={e.name} description={e.description} activity={e.activity} flagged={e.flagged} onSelect={onSelect} />
            ))}
          </div>
        </div>
      ) : null}

      {sections.map(({ group, inGroup }) => {
        const color = GROUP_COLORS[group.label]
        const expanded = expandedGroups.has(group.label)
        const shown = expanded ? inGroup : inGroup.slice(0, PREVIEW_CARD_COUNT)
        return (
          <div
            key={group.label}
            data-section={group.label}
            ref={(el) => {
              if (el) sectionRefs.current.set(group.label, el)
              else sectionRefs.current.delete(group.label)
            }}
            className="scroll-mt-28"
          >
            <span className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-bold ${color.bg} ${color.text}`}>
              {group.label}
              <span className="rounded-full bg-white/60 px-1.5 py-0.5 text-[11px] font-semibold">{inGroup.length}</span>
            </span>
            <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
              {shown.map((e) => (
                <EntityCard key={e.id} id={e.id} name={e.name} description={e.description} activity={e.activity} flagged={e.flagged} onSelect={onSelect} />
              ))}
            </div>
            {inGroup.length > PREVIEW_CARD_COUNT ? (
              <button
                type="button"
                onClick={() =>
                  setExpandedGroups((prev) => {
                    const next = new Set(prev)
                    if (expanded) next.delete(group.label)
                    else next.add(group.label)
                    return next
                  })
                }
                className="mt-2.5 text-[12px] font-semibold text-[#5A45FF] hover:underline"
              >
                {expanded ? 'Show fewer' : `Show all ${inGroup.length}`}
              </button>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function FindMode({
  memories,
  query,
  groupFilter,
  sourceFilter,
  onSelect,
}: {
  memories: CanonicalMemory[]
  query: string
  groupFilter: string
  sourceFilter: string
  onSelect: (id: string) => void
}) {
  const entityOptions = useMemo(() => {
    const byId = new Map<string, { name: string; type: EntityType; flagged: boolean }>()
    for (const m of memories) {
      for (const e of m.entities) byId.set(e.entity_id, { name: e.canonical_name, type: e.entity_type, flagged: e.flagged })
    }
    const allowedTypes = groupFilter === ALL_GROUPS ? null : ENTITY_GROUPS.find((g) => g.label === groupFilter)?.types ?? []
    return [...byId.entries()]
      .map(([id, v]) => ({ id, ...v }))
      .filter((e) => e.name.toLowerCase().includes(query.toLowerCase()))
      .filter((e) => !allowedTypes || allowedTypes.includes(e.type))
      .filter((e) => sourceFilter === ALL_SOURCES_PICKER || memories.some((m) => m.entities.some((me) => me.entity_id === e.id) && m.source_events.some((se) => se.source === sourceFilter)))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [memories, query, groupFilter, sourceFilter])

  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {entityOptions.map((e) => (
        <button
          key={e.id}
          type="button"
          onClick={() => onSelect(e.id)}
          className="inline-flex items-center gap-1.5 rounded-full border border-[#E5E7EB] bg-white px-3 py-1.5 text-[12px] font-medium text-[#374151] hover:bg-[#F9FAFB]"
        >
          {e.name}
          {e.flagged ? <span title="Possible duplicate - pending review">⚠</span> : null}
        </button>
      ))}
      {entityOptions.length === 0 ? <p className="text-[13px] text-[#9CA3AF]">No entities found yet.</p> : null}
    </div>
  )
}

function RelatedPanel({ entityId, onSelect }: { entityId: string; onSelect: (id: string) => void }) {
  const [related, setRelated] = useState<RelatedEntity[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setRelated(null)
    setError('')
    getRelatedEntities(entityId)
      .then((res) => {
        if (active) setRelated(res.related)
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof ApiError ? err.message : 'Unable to load related entities.')
      })
    return () => {
      active = false
    }
  }, [entityId])

  if (error) return null // quiet fail - this is a supplementary panel, not core content
  if (related !== null && related.length === 0) return null

  return (
    <div className="mt-4 rounded-xl border border-[#E5E7EB] bg-white p-4">
      <p className="text-[11px] font-semibold tracking-[0.06em] text-[#9CA3AF]">RELATED</p>
      {related === null ? (
        <p className="mt-2 text-[12px] text-[#9CA3AF]">Loading…</p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {related.map((r) => (
            <button
              key={r.entity_id}
              type="button"
              onClick={() => onSelect(r.entity_id)}
              className="inline-flex items-center gap-1.5 rounded-full border border-[#E5E7EB] bg-[#FAFAFF] px-3 py-1.5 text-[12px] font-medium text-[#374151] hover:bg-[#F3F1FF]"
            >
              {r.canonical_name}
              <span className="rounded-full bg-white px-1.5 text-[10px] font-semibold text-[#5A45FF]">{r.count}</span>
              {r.flagged ? <span title="Possible duplicate - pending review">⚠</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function MemoryCard({
  memory,
  onSelectSibling,
  onOpenEvidence,
}: {
  memory: CanonicalMemory
  onSelectSibling: (memoryId: string) => void
  onOpenEvidence: (memory: CanonicalMemory) => void
}) {
  return (
    <div className="rounded-2xl border border-[#E5E7EB] bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-[#EEEBFF] px-2.5 py-1 text-[11px] font-semibold text-[#5A45FF]">
            {memory.type}
          </span>
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${STATUS_STYLES[memory.status]}`}>
            {STATUS_LABELS[memory.status]}
          </span>
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${FRESHNESS_STYLES[memory.freshness]}`}>
            {memory.freshness}
          </span>
        </div>
        <span className="text-[12px] text-[#9CA3AF]">{formatDate(memory.valid_from)}</span>
      </div>

      <p className="mt-3 text-[15px] font-semibold leading-snug text-[#111827]">{memory.title}</p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-[#374151]">{memory.summary}</p>

      {memory.status === 'unresolved' && memory.contradicted_by ? (
        <button
          type="button"
          onClick={() => onSelectSibling(memory.contradicted_by as string)}
          className="mt-3 rounded-lg border border-[#FECACA] bg-[#FFF7F7] px-3 py-2 text-left text-[12px] font-semibold text-[#B4232C] hover:bg-[#FEF2F2]"
        >
          Conflicts with another memory - view it →
        </button>
      ) : null}

      {memory.supersedes ? (
        <button
          type="button"
          onClick={() => onSelectSibling(memory.supersedes as string)}
          className="mt-3 block text-[12px] font-medium text-[#5A45FF] hover:underline"
        >
          ← Supersedes an earlier memory
        </button>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {memory.entities.map((e) => (
          <span key={e.entity_id} className="inline-flex items-center gap-1 rounded-full bg-[#F3F4F6] px-2.5 py-1 text-[11px] text-[#6B7280]">
            {e.canonical_name}
            {e.flagged ? <span title="Possible duplicate - pending review">⚠</span> : null}
          </span>
        ))}
      </div>

      <button
        type="button"
        onClick={() => onOpenEvidence(memory)}
        className="mt-3 text-[12px] font-semibold text-[#5A45FF] hover:underline"
      >
        View evidence ({memory.source_events.length} source{memory.source_events.length === 1 ? '' : 's'})
      </button>
    </div>
  )
}

function EvidenceDrawer({ memoryId, onClose }: { memoryId: string; onClose: () => void }) {
  const [evidence, setEvidence] = useState<MemoryEvidence | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setEvidence(null)
    setError('')
    getMemoryEvidence(memoryId)
      .then((data) => {
        if (active) setEvidence(data)
      })
      .catch((err: unknown) => {
        if (!active) return
        setError(err instanceof ApiError ? err.message : 'Unable to load evidence for this memory.')
      })
    return () => {
      active = false
    }
  }, [memoryId])

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={onClose}>
      <div
        className="h-full w-full max-w-md overflow-y-auto bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" onClick={onClose} className="text-[13px] font-semibold text-[#5A45FF]">
          ← Close
        </button>

        {error ? <p className="mt-4 text-[13px] text-[#DC2626]">{error}</p> : null}
        {!error && !evidence ? <p className="mt-4 text-[13px] text-[#9CA3AF]">Loading…</p> : null}

        {evidence ? (
          <>
            <p className="mt-4 text-[16px] font-semibold text-[#111827]">{evidence.title}</p>
            <p className="mt-2 text-[13px] leading-relaxed text-[#374151]">{evidence.summary}</p>

            <p className="mt-5 text-[11px] font-semibold tracking-[0.06em] text-[#9CA3AF]">
              SOURCE EVENTS ({evidence.source_events.length})
            </p>
            <ul className="mt-2 flex flex-col gap-2">
              {evidence.source_events.map((se) => (
                <li key={se.event_id} className="rounded-lg border border-[#E5E7EB] p-2.5 text-[12px] text-[#374151]">
                  {se.source} · {se.source_id}
                </li>
              ))}
            </ul>

            {evidence.citations.length > 0 ? (
              <>
                <p className="mt-5 text-[11px] font-semibold tracking-[0.06em] text-[#9CA3AF]">CITED EXCERPTS</p>
                <ul className="mt-2 flex flex-col gap-2">
                  {evidence.citations.map((c, i) => (
                    <li key={i} className="rounded-lg border border-[#E5E7EB] p-2.5 text-[12px] text-[#374151]">
                      <span className="font-semibold">{c.source_event.source}</span>: {c.excerpt_ref}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            <p className="mt-5 text-[12px] text-[#9CA3AF]">
              Confidence {(evidence.confidence * 100).toFixed(0)}% · {evidence.freshness}
            </p>
          </>
        ) : null}
      </div>
    </div>
  )
}

export default function MemoryTimelinePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const entityId = searchParams.get('entity') ?? undefined

  const [memories, setMemories] = useState<CanonicalMemory[]>([])
  const [hiddenCount, setHiddenCount] = useState(0)
  const [someContentHidden, setSomeContentHidden] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  const [pickerMode, setPickerMode] = useState<'browse' | 'find'>('browse')
  // Filters which entity GROUP the picker shows (People/Projects/Teams/
  // Systems & Topics/Customers) - distinct from typeFilter below, which
  // filters MEMORY type on the already-selected entity's timeline. Group
  // rather than raw entity_type since that's the axis Browse mode already
  // organizes by - filtering to the same 5 buckets a user already sees as
  // section headers, not a 7th vocabulary to learn.
  const [pickerGroupFilter, setPickerGroupFilter] = useState<string>(ALL_GROUPS)
  const [pickerSourceFilter, setPickerSourceFilter] = useState<string>(ALL_SOURCES_PICKER)
  const [typeFilter, setTypeFilter] = useState<TypeFilter>(ALL_TYPES)
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>(ALL_SOURCES)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(ALL_STATUSES)
  const [pointInTime, setPointInTime] = useState('')
  const [entityQuery, setEntityQuery] = useState('')
  const [evidenceMemoryId, setEvidenceMemoryId] = useState<string | null>(null)

  // One fetch on mount (or when the selected entity changes) - every other
  // filter, and the point-in-time control, runs client-side over this same
  // list. No network round trip per point-in-time change or filter click.
  useEffect(() => {
    let active = true
    setIsLoading(true)
    setError('')
    listMemories(entityId)
      .then((res) => {
        if (!active) return
        setMemories(res.memories)
        setHiddenCount(res.hidden_count)
        setSomeContentHidden(res.some_content_hidden)
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof ApiError ? err.message : 'Unable to load the memory timeline.')
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })
    return () => {
      active = false
    }
  }, [entityId])

  const selectedEntityName = entityId ? memories.find((m) => m.entities.some((e) => e.entity_id === entityId))?.entities.find((e) => e.entity_id === entityId)?.canonical_name : undefined

  const sourceOptions = useMemo(() => {
    const set = new Set<string>()
    for (const m of memories) for (const se of m.source_events) set.add(se.source)
    return [...set].sort()
  }, [memories])

  // Explains the "why does the Source filter only show one option" case
  // directly, rather than leaving it to look broken - real when
  // fail-closed permissions are hiding content from other sources.
  const sourceOptionsLimitedByHiding = someContentHidden && sourceOptions.length <= 1

  const displayedMemories = useMemo(() => {
    let list = memories
    if (entityId && pointInTime) {
      const targetIso = new Date(pointInTime).toISOString()
      list = getStateAsOf(memories, entityId, targetIso)
    }
    return list
      .filter((m) => typeFilter === ALL_TYPES || m.type === typeFilter)
      .filter((m) => sourceFilter === ALL_SOURCES || m.source_events.some((se) => se.source === sourceFilter))
      .filter((m) => statusFilter === ALL_STATUSES || m.status === statusFilter)
      .sort((a, b) => b.valid_from.localeCompare(a.valid_from))
  }, [memories, entityId, pointInTime, typeFilter, sourceFilter, statusFilter])

  const selectEntity = (id: string) => {
    setSearchParams({ entity: id })
    setPointInTime('')
  }

  const selectSibling = (memoryId: string) => {
    const sibling = memories.find((m) => m.memory_id === memoryId)
    if (sibling?.entities[0]) selectEntity(sibling.entities[0].entity_id)
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-[22px] font-bold text-[#111827]">Memory Timeline</h1>
      <p className="mt-1 text-[13px] text-[#6B7280]">
        What your team knows about one thing, reconstructed over time - decisions, changes, blockers, and how they resolved.
      </p>

      {someContentHidden ? (
        <div className="mt-4 rounded-xl border border-[#F5E6C8] bg-[#FFFBF0] p-4 text-[13px] text-[#946C00]">
          Some content isn't shown yet because we can't confirm who has access to it ({hiddenCount} item
          {hiddenCount === 1 ? '' : 's'} hidden). This resolves automatically as real permission checks roll out - it's a
          disclosed limitation, not missing data.
        </div>
      ) : null}

      {!entityId ? (
        <div className="mt-6 rounded-2xl border border-[#E5E7EB] bg-white p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[13px] font-semibold text-[#111827]">
              {pickerMode === 'browse' ? 'Browse everything Locus knows about' : 'Find a specific entity'}
            </p>
            <div className="flex rounded-full border border-[#E5E7EB] p-0.5">
              <button
                type="button"
                onClick={() => setPickerMode('browse')}
                className={`rounded-full px-3 py-1 text-[12px] font-semibold transition-colors ${pickerMode === 'browse' ? 'bg-[#5A45FF] text-white' : 'text-[#6B7280]'}`}
              >
                Browse
              </button>
              <button
                type="button"
                onClick={() => setPickerMode('find')}
                className={`rounded-full px-3 py-1 text-[12px] font-semibold transition-colors ${pickerMode === 'find' ? 'bg-[#5A45FF] text-white' : 'text-[#6B7280]'}`}
              >
                Find
              </button>
            </div>
          </div>

          <input
            type="text"
            value={entityQuery}
            onChange={(e) => setEntityQuery(e.target.value)}
            placeholder="Search people, projects, customers…"
            className="mt-3 h-10 w-full rounded-full border border-[#E5E7EB] px-4 text-[13px] outline-none placeholder:text-[#9CA3AF] focus:border-[#5A45FF]"
          />

          <div className="mt-3 flex flex-wrap gap-1.5">
            {[ALL_GROUPS, ...ENTITY_GROUPS.map((g) => g.label)].map((label) => (
              <button
                key={label}
                type="button"
                onClick={() => setPickerGroupFilter(label)}
                className={`rounded-full px-3 py-1 text-[12px] font-semibold transition-colors ${
                  pickerGroupFilter === label ? 'bg-[#5A45FF] text-white' : 'bg-[#F3F4F6] text-[#6B7280] hover:bg-[#E5E7EB]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {sourceOptions.length > 1 ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {[ALL_SOURCES_PICKER, ...sourceOptions].map((label) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setPickerSourceFilter(label)}
                  className={`rounded-full border px-3 py-1 text-[12px] font-medium transition-colors ${
                    pickerSourceFilter === label
                      ? 'border-[#5A45FF] bg-[#EEEBFF] text-[#5A45FF]'
                      : 'border-[#E5E7EB] bg-white text-[#6B7280] hover:bg-[#F9FAFB]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}

          {pickerMode === 'browse' ? (
            <BrowseMode memories={memories} query={entityQuery} groupFilter={pickerGroupFilter} sourceFilter={pickerSourceFilter} onSelect={selectEntity} />
          ) : (
            <FindMode memories={memories} query={entityQuery} groupFilter={pickerGroupFilter} sourceFilter={pickerSourceFilter} onSelect={selectEntity} />
          )}
        </div>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => setSearchParams({})}
              className="rounded-full border border-[#E5E7EB] bg-white px-3 py-1.5 text-[12px] font-semibold text-[#5A45FF] hover:bg-[#F8F7FF]"
            >
              ← Change entity
            </button>
            <span className="text-[15px] font-semibold text-[#111827]">{selectedEntityName ?? entityId}</span>
          </div>

          {/* Promoted: the single most "acts like a brain" control in the
              product, previously buried as one input among filters. Its
              own card, not a row alongside three unrelated dropdowns. */}
          <div className="mt-4 rounded-xl border border-[#DCD6FF] bg-[#FAFAFF] p-4">
            <label className="flex flex-wrap items-center gap-3">
              <span className="text-[13px] font-semibold text-[#5A45FF]">See what we knew as of</span>
              <input
                type="date"
                value={pointInTime}
                onChange={(e) => setPointInTime(e.target.value)}
                className="h-10 rounded-lg border border-[#DCD6FF] bg-white px-3 text-[13px] outline-none focus:border-[#5A45FF]"
              />
              {pointInTime ? (
                <button
                  type="button"
                  onClick={() => setPointInTime('')}
                  className="text-[12px] font-semibold text-[#5A45FF] hover:underline"
                >
                  Back to current state
                </button>
              ) : (
                <span className="text-[12px] text-[#9CA3AF]">Showing current state</span>
              )}
            </label>
          </div>

          <RelatedPanel entityId={entityId} onSelect={selectEntity} />
        </>
      )}

      {entityId ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
            className="h-9 rounded-lg border border-[#E5E7EB] px-2 text-[12px] text-[#374151]"
          >
            <option value={ALL_TYPES}>{ALL_TYPES}</option>
            {(['Decision', 'Commitment', 'Blocker'] as MemoryType[]).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="h-9 rounded-lg border border-[#E5E7EB] px-2 text-[12px] text-[#374151]"
          >
            <option value={ALL_SOURCES}>{ALL_SOURCES}</option>
            {sourceOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {sourceOptionsLimitedByHiding ? (
            <span className="text-[11px] text-[#9CA3AF]">Only sources with visible content are listed</span>
          ) : null}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="h-9 rounded-lg border border-[#E5E7EB] px-2 text-[12px] text-[#374151]"
          >
            <option value={ALL_STATUSES}>{ALL_STATUSES}</option>
            {(Object.keys(STATUS_LABELS) as MemoryStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {error ? <p className="mt-6 text-[13px] text-[#DC2626]">{error}</p> : null}
      {isLoading ? <p className="mt-6 text-[13px] text-[#9CA3AF]">Loading…</p> : null}

      {!isLoading && entityId ? (
        <div className="mt-6 flex flex-col gap-3">
          {displayedMemories.length === 0 ? (
            <p className="text-[13px] text-[#9CA3AF]">No memories match these filters.</p>
          ) : (
            displayedMemories.map((m) => (
              <MemoryCard
                key={m.memory_id}
                memory={m}
                onSelectSibling={selectSibling}
                onOpenEvidence={(mem) => setEvidenceMemoryId(mem.memory_id)}
              />
            ))
          )}
        </div>
      ) : null}

      {evidenceMemoryId ? (
        <EvidenceDrawer memoryId={evidenceMemoryId} onClose={() => setEvidenceMemoryId(null)} />
      ) : null}
    </div>
  )
}
