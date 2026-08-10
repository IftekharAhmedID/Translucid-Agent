import type { ToolResult } from "../providers/contracts.ts";
import { redactSecrets } from "../providers/http.ts";

export const MAX_AGENT_TOOL_RESULT_BYTES = 512 * 1024;
export const MAX_TOTAL_EXCERPT_CHARACTERS = 300_000;
export const MAX_EXCERPT_CHARACTERS = 80_000;
const DEFAULT_AGENT_TOOL_RESULT_BYTES = 128 * 1024;
const DEFAULT_EXCERPT_CHARACTERS = 60_000;
const DEFAULT_SINGLE_EXCERPT_CHARACTERS = 20_000;

type Excerpt = { path: string; text: string };

export type AgentToolResult = Omit<ToolResult, "data"> & {
  data?: unknown;
  dataTruncated: boolean;
  instruction: string;
};

function keyPriority(key: string): number {
  if (key === "highlights") return 0;
  if (["title", "name", "headline", "url", "publishedDate", "author"].includes(key)) return 1;
  if (["results", "data", "positions", "experience", "education", "currentPositions"].includes(key)) return 2;
  if (key === "text") return 9;
  return 5;
}

function collectExcerpts(value: unknown, path: string, excerpts: Excerpt[], remaining: { characters: number }, depth = 0): void {
  if (remaining.characters <= 0 || depth > 8 || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (!value.trim()) return;
    const limit = Math.min(DEFAULT_SINGLE_EXCERPT_CHARACTERS, remaining.characters);
    const text = value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 24))}\n...[preview truncated]`;
    excerpts.push({ path, text });
    remaining.characters -= text.length;
    return;
  }
  if (["number", "boolean", "bigint"].includes(typeof value)) {
    collectExcerpts(String(value), path, excerpts, remaining, depth + 1);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length && remaining.characters > 0; index += 1) {
      collectExcerpts(value[index], `${path}[${index}]`, excerpts, remaining, depth + 1);
    }
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => keyPriority(left) - keyPriority(right));
    for (const [key, child] of entries) {
      collectExcerpts(child, path ? `${path}.${key}` : key, excerpts, remaining, depth + 1);
      if (remaining.characters <= 0) break;
    }
  }
}

export function compactToolResultForAgent(result: ToolResult): AgentToolResult {
  const { data, ...metadata } = result;
  const instruction = "Artifact IDs above are complete. Use them immediately. Never refetch or read OpenCode tool-output files to recover an artifact ID. If the preview omits a field, use artifact.excerpts with the artifact ID to search the immutable stored response before recording a limitation; move to the next independent question only after that local search fails.";
  const sanitizedData = data === undefined ? undefined : redactSecrets(data);
  const complete: AgentToolResult = { ...metadata, data: sanitizedData, dataTruncated: false, instruction };
  if (Buffer.byteLength(JSON.stringify(complete)) <= DEFAULT_AGENT_TOOL_RESULT_BYTES) return complete;

  const excerpts: Excerpt[] = [];
  collectExcerpts(sanitizedData, "data", excerpts, { characters: DEFAULT_EXCERPT_CHARACTERS });
  const compact: AgentToolResult = {
    ...metadata,
    data: { excerpts, notice: "The immutable full provider response is stored in PostgreSQL; this is a bounded agent preview." },
    dataTruncated: true,
    instruction,
  };
  while (Buffer.byteLength(JSON.stringify(compact)) > MAX_AGENT_TOOL_RESULT_BYTES && excerpts.length > 0) excerpts.pop();
  return compact;
}
