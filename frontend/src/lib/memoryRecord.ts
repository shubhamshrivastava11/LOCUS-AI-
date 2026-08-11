import type { DecisionOut, DecisionRecordType } from './api'
import type { MemoryRecord, MemoryRecordType } from '../components/MemoryRecordDetail'

const RECORD_TYPE_LABELS: Record<DecisionRecordType, MemoryRecordType> = {
  decision: 'Decision',
  action_item: 'Action Item',
  blocker: 'Blocker',
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
