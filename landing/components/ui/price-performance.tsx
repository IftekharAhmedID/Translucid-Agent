import { ArrowRight } from "lucide-react";
import { answerBenchmarks, dracoRows, sourceMetrics, type BenchmarkRow } from "@/lib/benchmarks";

export function BenchmarkBars({ rows }: { rows: BenchmarkRow[] }) {
  return <ol className="comparison-bars">
    {rows.map(row => <li key={row.name} className={row.source === "team" ? "is-tracedog" : ""}>
      <div className="bar-label"><span>{row.name}</span><strong>{row.score}%</strong></div>
      <div className="bar-track" aria-hidden="true"><span style={{ width: `${row.score}%` }} /></div>
    </li>)}
  </ol>;
}

export function BenchmarkSources() {
  return <div className="benchmark-source-metrics">
    {sourceMetrics.map(metric => <section key={metric.id} aria-labelledby={`metric-${metric.id}`}>
      <h3 id={`metric-${metric.id}`}>{metric.title}</h3><p className="source-metric-number">{metric.count}</p><p className="source-metric-description">{metric.description}</p>
      <ol className="comparison-bars">
        {metric.rows.map(row => <li key={row.name} className={row.source === "team" ? "is-tracedog" : ""}>
          <div className="bar-label"><span>{row.name}</span><strong>{row.count ?? <>None<span className="sr-only"> reported in the compared outputs</span></>}</strong></div>
          <div className="bar-track" aria-hidden="true"><span style={{ width: `${(row.count ?? 0) / Math.max(...metric.rows.map(item => item.count ?? 0)) * 100}%` }} /></div>
        </li>)}
      </ol>{metric.rows.some(row => row.count === null) && <p className="source-metric-note">None = no comparable count reported.</p>}
    </section>)}
  </div>;
}

export default function PricePerformance() {
  return <>
    <section id="comparison" className="story-section answer-benchmarks" aria-labelledby="comparison-heading">
      <div className="comparison-heading"><div><p className="section-kicker">TraceDog benchmarks</p><h2 id="comparison-heading">More right answers than<br /><span>Parallel, OpenAI, Perplexity and Exa.</span></h2></div></div>
      <div className="comparison-panels">
        {answerBenchmarks.map(benchmark => <section key={benchmark.id} className="comparison-panel" aria-labelledby={`${benchmark.id}-heading`}>
          <h3 id={`${benchmark.id}-heading`}>{benchmark.name}</h3><p className="comparison-number">{benchmark.score}<span>%</span></p><BenchmarkBars rows={benchmark.rows} />
        </section>)}
      </div>
      <div className="benchmark-caption"><p>TraceDog evaluation results · Published comparator scores.</p><a className="quiet-link" href="/benchmarks/answers/">How we tested<ArrowRight size={13} aria-hidden="true" /></a></div>
    </section>
    <section id="efficiency" className="story-section draco-benchmark" aria-labelledby="draco-heading">
      <div className="comparison-heading"><div><p className="section-kicker">Deep research</p><h2 id="draco-heading">74.8 on DRACO.<br /><span>Ahead of Claude, ChatGPT, Gemini and Perplexity.</span></h2></div></div>
      <div className="benchmark-caption draco-method"><p>TraceDog evaluation · 10 of 10 tasks · Published comparator scores.</p><a className="quiet-link" href="/benchmarks/draco/">How we tested<ArrowRight size={13} aria-hidden="true" /></a></div>
      <ol className="efficiency-ranking" aria-label="DRACO scores and reported reference results">
        {[...dracoRows].sort((a, b) => b.score - a.score).map((row, index) => <li key={row.name} className={row.source === "team" ? "is-tracedog" : ""}>
          <span className="efficiency-rank">{String(index + 1).padStart(2, "0")}</span>
          <div className="efficiency-name"><h3>{row.name}</h3><p>{row.provider}{row.tasks === "8 of 10" ? " · 8 of 10 tasks" : ""}</p></div>
          <div className="bar-track" aria-hidden="true"><span style={{ width: `${row.score}%` }} /></div><span className="efficiency-value">{row.score.toFixed(1)}</span>
        </li>)}
      </ol>
      <BenchmarkSources />
    </section>
  </>;
}
