import Link from "next/link";

import { AppHeader } from "./components/app-header.tsx";
import { StatusBadge } from "./components/status-badge.tsx";
import { listInvestigations } from "../db/read-model.ts";

export const dynamic = "force-dynamic";

function relativeDate(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

export default async function InvestigationDashboard() {
  const { items } = await listInvestigations();
  return (
    <main className="app-shell">
      <AppHeader />

      <section className="page-heading" aria-labelledby="page-title">
        <div>
          <p className="eyebrow">Investigation workspace</p>
          <h1 id="page-title">Candidate investigations</h1>
          <p className="lede">
            Trace claims to captured evidence without candidate scoring or automated decisions.
          </p>
        </div>
        <Link className="button button-primary" href="/investigations/new">
          New investigation
        </Link>
      </section>
      {items.length === 0 ? <section className="empty-state" aria-labelledby="empty-title">
        <div className="empty-glyph" aria-hidden="true">⌁</div>
        <h2 id="empty-title">No investigations yet</h2>
        <p>Submit synthetic PDF and JSON or text input to start the first evidence-backed case.</p>
        <Link className="button button-secondary" href="/investigations/new">
          Create the first case
        </Link>
      </section> : <section className="case-list" aria-label="Saved investigations">{items.map((item) => {
        const row = item as Record<string, unknown>;
        return <Link className="case-row" href={`/investigations/${row.id}`} key={String(row.id)}><div className="case-row-main"><div className="case-row-title"><span className="case-id">{String(row.id).slice(0, 8)}</span><StatusBadge status={String(row.status)} /></div><p>{String(row.preview)}</p></div><div className="case-row-metrics"><span>{Number(row.claimCount)} claims</span><span>{Number(row.evidenceCount)} evidence</span><time>{relativeDate(row.createdAt)}</time><span className="row-arrow" aria-hidden="true">→</span></div></Link>;
      })}</section>}
    </main>
  );
}
