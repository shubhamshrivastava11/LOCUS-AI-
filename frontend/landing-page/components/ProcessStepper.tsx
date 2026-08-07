const steps = [
  {
    number: 1,
    title: 'Connect Tools',
    description: 'Slack, Notion, Gmails',
  },
  {
    number: 2,
    title: 'Locus AI builds memory',
    description: 'Learn continuously in the background',
  },
  {
    number: 3,
    title: 'Ask with citations',
    description: 'Answers with links to memory sources',
  },
]

export function ProcessStepper() {
  return (
    <div className="mt-auto pt-10">
      <div className="relative flex items-start justify-between">
        <div className="absolute left-[calc(16.67%-8px)] right-[calc(16.67%-8px)] top-4 h-px bg-[#e5e7eb]" />

        {steps.map((step) => (
          <div key={step.number} className="relative z-10 flex w-[140px] flex-col items-center text-center">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-black text-[13px] font-semibold text-white">
              {step.number}
            </div>
            <p className="mt-3 text-[13px] font-semibold leading-snug text-[#111827]">
              {step.title}
            </p>
            <p className="mt-1 text-[12px] leading-snug text-[#9ca3af]">
              {step.description}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}
