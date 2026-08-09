import Link from "next/link";

export function AppHeader() {
  return (
    <header className="topbar">
      <Link className="wordmark" href="/" aria-label="Translucid investigations home">
        <span className="wordmark-mark" aria-hidden="true">T</span>
        <span>Translucid</span>
      </Link>
      <span className="environment-badge"><span className="status-dot" /> Synthetic workspace</span>
    </header>
  );
}
