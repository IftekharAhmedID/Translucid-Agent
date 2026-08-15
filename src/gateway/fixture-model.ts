import { randomUUID } from "node:crypto";

export type Completion = { content?: string; toolCall?: { name: string; arguments: Record<string, unknown> } };

export function writeFixtureCompletion(response: import("node:http").ServerResponse, body: Record<string, unknown>, model: string, completion: Completion): void {
  const id = `chatcmpl_fixture_${randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1_000);
  const message = completion.toolCall
    ? { role: "assistant", content: null, tool_calls: [{ id: `call_${randomUUID().replaceAll("-", "")}`, type: "function", function: { name: completion.toolCall.name, arguments: JSON.stringify(completion.toolCall.arguments) } }] }
    : { role: "assistant", content: completion.content ?? "" };
  if (body.stream === true) {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: completion.toolCall ? "tool_calls" : "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
    return;
  }
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ id, object: "chat.completion", created, model, choices: [{ index: 0, message, finish_reason: completion.toolCall ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
}
