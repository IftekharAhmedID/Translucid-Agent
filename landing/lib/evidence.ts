export type Relation = "supports" | "contradicts" | "unresolved";
export type EvidenceFilter = Relation | "all";
export type EvidenceSource = {
  id: string;
  title: string;
  type: string;
  relation: Relation;
  date: string;
  quote: string;
  detail: string;
  strength: string;
};
export type InvestigationCase = { id: string; label: string; claim: string; subject: string; evidence: EvidenceSource[] };

// Fictional examples explain evidence relationships without making claims about real people.
export const investigationCases: InvestigationCase[] = [
  { id: "employment", label: "Employment", subject: "Aster Labs", claim: "Led engineering at Aster Labs, Jan 2021–Sep 2023.", evidence: [
    { id: "team", title: "Archived team page", type: "Web archive", relation: "supports", date: "June 2022", strength: "Primary source", quote: "Nora Chen — Engineering Lead", detail: "The company’s archived team page names Nora and the role. It supports the title at this point in time." },
    { id: "release", title: "Product release notes", type: "Company record", relation: "supports", date: "September 2022", strength: "Primary source", quote: "Engineering led by Nora Chen.", detail: "A dated company release places the role in the claimed period." },
    { id: "repository", title: "Repository history", type: "Public code", relation: "supports", date: "2021–2023", strength: "Direct activity", quote: "Contributions recorded across three years.", detail: "Public commits support involvement. They do not establish a job title on their own." },
    { id: "profile", title: "Earlier public profile", type: "Social profile", relation: "contradicts", date: "May 2023", strength: "Self-reported", quote: "Joined Aster Labs in July 2021.", detail: "The stated start date conflicts with a January 2021 start. The date needs reconciliation." },
    { id: "speaker", title: "Conference biography", type: "Event record", relation: "supports", date: "October 2023", strength: "Independent source", quote: "Nora Chen, formerly Engineering Lead at Aster Labs.", detail: "An organizer’s biography corroborates the role and places the end of employment before this event." },
    { id: "tenure", title: "Exact tenure", type: "Missing record", relation: "unresolved", date: "2021–2023", strength: "Not established", quote: "The full employment dates remain unverified.", detail: "Public records establish the role, but do not settle the exact start and end dates." },
  ] },
  { id: "education", label: "Education", subject: "Northbridge University", claim: "Earned an MSc at Northbridge University in 2020.", evidence: [
    { id: "thesis", title: "University repository", type: "Institutional record", relation: "supports", date: "May 2020", strength: "Primary source", quote: "Master’s thesis — Nora Chen, 2020.", detail: "The institution’s repository ties the author to a master’s thesis in the stated year." },
    { id: "programme", title: "Graduation programme", type: "University archive", relation: "supports", date: "June 2020", strength: "Primary source", quote: "Master of Science: Nora Chen.", detail: "The archived programme names the degree and recipient." },
    { id: "lab", title: "Research group page", type: "Web archive", relation: "supports", date: "2019–2020", strength: "Institutional source", quote: "Nora Chen — graduate researcher.", detail: "An archived lab page supports the affiliation during the claimed period." },
    { id: "bio", title: "Later professional bio", type: "Public profile", relation: "contradicts", date: "August 2021", strength: "Self-reported", quote: "MSc, class of 2019.", detail: "A different graduation year appears in a later biography. It conflicts with the university record." },
    { id: "paper", title: "Published research", type: "Publication", relation: "supports", date: "April 2020", strength: "Independent record", quote: "Affiliation: Northbridge University.", detail: "The publication corroborates affiliation, but does not independently prove the degree." },
    { id: "honours", title: "Degree honours", type: "Missing record", relation: "unresolved", date: "2020", strength: "Not established", quote: "No public record establishes distinction.", detail: "The degree is documented; the additional honours claim needs its own evidence." },
  ] },
  { id: "company", label: "Company", subject: "Aster Labs", claim: "Aster Labs was founded in 2019.", evidence: [
    { id: "registry", title: "Company registry", type: "Public record", relation: "supports", date: "March 2019", strength: "Primary source", quote: "Incorporation date: 14 March 2019.", detail: "The registry establishes legal incorporation. It does not establish when informal work began." },
    { id: "launch", title: "Launch announcement", type: "Company record", relation: "supports", date: "June 2019", strength: "Primary source", quote: "Introducing Aster Labs.", detail: "A dated announcement places the public launch in the claimed year." },
    { id: "domain", title: "Domain history", type: "Domain record", relation: "supports", date: "January 2019", strength: "Technical record", quote: "First observed registration: January 2019.", detail: "The domain predates incorporation. Registration supports the timeline, not ownership on its own." },
    { id: "press", title: "Press interview", type: "News article", relation: "contradicts", date: "November 2020", strength: "Independent source", quote: "The company was founded in 2018.", detail: "The interview gives an earlier founding year. Legal incorporation and operating history may differ." },
    { id: "site", title: "First archived website", type: "Web archive", relation: "supports", date: "July 2019", strength: "Contemporaneous source", quote: "Aster Labs — building our first release.", detail: "The earliest captured website places public operations in 2019." },
    { id: "ownership", title: "Original ownership", type: "Missing record", relation: "unresolved", date: "2019", strength: "Not established", quote: "The original ownership split is not public.", detail: "Founding year evidence does not establish founder equity or beneficial ownership." },
  ] },
];

export function visibleEvidence(investigation: InvestigationCase, filter: EvidenceFilter): EvidenceSource[] {
  return investigation.evidence.filter(source => filter === "all" || source.relation === filter);
}

// Aggregates from the committed, delivered resume report of 14 October 2026.
// Source: .debug/tracedog-serverless/canary-proof/result.json, run f6d68f56-9ae6-49fe-9838-deee2697d28e.
// Only counts are public; no personal content from the report is included.
export const sampleReport = {
  claims: 24, sources: 22, linkedFindings: 21,
  outcomes: [
    { label: "Established", count: 8, tone: "supports" },
    { label: "Partially established", count: 7, tone: "partial" },
    { label: "Unresolved", count: 6, tone: "unresolved" },
    { label: "Conflicting", count: 1, tone: "conflicting" },
    { label: "Contradicted", count: 2, tone: "contradicts" },
  ],
} as const;
