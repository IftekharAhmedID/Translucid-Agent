import { useState } from "react";
import { ArrowUpRight, Check, GitBranch, Minus, Plus, RotateCcw, ScanLine, X } from "lucide-react";
import { investigationCases, visibleEvidence, type EvidenceFilter, type Relation } from "@/lib/evidence";

const relationLabels: Record<Relation, string> = { supports: "Supports", contradicts: "Contradicts", unresolved: "Unresolved" };
const positions = [{ x: 195, y: 105 }, { x: 485, y: 85 }, { x: 605, y: 240 }, { x: 510, y: 405 }, { x: 180, y: 405 }, { x: 90, y: 245 }];

export default function EvidenceMap() {
  const [caseId, setCaseId] = useState("employment");
  const [filter, setFilter] = useState<EvidenceFilter>("all");
  const [selectedId, setSelectedId] = useState("team");
  const [zoom, setZoom] = useState(1);
  const investigation = investigationCases.find(item => item.id === caseId)!;
  const visible = visibleEvidence(investigation, filter);
  const selected = visible.find(source => source.id === selectedId) ?? visible[0];
  const selectCase = (id: string) => { setCaseId(id); setFilter("all"); setSelectedId(""); setZoom(1); };

  return (
    <div className="evidence-workspace">
      <div className="map-toolbar">
        <div className="case-switcher" role="group" aria-label="Example investigation">
          {investigationCases.map(item => <button key={item.id} type="button" aria-pressed={caseId === item.id} onClick={() => selectCase(item.id)}>{item.label}</button>)}
        </div>
        <span className="example-label"><span />Illustrative case</span>
      </div>
      <div className="map-layout">
        <div className="network-canvas">
          <div className="map-caption"><GitBranch size={13} aria-hidden="true" /><span>CLAIM / SOURCE NETWORK</span></div>
          <div className="map-controls" role="group" aria-label="Graph view">
            <button type="button" aria-label="Zoom in" disabled={zoom >= 1.4} onClick={() => setZoom(value => Math.min(1.4, value + .2))}><Plus size={14} /></button>
            <button type="button" aria-label="Zoom out" disabled={zoom <= .8} onClick={() => setZoom(value => Math.max(.8, value - .2))}><Minus size={14} /></button>
            <button type="button" aria-label="Reset graph view" onClick={() => setZoom(1)}><RotateCcw size={13} /></button>
          </div>
          <svg className="evidence-network" viewBox="0 0 700 500" aria-label={`${investigation.label} evidence graph`}>
            <defs>
              <radialGradient id="claim-glow"><stop offset="0%" stopColor="#ffcd75" stopOpacity=".12" /><stop offset="100%" stopColor="#ffcd75" stopOpacity="0" /></radialGradient>
            </defs>
            <circle cx="345" cy="255" r="210" fill="url(#claim-glow)" />
            <g className="network-content" transform={`translate(345 255) scale(${zoom}) translate(-345 -255)`}>
              <circle className="orbit" cx="345" cy="255" r="117" />
              <circle className="orbit orbit-outer" cx="345" cy="255" r="210" />
              {investigation.evidence.map((source, index) => {
                const position = positions[index];
                const shown = visible.includes(source);
                const active = selected.id === source.id;
                const middleX = (position.x + 345) / 2;
                const curve = `M 345 255 Q ${middleX} ${255 + (position.y - 255) * .1} ${position.x} ${position.y}`;
                return <g key={source.id} className={`source-network source-${source.relation} ${active ? "is-active" : ""} ${shown ? "" : "is-filtered"}`}>
                  <path className="evidence-edge" d={curve} />
                  {active && <path className="evidence-edge edge-trace" d={curve} />}
                  {[0, 1, 2].map(branch => {
                    const angle = (index * 60 + branch * 34 - 35) * Math.PI / 180;
                    const x = position.x + Math.cos(angle) * (45 + branch * 7);
                    const y = position.y + Math.sin(angle) * (43 + branch * 7);
                    return <g key={branch} aria-hidden="true"><line className="satellite-edge" x1={position.x} y1={position.y} x2={x} y2={y} /><circle className="satellite" cx={x} cy={y} r={branch === 1 ? 3.5 : 2.5} /></g>;
                  })}
                  <g className="source-node" role="button" tabIndex={shown ? 0 : -1} aria-hidden={!shown} aria-label={`${source.title}: ${relationLabels[source.relation]}`} aria-pressed={active} onClick={() => setSelectedId(source.id)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedId(source.id); } }}>
                    <title>{source.title} · {source.type} · {source.strength}</title>
                    <circle className="node-hit-area" cx={position.x} cy={position.y} r="27" />
                    <circle className="node-halo" cx={position.x} cy={position.y} r="17" />
                    <circle className="node-core" cx={position.x} cy={position.y} r="7" />
                    <text className="node-label" x={position.x} y={position.y + 35} textAnchor="middle">{source.title}</text>
                    <text className="node-reference" x={position.x} y={position.y + 51} textAnchor="middle">S{String(index + 1).padStart(2, "0")}</text>
                  </g>
                </g>;
              })}
              <g className="central-claim" aria-hidden="true">
                <circle className="claim-pulse" cx="345" cy="255" r="38" />
                <circle className="claim-ring" cx="345" cy="255" r="27" />
                <circle className="claim-core" cx="345" cy="255" r="12" />
                <text x="345" y="204" textAnchor="middle" className="claim-tag">THE CLAIM</text>
                <text x="345" y="314" textAnchor="middle" className="claim-entity">{investigation.subject}</text>
              </g>
            </g>
          </svg>
          <div className="mobile-source-list" role="group" aria-label="Select an evidence source">{visible.map(source => <button type="button" key={source.id} aria-pressed={selected.id === source.id} onClick={() => setSelectedId(source.id)}><span className={`legend-dot dot-${source.relation}`} />{source.title}</button>)}</div>
          <div className="graph-bottom"><ScanLine size={13} aria-hidden="true" /><span>Select a source to follow its trail</span><span className="node-count">{visible.length} {visible.length === 1 ? "source" : "sources"}</span></div>
        </div>
        <aside className="evidence-inspector" aria-label="Selected evidence">
          <p className="section-kicker">Investigating</p>
          <h3 className="inspector-claim">“{investigation.claim}”</h3>
          <div className="selected-source" aria-live="polite" aria-atomic="true">
            <span className={`relation-tag relation-${selected.relation}`}>{selected.relation === "supports" ? <Check size={12} /> : selected.relation === "contradicts" ? <X size={12} /> : <Minus size={12} />}{relationLabels[selected.relation]}</span>
            <h4>{selected.title}</h4>
            <dl className="source-meta"><div><dt>Source</dt><dd>{selected.type}</dd></div><div><dt>Record date</dt><dd>{selected.date}</dd></div><div><dt>Weight</dt><dd>{selected.strength}</dd></div></dl>
            <blockquote>{selected.quote}</blockquote>
            <p className="source-explanation">{selected.detail}</p>
          </div>
          <a className="quiet-link inspector-link" href="#method">How evidence is weighed<ArrowUpRight size={14} aria-hidden="true" /></a>
        </aside>
      </div>
      <div className="graph-filters" role="group" aria-label="Filter evidence by relationship">
        {(["all", "supports", "contradicts", "unresolved"] as const).map(value => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value !== "all" && <span className={`legend-dot dot-${value}`} />}{value === "all" ? "All evidence" : relationLabels[value]}</button>)}
        <span className="graph-footnote">Fictional records. Real investigation logic.</span>
      </div>
    </div>
  );
}
