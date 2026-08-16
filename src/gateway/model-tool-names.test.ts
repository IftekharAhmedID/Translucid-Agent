import assert from "node:assert/strict";
import test from "node:test";

import { decodeJsonToolNames, encodeModelToolNames, SseToolNameDecoder } from "./model-tool-names.ts";

test("invalid semantic tool names are encoded only on the model wire", () => {
  const body = {
    tools: [
      { type: "function", function: { name: "claim.create", description: "Create a claim" } },
      { type: "function", function: { name: "StructuredOutput", description: "Return JSON" } },
    ],
    tool_choice: { type: "function", function: { name: "claim.create" } },
    messages: [{ role: "assistant", tool_calls: [{ function: { name: "claim.create" } }] }],
  };

  const encoded = encodeModelToolNames(body);
  const wireName = encoded.body.tools[0]!.function.name;
  assert.match(wireName, /^[a-zA-Z0-9_-]+$/);
  assert.notEqual(wireName, "claim.create");
  assert.equal(encoded.body.tools[1]!.function.name, "StructuredOutput");
  assert.equal(encoded.body.tool_choice.function.name, wireName);
  assert.equal(encoded.body.messages[0]!.tool_calls[0]!.function.name, wireName);
  assert.equal(encoded.wireToSemantic.get(wireName), "claim.create");
});

test("streamed tool calls are decoded across arbitrary chunk boundaries", () => {
  const decoder = new SseToolNameDecoder(new Map([["tool_deadbeef", "claim.create"]]));
  const first = decoder.push(Buffer.from('data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"tool_'));
  const second = decoder.push(Buffer.from('deadbeef"}}]}}]}\n\ndata: [DONE]\n'));
  const final = decoder.flush();

  assert.equal(first, "");
  assert.match(second + final, /"name":"claim\.create"/);
  assert.match(second + final, /data: \[DONE\]/);
});

test("non-streaming GO tool aliases round-trip all affected semantic tool-name fields", () => {
  const aliases = new Map([
    ["wire_entity", "entity.link"],
    ["wire_observation", "observation.record"],
    ["wire_research", "research.resolve"],
    ["wire_evidence", "evidence.capture"],
  ]);
  const payload = JSON.stringify({
    choices: [{ message: {
      tool_calls: [
        { function: { name: "wire_entity" } },
        { function: { name: "wire_observation" } },
        { function: { name: "wire_research" } },
        { function: { name: "wire_evidence" } },
      ],
      provider_metadata: { tool_name: "wire_entity", toolName: "wire_evidence" },
    } }],
  });

  const decoded = decodeJsonToolNames(payload, aliases);
  for (const semantic of aliases.values()) assert.match(decoded, new RegExp(semantic.replace(".", "\\.")));
  assert.doesNotMatch(decoded, /wire_/);
});
