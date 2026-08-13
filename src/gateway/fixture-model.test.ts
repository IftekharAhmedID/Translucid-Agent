import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import test from "node:test";

import { writeAnthropicFixtureCompletion } from "./fixture-model.ts";

test("Anthropic fixture responses honor streaming message events", () => {
  const chunks: string[] = [];
  let contentType = "";
  const response = {
    writeHead: (_status: number, headers: Record<string, string>) => { contentType = headers["content-type"] ?? ""; },
    write: (chunk: string) => { chunks.push(chunk); },
    end: (chunk?: string) => { if (chunk) chunks.push(chunk); },
  } as unknown as ServerResponse;

  writeAnthropicFixtureCompletion(response, { stream: true }, "minimax-m3", { content: "<RESULT_JSON>{}</RESULT_JSON>" });

  const body = chunks.join("");
  assert.equal(contentType, "text/event-stream");
  assert.match(body, /event: message_start/u);
  assert.match(body, /event: content_block_delta/u);
  assert.match(body, /<RESULT_JSON>\{\}<\/RESULT_JSON>/u);
  assert.match(body, /event: message_stop/u);
});
