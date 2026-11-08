import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";

// Display animation supplied by the team, not a live index measurement.
const initialCount = 1_308_116_316_541;
const format = new Intl.NumberFormat("en-US");

export default function ResearchCounter() {
  const section = useRef<HTMLElement>(null);
  const value = useRef(initialCount);
  const [count, setCount] = useState(initialCount);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let timer: ReturnType<typeof setInterval> | undefined;
    let visible = !window.IntersectionObserver;
    const sync = () => {
      clearInterval(timer);
      if (!visible || paused || motion.matches || document.hidden) return;
      let previous = performance.now();
      timer = setInterval(() => {
        const now = performance.now();
        value.current += (now - previous) * 2;
        previous = now;
        setCount(Math.floor(value.current));
      }, 50);
    };
    const observer = window.IntersectionObserver ? new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    }, { threshold: 0.2 }) : undefined;

    observer?.observe(section.current!);
    motion.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      observer?.disconnect();
      clearInterval(timer);
      motion.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [paused]);

  return <section ref={section} id="research-reach" className="story-section research-counter" aria-labelledby="research-reach-heading">
    <p className="section-kicker">Across the public web</p>
    <h2 id="research-reach-heading">Documents, records and pages.<br /><span>A wider trail to follow.</span></h2>
    <p className="research-counter-number"><span className="sr-only">Animated estimate starting at {format.format(initialCount)}</span><span aria-hidden="true">{format.format(count)}</span></p>
    <div className="research-counter-caption"><p className="research-counter-label">Documents, records and pages · Animated estimate</p><button type="button" onClick={() => setPaused(!paused)} aria-label={paused ? "Resume counter animation" : "Pause counter animation"} title={paused ? "Resume counter animation" : "Pause counter animation"}>{paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}</button></div>
  </section>;
}
