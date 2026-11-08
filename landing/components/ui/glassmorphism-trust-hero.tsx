import BrandLogo from "./brand-logo";
import { ArrowDown, ArrowRight, Target } from "lucide-react";
import InvestigationForm from "./investigation-form";

export default function HeroSection() {
  return (
    <section id="top" aria-label="TraceDog" className="tracedog-hero relative isolate min-h-dvh overflow-hidden bg-zinc-950 font-sans text-white">
      <div className="hero-background pointer-events-none absolute inset-0 -z-10" />
      <header className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-8 lg:px-8">
        <a href="/" className="inline-flex items-center gap-2.5 text-xl font-semibold tracking-tight"><BrandLogo /></a>
      </header>
      <div className="mx-auto w-full max-w-7xl px-6 pb-12 pt-12 sm:pt-20 lg:px-8 lg:pb-24 lg:pt-28">
        <div className="grid grid-cols-1 items-start gap-12 lg:grid-cols-12 lg:gap-12">
          <div className="space-y-8 pt-4 lg:col-span-7">
            <h1 className="heading-mask animate-fade-in delay-200 text-4xl font-medium leading-[.95] tracking-tighter sm:text-5xl lg:text-6xl xl:text-7xl">Investigation built<br /><span className="bg-gradient-to-br from-white via-white to-[#ffcd75] bg-clip-text text-transparent">on evidence.</span></h1>
            <p className="animate-fade-in delay-300 max-w-xl text-base leading-relaxed text-zinc-300 sm:text-lg">TraceDog follows the evidence across 100+ public records, web archives, and social sources to find what holds up, what doesn't, and what's missing.</p>
            <a href="https://calendly.com/iftyy/hi" className="animate-fade-in delay-400 group inline-flex items-center justify-center gap-2 rounded-full bg-white px-7 py-4 text-sm font-semibold text-zinc-950 transition hover:scale-[1.02] hover:bg-zinc-200 active:scale-[.98]">Get a demo<ArrowRight className="size-4 transition-transform group-hover:translate-x-1" aria-hidden="true" /></a>
          </div>
          <section id="investigate" aria-labelledby="form-heading" className="glass-card animate-fade-in delay-500 relative scroll-mt-6 overflow-hidden rounded-3xl border border-white/15 p-6 shadow-2xl backdrop-blur-xl sm:p-8 lg:col-span-5 lg:mt-4">
            <div className="pointer-events-none absolute -right-16 -top-16 size-64 rounded-full bg-white/5 blur-3xl" />
            <div className="relative z-10">
              <div className="mb-7 flex items-center gap-4"><div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-white/10 ring-1 ring-white/20"><Target className="size-6" aria-hidden="true" /></div><h2 id="form-heading" className="text-xl font-semibold tracking-tight">Deploy TraceDog</h2></div>
              <InvestigationForm />
            </div>
          </section>
        </div>
      </div>
      <div className="hero-scroll mx-auto max-w-7xl px-6 pb-8 lg:px-8"><a href="#evidence">Follow the evidence<ArrowDown size={13} aria-hidden="true" /></a><span>Claims. Sources. Connections.</span></div>
    </section>
  );
}
