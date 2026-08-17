import { randomUUID } from "node:crypto";

export type Completion = { content?: string; toolCall?: { name: string; arguments: Record<string, unknown> } };

export function writeFixtureCompletion(response: import("node:http").ServerResponse, body: Record<string, unknown>, model: string, completion: Completion): void {
  const id = `chatcmpl_fixture_${randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1_000);
  if (model === "gpt-5.6-luna") {
    const item = completion.toolCall
      ? { type: "function_call", id: `fc_${randomUUID().replaceAll("-", "")}`, call_id: `call_${randomUUID().replaceAll("-", "")}`, name: completion.toolCall.name, arguments: JSON.stringify(completion.toolCall.arguments), status: "completed" }
      : { type: "message", id: `msg_${randomUUID().replaceAll("-", "")}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: completion.content ?? "", annotations: [] }] };
    const responseObject = { id: `resp_fixture_${randomUUID().replaceAll("-", "")}`, object: "response", created_at: created, model, output: [item], output_text: completion.content ?? "", status: "completed", usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } };
    if (body.stream === true) {
      const events = completion.toolCall
        ? [
            { type: "response.created", response: { ...responseObject, output: [] } },
            { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
            { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
            { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, name: item.name, call_id: item.call_id, arguments: item.arguments },
            { type: "response.output_item.done", output_index: 0, item },
            { type: "response.completed", response: responseObject },
          ]
        : [
            { type: "response.created", response: { ...responseObject, output: [] } },
            { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
            { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: completion.content ?? "" },
            { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: completion.content ?? "" },
            { type: "response.output_item.done", output_index: 0, item },
            { type: "response.completed", response: responseObject },
          ];
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(responseObject));
    return;
  }
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
