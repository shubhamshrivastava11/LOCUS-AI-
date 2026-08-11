import { useNavigate } from 'react-router-dom'
import { LocusLogo } from './components/LocusLogo'

function SparkleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M9 1.5L10.2 6.8L15.5 8L10.2 9.2L9 14.5L7.8 9.2L2.5 8L7.8 6.8L9 1.5Z"
        fill="#5b52e8"
      />
      <path
        d="M14 11.5L14.5 13.5L16.5 14L14.5 14.5L14 16.5L13.5 14.5L11.5 14L13.5 13.5L14 11.5Z"
        fill="#5b52e8"
      />
    </svg>
  )
}

function ExternalLinkIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2.5" y="4.5" width="9.5" height="11" rx="1.5" stroke="#5b52e8" strokeWidth="1.6" />
      <path
        d="M7.5 2.5H15.5V10.5"
        stroke="#5b52e8"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15.2 2.8L8.5 9.5"
        stroke="#5b52e8"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

function TrendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M2.5 12.5L6.5 8.5L9.5 11.5L15.5 5.5"
        stroke="#16a34a"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M11.5 5.5H15.5V9.5"
        stroke="#16a34a"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function LockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="3.5" y="8" width="11" height="8" rx="1.5" stroke="#6b7280" strokeWidth="1.6" />
      <path
        d="M6 8V5.5a3 3 0 0 1 6 0V8"
        stroke="#6b7280"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="9" cy="12" r="1.1" fill="#6b7280" />
    </svg>
  )
}

function UsersIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="6.5" cy="6" r="2.4" stroke="#16a34a" strokeWidth="1.5" />
      <path
        d="M2.5 14.5c0-2.2 1.8-4 4-4s4 1.8 4 4"
        stroke="#16a34a"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="12.5" cy="6.5" r="2" stroke="#16a34a" strokeWidth="1.5" />
      <path
        d="M11.2 10.6c1.5.4 2.8 1.6 2.8 3.9"
        stroke="#16a34a"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

function BoltIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M10.2 1.5L4 10.2h4.2L7.8 16.5 14 7.8H9.8L10.2 1.5Z"
        fill="#5b52e8"
      />
    </svg>
  )
}

function FooterLogo() {
  return <LocusLogo variant="light" size={32} />
}

const FEATURES = [
  {
    title: 'Zero manual entry',
    description:
      'Every failed workaround failed because it required effort. Locus AI asks for none. It learns continuously in the background from day one.',
    icon: <SparkleIcon />,
    iconBg: 'bg-[#eee8ff]',
  },
  {
    title: 'Always cited',
    description:
      'Every memory record links directly to its source: the Slack thread, the Notion doc, or the Gmail thread. No context is lost in translation.',
    icon: <ExternalLinkIcon />,
    iconBg: 'bg-[#eee8ff]',
  },
  {
    title: 'Full memory lifecycle',
    description:
      'When understanding changes, both records stay with a link between them. See exactly when and why your team updated its context.',
    icon: <TrendIcon />,
    iconBg: 'bg-[#e8f9e8]',
  },
  {
    title: 'Private by design',
    description:
      'Read-only access. Raw content is encrypted and purged after 30 days. Only structured organizational memory persists long-term.',
    icon: <LockIcon />,
    iconBg: 'bg-[#f3f4f6]',
  },
  {
    title: 'Useful solo, powerful as a team',
    description:
      'Get value on day one. Invite your team and knowledge becomes shared institutional memory that is searchable by everyone.',
    icon: <UsersIcon />,
    iconBg: 'bg-[#e8f9e8]',
  },
  {
    title: 'Built for AI agents too',
    description:
      'Locus AI exposes your decision layer as MCP tools, so any AI agent can query your team\'s context, not just your teammates.',
    icon: <BoltIcon />,
    iconBg: 'bg-[#eee8ff]',
  },
]

export default function WhyLocus() {
  const navigate = useNavigate()

  return (
    <div className="bg-[#f7f7f9]">
      <div className="mx-auto max-w-[1040px] px-6 pb-4 pt-16 sm:px-10 lg:px-12 lg:pt-20">
        <p className="text-[12px] font-semibold tracking-[0.08em] text-[#5b52e8]">
          WHY LOCUS AI
        </p>
        <h1 className="mt-3 max-w-[720px] text-[36px] font-bold leading-[1.15] tracking-[-0.03em] text-[#111827] sm:text-[42px]">
          The memory layer your team is{' '}
          <span className="text-[#5b52e8]">missing.</span>
        </h1>
        <p className="mt-4 max-w-[620px] text-[15px] leading-[1.7] text-[#6b7280]">
          Existing tools are good at finding documents. Locus AI turns everyday
          work into organizational memory: context, knowledge, and
          understanding your team can ask for anytime.
        </p>

        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <div
              key={feature.title}
              className="rounded-2xl border border-[#ececf0] bg-white p-6 shadow-[0_1px_2px_rgba(17,24,39,0.03)]"
            >
              <div
                className={`mb-4 flex h-10 w-10 items-center justify-center rounded-xl ${feature.iconBg}`}
              >
                {feature.icon}
              </div>
              <h3 className="text-[16px] font-bold tracking-[-0.01em] text-[#111827]">
                {feature.title}
              </h3>
              <p className="mt-2 text-[13.5px] leading-[1.65] text-[#6b7280]">
                {feature.description}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-16 flex flex-col items-start justify-between gap-6 border-t border-transparent pb-16 pt-4 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-[28px] font-bold tracking-[-0.02em] text-[#111827] sm:text-[32px]">
              Ready to give your team a{' '}
              <span className="text-[#5b52e8]">shared memory?</span>
            </h2>
            <p className="mt-2 text-[14.5px] text-[#6b7280]">
              Set up in under 4 minutes. No new tools to learn.
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/welcome')}
            className="shrink-0 rounded-full bg-[#c8e619] px-6 py-3 text-[14.5px] font-semibold text-[#111827] transition-opacity hover:opacity-90"
          >
            Get started now →
          </button>
        </div>
      </div>

      <footer className="bg-[#111827] px-6 py-12 sm:px-10 lg:px-12">
        <div className="mx-auto max-w-[1040px]">
          <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-[380px]">
              <FooterLogo />
              <p className="mt-4 text-[13.5px] leading-[1.7] text-[#9ca3af]">
                Locus AI turns everyday work into organizational memory from your
                Slack, Notion, and Gmail, so your team can ask anything it
                already knows.
              </p>
            </div>
            <nav className="flex gap-8 text-[14px] text-white">
              <a href="#how-it-works" className="hover:text-[#c8e619]">
                How it works
              </a>
              <a href="#why-locus" className="hover:text-[#c8e619]">
                Why Locus AI
              </a>
            </nav>
          </div>

          <div className="mt-10 border-t border-[#374151] pt-6">
            <p className="text-[13px] text-[#9ca3af]">© 2026 All rights reserved.</p>
          </div>
        </div>
      </footer>
    </div>
  )
}
