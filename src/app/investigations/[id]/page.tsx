import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AppHeader } from "../../components/app-header.tsx";
import { getInvestigationDetail } from "../../../db/read-model.ts";
import { InvestigationDetail } from "./investigation-detail.tsx";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> { return { title: `Case ${(await params).id.slice(0, 8)}` }; }

export default async function InvestigationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getInvestigationDetail(id);
  if (!detail) notFound();
  return <main className="app-shell detail-shell"><AppHeader /><nav className="breadcrumb" aria-label="Breadcrumb"><Link href="/">Investigations</Link><span>/</span><span>{id.slice(0, 8)}</span></nav><InvestigationDetail initial={JSON.parse(JSON.stringify(detail))} /></main>;
}
