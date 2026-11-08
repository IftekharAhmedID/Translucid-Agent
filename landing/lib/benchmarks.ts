export type BenchmarkRow = {
  name: string;
  provider: string;
  score: number;
  source: "team" | "reference";
  tasks?: string;
};



export const benchmarkPageMeta = {
  answers: { title: "BrowseComp and DeepSearchQA — TraceDog", description: "TraceDog's answer benchmark results, research process, and evaluation references." },
  draco: { title: "DRACO benchmark methodology — TraceDog", description: "TraceDog's DRACO evaluation result, source metrics, and evaluation references." },
};

// TraceDog values and its 10-of-10 task count supplied by the team on 8 Nov 2026.
// Underlying artifacts have not yet been supplied.
// Reference values belong to Hyperresearch's evaluations, not TraceDog's test harness.
export const answerBenchmarks = [
  { id: "browsecomp", name: "BrowseComp", score: 77, rows: [
    { name: "TraceDog", provider: "TraceDog", score: 77, source: "team" },
    { name: "Parallel (Pro)", provider: "Parallel", score: 73, source: "reference" },
    { name: "OpenAI web search", provider: "OpenAI", score: 58, source: "reference" },
    { name: "Perplexity Sonar Pro", provider: "Perplexity", score: 43, source: "reference" },
    { name: "Exa", provider: "Exa", score: 12, source: "reference" },
  ] },
  { id: "deepsearchqa", name: "DeepSearchQA", score: 82, rows: [
    { name: "TraceDog", provider: "TraceDog", score: 82, source: "team" },
    { name: "Parallel (Pro)", provider: "Parallel", score: 81, source: "reference" },
    { name: "OpenAI web search", provider: "OpenAI", score: 70, source: "reference" },
    { name: "Exa", provider: "Exa", score: 28, source: "reference" },
    { name: "Perplexity Sonar Pro", provider: "Perplexity", score: 24, source: "reference" },
  ] },
] satisfies Array<{ id: string; name: string; score: number; rows: BenchmarkRow[] }>;

export const dracoRows: BenchmarkRow[] = [
  { name: "TraceDog", provider: "TraceDog", score: 74.8, source: "team", tasks: "10 of 10" },
  { name: "Claude Research (Opus)", provider: "Anthropic", score: 73, source: "reference", tasks: "10 of 10" },
  { name: "Parallel Ultra", provider: "Parallel", score: 61.5, source: "reference", tasks: "10 of 10" },
  { name: "You.com Research", provider: "You.com", score: 60.1, source: "reference", tasks: "8 of 10" },
  { name: "Perplexity Deep Research", provider: "Perplexity", score: 57.8, source: "reference", tasks: "8 of 10" },
  { name: "Valyu DeepResearch Heavy", provider: "Valyu", score: 57.2, source: "reference", tasks: "8 of 10" },
  { name: "ChatGPT Deep research", provider: "OpenAI", score: 55.2, source: "reference", tasks: "10 of 10" },
  { name: "Gemini Deep Research", provider: "Google", score: 54.7, source: "reference", tasks: "10 of 10" },
];

type SourceMetric = {
  id: string;
  title: string;
  count: number;
  description: string;
  rows: Array<{ name: string; count: number | null; source: "team" | "reference" }>;
};

export const sourceMetrics: SourceMetric[] = [
  { id: "cited", title: "Sources cited", count: 65, description: "Distinct sources per report", rows: [
    { name: "TraceDog", count: 65, source: "team" },
    { name: "Perplexity Deep Research", count: 29, source: "reference" },
    { name: "Gemini Deep Research", count: 29, source: "reference" },
  ] },
  { id: "checked", title: "Sources validated", count: 87, description: "Cited figures checked against their source, per report", rows: [
    { name: "TraceDog", count: 87, source: "team" },
    { name: "Perplexity Deep Research", count: null, source: "reference" },
    { name: "ChatGPT Deep research", count: null, source: "reference" },
    { name: "Gemini Deep Research", count: null, source: "reference" },
  ] },
  { id: "captured", title: "Sources captured", count: 192, description: "Sources collected per investigation", rows: [
    { name: "TraceDog", count: 192, source: "team" },
    { name: "Perplexity Deep Research", count: null, source: "reference" },
    { name: "ChatGPT Deep research", count: null, source: "reference" },
    { name: "Gemini Deep Research", count: null, source: "reference" },
  ] },
];
