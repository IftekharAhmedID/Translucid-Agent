"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { DataClassification } from "../../../core/contracts.ts";

export function IntakeForm({ dataClassification }: { dataClassification: DataClassification }) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(undefined); setSubmitting(true);
    const response = await fetch("/api/investigations", { method: "POST", body: new FormData(event.currentTarget) }).catch(() => undefined);
    if (!response?.ok) {
      const body = response ? await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined : undefined;
      setError(body?.error?.message ?? "The investigation could not be queued."); setSubmitting(false); return;
    }
    const result = await response.json() as { investigationId: string };
    router.push(`/investigations/${result.investigationId}`);
  }

  return (
    <form className="intake-form" onSubmit={submit}>
      <div className="field-group">
        <label htmlFor="submission">Candidate submission <span>required</span></label>
        <p className="field-help">Paste arbitrary text or JSON exactly as received. It is retained unchanged and normalized separately.</p>
        <textarea id="submission" name="submission" rows={13} maxLength={1_048_576} required placeholder={'Name: Candidate\nClaim: Principal Engineer at Acme, 2021–2025'} />
      </div>
      <div className="form-grid">
        <div className="field-group">
          <label htmlFor="pdf">Original PDF <span>optional · 20 MiB · 50 pages</span></label>
          <input id="pdf" name="pdf" type="file" accept="application/pdf,.pdf" />
        </div>
        <div className="field-group">
          <label htmlFor="runtime">Runtime</label>
          <select id="runtime" name="runtime" defaultValue="LOCAL"><option value="LOCAL">Local Docker</option><option value="E2B">E2B sandbox</option></select>
        </div>
      </div>
      <input type="hidden" name="dataClassification" value={dataClassification} />
      <div className="boundary-note"><strong>Investigation boundary</strong><p>{dataClassification === "SYNTHETIC" ? "Only synthetic data is accepted." : "Only authorized public professional material is accepted."} The result describes evidence and uncertainty; it never scores, ranks, or recommends a candidate.</p></div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="form-actions"><button className="button button-primary" type="submit" disabled={submitting}>{submitting ? "Queuing…" : "Queue investigation"}</button></div>
    </form>
  );
}
