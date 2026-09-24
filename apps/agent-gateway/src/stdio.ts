import { Entry } from "@napi-rs/keyring";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import {
  AgentAnswerArgs,
  AgentOperationArgs,
  AgentReadArgs,
  AgentSearchArgs,
  Id,
} from "@kb/contracts";
import { tools } from "./tools";

const argv = process.argv.slice(2);
const option = (name: string) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const mode = argv[0];
const clientId = Id.parse(option("--client-id"));
const entry = new Entry("knowledge-task-center", `agent:${clientId}`);
if (mode === "pair") {
  const secret = readFileSync(0, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret))
    throw new Error("Invalid pairing secret");
  entry.setPassword(secret);
  process.stderr.write("Agent credential stored in system keyring.\n");
} else if (mode === "serve") {
  const port = Number(option("--port") ?? "27124");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid port");
  const secret = process.env.KB_AGENT_TOKEN ?? entry.getPassword();
  if (!secret) throw new Error("Agent credential unavailable");
  let negotiated = false;
  let initialized = false;
  const send = (message: unknown) =>
    process.stdout.write(`${JSON.stringify(message)}\n`);
  const fail = (id: unknown, code: number, message: string) => ({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  });
  const call = async (name: string, input: unknown) => {
    if (!tools.some((item) => item.name === name))
      throw new Error("Unknown tool");
    const value =
      input && typeof input === "object"
        ? (input as Record<string, unknown>)
        : {};
    const requestId = Id.parse(value.requestId);
    const args = { ...value };
    if (name !== "kb_operation") delete args.requestId;
    if (name === "kb_search") AgentSearchArgs.parse(args);
    if (name === "kb_read_evidence") AgentReadArgs.parse(args);
    if (name === "kb_answer") AgentAnswerArgs.parse(args);
    if (name === "kb_operation") AgentOperationArgs.parse(args);
    const response = await fetch(`http://127.0.0.1:${port}/v1/agents/invoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-id": clientId,
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ requestId, tool: name, args }),
      signal: AbortSignal.timeout(40_000),
    });
    const result = (await response.json()) as Record<string, unknown>;
    const output = response.ok
      ? result
      : {
          code: result.code ?? "UNAVAILABLE",
          retryable: result.retryable ?? false,
        };
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
      ...(response.ok ? {} : { isError: true }),
    };
  };
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    void (async () => {
      let message: Record<string, unknown>;
      try {
        if (Buffer.byteLength(line) > 32_768) throw new Error("oversize");
        message = JSON.parse(line) as Record<string, unknown>;
        if (
          !message ||
          message.jsonrpc !== "2.0" ||
          typeof message.method !== "string"
        )
          throw new Error("invalid request");
      } catch {
        send(fail(null, -32700, "Parse error"));
        return;
      }
      const id = message.id;
      if (id === undefined) {
        if (message.method === "notifications/initialized" && negotiated)
          initialized = true;
        return;
      }
      if (message.method === "initialize") {
        negotiated = true;
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "knowledge-task-center", version: "0.1.0" },
          },
        });
        return;
      }
      if (message.method === "ping") {
        send({ jsonrpc: "2.0", id, result: {} });
        return;
      }
      if (!initialized) {
        send(fail(id, -32000, "Initialize first"));
        return;
      }
      if (message.method === "tools/list") {
        send({ jsonrpc: "2.0", id, result: { tools } });
        return;
      }
      if (message.method === "tools/call") {
        const params = message.params as Record<string, unknown> | undefined;
        if (
          !params ||
          typeof params.name !== "string" ||
          !tools.some((tool) => tool.name === params.name)
        ) {
          send(fail(id, -32602, "Unknown tool"));
          return;
        }
        try {
          const result = await call(params.name, params.arguments);
          send({ jsonrpc: "2.0", id, result });
        } catch {
          send({
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ code: "VALIDATION_OR_UNAVAILABLE" }),
                },
              ],
            },
          });
        }
        return;
      }
      send(fail(id, -32601, "Method not found"));
    })().catch(() => process.stderr.write("Agent protocol request failed.\n"));
  });
} else {
  throw new Error("Use pair or serve with --client-id <UUID>");
}
