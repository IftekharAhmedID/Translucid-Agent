import BrandLogo from "./brand-logo";
import { useEffect } from "react";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { answerBenchmarks, benchmarkPageMeta, dracoRows, type BenchmarkRow } from "@/lib/benchmarks";
import { BenchmarkBars, BenchmarkSources } from "./price-performance";

function ResultTable({ rows }: { rows: BenchmarkRow[] }) {
  return <div className="method-table-scroll" tabIndex={0} aria-label="Benchmark results table"><table className="method-table"><thead><tr><th scope="col">System</th><th scope="col">Score</th><th scope="col">Tasks</th></tr></thead><tbody>{rows.map(row => <tr key={row.name} className={row.source === "team" ? "is-tracedog" : ""}><th scope="row">{row.name}</th><td>{row.score.toFixed(1)}</td><td>{row.tasks ?? (row.source === "reference" ? "100 questions" : "Not supplied")}</td></tr>)}</tbody></table></div>;
}

function AnswersMethod() {
  return <>
    <section id="results"><h2>Answer benchmark results</h2><div className="comparison-panels">{answerBenchmarks.map(benchmark => <section className="comparison-panel" key={benchmark.id}><h3>{benchmark.name}</h3><p className="comparison-number">{benchmark.score}<span>%</span></p><BenchmarkBars rows={benchmark.rows} /></section>)}</div></section>
    <section><h2>What the benchmarks measure</h2><p><a href="https://openai.com/index/browsecomp/">BrowseComp</a> tests whether a browsing agent can locate difficult, verifiable facts. <a href="https://arxiv.org/abs/2601.20975">DeepSearchQA</a> tests multi-step information gathering, including questions that require complete answer lists. Their scores depend on the sample, output format, grader, and failure rules.</p><p>TraceDog evaluation results: 77% on BrowseComp and 82% on DeepSearchQA.</p></section>
    <section><h2>How TraceDog investigates</h2><ol className="method-steps"><li><strong>Read the submission.</strong> Parse documents into structured text and preserve links and claim locations.</li><li><strong>Follow the sources.</strong> Search public records, profiles, archived pages, and relevant original documents.</li><li><strong>Capture the evidence.</strong> Keep discovery leads separate from fetched records that can support a finding.</li><li><strong>Check the claim.</strong> Resolve identity and dates, connect citations to findings, and retain disagreements and remaining gaps.</li><li><strong>Publish the report.</strong> Commit the research state and materialize the report before email delivery.</li></ol></section>
    <section><h2>Question sets and contamination</h2><p>The reproduction protocol freezes the question manifest and sampling seed before execution, excludes development questions, and keeps reference answers outside the investigator’s context. Benchmark answer repositories and leaked question-answer pages cannot count as evidence.</p></section>
    <section><h2>Grading and failures</h2><p>The reproduction protocol records the grader model, prompt, retry policy, and scoring rule. Single-answer questions are checked against the reference fact; list questions require a declared policy for missing and extra items. Timeouts, empty answers, abstentions, and server failures stay in the evaluation denominator.</p><p>TraceDog's evidence-support score inside an investigation report measures captured support for that submission. It is a separate measure from accuracy on BrowseComp or DeepSearchQA.</p></section>
    <section><h2>Latency, cost, and run records</h2><p>The reproduction record includes end-to-end timing and model, search, retrieval, sandbox, retry, and delivery costs. Each answer is tied to a question identifier, run timestamp, model version, grade, and captured evidence. No cost comparison is claimed from the reported answer scores.</p></section>
  </>;
}

function DracoMethod() {
  return <>
    <section id="results"><h2>DRACO evaluation results</h2><ResultTable rows={dracoRows} /></section>
    <section><h2>What DRACO measures</h2><p><a href="https://r2cdn.perplexity.ai/pplx-draco.pdf">DRACO</a> evaluates deep research reports across expert-written criteria for factual accuracy, coverage, presentation, and citation quality. A score depends on the selected tasks, grading rubric, judge, and exported report content.</p><p>TraceDog evaluation result: 74.8 across 10 of 10 tasks.</p></section>
    <section><h2>External evaluation setup</h2><p>The comparison rows are taken from the published DRACO comparison. It used a 10-task selection and its stated judge configuration. Some systems have results for eight tasks. These reference scores should not be substituted for full-dataset leaderboard results or treated as a shared TraceDog test run.</p></section>
    <section><h2>Tasks and reports</h2><p>The reproduction protocol freezes task identifiers across the benchmark’s domains, keeps the original prompts, and records system configuration and clarifications. Complete reports and citation exports accompany each task. Task selection happens before inspecting results.</p></section>
    <section><h2>How the score is calculated</h2><p>The reproduction protocol records the rubric version, judge model and settings, per-criterion grades, repeated grades, and averaging formula. Missing tasks and failed runs receive an explicit policy. The reported aggregate score is 74.8.</p></section>
    <section><h2>Evidence behind the report</h2><p>Sources cited counts distinct referenced sources. Sources validated counts cited figures compared with their source material. Sources captured counts records collected during an investigation. Reported per-investigation source metrics:</p><BenchmarkSources /><p>“None” means no comparable count was reported in the reference outputs; it does not mean that the system cannot validate or capture sources. Captured sources are investigation records, not a shared vault for later runs.</p></section>
    <section><h2>Evaluation record</h2><p>The TraceDog figures were supplied by its team on 8 November 2026. The external reference evaluation has different provenance, and configuration alignment has not been confirmed. Aggregate figures alone cannot establish statistical significance, grading consistency, or the behavior of later model versions.</p><p>The reproduction record will link the reports, grader outputs, and source-count ledgers. External testing history remains attributed to the linked reference study.</p></section>
  </>;
}

export default function BenchmarkPage({ kind }: { kind: keyof typeof benchmarkPageMeta }) {
  const answers = kind === "answers";
  const meta = benchmarkPageMeta[kind];
  useEffect(() => { document.title = meta.title; }, [meta.title]);

  return <div className="benchmark-page">
    <header className="benchmark-nav"><a className="footer-brand" href="/"><BrandLogo /></a><a className="quiet-link" href={`/#${answers ? "comparison" : "efficiency"}`}><ArrowLeft size={14} aria-hidden="true" />Back to results</a></header>
    <article className="benchmark-article">
      <p className="section-kicker">Benchmark methodology</p><h1>{answers ? "BrowseComp and DeepSearchQA." : "DRACO: how we evaluate."}</h1>
      <p className="method-lede">{answers ? "Answer benchmark results, the investigation process, and the evidence needed to reproduce the evaluation." : "Reported research performance, source metrics, and the scope of the comparison."}</p>
      <p className="method-provenance">Results supplied by TraceDog · 8 Nov 2026. Supporting run reports pending publication.</p>
      {answers ? <AnswersMethod /> : <DracoMethod />}
      <section className="method-references"><h2>References</h2><a href={`/benchmarks/${answers ? "draco" : "answers"}/`}>{answers ? "DRACO methodology" : "Answer benchmarks"}<ArrowUpRight size={13} aria-hidden="true" /></a></section>
    </article>
    <footer className="benchmark-nav story-footer"><a className="footer-brand" href="/"><BrandLogo /></a><span>Follow the evidence.</span></footer>
  </div>;
}
