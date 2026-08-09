import type { Metadata } from "next";
import Link from "next/link";

import { AppHeader } from "../../components/app-header.tsx";
import { IntakeForm } from "./intake-form.tsx";

export const metadata: Metadata = { title: "New investigation" };

export default function NewInvestigationPage() {
  return <main className="app-shell"><AppHeader /><nav className="breadcrumb" aria-label="Breadcrumb"><Link href="/">Investigations</Link><span>/</span><span>New</span></nav><section className="page-heading compact"><div><p className="eyebrow">Synthetic intake</p><h1>Open an investigation</h1><p className="lede">Start with the source material. The runner will decompose claims, resolve identities, and preserve every evidence trail.</p></div></section><IntakeForm /></main>;
}
