import BrandLogo from "./brand-logo";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import EvidenceMap from "./evidence-map";
import SourceFlow from "./source-flow";
import InvestigationProcess from "./investigation-process";
import PricePerformance from "./price-performance";
import ResearchCounter from "./research-counter";

const steps = [
  { title: "Extract the claims.", description: "Turn a résumé, profile, or question into specific things to verify." },
  { title: "Follow the sources.", description: "Trace public records, archives, and independent accounts." },
  { title: "Show what holds up.", description: "Separate established facts, contradictions, and missing proof." },
];

export default function EvidenceSections() {
  return (
    <div className="evidence-story">
      <div className="story-container">
        <section className="process-strip" aria-label="How TraceDog works">
          {steps.map((step, index) => <div className="process-step" key={step.title}><span className="section-kicker">0{index + 1} / {index === 0 ? "Extract" : index === 1 ? "Investigate" : "Resolve"}</span><h2>{step.title}</h2><p>{step.description}</p></div>)}
        </section>
        <section id="evidence" className="story-section graph-section" aria-labelledby="evidence-heading">
          <div className="section-heading"><div><p className="section-kicker">The evidence map</p><h2 id="evidence-heading">Nothing in isolation.<br /><span>Every connection counts.</span></h2></div></div>
          <EvidenceMap />
        </section>
        <SourceFlow />
        <InvestigationProcess />
        <PricePerformance />
        <ResearchCounter />
        <section className="closing-section" aria-label="Start your investigation"><p className="section-kicker">Have something to verify?</p><div><h2>Give us a trail to follow.</h2><a className="closing-cta" href="#investigate">Deploy TraceDog<ArrowRight size={16} aria-hidden="true" /></a></div></section>
        <footer className="story-footer"><a href="#top" className="footer-brand"><BrandLogo /></a><span>© <a href="https://ahmedifty.com/">Iftekhar “Ifty” Ahmed<ArrowUpRight size={12} aria-hidden="true" /></a></span><span className="footer-note">Follow the evidence.</span></footer>
      </div>
    </div>
  );
}
