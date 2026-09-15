import { useEffect, useRef, useState } from 'react'
import type { SearchStage } from '../lib/api'

/**
 * The retrieval pipeline, shown while a search runs.
 *
 * Driven by real `stage` events from POST /search rather than a timer. That
 * distinction is the whole point: the median search spends 2.3s in
 * analyze_and_embed before the answer's first character exists (measured from
 * request_traces, not guessed), and that time used to be completely blank -
 * the Ask button said "Asking..." and nothing else moved. A progress
 * animation on a fixed schedule would have filled the same seconds while
 * telling the user nothing true; these cards light up when the work actually
 * finishes, and each one reports what it actually did.
 */

type StageName = SearchStage['name']

const STAGE_ORDER: StageName[] = [
  'resolve_scopes',
  'analyze_and_embed',
  'retrieve',
  'authorize',
  'generate_answer',
]

const STAGE_COPY: Record<StageName, { title: string; doing: string }> = {
  resolve_scopes: { title: 'Access', doing: 'Working out what you can see' },
  analyze_and_embed: { title: 'Understand', doing: 'Reading the question' },
  retrieve: { title: 'Retrieve', doing: 'Searching memory' },
  authorize: { title: 'Filter', doing: 'Removing what is not yours' },
  generate_answer: { title: 'Answer', doing: 'Writing with citations' },
}

/** What a finished stage gets to say for itself. Real counts, never labels. */
function stageResult(stage: SearchStage): string {
  switch (stage.name) {
    case 'resolve_scopes':
      return stage.scopes === 1 ? '1 source' : `${stage.scopes ?? 0} sources`
    case 'analyze_and_embed':
      return stage.is_multi_document ? 'Multi-part question' : (stage.question_type ?? 'Understood')
    case 'retrieve':
      return `${stage.candidates ?? 0} candidates`
    case 'authorize':
      return stage.withheld
        ? `${stage.authorized ?? 0} allowed, ${stage.withheld} withheld`
        : `${stage.authorized ?? 0} allowed`
    case 'generate_answer':
      return `${stage.decisions ?? 0} in context`
  }
}

function StageIcon({ name, className }: { name: StageName; className?: string }) {
  const common = {
    className,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  switch (name) {
    case 'resolve_scopes':
      return (
        <svg {...common}>
          <rect x="4" y="10.5" width="16" height="10" rx="2" />
          <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
        </svg>
      )
    case 'analyze_and_embed':
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="6.5" />
          <path d="M20 20l-4.4-4.4M11 8v6M8 11h6" />
        </svg>
      )
    case 'retrieve':
      return (
        <svg {...common}>
          <ellipse cx="12" cy="6" rx="7.5" ry="3" />
          <path d="M4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6" />
          <path d="M4.5 12v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" />
        </svg>
      )
    case 'authorize':
      return (
        <svg {...common}>
          <path d="M4 5h16l-6.2 7.3v6.4L10.2 21v-8.7L4 5z" />
        </svg>
      )
    case 'generate_answer':
      return (
        <svg {...common}>
          <path d="M4 5.5h10M4 10h16M4 14.5h13M4 19h8" />
        </svg>
      )
  }
}

function Check({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M5 12.5l4.5 4.5L19 7.5"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function SearchPipeline({
  stages,
  answerStarted,
  done,
}: {
  /** Completed stages, in arrival order. */
  stages: SearchStage[]
  /** True once the first answer token has arrived. */
  answerStarted: boolean
  /** True once the whole search has finished. */
  done: boolean
}) {
  const [elapsed, setElapsed] = useState(0)
  const startedAt = useRef(Date.now())

  useEffect(() => {
    if (done) return
    // 100ms rather than requestAnimationFrame: the readout is tenths of a
    // second, so a 60fps loop would repaint sixty times to change a digit ten
    // times, for a number nobody is watching that closely.
    const id = setInterval(() => setElapsed(Date.now() - startedAt.current), 100)
    return () => clearInterval(id)
  }, [done])

  const byName = new Map(stages.map((s) => [s.name, s]))
  // generate_answer arrives with status "started" and is the only stage that
  // reports before it finishes - it is finished when the answer is.
  const generating = byName.has('generate_answer') && !done

  const currentIndex = STAGE_ORDER.findIndex((name) => {
    const seen = byName.get(name)
    if (!seen) return true
    return name === 'generate_answer' && !done
  })

  return (
    <div
      className="locus-pipeline mb-4 overflow-hidden rounded-2xl border border-[#E7E5F8] bg-gradient-to-b from-[#FBFAFF] to-white p-4"
      role="status"
      aria-live="polite"
    >
      <div className="mb-3.5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            {!done ? (
              <span className="locus-pipeline-ring absolute inline-flex h-full w-full rounded-full bg-[#5b52e8]" />
            ) : null}
            <span
              className={`relative inline-flex h-2 w-2 rounded-full ${done ? 'bg-[#16a34a]' : 'bg-[#5b52e8]'}`}
            />
          </span>
          <span className="text-[13px] font-semibold text-[#111827]">
            {done
              ? 'Answered'
              : generating
                // The stage event says generation began; answerStarted says
                // tokens are actually arriving. Worth separating - the gap
                // between them is the model's time to first token, and
                // claiming to be writing before anything is written is the
                // kind of small lie this whole panel exists to avoid.
                ? (answerStarted ? 'Writing the answer' : 'Preparing to write')
                : (STAGE_COPY[STAGE_ORDER[Math.max(0, currentIndex)]]?.doing ?? 'Searching memory')}
          </span>
        </div>
        <span className="font-mono text-[12px] tabular-nums text-[#6B7280]">
          {(elapsed / 1000).toFixed(1)}s
        </span>
      </div>

      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {STAGE_ORDER.map((name, index) => {
          const stage = byName.get(name)
          const isGenerateInFlight = name === 'generate_answer' && generating
          const complete = Boolean(stage) && !isGenerateInFlight
          const active = isGenerateInFlight || (!stage && index === currentIndex)
          const copy = STAGE_COPY[name]

          return (
            <li
              key={name}
              className={`locus-pipeline-card relative overflow-hidden rounded-xl border p-3 transition-colors duration-300 ${
                complete
                  ? 'border-[#D6F0E0] bg-[#F6FCF8]'
                  : active
                    ? 'locus-pipeline-card-active border-[#C7C2F7] bg-white'
                    : 'border-[#EFEEF6] bg-[#FCFCFE]'
              }`}
              style={{ ['--locus-delay' as string]: `${index * 55}ms` }}
              aria-label={`${copy.title}: ${
                complete ? `done, ${stageResult(stage as SearchStage)}` : active ? 'in progress' : 'waiting'
              }`}
            >
              {active ? (
                <span
                  aria-hidden="true"
                  className="locus-pipeline-scan pointer-events-none absolute inset-x-0 top-0 h-2/3 bg-gradient-to-b from-transparent via-[#5b52e8]/10 to-transparent"
                />
              ) : null}

              <div className="relative mb-2 flex items-center justify-between">
                <span
                  className={`relative inline-flex h-7 w-7 items-center justify-center rounded-lg ${
                    complete
                      ? 'bg-[#E7F7EE] text-[#16a34a]'
                      : active
                        ? 'bg-[#EEECFD] text-[#5b52e8]'
                        : 'bg-[#F3F3F8] text-[#9CA3AF]'
                  }`}
                >
                  {active ? (
                    <span
                      aria-hidden="true"
                      className="locus-pipeline-ring absolute inset-0 rounded-lg bg-[#5b52e8]/25"
                    />
                  ) : null}
                  {complete ? (
                    <Check className="locus-pipeline-pop h-4 w-4" />
                  ) : (
                    <StageIcon name={name} className="h-4 w-4" />
                  )}
                </span>

                <span className="font-mono text-[10px] tabular-nums text-[#9CA3AF]">
                  {stage && !isGenerateInFlight ? `${stage.elapsed_ms}ms` : `0${index + 1}`}
                </span>
              </div>

              <p
                className={`relative text-[12px] font-semibold leading-tight ${
                  complete ? 'text-[#15803d]' : active ? 'text-[#111827]' : 'text-[#9CA3AF]'
                }`}
              >
                {copy.title}
              </p>
              {/* Wraps rather than truncating: at five columns the cards are narrow,
                  and "17 allowed, 3 withheld" cut to "17 allowed, 3 with..." loses
                  exactly the half that matters. */}
              <p className="relative mt-0.5 line-clamp-2 text-[11px] leading-tight text-[#6B7280]">
                {complete && stage ? stageResult(stage) : active ? copy.doing : 'Waiting'}
              </p>

              <div className="relative mt-2 h-[3px] overflow-hidden rounded-full bg-[#F0EFF7]">
                {complete ? (
                  <span className="block h-full w-full rounded-full bg-[#86D3A6]" />
                ) : active ? (
                  <span className="locus-pipeline-bar block h-full w-1/4 rounded-full bg-[#5b52e8]" />
                ) : null}
              </div>

              {/* Data handing off to the next stage. Decorative, and removed
                  entirely under prefers-reduced-motion. */}
              {complete && index < STAGE_ORDER.length - 1 ? (
                <span aria-hidden="true" className="pointer-events-none absolute -right-1 top-1/2 hidden lg:block">
                  {[0, 1, 2].map((mote) => (
                    <span
                      key={mote}
                      className="locus-pipeline-mote absolute h-1 w-1 rounded-full bg-[#5b52e8]"
                      style={{ ['--locus-delay' as string]: `${mote * 300}ms` }}
                    />
                  ))}
                </span>
              ) : null}
            </li>
          )
        })}
      </ol>

      {generating ? (
        <p className="mt-3 flex items-center gap-1.5 text-[11.5px] text-[#6B7280]">
          <span className="locus-pipeline-caret inline-block h-3 w-[2px] bg-[#5b52e8]" aria-hidden="true" />
          {answerStarted
            ? `Citing from ${byName.get('generate_answer')?.decisions ?? 0} records as it writes`
            : `Reading ${byName.get('generate_answer')?.decisions ?? 0} records`}
        </p>
      ) : null}
    </div>
  )
}
