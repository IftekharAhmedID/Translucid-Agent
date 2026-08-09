import Link from "next/link";

export default function InvestigationDashboard() {
  return (
    <main className="app-shell">
      <header className="topbar">
        <Link className="wordmark" href="/" aria-label="Translucid investigations home">
          <span className="wordmark-mark" aria-hidden="true">T</span>
          <span>Translucid</span>
        </Link>
        <span className="environment-badge">Synthetic workspace</span>
      </header>

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

      <section className="empty-state" aria-labelledby="empty-title">
        <div className="empty-glyph" aria-hidden="true">⌁</div>
        <h2 id="empty-title">No investigations yet</h2>
        <p>Submit synthetic PDF and JSON or text input to start the first evidence-backed case.</p>
        <Link className="button button-secondary" href="/investigations/new">
          Create the first case
        </Link>
      </section>
    </main>
  );
}
