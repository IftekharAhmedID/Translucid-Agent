import { useState } from "react";
import { ArrowRight, Check, FileText, GitCompareArrows, History, Link2, Minus, ScanLine, TriangleAlert, UserRound } from "lucide-react";
import { investigationCases } from "@/lib/evidence";

const example = investigationCases.find(item => item.id === "employment")!;
const team = example.evidence.find(source => source.id === "team")!;
const release = example.evidence.find(source => source.id === "release")!;
const profile = example.evidence.find(source => source.id === "profile")!;
const features = [
  { title: "Resolve the identity.", detail: "Match employer, career history, and verified links before attributing a record.", icon: ScanLine },
  { title: "Recover the history.", detail: "Compare dated records and archived pages against the claimed timeline.", icon: History },
  { title: "Cross-check the evidence.", detail: "Separate original sources from repeated biographies. Keep conflicting accounts visible.", icon: GitCompareArrows },
  { title: "Explain the finding.", detail: "Show the conclusion, cited evidence, and the specific gap that remains.", icon: FileText },
];

function IdentityPreview() {
  return (
    <div className="identity-preview">
      <div className="identity-person"><span className="person-mark"><UserRound size={22} aria-hidden="true" /></span><div><h3>Nora Chen</h3><p>Engineering · Aster Labs</p></div></div>
      <div className="identity-records">
        <div className="preview-record"><span className="preview-source-type">Company archive</span><h4>{team.title}</h4><p className="preview-record-date">{team.date}</p><blockquote>“{team.quote}”</blockquote></div>
        <div className="preview-record"><span className="preview-source-type">Self-reported profile</span><h4>{profile.title}</h4><p className="preview-record-date">{profile.date}</p><blockquote>“{profile.quote}”</blockquote></div>
      </div>
      <div className="identity-anchors">
        <div><Check size={15} aria-hidden="true" /><span><strong>Employer match</strong>Aster Labs in both records</span></div>
        <div><Link2 size={15} aria-hidden="true" /><span><strong>Verified link</strong>Company team page → Nora’s profile</span></div>
      </div>
    </div>
  );
}

function HistoryPreview() {
  return (
    <div className="history-preview">
      <div className="claimed-timeline"><span>Claimed tenure</span><div><span>Jan 2021</span><span className="claimed-timeline-line" aria-hidden="true" /><span>Sep 2023</span></div></div>
      <ol className="history-records">
        <li><div className="history-date"><strong>{team.date}</strong><span>Archive capture date</span></div><div><span className="preview-reference">S01</span><h3>{team.title}</h3><p>“{team.quote}”</p></div></li>
        <li><div className="history-date"><strong>{release.date}</strong><span>Original record date</span></div><div><span className="preview-reference">S02</span><h3>{release.title}</h3><p>“{release.quote}”</p></div></li>
        <li><div className="history-date"><strong>{profile.date}</strong><span>Original record date</span></div><div><span className="preview-reference">S04</span><h3>{profile.title}</h3><p>“{profile.quote}”</p></div></li>
      </ol>
    </div>
  );
}

function CrossCheckPreview() {
  return (
    <div className="crosscheck-preview">
      <div className="comparison-excerpts">
        <div className="preview-record"><span className="preview-source-type">Submitted claim</span><h3>Submitted résumé</h3><blockquote>“Led engineering at Aster Labs, <mark>Jan 2021</mark>–Sep 2023.”</blockquote></div>
        <div className="preview-record"><span className="preview-source-type">Self-reported · {profile.date}</span><h3>{profile.title}</h3><blockquote>“Joined Aster Labs in <mark>July 2021</mark>.”</blockquote></div>
      </div>
      <div className="date-conflict"><TriangleAlert size={15} aria-hidden="true" /><span>Conflicting start dates</span></div>
      <div className="original-evidence"><span className="preview-source-type">Original source · S01</span><h3>{team.title} <span>· {team.date}</span></h3><blockquote>“{team.quote}”</blockquote><p>Supports the role at that point in time.</p></div>
    </div>
  );
}

function FindingPreview() {
  return (
    <div className="finding-preview">
      <span className="finding-status"><Minus size={13} aria-hidden="true" />Partially established</span>
      <h3>Leadership role supported. Exact tenure unresolved.</h3>
      <div className="finding-sources">
        {[team, release, profile].map((source, index) => <div key={source.id}><span className="preview-reference">{["S01", "S02", "S04"][index]}</span><div><h4>{source.title}<span>{source.date}</span></h4><blockquote>“{source.quote}”</blockquote></div></div>)}
      </div>
      <div className="finding-gap"><Minus size={15} aria-hidden="true" /><div><h4>Remaining gap</h4><p>January vs July 2021 start; September 2023 end not established.</p></div></div>
    </div>
  );
}

const previews = [IdentityPreview, HistoryPreview, CrossCheckPreview, FindingPreview];

export default function InvestigationProcess() {
  const [selected, setSelected] = useState(0);
  const Preview = previews[selected];

  return (
    <section id="process" className="story-section investigation-process" aria-labelledby="process-heading">
      <div className="visual-introduction"><h2 id="process-heading">See how a claim is checked.</h2></div>
      <div className="process-showcase">
        <div className="process-features" role="group" aria-label="Investigation process">
          {features.map((feature, index) => {
            const Icon = feature.icon;
            return <button key={feature.title} type="button" aria-pressed={selected === index} aria-controls="process-preview" onClick={() => setSelected(index)}><span className="process-feature-title"><Icon size={17} aria-hidden="true" /><span>{feature.title}</span><ArrowRight size={15} aria-hidden="true" /></span>{selected === index && <span className="process-feature-detail">{feature.detail}</span>}</button>;
          })}
        </div>
        <div id="process-preview" className="process-preview" role="region" aria-label={features[selected].title}>
          <div className="preview-claim"><span>Nora Chen · Aster Labs</span><p>“{example.claim}”</p></div>
          <div className="process-preview-content" aria-live="polite" aria-atomic="true"><Preview /></div>
        </div>
      </div>
    </section>
  );
}
