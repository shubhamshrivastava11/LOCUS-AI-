import { useEffect, useState } from 'react'
import { getSupabaseClient } from '../lib/supabase'
import { ApiError, getDecision, listDecisions, searchDecisionsStreaming, type SearchResponse, type SearchStage } from '../lib/api'
import { SearchPipeline } from './SearchPipeline'
import { DEMO_EMAIL_KEY } from '../lib/sessionKeys'
import { decisionToMemoryRecord } from '../lib/memoryRecord'
import { MemoryRecordDetail, type MemoryRecord } from './MemoryRecordDetail'

/**
 * Fire-and-forget: logs a completed search to search_history via the
 * search-history Edge Function so it shows up in Settings > Search. Never
 * blocks or fails the actual search — a logging problem shouldn't stop the
 * user from seeing their answer. Respects the user's saveHistory
 * preference server side (the function no-ops if they've turned it off).
 */
function recordSearchHistory(query: string, resultCount: number) {
  void getSupabaseClient()
    .functions.invoke('search-history', {
      body: { action: 'record', query, result_count: resultCount },
    })
    .catch(() => {
      // Best-effort only.
    })
}

/** Turns a real decision statement into a natural suggested question, e.g.
 * "Adopt PostgreSQL for the context layer" -> "What do we know about
 * adopt postgresql for the context layer?". Truncated so a long statement
 * doesn't blow out the chip. */
/**
 * A chip the user can tap, and the question it actually asks.
 *
 * These used to be one string: the whole decision statement, truncated at 60
 * characters, wrapped in "What do we know about ...?". That produced ~85
 * character chips that wrapped across the full width, and the first 22
 * characters were identical on every single one - the same five words
 * repeated three times, carrying no information and crowding out the part
 * that did.
 *
 * The label is now just the topic, cut at a word boundary so it never ends
 * mid-word. The full question is kept separately and is what gets submitted,
 * so shortening what is displayed costs the search nothing.
 */
type Suggestion = { label: string; query: string }

const SUGGESTION_MAX_CHARS = 44

function toSuggestion(statement: string): Suggestion {
  const clean = statement.replace(/[.?!]+$/, '').trim()

  let label = clean
  if (label.length > SUGGESTION_MAX_CHARS) {
    const cut = label.slice(0, SUGGESTION_MAX_CHARS)
    const lastSpace = cut.lastIndexOf(' ')
    // Fall back to the hard cut only if there is no space to break on, which
    // means one very long token rather than a sentence.
    label = `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim()}…`
  }

  return { label, query: `What do we know about ${clean.toLowerCase()}?` }
}

type RecentSearch = { query: string; at: number }

function firstName(email: string | null | undefined, displayName: string | null | undefined) {
  // displayName's first token was returned raw - Supabase/Google metadata
  // is lowercase for some accounts, so the greeting read "Good evening,
  // shubham" instead of "Shubham". Only the email-prefix fallback below
  // ever title-cased.
  if (displayName) return displayName.split(/\s+/)[0].replace(/^\w/, (c) => c.toUpperCase())
  if (!email) return 'there'
  return email.split('@')[0].split(/[._-]+/)[0].replace(/^\w/, (c) => c.toUpperCase())
}

function timeAgo(at: number, now = Date.now()) {
  const minutes = Math.max(1, Math.floor((now - at) / 60_000))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function timeOfDayGreeting(hour = new Date().getHours()) {
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

/**
 * One citation in a search answer, expandable into the same full context
 * (source, exact time, conversation thread) the decision log shows - a
 * search result shouldn't be a dead end, the reasoning behind it should be
 * one click away, not a separate trip to Memory Explorer.
 */
function CitationRow({ decisionNumber, decisionId, decisionStatement }: {
  decisionNumber: number
  decisionId: string
  decisionStatement: string
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [record, setRecord] = useState<MemoryRecord | null>(null)
  const [loadError, setLoadError] = useState('')

  const toggle = () => {
    const next = !isExpanded
    setIsExpanded(next)
    if (next && !record && !loadError) {
      getDecision(decisionId)
        .then((detail) => setRecord(decisionToMemoryRecord(detail)))
        .catch(() => setLoadError('Unable to load this decision.'))
    }
  }

  return (
    <li className="text-[13px] text-[#6B7280]">
      <button type="button" onClick={toggle} className="text-left hover:text-[#374151]">
        <span className="font-semibold text-[#5A45FF]">[{decisionNumber}]</span> {decisionStatement}
      </button>
      {isExpanded ? (
        <div className="mt-2 rounded-lg border border-[#E8E8ED] bg-[#FAFAFB] p-3">
          {loadError ? (
            <span className="text-[#9CA3AF]">{loadError}</span>
          ) : record ? (
            <MemoryRecordDetail record={record} compactHeader />
          ) : (
            <span className="text-[#9CA3AF]">Loading…</span>
          )}
        </div>
      ) : null}
    </li>
  )
}

export function DashboardSearch() {
  const [greetingName, setGreetingName] = useState('there')
  const [question, setQuestion] = useState('')
  const [isSearching, setIsSearching] = useState(false)
  const [result, setResult] = useState<SearchResponse | null>(null)
  // Answer text as it arrives, before the final structured payload (with
  // citations) lands. Cleared once `result` takes over the rendering.
  const [streamingAnswer, setStreamingAnswer] = useState('')
  // Pipeline stages as the server finishes them. Cleared per search so a
  // second question never shows the first one's progress.
  const [stages, setStages] = useState<SearchStage[]>([])
  const [error, setError] = useState('')
  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>([])
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])

  useEffect(() => {
    const demoEmail = sessionStorage.getItem(DEMO_EMAIL_KEY)
    if (demoEmail) {
      setGreetingName(firstName(demoEmail, null))
      return
    }

    const supabase = getSupabaseClient()
    void supabase.auth.getSession().then(({ data }) => {
      const user = data.session?.user
      const displayName =
        (user?.user_metadata.full_name as string | undefined) ??
        (user?.user_metadata.name as string | undefined) ??
        null
      setGreetingName(firstName(user?.email, displayName))
    })
  }, [])

  // Suggestion chips reflect this tenant's own real decisions, not fixed
  // demo examples - a tenant with no captures yet just sees none, rather
  // than examples that imply data that isn't there.
  useEffect(() => {
    if (sessionStorage.getItem(DEMO_EMAIL_KEY)) return
    listDecisions(3, 0)
      .then((response) => {
        setSuggestions(response.items.map((item) => toSuggestion(item.decision_statement)))
      })
      .catch(() => {
        // No suggestions is a fine fallback - the search bar works without them.
      })
  }, [])

  const runSearch = async (submittedQuestion: string) => {
    const trimmed = submittedQuestion.trim()
    if (!trimmed || isSearching) return

    setIsSearching(true)
    setError('')
    setResult(null)
    setStreamingAnswer('')
    setStages([])

    try {
      const response = await searchDecisionsStreaming(
        trimmed,
        (chunk) => setStreamingAnswer((current) => current + chunk),
        // Replaces a same-named stage rather than appending, so the
        // generate_answer "started" frame does not stack up if the server
        // ever reports it more than once.
        (stage) => setStages((current) => [...current.filter((s) => s.name !== stage.name), stage]),
      )
      setResult(response)
      setStreamingAnswer('')
      setRecentSearches((current) => [{ query: trimmed, at: Date.now() }, ...current].slice(0, 5))
      recordSearchHistory(trimmed, response.citations.length)
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        const wait = err.retryAfterSeconds ? ` Try again in ${err.retryAfterSeconds}s.` : ''
        setError(`You're searching too quickly.${wait}`)
      } else {
        setError(err instanceof ApiError ? err.message : 'Search failed, try again.')
      }
    } finally {
      setIsSearching(false)
    }
  }

  return (
    <section className="mb-8">
      <h1 className="mb-5 text-[32px] font-bold leading-tight tracking-[-0.02em] text-[#111827]">
        {timeOfDayGreeting()}, {greetingName}
      </h1>

      <form
        className="relative mb-3.5"
        onSubmit={(event) => {
          event.preventDefault()
          void runSearch(question)
        }}
      >
        <div className="flex h-[52px] items-center rounded-xl border border-[#E5E7EB] bg-white px-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
          <svg
            className="mr-3 shrink-0 text-[#9CA3AF]"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
            <path
              d="M20 20l-3.5-3.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          <input
            type="text"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ask anything your organization already knows."
            className="h-full w-full bg-transparent text-[15px] text-[#111827] outline-none placeholder:text-[#9CA3AF]"
          />
          <button
            type="submit"
            disabled={isSearching || !question.trim()}
            className="ml-3 shrink-0 rounded-lg bg-[#5A45FF] px-5 py-2 text-[14px] font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSearching ? 'Asking...' : 'Ask'}
          </button>
        </div>
      </form>

      {/* Only while there is nothing else to look at. These are a prompt for
          someone staring at an empty box; once a search is running or an
          answer is on screen they are just clutter sitting between the
          question and its answer. */}
      {suggestions.length > 0 && !isSearching && !result && !streamingAnswer ? (
        <div className="mb-7 flex flex-wrap gap-2.5">
          {suggestions.map((suggestion, i) => (
            <button
              key={`${suggestion.label}-${i}`}
              type="button"
              onClick={() => {
                setQuestion(suggestion.query)
                void runSearch(suggestion.query)
              }}
              title={suggestion.query}
              className="max-w-full truncate rounded-full border border-[#E5E7EB] bg-white px-3.5 py-1.5 text-[12.5px] font-medium text-[#374151] transition-colors hover:border-[#C7C2F7] hover:bg-[#F9F8FF] hover:text-[#4c43c9]"
            >
              {suggestion.label}
            </button>
          ))}
        </div>
      ) : null}

      {isSearching ? (
        <SearchPipeline
          stages={stages}
          answerStarted={streamingAnswer.length > 0}
          done={false}
        />
      ) : null}

      {error ? (
        <div className="mb-6 rounded-xl border border-[#F3D6D6] bg-[#FFF7F7] px-4 py-3 text-[14px] text-[#B4232C]">
          {error}
        </div>
      ) : null}

      {!result && streamingAnswer ? (
        <div className="mb-7 rounded-xl border border-[#E8E8ED] bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
          <p className="text-[15px] leading-6 whitespace-pre-wrap text-[#111827]">
            {streamingAnswer}
            <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.15em] animate-pulse bg-[#5A45FF] align-middle" />
          </p>
        </div>
      ) : null}

      {result ? (
        <div className="mb-7 rounded-xl border border-[#E8E8ED] bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
          <p className="text-[15px] leading-6 whitespace-pre-wrap text-[#111827]">
            {result.answer}
          </p>
          {result.citations.length > 0 ? (
            <ul className="mt-4 flex flex-col gap-2 border-t border-[#F0F0F4] pt-4">
              {result.citations.map((citation) => (
                <CitationRow
                  key={citation.decision_id}
                  decisionNumber={citation.decision_number}
                  decisionId={citation.decision_id}
                  decisionStatement={citation.decision_statement}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {recentSearches.length > 0 ? (
        <div>
          <h2 className="mb-3 text-[11px] font-semibold tracking-[0.08em] text-[#9CA3AF] uppercase">
            Recent Search
          </h2>
          <ul className="overflow-hidden rounded-xl border border-[#E8E8ED] bg-white">
            {recentSearches.map((item, i) => (
              <li
                key={`${item.query}-${item.at}`}
                className={`flex items-center justify-between px-4 py-3.5 ${
                  i < recentSearches.length - 1 ? 'border-b border-[#F0F0F4]' : ''
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    setQuestion(item.query)
                    void runSearch(item.query)
                  }}
                  className="truncate text-left text-[14px] text-[#374151] hover:text-[#5A45FF]"
                >
                  {item.query}
                </button>
                <span className="ml-4 shrink-0 text-[13px] text-[#9CA3AF]">
                  {timeAgo(item.at)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
