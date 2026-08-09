import { createHash } from "node:crypto";

const validToolName = /^[a-zA-Z0-9_-]+$/;

function encodedName(name: string): string {
  return `tool_${createHash("sha256").update(name).digest("hex").slice(0, 24)}`;
}

function replaceNamedFields(value: unknown, names: Map<string, string>): void {
  if (Array.isArray(value)) {
    for (const item of value) replaceNamedFields(item, names);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.name === "string" && names.has(record.name)) {
    record.name = names.get(record.name)!;
  }
  for (const nested of Object.values(record)) replaceNamedFields(nested, names);
}

export function encodeModelToolNames<T>(body: T): {
  body: T;
  wireToSemantic: Map<string, string>;
} {
  const encoded = structuredClone(body);
  const semanticToWire = new Map<string, string>();
  if (encoded && typeof encoded === "object") {
    const tools = (encoded as { tools?: unknown }).tools;
    if (Array.isArray(tools)) {
      for (const tool of tools) {
        const name = tool && typeof tool === "object"
          ? (tool as { function?: { name?: unknown } }).function?.name
          : undefined;
        if (typeof name === "string" && !validToolName.test(name)) {
          semanticToWire.set(name, encodedName(name));
        }
      }
    }
  }
  replaceNamedFields(encoded, semanticToWire);
  return {
    body: encoded,
    wireToSemantic: new Map([...semanticToWire].map(([semantic, wire]) => [wire, semantic])),
  };
}

function decodeSseLine(line: string, wireToSemantic: Map<string, string>): string {
  const carriageReturn = line.endsWith("\r") ? "\r" : "";
  const content = carriageReturn ? line.slice(0, -1) : line;
  if (!content.startsWith("data:")) return line;
  const separator = content.startsWith("data: ") ? "data: " : "data:";
  const payload = content.slice(separator.length);
  if (!payload || payload === "[DONE]") return line;
  try {
    const parsed: unknown = JSON.parse(payload);
    replaceNamedFields(parsed, wireToSemantic);
    return `${separator}${JSON.stringify(parsed)}${carriageReturn}`;
  } catch {
    return line;
  }
}

export class SseToolNameDecoder {
  private readonly decoder = new TextDecoder();
  private pending = "";

  constructor(private readonly wireToSemantic: Map<string, string>) {}

  push(chunk: Uint8Array): string {
    this.pending += this.decoder.decode(chunk, { stream: true });
    let output = "";
    let newline = this.pending.indexOf("\n");
    while (newline >= 0) {
      output += `${decodeSseLine(this.pending.slice(0, newline), this.wireToSemantic)}\n`;
      this.pending = this.pending.slice(newline + 1);
      newline = this.pending.indexOf("\n");
    }
    return output;
  }

  flush(): string {
    this.pending += this.decoder.decode();
    const output = this.pending ? decodeSseLine(this.pending, this.wireToSemantic) : "";
    this.pending = "";
    return output;
  }
}
