import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { fixture } from "../helpers";
import { publish } from "../evidence-helpers";
import { EvidenceStore } from "../../apps/service/src/evidence/locator";
import { createServer } from "../../apps/service/src/http/server";

async function freePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  server.close();
  await once(server, "close");
  return port;
}

test("real stdio MCP handshake searches and reads fixed evidence without exposing other tools", async () => {
  const f = await fixture();
  const port = await freePort();
  const app = createServer(f.registry, f.sessions, f.jobs, port);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const evidence = new EvidenceStore(f.registry).register(
      publish(f, "MCP 可回读的固定证据"),
    )[0]!;
    await app.listen({ port, host: "127.0.0.1" });
    const created = await fetch(`http://127.0.0.1:${port}/v1/agents/clients`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.token}`,
        "content-type": "application/json",
        "x-operation-key": randomUUID(),
        "x-policy-version": String(f.registry.get().policyVersion),
      },
      body: JSON.stringify({
        name: "MCP 客户端",
        sourceIds: [evidence.sourceId],
        receiver: { kind: "local" },
        expiresInMinutes: 60,
      }),
    });
    expect(created.status).toBe(200);
    const grant = (await created.json()) as {
      client: { id: string };
      secret: string;
    };
    child = spawn(
      process.execPath,
      [
        "apps/agent-gateway/dist/stdio.js",
        "serve",
        "--client-id",
        grant.client.id,
        "--port",
        String(port),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, KB_AGENT_TOKEN: grant.secret },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const lines = createInterface({ input: child.stdout! });
    const send = async (id: number, method: string, params: unknown = {}) => {
      const next = once(lines, "line") as Promise<[string]>;
      child!.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
      return JSON.parse((await next)[0]) as {
        result: {
          protocolVersion: string;
          tools: { name: string }[];
          structuredContent: {
            result: { hits: { id: string }[]; evidence: { text: string } };
          };
          isError: boolean;
        };
        error: { code: number };
      };
    };
    const init = await send(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.result.protocolVersion).toBe("2025-11-25");
    child.stdin!.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );
    const listed = await send(2, "tools/list");
    expect(
      listed.result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual(["kb_search", "kb_read_evidence", "kb_answer", "kb_operation"]);
    const denied = await send(3, "tools/call", {
      name: "kb_publish",
      arguments: {},
    });
    expect(denied.error.code).toBe(-32602);
    const search = await send(4, "tools/call", {
      name: "kb_search",
      arguments: { requestId: randomUUID(), query: "MCP", limit: 1 },
    });
    expect(search.result.structuredContent.result.hits[0]?.id).toBe(
      evidence.id,
    );
    const read = await send(5, "tools/call", {
      name: "kb_read_evidence",
      arguments: { requestId: randomUUID(), evidenceId: evidence.id },
    });
    expect(read.result.structuredContent.result.evidence.text).toContain(
      "MCP 可回读",
    );
    expect(JSON.stringify(read)).not.toContain("fixtures.invalid");
    const bad = await send(6, "tools/call", {
      name: "kb_read_evidence",
      arguments: { requestId: randomUUID(), path: "/etc/passwd" },
    });
    expect(bad.result.isError).toBe(true);
  } finally {
    child?.kill();
    await app.close();
    await f.close();
  }
}, 30_000);
