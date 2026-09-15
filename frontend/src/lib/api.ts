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
    // Region-pinned for the same reason apiFetch is - and it matters more
    // here, because this call sits in front of every other one: no page can
    // fetch anything until the backend token exists. Measured out of region
    // at 2,866ms for a single one-row membership lookup that takes ~20ms in
    // region, on every cold page load.
    headers: {
      'Content-Type': 'application/json',
      'x-region': FUNCTION_REGION,
    },
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
  primedTenantId = null
}

/** Returns the caller's tenant_id, exchanging (or re-exchanging) a backend session as needed. */
/**
 * Tenant id learned from a plain memberships read, without minting a tenant
 * JWT.
 *
 * Page load used to stall on a waterfall: read memberships, then exchange
 * for a backend session purely to learn the tenant id, then read
 * source_connections. Three sequential round trips before a single
 * connector could render - and from Asia to the us-west-1 database each one
 * is expensive. The middle hop was doing no work the first hop hadn't
 * already done.
 *
 * Resolution deliberately matches /auth/session exactly (oldest membership
 * first), so this can never disagree with the tenant the backend token
 * would have carried.
 */
let primedTenantId: string | null = null

export function primeTenantId(tenantId: string): void {
  primedTenantId = tenantId
}

export async function getTenantId(): Promise<string> {
  assertNotDemoMode()
  if (cachedSession && cachedSession.expiresAt > Date.now()) {
    return cachedSession.tenantId
  }
  if (primedTenantId) return primedTenantId
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
/**
 * Region the Edge Functions must execute in.
 *
 * Measured, not guessed: Edge Functions default to running near the USER,
 * while the database lives in us-west-1. Every database round trip was
 * therefore crossing the Pacific at ~250ms, and one withTenant() call costs
 * four of them (BEGIN, set_config, the query, COMMIT). The same diagnostic
 * run twice, differing only by this header, measured 7,422ms vs 133ms - a
 * 56x difference on identical work.
 *
 * Paying one long trip to reach the function beats the function making
 * fifteen long trips to reach the database. This also shortens the hops to
 * Anthropic and Voyage, which are US-hosted too.
 *
 * Keep this in sync with the database region if the project ever moves.
 */
const FUNCTION_REGION = 'us-west-1'

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getBackendToken()

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-region': FUNCTION_REGION,
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
  /** True for the exact message(s) this record was actually extracted
   * from - never filtered out regardless of how the rest of the thread
   * gets trimmed, so the real evidence is always distinguishable from
   * surrounding context. */
  is_source: boolean
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

/**
 * Streaming search. Same endpoint and same result as searchDecisions, but
 * onDelta fires with each slice of the answer as Claude writes it.
 *
 * Why: the synthesis call measures ~4.9s, and the user previously watched a
 * blank panel for all of it. Total time is unchanged - this only makes the
 * wait legible.
 *
 * Falls back to the plain JSON path on any transport problem, so a proxy
 * that buffers or strips event-streams degrades to today's behaviour rather
 * than breaking search outright.
 */
/**
 * One completed step of the retrieval pipeline, reported by the server as it
 * happens. The median search spends 2.3s in analyze_and_embed before a single
 * character of the answer exists, and until these events existed the browser
 * had no way to know anything was happening during it.
 *
 * Every field beyond `name` and `elapsed_ms` is whatever that particular stage
 * actually measured, so the UI can say "20 candidates" rather than spin.
 */
export interface SearchStage {
  name: 'resolve_scopes' | 'analyze_and_embed' | 'retrieve' | 'authorize' | 'generate_answer'
  elapsed_ms: number
  status?: string
  scopes?: number
  question_type?: string
  is_multi_document?: boolean
  candidates?: number
  authorized?: number
  withheld?: number
  decisions?: number
}

export async function searchDecisionsStreaming(
  question: string,
  onDelta: (chunk: string) => void,
  onStage?: (stage: SearchStage) => void,
): Promise<SearchResponse> {
  const token = await getBackendToken()

  let response: Response
  try {
    response = await fetch(`${API_URL}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'x-region': FUNCTION_REGION,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ question, stream: true }),
    })
  } catch {
    return searchDecisions(question)
  }

  if (!response.ok) {
    let detail = `Request failed (${response.status})`
    try {
      const body = (await response.json()) as { detail?: string }
      if (body.detail) detail = body.detail
    } catch {
      // Non-JSON error body, keep the generic message.
    }
    if (response.status === 429) {
      const retryAfterSeconds = Number(response.headers.get('Retry-After') ?? '0')
      throw new ApiError(detail, 429, retryAfterSeconds)
    }
    throw new ApiError(detail, response.status)
  }

  // Server answered without a stream (older deploy, or an intermediary that
  // rewrote the content type) - read it as the plain JSON it is.
  if (!response.body || !response.headers.get('Content-Type')?.includes('text/event-stream')) {
    return (await response.json()) as SearchResponse
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let final: SearchResponse | null = null
  let streamError: string | null = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // Frames are blank-line separated and can straddle chunks; keep the tail.
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''

    for (const frame of frames) {
      let event = 'message'
      let data = ''
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (!data) continue
      try {
        const parsed = JSON.parse(data)
        if (event === 'delta' && typeof parsed.text === 'string') onDelta(parsed.text)
        else if (event === 'stage' && typeof parsed.name === 'string') onStage?.(parsed as SearchStage)
        else if (event === 'done') final = parsed as SearchResponse
        else if (event === 'error') streamError = String(parsed.error ?? 'Search failed')
      } catch {
        // Skip an unparseable frame rather than failing the whole search.
      }
    }
  }

  if (streamError) throw new ApiError(streamError, 502)
  if (!final) throw new ApiError('Search ended before an answer arrived.', 502)
  return final
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

// ---- Attention strip ----
// Rebuilt after the memory-intelligence layer was removed - reads
// unresolved decision conflicts (decision_conflicts, real data the
// existing pipeline already produces) via GET /attention on the same
// api Edge Function everything else here talks to, not a separate
// service. No new Claude/LLM calls anywhere in this path.

export interface AttentionConflictItem {
  id: string
  decision_id: string
  decision_statement: string
  related_decision_id: string
  related_decision_statement: string
  reason: string
  confidence: number
  created_at: string
}

export interface AttentionResponse {
  items: AttentionConflictItem[]
  total: number
}

export function listAttentionItems(): Promise<AttentionResponse> {
  return apiFetch<AttentionResponse>('/attention')
}
