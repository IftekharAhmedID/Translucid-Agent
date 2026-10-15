import { ArrowRight, Dog, Target } from "lucide-react";
import InvestigationForm from "./investigation-form";

export default function HeroSection() {
  return (
    <div className="relative isolate min-h-dvh overflow-hidden bg-zinc-950 font-sans text-white">
      <div className="hero-background pointer-events-none absolute inset-0 -z-10" />
      <header className="mx-auto flex max-w-7xl items-center justify-between px-6 py-8 lg:px-8">
        <a href="/" className="inline-flex items-center gap-2.5 text-xl font-semibold tracking-tight"><Dog className="size-6 text-[#ffcd75]" aria-hidden="true" />TraceDog</a>
        <a href="https://ahmedifty.com/" className="inline-flex items-center gap-2 text-xs text-zinc-300 transition-colors hover:text-white">Get in touch<ArrowRight className="size-3.5" aria-hidden="true" /></a>
      </header>
      <main className="mx-auto max-w-7xl px-6 pb-12 pt-12 sm:pt-20 lg:px-8 lg:pb-24 lg:pt-28">
        <div className="grid grid-cols-1 items-start gap-12 lg:grid-cols-12 lg:gap-12">
          <div className="space-y-8 pt-4 lg:col-span-7">
            <div className="animate-fade-in delay-100">
              <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-300 backdrop-blur-md sm:text-xs"><span className="size-1.5 rounded-full bg-[#ffcd75]" />AI agent for deep OSINT investigations</div>
            </div>
            <h1 className="heading-mask animate-fade-in delay-200 text-5xl font-medium leading-[.95] tracking-tighter sm:text-6xl lg:text-7xl xl:text-8xl">Every claim<br /><span className="bg-gradient-to-br from-white via-white to-[#ffcd75] bg-clip-text text-transparent">has a trail.</span><br />Follow it.</h1>
            <p className="animate-fade-in delay-300 max-w-md text-base leading-relaxed text-zinc-300 sm:text-lg">Follow the evidence. Connect the sources.<br />Get the full picture.</p>
            <a href="#investigate" className="animate-fade-in delay-400 group inline-flex items-center justify-center gap-2 rounded-full bg-white px-7 py-4 text-sm font-semibold text-zinc-950 transition hover:scale-[1.02] hover:bg-zinc-200 active:scale-[.98]">Start an investigation<ArrowRight className="size-4 transition-transform group-hover:translate-x-1" aria-hidden="true" /></a>
          </div>
          <section id="investigate" aria-labelledby="form-heading" className="glass-card animate-fade-in delay-500 relative scroll-mt-6 overflow-hidden rounded-3xl border border-white/15 p-6 shadow-2xl backdrop-blur-xl sm:p-8 lg:col-span-5 lg:mt-4">
            <div className="pointer-events-none absolute -right-16 -top-16 size-64 rounded-full bg-white/5 blur-3xl" />
            <div className="relative z-10">
              <div className="mb-7 flex items-center gap-4"><div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-white/10 ring-1 ring-white/20"><Target className="size-6" aria-hidden="true" /></div><div><h2 id="form-heading" className="text-xl font-semibold tracking-tight">Start with a claim.</h2><p className="mt-1 text-sm text-zinc-400">Upload a file or paste your text.</p></div></div>
              <InvestigationForm />
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
