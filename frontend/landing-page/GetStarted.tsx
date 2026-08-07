import { useNavigate } from 'react-router-dom'
import { Header } from './components/Header'
import { ProcessStepper } from './components/ProcessStepper'
import { DashboardPreview } from './components/DashboardPreview'

export default function GetStarted() {
  const navigate = useNavigate()

  return (
    <div className="relative w-full bg-white">
      <div className="mx-auto min-h-screen w-full max-w-[1100px]">
        <Header />

        <main className="flex min-h-[calc(100vh-72px)] flex-col gap-10 px-8 pb-10 pt-2 lg:flex-row lg:items-stretch lg:gap-8 lg:px-10">
          <section className="flex w-full shrink-0 flex-col pt-4 lg:w-[42%]">
            <h1 className="text-[40px] font-bold leading-[1.15] tracking-[-0.025em] text-[#111827]">
              Turn everyday work into{' '}
              <span className="bg-gradient-to-r from-[#5b52e8] to-[#6366f1] bg-clip-text text-transparent">
                organizational memory.
              </span>
            </h1>

            <p className="mt-4 max-w-[390px] text-[14.5px] leading-[1.65] text-[#6b7280]">
              Locus AI continuously builds memory from your Slack and Notion
              workspaces so your team can ask anything it already knows, with
              links back to the original context.
            </p>

            <button
              type="button"
              onClick={() => navigate('/welcome')}
              className="mt-6 w-fit rounded-full bg-[#C8E619] px-7 py-3 text-[15px] font-semibold text-[#111827] transition-opacity hover:opacity-90"
            >
              Get started now
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
    </div>
  )
}
