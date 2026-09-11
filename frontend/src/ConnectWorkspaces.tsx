import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { GoogleIcon } from '../landing-page/components/GoogleIcon'
import { LocusLogo } from '../landing-page/components/LocusLogo'
import { connectSource, fetchSourceConnections, type SourceId } from './lib/sourceConnections'
import { DEMO_EMAIL_KEY } from './lib/sessionKeys'
import { isSupabaseConfigured } from './lib/supabase'
import { SourceLogo, type SourceName } from './components/SourceLogo'

type ToolId = SourceId
type ToolState = 'idle' | 'connecting' | 'connected' | 'error'

type Tool = {
  id: ToolId
  name: SourceName
  description: string
}

// All 9 connectors, not just Slack/Notion/Gmail - this screen used to
// curate down to 3 "most common" sources, silently leaving the other 6
// (which Settings > Connected Sources already lists) invisible until
// someone thought to look there. First impression of the product should
// show everything it actually supports.
const tools: Tool[] = [
  {
    id: 'slack',
    name: 'Slack',
    description:
      "Capture memory from channels and threads you're already in. Locus AI listens — you stay focused.",
  },
  {
    id: 'notion',
    name: 'Notion',
    description:
      "Capture memory from pages and databases you're already in. Locus AI listens — you stay focused.",
  },
  {
    id: 'gmail',
    name: 'Gmail',
    description:
      "Capture memory from decisions made over email. Locus AI listens — you stay focused.",
  },
  {
    id: 'jira',
    name: 'Jira',
    description:
      "Capture memory from tickets and comments you're already writing. Locus AI listens — you stay focused.",
  },
  {
    id: 'confluence',
    name: 'Confluence',
    description:
      "Capture memory from docs and pages you're already writing. Locus AI listens — you stay focused.",
  },
  {
    id: 'discord',
    name: 'Discord',
    description:
      "Capture memory from channels and threads you're already in. Locus AI listens — you stay focused.",
  },
  {
    id: 'github',
    name: 'GitHub',
    description:
      "Capture memory from issues and pull requests you're already working on. Locus AI listens — you stay focused.",
  },
  {
    id: 'monday',
    name: 'Monday',
    description:
      "Capture memory from boards and items you're already updating. Locus AI listens — you stay focused.",
  },
  {
    id: 'clickup',
    name: 'ClickUp',
    description:
      "Capture memory from tasks and comments you're already writing. Locus AI listens — you stay focused.",
  },
  {
    id: 'teams',
    name: 'Teams',
    description:
      "Capture memory from the channel conversations your team is already having. Needs a Microsoft 365 admin to approve it once.",
  },
]

const STORAGE_KEY = 'locus:connected-tools'

// Demo sessions (WelcomePage's "demo" button, or Supabase not configured at
// all) have no real tenant/session to connect a source against — fall back
// to the local sessionStorage toggle so the demo flow still works.
function isDemoSession(): boolean {
  return !isSupabaseConfigured() || Boolean(sessionStorage.getItem(DEMO_EMAIL_KEY))
}

function loadDemoConnected(): Set<ToolId> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as ToolId[]
    return new Set(parsed.filter((id) => tools.some((t) => t.id === id)))
  } catch {
    return new Set()
  }
}

function saveDemoConnected(toolsSet: Set<ToolId>) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...toolsSet]))
}

export default function ConnectWorkspaces({ email, onContinue }: { email: string; onContinue: () => void }) {
  const demoMode = isDemoSession()
  const [toolState, setToolState] = useState<Record<ToolId, ToolState>>(() => {
    if (demoMode) {
      const connected = loadDemoConnected()
      return {
        slack: connected.has('slack') ? 'connected' : 'idle',
        notion: connected.has('notion') ? 'connected' : 'idle',
        gmail: connected.has('gmail') ? 'connected' : 'idle',
        jira: connected.has('jira') ? 'connected' : 'idle',
        confluence: connected.has('confluence') ? 'connected' : 'idle',
        discord: connected.has('discord') ? 'connected' : 'idle',
        github: connected.has('github') ? 'connected' : 'idle',
        monday: connected.has('monday') ? 'connected' : 'idle',
        clickup: connected.has('clickup') ? 'connected' : 'idle',
        teams: connected.has('teams') ? 'connected' : 'idle',
      }
    }
    return { slack: 'idle', notion: 'idle', gmail: 'idle', jira: 'idle', confluence: 'idle', discord: 'idle', github: 'idle', monday: 'idle', clickup: 'idle', teams: 'idle' }
  })
  const [toolError, setToolError] = useState<Record<ToolId, string>>({
    slack: '', notion: '', gmail: '', jira: '', confluence: '', discord: '', github: '', monday: '', clickup: '', teams: '',
  })
  const canContinue = Object.values(toolState).some((state) => state === 'connected')

  // Real initial state: read existing source_connections rows for this tenant
  // (RLS lets an authenticated member read their own tenant's rows directly).
  useEffect(() => {
    if (demoMode) return
    let active = true

    void (async () => {
      try {
        const rows = await fetchSourceConnections()
        if (!active) return

        setToolState((current) => {
          const next = { ...current }
          for (const row of rows) {
            if (row.status === 'active') next[row.source] = 'connected'
          }
          return next
        })
      } catch {
        // No backend session yet or tenant lookup failed — leave tools as idle,
        // the user can still attempt to connect (which re-resolves the tenant).
      }
    })()

    return () => {
      active = false
    }
  }, [demoMode])

  const toggleDemoTool = useCallback((toolId: ToolId) => {
    setToolState((current) => {
      const next = { ...current, [toolId]: current[toolId] === 'connected' ? ('idle' as ToolState) : ('connected' as ToolState) }
      const connected = new Set(
        (Object.keys(next) as ToolId[]).filter((id) => next[id] === 'connected'),
      )
      saveDemoConnected(connected)
      return next
    })
  }, [])

  const connectTool = async (toolId: ToolId) => {
    if (demoMode) {
      toggleDemoTool(toolId)
      return
    }

    if (toolState[toolId] === 'connecting') return

    setToolState((current) => ({ ...current, [toolId]: 'connecting' }))
    setToolError((current) => ({ ...current, [toolId]: '' }))

    const result = await connectSource(toolId)

    if (result.success) {
      setToolState((current) => ({ ...current, [toolId]: 'connected' }))
      setToolError((current) => ({ ...current, [toolId]: '' }))
    } else {
      setToolState((current) => ({ ...current, [toolId]: 'error' }))
      setToolError((current) => ({ ...current, [toolId]: result.error ?? 'Connection failed.' }))
    }
  }

  return (
    <main className="min-h-screen bg-[#f4f4f8] px-5 py-6 text-[#18181b] sm:px-8 sm:py-8 lg:px-10">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-[1360px] flex-col items-center">
        <LocusLogo size={40} className="gap-3 [&_span]:text-[22px]" />

        <section className="mt-8 text-center">
          <h1 className="text-[28px] font-bold leading-tight sm:text-[32px]">
            Connect your workspaces
          </h1>
          <p className="mx-auto mt-3 max-w-[760px] text-[15px] leading-[1.45] text-[#6b7280] sm:text-[17px]">
            <span className="block">
              Your Locus AI account is ready. Connect whichever tools your team already lives in
            </span>
            <span className="block">so we can start capturing decisions.</span>
          </p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-2 text-[14px] text-[#7a8190]">
            <GoogleIcon />
            <span>Signed in as</span>
            <strong className="font-semibold text-[#25252b]">{email}</strong>
          </div>
        </section>

        {/* Compact row cards, not the old 238px description-heavy tiles -
            those worked for 3 tools, but the same size times 9 was mostly
            nine copies of the same boilerplate sentence stacked into a
            long scroll. Icon + name + one-line status on the left, a
            single action on the right - the tool's own name already says
            what it is, it doesn't need three lines re-explaining "Locus AI
            listens" every time. */}
        <section aria-label="Workspace tools" className="mt-8 grid w-full gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tools.map((tool) => {
            const state = toolState[tool.id]
            const isConnected = state === 'connected'
            const isConnecting = state === 'connecting'
            const isError = state === 'error'
            return (
              <article
                key={tool.id}
                className={`flex items-center gap-3 rounded-[10px] border bg-white px-4 py-3 shadow-[0_1px_2px_rgba(17,24,39,0.02)] ${
                  isConnected ? 'border-[#8177d2]' : 'border-[#dfe1e8]'
                }`}
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[8px] border border-[#bfc4cf] bg-white">
                  <SourceLogo source={tool.name} className="h-6 w-6" />
                </div>

                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-[15px] font-bold leading-tight">{tool.name}</h2>
                  {isConnected ? (
                    <p className="mt-0.5 inline-flex items-center gap-1 text-[12px] font-medium text-[#5f8422]">
                      <span className="h-1.5 w-1.5 rounded-full bg-[#80aa3b]" />
                      Connected
                    </p>
                  ) : isConnecting ? (
                    <p className="mt-0.5 text-[12px] text-[#a2a8b5]">Connecting…</p>
                  ) : isError ? (
                    <p className="mt-0.5 truncate text-[12px] font-medium text-[#b4232c]" title={toolError[tool.id]}>
                      {toolError[tool.id] || 'Connection failed'}
                    </p>
                  ) : null}
                </div>

                <button
                  type="button"
                  aria-pressed={isConnected}
                  disabled={isConnecting || (isConnected && !demoMode)}
                  onClick={() => void connectTool(tool.id)}
                  className={`shrink-0 rounded-full border px-3.5 py-1.5 text-[13px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b38d1] disabled:cursor-wait disabled:opacity-70 ${
                    isConnected
                      ? 'border-[#e0a3a8] bg-[#fee5e6] text-[#b75058] hover:bg-[#fbd9db]'
                      : 'border-[#4b38d1] bg-[#4b38d1] text-white hover:bg-[#3f2dbd]'
                  }`}
                >
                  {isConnected
                    ? demoMode
                      ? 'Disconnect'
                      : 'Connected'
                    : isConnecting
                      ? '...'
                      : isError
                        ? 'Retry'
                        : 'Connect'}
                </button>
              </article>
            )
          })}
        </section>

        <div className="mt-8 flex flex-col items-center pb-1">
          <button
            type="button"
            disabled={!canContinue}
            onClick={onContinue}
            className="min-h-[50px] w-full min-w-0 rounded-full bg-[#4b38d1] px-10 text-[16px] font-semibold text-white transition-colors hover:bg-[#3f2dbd] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b38d1] disabled:cursor-not-allowed disabled:bg-[#aaa7e7] sm:w-[380px]"
          >
            Continue
          </button>
          <p className="mt-3 text-center text-[13px] text-[#7a8190]">
            You can connect or disconnect tools anytime from{' '}
            <Link to="/settings" className="font-medium text-[#4b38d1] hover:underline">
              Settings
            </Link>
          </p>
        </div>
      </div>
    </main>
  )
}
