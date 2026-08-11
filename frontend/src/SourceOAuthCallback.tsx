import { useEffect } from 'react'

/**
 * Landing page for the Slack/Notion/Gmail OAuth popup's final redirect
 * (see supabase/functions/_shared/oauth_tenant.ts's popupCallbackResponse).
 *
 * Supabase Edge Functions can't serve HTML on the default domain (any
 * text/html response gets rewritten to text/plain by the platform), so the
 * callback Edge Function redirects here instead — a normal SPA route on
 * our own origin, where posting back to the opener and closing actually
 * works.
 */
export default function SourceOAuthCallback() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const source = params.get('source')
    const success = params.get('success') === 'true'
    const error = params.get('error') ?? undefined

    if (source) {
      try {
        window.opener?.postMessage(
          { type: 'locus:source-oauth', source, success, error },
          window.location.origin,
        )
      } catch {
        // Best-effort — the opener also polls source_connections directly.
      }
    }
    window.close()
  }, [])

  return (
    <main className="flex min-h-screen items-center justify-center bg-white text-sm text-[#6B7280]">
      Finishing up… you can close this window.
    </main>
  )
}
