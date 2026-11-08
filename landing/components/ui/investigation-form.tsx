import { useRef, useState, type FormEvent } from "react";
import { ArrowRight, Check, FileText, LoaderCircle, Mail, Upload, X } from "lucide-react";
import { buildSubmission, countWords, type InputKind } from "@/lib/submission";

const inputClass = "w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white placeholder:text-zinc-500 transition-colors focus:border-white/30 focus:outline-none focus:ring-2 focus:ring-white/15";
const inputOptions: Array<{ value: InputKind; label: string }> = [
  { value: "pdf", label: "Resume" }, { value: "text", label: "Claim" },
  { value: "linkedin", label: "LinkedIn Profile" }, { value: "social", label: "Social ID" }, { value: "person", label: "Person" },
];

export default function InvestigationForm() {
  const [kind, setKind] = useState<InputKind>("pdf");
  const [pdf, setPdf] = useState<File | null>(null);
  const [textFile, setTextFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [profile, setProfile] = useState("");
  const [socialId, setSocialId] = useState("");
  const [person, setPerson] = useState({ name: "", context: "", claim: "" });
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const submitting = useRef(false);
  const showEmail = kind === "pdf" ? Boolean(pdf)
    : kind === "text" ? Boolean(textFile) || countWords(text) >= 15
    : kind === "linkedin" ? Boolean(profile.trim())
    : kind === "social" ? Boolean(socialId.trim())
    : Boolean(person.name.trim() && person.context.trim());

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || queued) return;
    const form = event.currentTarget;
    submitting.current = true;
    setBusy(true);
    setStatus("");
    try {
      const website = String(new FormData(form).get("website") ?? "");
      const payload = await buildSubmission({ kind, pdf, text, textFile, profile, socialId, person, email, website });
      const endpoint = import.meta.env.VITE_SUBMISSIONS_URL || "/api/submissions";
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json().catch(() => ({ error: "Please try again in a moment." }));
      if (!response.ok || !result.submissionId) throw new Error(result.error || "Please try again in a moment.");
      setQueued(true);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Please try again in a moment.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  if (queued) return (
    <div className="py-8 text-center" role="status">
      <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-full border border-white/15 bg-white/10"><Check className="size-6 text-[#ffcd75]" aria-hidden="true" /></div>
      <h3 className="text-xl font-medium tracking-tight">Investigation started.</h3>
      <p className="mt-3 text-sm leading-relaxed text-zinc-300">Your report will arrive at<br /><span className="break-all text-white">{email}</span></p>
    </div>
  );

  return (
    <form onSubmit={submit} noValidate aria-busy={busy}>
      <fieldset disabled={busy} className="min-w-0 space-y-6 disabled:opacity-70">
        <legend className="sr-only">Investigation input</legend>
        <div className="intake-tabs" role="tablist" aria-label="Input type">
          {inputOptions.map((option, index) => <button key={option.value} id={`input-tab-${option.value}`} type="button" role="tab" aria-selected={kind === option.value} aria-controls="input-panel" tabIndex={kind === option.value ? 0 : -1} onClick={() => { setKind(option.value); setStatus(""); }} onKeyDown={event => {
            const next = event.key === "ArrowRight" ? (index + 1) % inputOptions.length : event.key === "ArrowLeft" ? (index + inputOptions.length - 1) % inputOptions.length : event.key === "Home" ? 0 : event.key === "End" ? inputOptions.length - 1 : -1;
            if (next < 0) return;
            event.preventDefault();
            setKind(inputOptions[next].value);
            setStatus("");
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
          }}>{option.label}</button>)}
        </div>
        <div id="input-panel" role="tabpanel" aria-labelledby={`input-tab-${kind}`}>
        {kind === "pdf" ? (
          <div>
            <input id="resume" type="file" accept="application/pdf,.pdf" className="peer sr-only" onChange={event => { setPdf(event.target.files?.[0] ?? null); event.target.value = ""; setStatus(""); }} />
            <label htmlFor="resume" className="group flex min-h-40 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-white/20 bg-white/[.025] px-5 py-6 text-center transition-colors hover:border-white/40 hover:bg-white/5 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-amber-200">
              {pdf ? <FileText className="size-6 text-[#ffcd75]" aria-hidden="true" /> : <Upload className="size-6 text-zinc-400 transition-colors group-hover:text-white" aria-hidden="true" />}
              <span className="max-w-full truncate text-sm font-medium">{pdf?.name ?? "Choose your PDF"}</span>
              <span className="text-xs text-zinc-400">{pdf ? "Click to change" : "Up to 2 MB · 2 pages"}</span>
            </label>
          </div>
        ) : kind === "text" ? (
          <div className="space-y-3">
            {textFile ? <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-white/20 bg-white/[.025] px-5 py-6 text-center"><FileText className="size-6 text-[#ffcd75]" aria-hidden="true" /><span className="max-w-full truncate text-sm font-medium">{textFile.name}</span></div> : <>
              <label htmlFor="submission" className="sr-only">Information to investigate</label>
              <textarea id="submission" value={text} onChange={event => { setText(event.target.value); setStatus(""); }} rows={5} placeholder="Paste the information to investigate…" className={`${inputClass} resize-y`} />
            </>}
            <div className="flex min-w-0 items-center gap-2 text-xs text-zinc-400">
              <input id="submission-file" type="file" accept="text/plain,.txt" className="peer sr-only" onChange={event => { setTextFile(event.target.files?.[0] ?? null); event.target.value = ""; setStatus(""); }} />
              <label htmlFor="submission-file" className="inline-flex min-w-0 items-center gap-2 transition-colors hover:text-white peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-amber-200"><Upload className="size-3.5 shrink-0" aria-hidden="true" /><span>{textFile ? "Change file" : "Or upload a .txt file"}</span></label>
              {textFile && <button type="button" aria-label="Remove text file" onClick={() => setTextFile(null)} className="ml-auto p-1"><X className="size-3.5" aria-hidden="true" /></button>}
            </div>
          </div>
        ) : kind === "person" ? (
          <div className="space-y-4">
            <div><label htmlFor="person-name" className="mb-2 block text-xs font-medium text-zinc-300">Name</label><input id="person-name" required autoComplete="off" maxLength={150} value={person.name} onChange={event => { setPerson({ ...person, name: event.target.value }); setStatus(""); }} className={inputClass} /></div>
            <div><label htmlFor="person-context" className="mb-2 block text-xs font-medium text-zinc-300">Workplace or school</label><input id="person-context" required autoComplete="off" maxLength={200} value={person.context} onChange={event => { setPerson({ ...person, context: event.target.value }); setStatus(""); }} className={inputClass} /></div>
            <div><label htmlFor="person-claim" className="mb-2 block text-xs font-medium text-zinc-300">Claim <span className="font-normal text-zinc-400">(optional)</span></label><textarea id="person-claim" rows={3} value={person.claim} onChange={event => { setPerson({ ...person, claim: event.target.value }); setStatus(""); }} className={`${inputClass} resize-y`} /></div>
          </div>
        ) : (
          <div>
            <label htmlFor="profile-input" className="mb-2 block text-xs font-medium text-zinc-300">{kind === "linkedin" ? "LinkedIn profile URL" : "Social ID"}</label>
            <input id="profile-input" type="text" required autoComplete="off" spellCheck={false} maxLength={kind === "linkedin" ? 2048 : 300} placeholder={kind === "linkedin" ? "linkedin.com/in/username" : "Profile URL or Instagram @username"} value={kind === "linkedin" ? profile : socialId} onChange={event => { (kind === "linkedin" ? setProfile : setSocialId)(event.target.value); setStatus(""); }} className={inputClass} />
          </div>
        )}
        </div>
        {showEmail && <>
          <div className="h-px bg-white/10" />
          <div className="animate-fade-in">
            <label htmlFor="work-email" className="mb-2.5 block text-xs font-medium text-zinc-300">Work email</label>
            <div className="relative"><Mail className="pointer-events-none absolute left-4 top-3.5 size-4 text-zinc-500" aria-hidden="true" /><input id="work-email" type="email" required autoComplete="email" placeholder="you@company.com" value={email} onChange={event => { setEmail(event.target.value); setStatus(""); }} className={`${inputClass} pl-11`} /></div>
          </div>
        </>}
        <label hidden aria-hidden="true">Website<input type="text" name="website" tabIndex={-1} autoComplete="off" /></label>
        <button type="submit" className="group flex w-full items-center justify-center gap-2 rounded-full bg-white px-6 py-3.5 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200 active:scale-[.98] disabled:cursor-wait" disabled={busy}>
          {busy ? <><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />Starting…</> : <>Deploy TraceDog<ArrowRight className="size-4 transition-transform group-hover:translate-x-1" aria-hidden="true" /></>}
        </button>
      </fieldset>
      <p role="status" aria-live="polite" className={`text-xs leading-relaxed text-amber-200 ${status ? "mt-4" : ""}`}>{status}</p>
    </form>
  );
}
