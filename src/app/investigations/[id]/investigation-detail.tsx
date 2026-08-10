"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { StatusBadge } from "../../components/status-badge.tsx";
import { PdfViewer } from "./pdf-viewer.tsx";

type Row = Record<string, unknown>;
type Detail = Row & {
  id: string; status: string; events: Row[]; claims: Row[]; findings: Row[]; entities: Row[];
  identifiers: Row[]; links: Row[]; observations: Row[]; researchQuestions: Row[]; evidence: Row[]; artifacts: Row[];
};

const tabs = ["Overview", "Findings", "Timeline", "Entities", "Research frontier", "Evidence", "Original input", "Agent trace"] as const;
const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"]);

function display(value: unknown): string { return typeof value === "string" ? value : value === null || value === undefined ? "—" : JSON.stringify(value); }
function formatDate(value: unknown): string { if (!value) return "Not recorded"; return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(String(value))); }
function shortId(value: unknown): string { return String(value).slice(0, 8); }
function caseTitle(detail: Detail): string {
  if (detail.submissionKind === "JSON") {
    try {
      const value = JSON.parse(String(detail.submissionNormalized)) as Record<string, unknown>;
      for (const key of ["name", "candidateName", "candidate_name", "fullName"]) if (typeof value[key] === "string" && value[key]) return String(value[key]).slice(0, 90);
      const candidate = value.candidate;
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        for (const key of ["name", "candidateName", "candidate_name", "fullName"]) {
          const nested = (candidate as Record<string, unknown>)[key];
          if (typeof nested === "string" && nested) return nested.slice(0, 90);
        }
      }
    } catch { /* normalized intake remains visible in its own tab */ }
  }
  return String(detail.submissionNormalized).split("\n").find((line) => line.trim().length > 2)?.slice(0, 90) || "Candidate investigation";
}

export function InvestigationDetail({ initial }: { initial: Detail }) {
  const router = useRouter();
  const [detail, setDetail] = useState(initial);
  const [tab, setTab] = useState<(typeof tabs)[number]>("Overview");
  const [cancelPending, setCancelPending] = useState(false);
  const entityNames = useMemo(() => new Map(detail.entities.map((entity) => [String(entity.id), String(entity.canonicalName)])), [detail.entities]);
  const visibleEvents = useMemo(() => [...new Map(detail.events.map((event) => [String(event.id), event])).values()], [detail.events]);

  useEffect(() => {
    if (terminal.has(detail.status)) return;
    const events = new EventSource(`/api/investigations/${detail.id}/events`);
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(async () => {
        refreshTimer = undefined;
        const response = await fetch(`/api/investigations/${detail.id}`, { cache: "no-store" });
        if (response.ok) setDetail(await response.json() as Detail);
      }, 250);
    };
    events.addEventListener("agent_event", (message) => {
      const event = JSON.parse((message as MessageEvent).data) as Row;
      setDetail((current) => current.events.some((item) => item.id === event.id) ? current : { ...current, events: [...current.events, event] });
      refresh();
    });
    events.addEventListener("heartbeat", (message) => {
      const heartbeat = JSON.parse((message as MessageEvent).data) as { status: string };
      setDetail((current) => ({ ...current, status: heartbeat.status }));
      if (terminal.has(heartbeat.status)) { events.close(); refresh(); router.refresh(); }
    });
    return () => { events.close(); if (refreshTimer) clearTimeout(refreshTimer); };
  }, [detail.id, detail.status, router]);

  async function cancel() {
    setCancelPending(true);
    const response = await fetch(`/api/investigations/${detail.id}/cancel`, { method: "POST" });
    if (response.ok) setDetail((current) => ({ ...current, status: "CANCELLED" }));
    setCancelPending(false);
  }

  const summary = detail.finalSummary as Row | undefined;
  const identity = summary?.professionalIdentity as Row | undefined;
  const runTime = detail.startedAt ? Math.max(0, ((detail.finishedAt ? new Date(String(detail.finishedAt)) : new Date()).getTime() - new Date(String(detail.startedAt)).getTime()) / 60_000) : 0;
  const originalPdf = detail.artifacts.find((artifact) => artifact.kind === "INPUT_PDF");

  return <>
    <section className="case-hero"><div><div className="case-kicker"><StatusBadge status={detail.status} /><span>Case {shortId(detail.id)}</span><span>{display(detail.runtimeKind)}</span></div><h1>{caseTitle(detail)}</h1><p className="lede">Evidence-focused review · {display(detail.dataClassification)}</p></div><div className="hero-actions"><a className="button button-secondary" href={`/api/investigations/${detail.id}/report.pdf`}>Download report</a>{!terminal.has(detail.status) ? <button className="button button-danger" type="button" onClick={cancel} disabled={cancelPending}>{cancelPending ? "Cancelling…" : "Cancel run"}</button> : null}</div></section>
    <section className="metric-strip" aria-label="Investigation metrics"><div><span>Claims</span><strong>{detail.claims.length}</strong></div><div><span>Evidence</span><strong>{detail.evidence.length}</strong></div><div><span>Open questions</span><strong>{detail.researchQuestions.filter((question) => ["OPEN", "IN_PROGRESS"].includes(String(question.status))).length}</strong></div><div><span>Elapsed</span><strong>{runTime.toFixed(1)}m</strong></div><div><span>Cleanup</span><strong>{display(detail.cleanupStatus)}</strong></div></section>
    <div className="tabs" role="tablist" aria-label="Investigation sections">{tabs.map((name) => <button key={name} role="tab" aria-selected={tab === name} className={tab === name ? "active" : ""} onClick={() => setTab(name)}>{name}</button>)}</div>
    <section className="tab-panel" role="tabpanel">
      {tab === "Overview" ? <div className="overview-grid"><article className="panel panel-wide"><p className="panel-label">Professional identity</p><h2>{identity ? display(identity.status) : "Pending adjudication"}</h2><p>{identity ? display(identity.summary) : "The fresh adjudicator has not produced a candidate-level summary yet."}</p>{identity && Array.isArray(identity.evidenceIds) ? <IdLinks ids={identity.evidenceIds as string[]} /> : null}</article><article className="panel"><p className="panel-label">Timeline summary</p><p>{summary ? display(summary.professionalTimelineSummary) : "Observations will appear as sources are captured."}</p></article><article className="panel"><p className="panel-label">Investigation boundary</p><p>No score, ranking, fraud probability, or hiring recommendation is produced. Unresolved evidence remains unresolved.</p></article>{summary && Array.isArray(summary.investigationLimitations) ? <article className="panel panel-wide"><p className="panel-label">Limitations</p><ul>{(summary.investigationLimitations as string[]).map((item) => <li key={item}>{item}</li>)}</ul></article> : null}</div> : null}
      {tab === "Findings" ? <div className="stack">{detail.claims.map((claim) => { const finding = detail.findings.find((item) => item.claimId === claim.id); return <article className="finding-card" key={String(claim.id)}><div className="finding-head"><span className={`materiality materiality-${String(claim.materiality).toLowerCase()}`}>{display(claim.materiality)}</span>{finding ? <StatusBadge status={String(finding.verdict)} /> : <span className="muted">Pending</span>}</div><h2>{display(claim.normalizedClaim)}</h2>{finding ? <><p>{display(finding.explanation)}</p><EvidencePills supports={finding.supportingEvidenceIds as string[]} contradicts={finding.contradictingEvidenceIds as string[]} /></> : <p className="muted">No adjudicated finding yet.</p>}</article>; })}{detail.claims.length === 0 ? <Empty label="No claims have been decomposed yet." /> : null}</div> : null}
      {tab === "Timeline" ? <div className="timeline">{detail.observations.map((observation) => <article className="timeline-item" key={String(observation.id)}><div className="timeline-marker" /><div><time>{formatDate(observation.validFrom)} → {formatDate(observation.validTo)}</time><h2>{entityNames.get(String(observation.entityId)) ?? shortId(observation.entityId)}</h2><p><strong>{display(observation.field)}</strong> · {display(observation.value)}</p><a href={`#evidence-${observation.artifactId}`}>Artifact {shortId(observation.artifactId)}</a></div></article>)}{detail.observations.length === 0 ? <Empty label="No data-backed observations yet." /> : null}</div> : null}
      {tab === "Entities" ? <div className="entity-layout"><div className="entity-grid">{detail.entities.map((entity) => <article className="entity-card" key={String(entity.id)}><span>{display(entity.type)}</span><h2>{display(entity.canonicalName)}</h2><code>{shortId(entity.id)}</code>{detail.identifiers.filter((identifier) => identifier.entityId === entity.id).map((identifier) => <p key={String(identifier.id)}>{display(identifier.type)} · {display(identifier.value)} · {Math.round(Number(identifier.confidence) * 100)}%</p>)}</article>)}</div><div className="link-list"><h2>Evidence-backed links</h2>{detail.links.map((link) => <div className="link-row" key={String(link.id)}><strong>{entityNames.get(String(link.fromEntityId))}</strong><span>→ {display(link.relationship)} →</span><strong>{entityNames.get(String(link.toEntityId))}</strong><small>{Math.round(Number(link.confidence) * 100)}% · {(link.evidenceIds as string[]).length} anchors</small></div>)}{detail.links.length === 0 ? <p className="muted">No entities have met the two-anchor linking threshold.</p> : null}</div></div> : null}
      {tab === "Research frontier" ? <div className="frontier">{detail.researchQuestions.map((question) => <article className="frontier-row" key={String(question.id)}><span className={`frontier-icon frontier-${String(question.status).toLowerCase()}`}>{question.status === "RESOLVED" ? "✓" : question.status === "IN_PROGRESS" ? "●" : "○"}</span><div><div className="frontier-title"><h2>{display(question.question)}</h2><span>{display(question.priority)}</span></div><p>{question.selectedRoute ? `Selected route: ${display(question.selectedRoute)}` : `Routes: ${(question.possibleRoutes as string[]).join(" · ")}`}</p>{question.resolutionSummary ? <p className="resolution">{display(question.resolutionSummary)}</p> : null}</div></article>)}{detail.researchQuestions.length === 0 ? <Empty label="The lead has not opened the research frontier yet." /> : null}</div> : null}
      {tab === "Evidence" ? <div className="evidence-layout">{detail.evidence.map((item) => { const artifact = detail.artifacts.find((candidate) => candidate.id === item.artifactId); return <article className="evidence-card" id={`evidence-${item.id}`} key={String(item.id)}><div className="evidence-meta"><StatusBadge status={String(item.relation)} /><span>{display(item.sourceTier)}</span><code>{shortId(item.id)}</code></div><blockquote>{display(item.exactQuote)}</blockquote><div className="artifact-meta"><span>{display(artifact?.provider) || "submission"}</span><span>{formatDate(artifact?.retrievedAt)}</span><code>sha256:{String(artifact?.sha256).slice(0, 12)}…</code><a href={`/api/investigations/${detail.id}/artifacts/${item.artifactId}`} target="_blank" rel="noreferrer">Open artifact ↗</a></div></article>; })}{detail.evidence.length === 0 ? <Empty label="No citable evidence has been captured yet." /> : null}</div> : null}
      {tab === "Original input" ? <div className="input-grid"><article className="panel"><p className="panel-label">Unchanged {display(detail.submissionKind)}</p><pre>{display(detail.submissionRaw)}</pre><code>SHA-256 {display(detail.submissionSha256)}</code></article>{originalPdf ? <article className="panel pdf-panel"><p className="panel-label">Unchanged original PDF</p><PdfViewer url={`/api/investigations/${detail.id}/artifacts/${originalPdf.id}`} /></article> : <article className="panel"><p>No original PDF was submitted.</p></article>}</div> : null}
      {tab === "Agent trace" ? <div className="trace-layout"><aside className="trace-summary"><p className="panel-label">Current operation</p><h2>{visibleEvents.at(-1) ? display(visibleEvents.at(-1)?.status) : display(detail.status)}</h2><p>{visibleEvents.at(-1)?.publicRationale ? display(visibleEvents.at(-1)?.publicRationale) : "Operational events appear here without private model reasoning."}</p><dl><dt>Model budget</dt><dd>${Number((detail.budgetCounters as Row | undefined)?.modelUsd ?? 0).toFixed(3)} / $5</dd><dt>Provider budget</dt><dd>${Number((detail.budgetCounters as Row | undefined)?.providerUsd ?? 0).toFixed(3)} / $10</dd><dt>Manifest</dt><dd><code>{String(detail.runtimeManifestHash ?? "pending").slice(0, 12)}</code></dd></dl></aside><div className="trace-stream">{visibleEvents.map((event) => <article className="trace-event" key={String(event.id)}><time>{formatDate(event.createdAt)}</time><span className="trace-agent">{display(event.agent)}</span><div><strong>{display(event.eventType)}</strong>{event.tool ? <code>{display(event.tool)}</code> : null}<p>{event.publicRationale ? display(event.publicRationale) : `${display(event.status)}${event.source ? ` · ${display(event.source)}` : ""}`}</p></div></article>)}{visibleEvents.length === 0 ? <Empty label="Waiting for the runner to claim this case." /> : null}</div></div> : null}
    </section>
  </>;
}

function Empty({ label }: { label: string }) { return <div className="inline-empty"><span>⌁</span><p>{label}</p></div>; }
function IdLinks({ ids }: { ids: string[] }) { return <div className="id-pills">{ids.map((id) => <code key={id}>{shortId(id)}</code>)}</div>; }
function EvidencePills({ supports = [], contradicts = [] }: { supports?: string[]; contradicts?: string[] }) { return <div className="evidence-pills">{supports.map((id) => <span className="supports" key={id}>+ {shortId(id)}</span>)}{contradicts.map((id) => <span className="contradicts" key={id}>− {shortId(id)}</span>)}</div>; }
