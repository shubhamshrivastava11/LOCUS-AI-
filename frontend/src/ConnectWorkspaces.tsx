import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { GoogleIcon } from '../landing-page/components/GoogleIcon'
import { LocusLogo } from '../landing-page/components/LocusLogo'
import { connectSource, fetchSourceConnections, type SourceId } from './lib/sourceConnections'
import { DEMO_EMAIL_KEY } from './lib/sessionKeys'
import { isSupabaseConfigured } from './lib/supabase'

type ToolId = SourceId
type ToolState = 'idle' | 'connecting' | 'connected' | 'error'

type Tool = {
  id: ToolId
  name: string
  description: string
  iconSrc: string
}

const tools: Tool[] = [
  {
    id: 'slack',
    name: 'Slack',
    description:
      "Capture memory from channels and threads you're already in. Locus AI listens — you stay focused.",
    iconSrc: '/slack-logo.png',
  },
  {
    id: 'notion',
    name: 'Notion',
    description:
      "Capture memory from channels and threads you're already in. Locus AI listens — you stay focused.",
    iconSrc: '/notion-logo.png',
  },
  {
    id: 'gmail',
    name: 'Gmail',
    description:
      "Capture memory from channels and threads you're already in. Locus AI listens — you stay focused.",
    iconSrc: '/gmail-logo.png',
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
      }
    }
    return { slack: 'idle', notion: 'idle', gmail: 'idle' }
  })
  const [toolError, setToolError] = useState<Record<ToolId, string>>({ slack: '', notion: '', gmail: '' })
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
              Your Locus AI account is ready. Next: connect Slack, Notion, and Gmail so
            </span>
            <span className="block">we can start capturing decisions.</span>
          </p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-2 text-[14px] text-[#7a8190]">
            <GoogleIcon />
            <span>Signed in as</span>
            <strong className="font-semibold text-[#25252b]">{email}</strong>
          </div>
        </section>

        <section aria-label="Workspace tools" className="mt-8 grid w-full gap-5 md:grid-cols-3">
          {tools.map((tool) => {
            const state = toolState[tool.id]
            const isConnected = state === 'connected'
            const isConnecting = state === 'connecting'
            const isError = state === 'error'
            return (
              <article
                key={tool.id}
                className={`flex min-h-[238px] flex-col rounded-[10px] border bg-white p-5 shadow-[0_1px_2px_rgba(17,24,39,0.02)] ${
                  isConnected ? 'border-[#8177d2]' : 'border-[#dfe1e8]'
                }`}
              >
                <div className="flex items-center gap-4">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-[9px] border border-[#bfc4cf] bg-white">
                    <img
                      src={tool.iconSrc}
                      alt=""
                      className="h-9 w-9 bg-white object-contain"
                    />
                  </div>
                  <div>
                    <h2 className="text-[18px] font-bold leading-tight">{tool.name}</h2>
                    {isConnected ? (
                      <p className="mt-1 inline-flex items-center gap-1 rounded-full bg-[#e4f7b8] px-2 py-0.5 text-[12px] font-medium text-[#5f8422]">
                        <span className="h-1.5 w-1.5 rounded-full bg-[#80aa3b]" />
                        Connected
                      </p>
                    ) : isConnecting ? (
                      <p className="mt-1 text-[14px] text-[#a2a8b5]">Connecting…</p>
                    ) : isError ? (
                      <p className="mt-1 text-[14px] font-medium text-[#b4232c]">Connection failed</p>
                    ) : (
                      <p className="mt-1 text-[14px] text-[#a2a8b5]">Not Connected</p>
                    )}
                  </div>
                </div>

                <p className="mt-4 flex-1 text-[15px] leading-[1.45] text-[#6b7280]">
                  <span className="block">Capture memory from channels and</span>
                  <span className="block">threads you're already in. Locus AI listens —</span>
                  <span className="block">you stay focused.</span>
                </p>

                {isError && toolError[tool.id] ? (
                  <p role="alert" className="mt-2 text-[13px] leading-5 text-[#b4232c]">
                    {toolError[tool.id]}
                  </p>
                ) : null}

                <button
                  type="button"
                  aria-pressed={isConnected}
                  disabled={isConnecting || (isConnected && !demoMode)}
                  onClick={() => void connectTool(tool.id)}
                  className={`mt-4 min-h-11 w-full rounded-full border px-5 text-[15px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b38d1] disabled:cursor-wait disabled:opacity-70 ${
                    isConnected
                      ? 'border-[#e0a3a8] bg-[#fee5e6] text-[#b75058] hover:bg-[#fbd9db]'
                      : 'border-[#4b38d1] bg-[#4b38d1] text-white hover:bg-[#3f2dbd]'
                  }`}
                >
                  {isConnected
                    ? demoMode
                      ? 'Disconnect'
                      : `${tool.name} Connected`
                    : isConnecting
                      ? 'Connecting…'
                      : isError
                        ? `Retry ${tool.name}`
                        : `Connect ${tool.name}`}
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
