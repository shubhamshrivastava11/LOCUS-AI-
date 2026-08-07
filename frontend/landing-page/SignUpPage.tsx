import { Header } from './components/Header'
import { GoogleIcon } from './components/GoogleIcon'
import { ProcessStepper } from './components/ProcessStepper'
import { DashboardPreview } from './components/DashboardPreview'

export function SignUpPage() {
  return (
    <div className="relative mx-auto min-h-screen w-full max-w-[1024px] bg-white">
      <Header />

      <main className="flex min-h-[calc(100vh-64px)] px-10 pb-6">
        <section className="flex w-[44%] shrink-0 flex-col pt-4">
          <h1 className="text-[40px] font-bold leading-[1.15] tracking-[-0.025em] text-[#111827]">
            Turn everyday work into{' '}
            <span className="text-[#5b52e8]">organizational memory.</span>
          </h1>

          <p className="mt-4 max-w-[390px] text-[14.5px] leading-[1.65] text-[#6b7280]">
            Locus AI continuously builds memory from your Slack and Notion
            workspaces so your team can ask anything it already knows, with
            links back to the original context.
          </p>

          <button
            type="button"
            className="mt-6 flex w-fit items-center gap-2.5 rounded-full bg-[#c8e619] px-5 py-3 text-[14.5px] font-semibold text-[#111827] transition-opacity hover:opacity-90"
          >
            <GoogleIcon />
            Sign up with Google
          </button>

          <p className="mt-2.5 max-w-[370px] text-[12.5px] leading-[1.55] text-[#9ca3af]">
            We&apos;ll connect Slack and Notion next so Locus AI can start
            building memory.
          </p>

          <ProcessStepper />
        </section>

        <DashboardPreview />
      </main>
    </div>
  )
}
