import logoSrc from '../assets/locuslogo.png'

export function LocusLogo({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <img
        src={logoSrc}
        alt="Locus AI"
        className="h-[30px] w-[30px] shrink-0 rounded-[6px]"
      />
      <span className="text-[14px] font-bold tracking-[0.04em] text-black">
        LOCUS AI
      </span>
    </div>
  )
}
