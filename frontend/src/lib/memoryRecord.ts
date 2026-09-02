import type { DecisionOut, DecisionRecordType, CanonicalMemory, MemoryType } from './api'
import type { MemoryRecord, MemoryRecordType } from '../components/MemoryRecordDetail'

const RECORD_TYPE_LABELS: Record<DecisionRecordType, MemoryRecordType> = {
  decision: 'Decision',
  action_item: 'Action Item',
  blocker: 'Blocker',
}

// CanonicalMemory's 3-type taxonomy maps onto MemoryRecordDetail's existing
// display types - Commitment is the same concept the old pipeline called
// action_item, so it reuses that same "Action Item" badge/color rather than
// adding a fourth visual type for what's semantically the same thing.
const MEMORY_TYPE_LABELS: Record<MemoryType, MemoryRecordType> = {
  Decision: 'Decision',
  Commitment: 'Action Item',
  Blocker: 'Blocker',
}

export const PLATFORM_LABELS: Record<string, string> = {
  gmail: 'Gmail',
  slack: 'Slack',
  notion: 'Notion',
}

const ROLE_LABELS: Record<string, string> = {
  decided_by: 'decided by',
  mentioned: 'mentioned',
}

function formatParticipants(actors: DecisionOut['actors']): string {
  if (actors.length === 0) return 'Not recorded'
  return actors
    .map((actor) => {
      const who = actor.name || 'Unknown'
      const roleLabel = ROLE_LABELS[actor.role] ?? actor.role
      return `${who} (${roleLabel})`
    })
    .join(', ')
}

export function timeAgo(iso: string, now = Date.now()): string {
  const elapsedMs = Math.max(0, now - new Date(iso).getTime())
  const hours = Math.floor(elapsedMs / 3_600_000)
  if (hours < 1) return 'just now'
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatExactTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * Adapts a real DecisionOut row into the MemoryRecordDetail panel's display
 * shape. All fields come from the actual decision - nothing here is
 * placeholder text.
 */
export function decisionToMemoryRecord(decision: DecisionOut): MemoryRecord {
  const type: MemoryRecordType =
    RECORD_TYPE_LABELS[decision.record_type as DecisionRecordType] ?? 'Decision'
  const platform = decision.source_platforms[0]
  const platformLabel = platform ? PLATFORM_LABELS[platform] ?? platform : 'Unknown source'

  return {
    id: decision.id,
    type,
    title: decision.decision_statement,
    meta: `${platformLabel} · ${timeAgo(decision.created_at)}`,
    summary: decision.rationale || decision.decision_statement,
    participants: formatParticipants(decision.actors),
    source: platformLabel,
    status: decision.superseded_by ? 'Superseded' : 'Current',
    listSource: platformLabel,
    date: formatDate(decision.created_at),
    sourceLink: decision.source_links[0],
    exactTime: formatExactTime(decision.created_at),
  }
}

/**
 * Adapts a real CanonicalMemory row (ai-worker's direct-to-memories write
 * path, memory-explorer upgrade) into the same MemoryRecordDetail display
 * shape decisionToMemoryRecord produces - the dashboard's "Build Memory"
 * list and search-suggestion chips read memories now that ai-worker no
 * longer writes to public.decisions at all.
 */
export function memoryToMemoryRecord(memory: CanonicalMemory): MemoryRecord {
  const type = MEMORY_TYPE_LABELS[memory.type] ?? 'Decision'
  const platform = memory.source_events[0]?.source
  const platformLabel = platform ? PLATFORM_LABELS[platform] ?? platform : 'Unknown source'
  const people = memory.entities.filter((e) => e.entity_type === 'Person')

  return {
    id: memory.memory_id,
    type,
    title: memory.title,
    meta: `${platformLabel} · ${timeAgo(memory.observed_at)}`,
    summary: memory.summary || memory.title,
    participants: people.length > 0 ? people.map((p) => p.canonical_name).join(', ') : 'Not recorded',
    source: platformLabel,
    status: memory.status === 'current' || memory.status === 'proposed' ? 'Current' : 'Superseded',
    listSource: platformLabel,
    date: formatDate(memory.occurred_at),
    sourceLink: memory.source_events[0]?.url ?? undefined,
    exactTime: formatExactTime(memory.occurred_at),
  }
}
