import { createInterface } from "node:readline";

const tools = [
  { name: "screenshot", description: "Capture the VM screen", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "click", description: "Click at a point", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false } },
  { name: "type_text", description: "Type text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
  { name: "open_url", description: "Open a URL in the VM browser", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } },
];

const respond = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    respond(request.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture-local-vm", version: "1" } });
  } else if (request.method === "tools/list") {
    respond(request.id, { tools });
  } else if (request.method === "tools/call") {
    respond(request.id, { content: [{ type: "text", text: `fixture VM ran ${String(request.params?.name)}` }] });
  } else {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unsupported method" } })}\n`);
  }
});
