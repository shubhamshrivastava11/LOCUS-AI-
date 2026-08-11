import { getSupabaseClient } from './supabase'
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
getSupabaseClient().auth.onAuthStateChange((_event, session) => {
  const userId = session?.user.id ?? null
  if (userId !== cachedUserId) {
    cachedUserId = userId
    cachedSession = null
  }
})

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
