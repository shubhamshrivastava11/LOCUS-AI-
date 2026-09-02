import { getSupabaseClient, isSupabaseConfigured } from './supabase'
import { DEMO_EMAIL_KEY } from './sessionKeys'

/**
 * Shared client for the FastAPI backend (not Supabase Edge Functions).
 *
 * Auth is a two-step exchange: Supabase issues its own session token, which
 * gets exchanged here for a separate, Locus-issued tenant-scoped token via
 * POST /auth/session. Every protected backend route needs that second,
 * Locus-issued token, not the raw Supabase one. This module owns that
 * exchange and caches the result so callers don't repeat it per request.
 */

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

// memory-api is a separate Supabase Edge Function from api/index.ts (see
// supabase/functions/memory-api/index.ts) - kept apart so nothing there can
// regress /search or /digest. Its real-user routes (GET /memories, GET
// /memories/:id/evidence) accept the exact same Locus-issued tenant JWT
// apiFetch already obtains via /auth/session, so memoryApiFetch below
// reuses getBackendToken() rather than a second login flow.
const MEMORY_API_URL = import.meta.env.VITE_MEMORY_API_URL || 'http://localhost:8000'

interface BackendSession {
  token: string
  tenantId: string
  role: string
  plan: string
  expiresAt: number
}

let cachedSession: BackendSession | null = null
let pendingExchange: Promise<BackendSession> | null = null

// Invalidate the cached session whenever the signed-in Supabase user changes
// (sign-out, or a different account signing in within the same tab/session
// without ever going through clearBackendSession()'s explicit call sites) —
// otherwise a stale tenant_id from a previous user can get paired with a
// new user's access token, which the backend correctly rejects as a
// tenant-membership mismatch.
let cachedUserId: string | null = null
let authListenerSetup = false

function setupAuthListener() {
  if (authListenerSetup || !isSupabaseConfigured()) return
  authListenerSetup = true

  getSupabaseClient().auth.onAuthStateChange((_event, session) => {
    const userId = session?.user.id ?? null
    if (userId !== cachedUserId) {
      cachedUserId = userId
      cachedSession = null
    }
  })
}

export class ApiError extends Error {
  status: number
  retryAfterSeconds?: number

  constructor(message: string, status: number, retryAfterSeconds?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/**
 * Demo sessions (WelcomePage's "demo" button) never have a real Supabase
 * session, but nothing about entering demo mode clears a *previous* real
 * session's cache if one exists in the same tab — without this check, a
 * user who signed in for real and later clicked into a demo session in the
 * same tab would silently keep hitting the backend as their real tenant.
 * Demo mode must never reach the real backend, full stop.
 */
function assertNotDemoMode(): void {
  if (sessionStorage.getItem(DEMO_EMAIL_KEY)) {
    throw new ApiError('Demo session has no backend account', 401)
  }
}

async function exchangeForBackendSession(): Promise<BackendSession> {
  assertNotDemoMode()
  setupAuthListener()
  const supabase = getSupabaseClient()
  const { data } = await supabase.auth.getSession()
  const supabaseToken = data.session?.access_token

  if (!supabaseToken) {
    throw new ApiError('Not signed in', 401)
  }

  const response = await fetch(`${API_URL}/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ supabase_token: supabaseToken }),
  })

  if (!response.ok) {
    throw new ApiError('Unable to start a backend session', response.status)
  }

  const body = (await response.json()) as {
    token: string
    tenant_id: string
    role: string
    plan: string
    expires_in: number
  }

  const session: BackendSession = {
    token: body.token,
    tenantId: body.tenant_id,
    role: body.role,
    plan: body.plan,
    // Refresh a minute early rather than exactly at expiry.
    expiresAt: Date.now() + Math.max(0, body.expires_in - 60) * 1000,
  }
  cachedSession = session
  return session
}

/** Returns a valid backend token, exchanging (or re-exchanging) as needed. */
async function getBackendToken(): Promise<string> {
  assertNotDemoMode()
  if (cachedSession && cachedSession.expiresAt > Date.now()) {
    return cachedSession.token
  }
  // Coalesce concurrent callers into a single exchange request.
  if (!pendingExchange) {
    pendingExchange = exchangeForBackendSession().finally(() => {
      pendingExchange = null
    })
  }
  const session = await pendingExchange
  return session.token
}

/** Call this on sign-out so a stale token from the previous user can't leak into the next session. */
export function clearBackendSession(): void {
  cachedSession = null
}

/** Returns the caller's tenant_id, exchanging (or re-exchanging) a backend session as needed. */
export async function getTenantId(): Promise<string> {
  assertNotDemoMode()
  if (cachedSession && cachedSession.expiresAt > Date.now()) {
    return cachedSession.tenantId
  }
  if (!pendingExchange) {
    pendingExchange = exchangeForBackendSession().finally(() => {
      pendingExchange = null
    })
  }
  const session = await pendingExchange
  return session.tenantId
}

/** Returns the tenant's real subscription plan ('self_serve' | 'team'), exchanging as needed. */
export async function getTenantPlan(): Promise<string> {
  assertNotDemoMode()
  if (cachedSession && cachedSession.expiresAt > Date.now()) {
    return cachedSession.plan
  }
  if (!pendingExchange) {
    pendingExchange = exchangeForBackendSession().finally(() => {
      pendingExchange = null
    })
  }
  const session = await pendingExchange
  return session.plan
}

/**
 * fetch() against the FastAPI backend with the Locus Bearer token attached.
 * Throws ApiError on any non-2xx response, with retryAfterSeconds populated
 * for 429s (see the Retry-After header /search and /digest send).
 */
export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getBackendToken()

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  })

  if (!response.ok) {
    let detail = `Request failed (${response.status})`
    try {
      const body = (await response.json()) as { detail?: string }
      if (body.detail) detail = body.detail
    } catch {
      // Response body wasn't JSON, keep the generic message.
    }

    if (response.status === 429) {
      const retryAfterSeconds = Number(response.headers.get('Retry-After') ?? '0')
      throw new ApiError(detail, 429, retryAfterSeconds)
    }
    throw new ApiError(detail, response.status)
  }

  return response.json() as Promise<T>
}

async function memoryApiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getBackendToken()

  const response = await fetch(`${MEMORY_API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  })

  if (!response.ok) {
    let detail = `Request failed (${response.status})`
    try {
      const body = (await response.json()) as { detail?: string }
      if (body.detail) detail = body.detail
    } catch {
      // Response body wasn't JSON, keep the generic message.
    }
    throw new ApiError(detail, response.status)
  }

  return response.json() as Promise<T>
}

// ---- Response shapes, matching the real backend exactly (verified live) ----

export interface SearchCitation {
  decision_number: number
  decision_id: string
  decision_statement: string
  confidence: number
}

export interface SearchResponse {
  answer: string
  citations: SearchCitation[]
  metadata: {
    model: string
    latency_ms: number
    retrieved_count: number
    authorized_count: number
  }
  reasoning?: string
  confidence: number
}

export type DecisionRecordType = 'decision' | 'action_item' | 'blocker'

export interface ActorRef {
  id: string
  role: string
  name: string | null
}

export interface DecisionOut {
  id: string
  tenant_id: string
  record_type: DecisionRecordType | string
  decision_statement: string
  rationale: string | null
  alternatives_considered: string[]
  actors: ActorRef[]
  status: string
  superseded_by: string | null
  scope: string
  confidence: number
  source_links: string[]
  source_platforms: string[]
  created_at: string
  updated_at: string
}

export interface DecisionListResponse {
  items: DecisionOut[]
  total: number
}

export interface ThreadMessage {
  at: string
  actor: string
  source: string
  text: string
}

/** A conflict flagged automatically when this decision was captured -
 * compared against its most similar existing decisions, Claude classified
 * whether it genuinely contradicts or duplicates one of them. */
export interface DecisionConflict {
  decision_id: string
  decision_statement: string
  relationship: 'contradicts' | 'duplicates'
  reason: string
  confidence: number
}

/** Only returned by GET /api/v1/decisions/:id - too expensive (decrypts and
 * walks every raw_event in the thread) to include on every row of a list. */
export interface DecisionDetail extends DecisionOut {
  source_received_at: string | null
  thread_context: ThreadMessage[]
  conflicts: DecisionConflict[]
}

export interface DigestItem {
  decision_statement: string
  rationale: string | null
  confidence: number
  created_at: string | null
  record_type: DecisionRecordType | null
}

export interface DigestResponse {
  scope: 'team' | 'personal'
  period: string
  summary: string
  items: DigestItem[]
  metadata: {
    model: string
    latency_ms: number
    decision_count: number
    token_estimate: number
    personalized: boolean
  }
}

// ---- Typed convenience wrappers for the endpoints this app calls ----

export function searchDecisions(question: string): Promise<SearchResponse> {
  return apiFetch<SearchResponse>('/search', {
    method: 'POST',
    body: JSON.stringify({ question }),
  })
}

export function listDecisions(
  limit: number,
  offset: number,
  recordType?: string,
  source?: string,
): Promise<DecisionListResponse> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  if (recordType) params.set('record_type', recordType)
  if (source) params.set('source', source)
  return apiFetch<DecisionListResponse>(`/api/v1/decisions?${params.toString()}`)
}

export function listDecisionSources(): Promise<{ sources: string[] }> {
  return apiFetch('/api/v1/decisions/sources')
}

/** Fetches one decision with its full reconstructed conversation thread -
 * every message sharing the same thread_ref as the source event, not just
 * the single message that got extracted. */
export function getDecision(id: string): Promise<DecisionDetail> {
  return apiFetch<DecisionDetail>(`/api/v1/decisions/${id}`)
}

export function getDigest(
  scope: 'team' | 'personal',
  refresh = false,
  weekOf?: string,
): Promise<DigestResponse> {
  const params = new URLSearchParams({ scope })
  if (refresh) params.set('refresh', 'true')
  if (weekOf) params.set('week_of', weekOf)
  return apiFetch<DigestResponse>(`/digest?${params.toString()}`)
}

export interface CheckoutResponse {
  checkout_url: string
  session_id: string
}

/** Starts a real Stripe Checkout session for the given plan. */
export function createCheckoutSession(plan: 'self_serve' | 'team'): Promise<CheckoutResponse> {
  return apiFetch<CheckoutResponse>('/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({ plan }),
  })
}

/**
 * Fetches every decision for the tenant by walking GET /api/v1/decisions'
 * pagination (max page size 200) until `total` is reached. Used where a
 * real aggregate (counts by type, a date-range filter) is needed and the
 * backend has no dedicated aggregation endpoint for it.
 */
export async function listAllDecisions(hardCap = 2000): Promise<DecisionOut[]> {
  const pageSize = 200
  const items: DecisionOut[] = []
  let offset = 0

  for (;;) {
    const page = await listDecisions(pageSize, offset)
    items.push(...page.items)
    if (page.items.length === 0 || items.length >= page.total || items.length >= hardCap) {
      break
    }
    offset += pageSize
  }

  return items
}

// ---- Memory Intelligence layer (memory-api) ----
// Mirrors supabase/functions/_shared/memory/types.ts's CanonicalMemoryObject
// exactly - this is the JSON shape loadMemoriesForTenant() assembles and
// GET /memories / GET /memories/:id/evidence return as-is, no reshaping.

// 3-core-type taxonomy (memory-explorer upgrade). Rationale/Outcome/
// Requirement/Change/CustomerSignal collapsed into Decision's payload -
// see the migration's comment for the full mapping.
export type MemoryType = 'Decision' | 'Commitment' | 'Blocker'

export type MemoryStatus =
  | 'proposed' | 'current' | 'stale' | 'superseded' | 'contradicted' | 'unresolved'

export type FreshnessState = 'fresh' | 'aging' | 'stale'

// Customer/Product/Topic/System demoted to memory.tags (searchable
// metadata) rather than relational entities - see the migration's comment.
export type EntityType = 'Person' | 'Team' | 'Project'

export interface MemoryEntityRef {
  entity_id: string
  entity_type: EntityType
  canonical_name: string
  flagged: boolean
}

export interface MemorySourceEventRef {
  event_id: string
  source: string
  source_id: string
  url: string | null
}

export interface MemoryCitation {
  source_event: MemorySourceEventRef
  excerpt_ref: string
}

export interface CanonicalMemory {
  memory_id: string
  organization_id: string
  type: MemoryType
  title: string
  summary: string
  payload: Record<string, unknown>
  entities: MemoryEntityRef[]
  occurred_at: string
  valid_from: string
  valid_until: string | null
  observed_at: string
  source_events: MemorySourceEventRef[]
  citations: MemoryCitation[]
  confidence: number
  freshness: FreshnessState
  authority: number | null
  status: MemoryStatus
  supersedes: string | null
  contradicted_by: string | null
  permissions: { inherited_from: MemorySourceEventRef[]; visible_to: string[] }
  searchable_text: string
}

export interface ListMemoriesResponse {
  memories: CanonicalMemory[]
  hidden_count: number
  /** True whenever this tenant has real content the caller can't be shown
   * yet because no confirmed membership data exists for its scope - the
   * fail-closed default, not a bug. The Memory Timeline surfaces this
   * directly rather than silently looking empty/broken. */
  some_content_hidden: boolean
}

export function listMemories(entityId?: string): Promise<ListMemoriesResponse> {
  const params = entityId ? `?entity_id=${encodeURIComponent(entityId)}` : ''
  return memoryApiFetch<ListMemoriesResponse>(`/memories${params}`)
}

export interface MemoryEvidence {
  memory_id: string
  title: string
  summary: string
  source_events: MemorySourceEventRef[]
  citations: MemoryCitation[]
  confidence: number
  freshness: FreshnessState
  status: MemoryStatus
  supersedes: string | null
}

export function getMemoryEvidence(memoryId: string): Promise<MemoryEvidence> {
  return memoryApiFetch<MemoryEvidence>(`/memories/${encodeURIComponent(memoryId)}/evidence`)
}

// ---- Attention strip (spec Section 10) ----

export type AttentionCategory = 'conflict' | 'decision' | 'commitment' | 'staleness'
export type ResolutionAction = 'confirm_decision' | 'check_in_commitment' | 'recheck_freshness' | 'dismiss_conflict'

export interface MemoryAttentionItem {
  kind: 'memory'
  memory_id: string
  title: string
  summary: string
  type: MemoryType
  category: AttentionCategory
  weight: number
  action: ResolutionAction
}

// Surfaced only when the judgment tier (entity resolution) couldn't
// resolve a mention confidently either way - genuinely ambiguous, with a
// real suggested target. No-candidate ambiguity never reaches here; it
// stays on the internal-only review-queue page instead, since there's
// nothing one-click actionable to show a customer for it.
export interface EntityDuplicateAttentionItem {
  kind: 'entity_duplicate'
  unresolved_id: string
  mention_text: string
  entity_type: string
  candidate_entity_id: string
  candidate_name: string
  category: 'entity_duplicate'
  weight: number
}

export type AttentionItem = MemoryAttentionItem | EntityDuplicateAttentionItem

export interface AttentionResponse {
  items: AttentionItem[]
  total: number
}

export function listAttentionItems(limit = 4): Promise<AttentionResponse> {
  return memoryApiFetch<AttentionResponse>(`/attention?limit=${limit}`)
}

export function resolveMemory(memoryId: string, action: ResolutionAction, note?: string): Promise<{ resolved: boolean }> {
  return memoryApiFetch<{ resolved: boolean }>(`/memories/${encodeURIComponent(memoryId)}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ action, note }),
  })
}

// ---- Related entities panel ----

export interface RelatedEntity {
  entity_id: string
  canonical_name: string
  entity_type: EntityType
  flagged: boolean
  count: number
}

export function getRelatedEntities(entityId: string): Promise<{ entity_id: string; related: RelatedEntity[] }> {
  return memoryApiFetch(`/entities/${encodeURIComponent(entityId)}/related`)
}

// ---- Entity review queue ----

export interface ReviewQueueSide {
  entity_id: string | null
  name: string
  entity_type: string
  memory_count: number
  snippet: string | null
  sources: string[]
}

export interface ReviewQueueItem {
  id: string
  kind: 'raw_mention' | 'confirmed_duplicate'
  candidate_score: number | null
  left: ReviewQueueSide
  right: ReviewQueueSide | null
}

// tenantId is only ever honored server-side for a caller on STAFF_EMAILS -
// the customer-facing Attention strip never passes it, so its calls are
// unaffected. Only the internal review-queue page passes it, to inspect a
// tenant other than the staff member's own.
export function listUnresolvedEntities(tenantId?: string): Promise<{ tenant_id: string; pending: ReviewQueueItem[] }> {
  const params = tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}` : ''
  return memoryApiFetch(`/entities/unresolved${params}`)
}

export function confirmNewEntity(unresolvedId: string, tenantId?: string): Promise<{ entity_id: string; attached_existing: boolean; flagged_for_merge_review: string | null }> {
  return memoryApiFetch('/entities/confirm-new', { method: 'POST', body: JSON.stringify({ unresolved_id: unresolvedId, tenant_id: tenantId }) })
}

export function mergeEntity(unresolvedId: string, targetEntityId: string, tenantId?: string): Promise<{ merged: boolean }> {
  return memoryApiFetch('/entities/merge', { method: 'POST', body: JSON.stringify({ unresolved_id: unresolvedId, target_entity_id: targetEntityId, tenant_id: tenantId }) })
}

export function dismissUnresolvedEntity(unresolvedId: string, tenantId?: string): Promise<{ dismissed: boolean }> {
  return memoryApiFetch('/entities/dismiss', { method: 'POST', body: JSON.stringify({ unresolved_id: unresolvedId, tenant_id: tenantId }) })
}

export interface EntitySearchResult {
  entity_id: string
  canonical_name: string
  entity_type: string
}

export function searchEntities(query: string, tenantId?: string): Promise<{ entities: EntitySearchResult[] }> {
  const tenantParam = tenantId ? `&tenant_id=${encodeURIComponent(tenantId)}` : ''
  return memoryApiFetch(`/entities/search?q=${encodeURIComponent(query)}${tenantParam}`)
}
