import { ArrowRight, ArrowUpRight, Check, ChevronDown, Dog } from "lucide-react";
import { sampleReport } from "@/lib/evidence";
import EvidenceMap from "./evidence-map";

const steps = [
  { title: "Extract the claims.", description: "Turn a résumé, profile, or question into specific things to verify." },
  { title: "Follow the sources.", description: "Trace public records, archives, and independent accounts." },
  { title: "Show what holds up.", description: "Separate established facts, contradictions, and missing proof." },
];
const method = [
  { title: "Go to the original.", note: "Primary sources first", detail: "An institutional record carries different weight from a self-written biography. Sources are assessed for authority, relevance, and date." },
  { title: "Look for another account.", note: "Independent corroboration", detail: "Repeated versions of the same story are not independent confirmation. TraceDog looks for a separate source that establishes the same specific fact." },
  { title: "Keep the disagreements.", note: "Contradictions stay visible", detail: "Conflicting dates and accounts stay in the findings. Evidence for one part of a claim does not establish the rest." },
  { title: "Leave room for unknowns.", note: "Uncertainty, stated clearly", detail: "A missing record is not proof that a claim is false. The report distinguishes what is established from what still needs evidence." },
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
        <section id="results" className="story-section results-section" aria-labelledby="results-heading">
          <div className="section-heading"><div><p className="section-kicker">Inside a completed investigation</p><h2 id="results-heading">Evidence you can count.</h2></div></div>
          <div className="sample-metrics">
            <div><span className="metric-number">{sampleReport.claims}</span><h3>Claims assessed</h3><p>Each with its own finding.</p></div>
            <div><span className="metric-number">{sampleReport.sources}</span><h3>Distinct sources cited</h3><p>A trail beyond the first result.</p></div>
            <div><span className="metric-number">{sampleReport.linkedFindings}<span className="metric-denominator"> / {sampleReport.claims}</span></span><h3>Source-linked findings</h3><p>Evidence attached to the conclusion.</p></div>
          </div>
          <div className="sample-breakdown">
            <div className="sample-context"><p className="section-kicker">The full picture</p><h3>A finding for every claim.<br /><span>Including the uncertain ones.</span></h3><p>One completed résumé investigation.<br />Five outcomes. No forced yes or no.</p><span className="sample-seal"><Check size={13} aria-hidden="true" />Report committed & delivered</span></div>
            <div className="outcome-table" role="table" aria-label="Sample investigation outcomes"><div className="outcome-table-head" role="row"><span role="columnheader">Finding</span><span role="columnheader">Claims / 24</span></div>{sampleReport.outcomes.map(outcome => <div className={`outcome-row outcome-${outcome.tone}`} role="row" key={outcome.label}><span role="cell">{outcome.label}</span><span className="outcome-bar-cell" role="cell"><span className="outcome-track" aria-hidden="true"><span style={{ width: `${outcome.count / sampleReport.claims * 100}%` }} /></span><span>{outcome.count.toString().padStart(2, "0")}</span></span></div>)}</div>
          </div>
        </section>
        <section id="method" className="story-section method-section" aria-labelledby="method-heading">
          <div className="method-introduction"><p className="section-kicker">The method</p><h2 id="method-heading">The answer matters.<br /><span>So does the trail.</span></h2><p>Source by source. Claim by claim.<br />With the uncertainty left in.</p></div>
          <div className="method-list">{method.map((item, index) => <details key={item.title}><summary><span className="method-index">0{index + 1}</span><span><span className="method-title">{item.title}</span><span className="method-note">{item.note}</span></span><ChevronDown size={15} aria-hidden="true" /></summary><p>{item.detail}</p></details>)}</div>
        </section>
        <section className="closing-section" aria-label="Start your investigation"><p className="section-kicker">Have something to verify?</p><div><h2>Give us a trail to follow.</h2><a className="closing-cta" href="#investigate">Deploy TraceDog<ArrowRight size={16} aria-hidden="true" /></a></div></section>
        <footer className="story-footer"><a href="#top" className="footer-brand"><Dog size={20} aria-hidden="true" />TraceDog</a><span>Built by <a href="https://ahmedifty.com/">Iftekhar “Ifty” Ahmed<ArrowUpRight size={12} aria-hidden="true" /></a></span><span className="footer-note">Follow the evidence.</span></footer>
      </div>
    </div>
  );
}
