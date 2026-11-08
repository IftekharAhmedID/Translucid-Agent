import BrandLogo from "./brand-logo";
import { useState } from "react";
import { ArrowRight, BookOpen, Building2, FileText, GitBranch, History, UserRound } from "lucide-react";

const sources = [
  { title: "Public profiles", detail: "Identity and career-history leads", icon: UserRound, path: "M82 218 V238 Q82 276 120 276 H270 Q304 276 304 310 V340 H360" },
  { title: "Company & institutional pages", detail: "Original records of roles and affiliations", icon: Building2, path: "M170 124 V180 Q170 224 214 224 H294 Q332 224 332 270 V340 H360" },
  { title: "Web archives", detail: "Dated captures of historical pages", icon: History, path: "M280 70 V170 Q280 198 308 198 H332 Q360 198 360 236 V340" },
  { title: "Repositories & releases", detail: "Public technical work and contribution history", icon: GitBranch, path: "M440 70 V170 Q440 198 412 198 H388 Q360 198 360 236 V340" },
  { title: "Research publications", detail: "Authorship and institutional affiliations", icon: BookOpen, path: "M550 124 V180 Q550 224 506 224 H426 Q388 224 388 270 V340 H360" },
  { title: "Patents & filings", detail: "Relevant official records", icon: FileText, path: "M638 218 V238 Q638 276 600 276 H450 Q416 276 416 310 V340 H360" },
];

export default function SourceFlow() {
  const [selected, setSelected] = useState(0);

  return (
    <section id="sources" className="story-section source-flow-section" aria-labelledby="sources-heading">
      <div className="visual-introduction">
        <h2 id="sources-heading">Search across public sources.</h2>
        <p>Trace profiles, archived pages, technical work, and original records to the evidence behind a claim.</p>
      </div>
      <div className="source-flow-panel">
        <div className="source-flow-visual">
          <svg className="flow-diagram" viewBox="0 0 720 440" preserveAspectRatio="none" aria-hidden="true">
            {sources.map((source, index) => (
              <g key={source.title} className={`flow-route ${selected === index ? "is-selected" : ""}`}>
                <path className="flow-path" d={source.path} />
                <path className="flow-trace" d={source.path} pathLength="100" />
              </g>
            ))}
          </svg>
          <div className="flow-options" role="group" aria-label="Public source categories">
            {sources.map((source, index) => {
              const Icon = source.icon;
              return (
                <button key={source.title} type="button" className="flow-option" aria-pressed={selected === index} aria-controls="source-explanation" onClick={() => setSelected(index)}>
                  <Icon size={16} aria-hidden="true" /><span>{source.title}</span>
                </button>
              );
            })}
          </div>
          <div className="flow-hub"><BrandLogo /></div>
        </div>
        <div className="source-flow-footer">
          <p id="source-explanation" aria-live="polite" aria-atomic="true">{sources[selected].detail}</p>
          <span className="source-transfer">Search<ArrowRight size={11} aria-hidden="true" />Capture<ArrowRight size={11} aria-hidden="true" />Compare</span>
        </div>
      </div>
    </section>
  );
}
