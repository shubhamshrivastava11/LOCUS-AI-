export type SourceName = 'Slack' | 'Notion' | 'Gmail' | 'Jira' | 'Confluence' | 'Discord' | 'GitHub' | 'Monday' | 'ClickUp' | 'Teams'

const SOURCE_LOGOS: Partial<Record<SourceName, string>> = {
  Slack: '/slack-logo.png',
  Notion: '/notion-logo.png',
  Gmail: '/gmail-logo.png',
}

// Jira/Confluence have no real brand-logo asset in /public yet (the other
// three were added as actual PNG files) - rather than block the connector
// on sourcing official logo files, these render as a plain colored initial
// instead. Honest placeholder, not a fake logo: swap in a real asset file
// under SOURCE_LOGOS above whenever one's added, no other code changes
// needed.
const FALLBACK_BADGE: Partial<Record<SourceName, { letter: string; bg: string; fg: string }>> = {
  Jira: { letter: 'J', bg: '#0052CC', fg: '#FFFFFF' },
  Confluence: { letter: 'C', bg: '#1868DB', fg: '#FFFFFF' },
  Discord: { letter: 'D', bg: '#5865F2', fg: '#FFFFFF' },
  GitHub: { letter: 'G', bg: '#181717', fg: '#FFFFFF' },
  Monday: { letter: 'M', bg: '#FF3D57', fg: '#FFFFFF' },
  ClickUp: { letter: 'C', bg: '#7B68EE', fg: '#FFFFFF' },
  Teams: { letter: 'T', bg: '#6264A7', fg: '#FFFFFF' },
}

/**
 * Maps the API's source name to the display name used here.
 *
 * The two differ, and the difference is not mechanical: the database and the
 * API deal in lowercase ('github', 'clickup'), while these are brand names
 * with their own capitalisation. Naively upper-casing the first letter gives
 * "Github" and "Clickup", and passing the lowercase value straight through
 * matches no key at all, so every source silently renders the grey "?"
 * fallback badge.
 *
 * Returns null for anything unrecognised rather than guessing.
 */
const BY_API_NAME: Record<string, SourceName> = {
  slack: 'Slack',
  notion: 'Notion',
  gmail: 'Gmail',
  jira: 'Jira',
  confluence: 'Confluence',
  discord: 'Discord',
  github: 'GitHub',
  monday: 'Monday',
  clickup: 'ClickUp',
  teams: 'Teams',
}

export function toSourceName(apiSource: string): SourceName | null {
  return BY_API_NAME[apiSource.trim().toLowerCase()] ?? null
}

export function SourceLogo({
  source,
  className = 'h-6 w-6',
}: {
  source: SourceName
  className?: string
}) {
  const logoSrc = SOURCE_LOGOS[source]
  if (logoSrc) {
    return (
      <img
        src={logoSrc}
        alt=""
        aria-hidden="true"
        className={`bg-white object-contain ${className}`}
      />
    )
  }

  const badge = FALLBACK_BADGE[source]
  return (
    <span
      aria-hidden="true"
      className={`flex items-center justify-center rounded font-bold ${className}`}
      style={{ backgroundColor: badge?.bg ?? '#9CA3AF', color: badge?.fg ?? '#FFFFFF', fontSize: '0.7em' }}
    >
      {badge?.letter ?? '?'}
    </span>
  )
}
