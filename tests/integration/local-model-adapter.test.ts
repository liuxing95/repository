import { expect, test } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scope, ModelAnswer } from "@kb/contracts";
import { localModelName, startLocalOllama } from "../../apps/service/src/answers/local-model";
import type { EvidencePack } from "../../apps/service/src/answers/evidence-pack";

test("dedicated local adapter disables cloud, discovers an installed model and sends a bounded structured prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-ollama-test-"));
  const binary = join(dir, "fake-ollama");
  await writeFile(binary, `#!/usr/bin/env node
const http = require("node:http");
const port = Number(process.env.OLLAMA_HOST.split(":")[1]);
http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (process.env.OLLAMA_NO_CLOUD !== "1") { res.statusCode = 500; res.end("{}"); return; }
  if (req.url === "/api/tags") { res.end(JSON.stringify({ models: [{ name: "fixture:1", digest: "a".repeat(64) }] })); return; }
  let body = "";
  req.on("data", part => body += part);
  req.on("end", () => {
    const input = JSON.parse(body);
    const pack = JSON.parse(input.messages[1].content);
    const e = pack.evidence[0];
    if (e.heading[0] !== "3.4 权限") { res.statusCode = 500; res.end("{}"); return; }
    const value = { paragraphs: [{ text: e.text, citations: [pack.question === "未知证据" ? "E99" : e.id] }], gaps: [] };
    res.end(JSON.stringify({ message: { content: JSON.stringify(value) }, prompt_eval_count: 100 }));
  });
}).listen(port, "127.0.0.1");
`);
  await chmod(binary, 0o700);
  let runtime: Awaited<ReturnType<typeof startLocalOllama>> | undefined;
  try {
    runtime = await startLocalOllama("fixture:1", binary);
    const scope = Scope.parse({});
    const pack = {
      question: "权限条件是什么？",
      scope,
      evidence: [{ id: "a".repeat(64), text: "权限不可默认开启。", locator: { heading: ["3.4 权限"] }, profile: { scope }, title: "指南" }],
    } as EvidencePack;
    expect(runtime.provider.inputTokenUpperBound!(pack, 512)).toBeGreaterThan(0);
    const result = await runtime.provider.generate(pack, {
      signal: AbortSignal.timeout(5000),
      maxOutputTokens: 512,
      idempotencyKey: "test",
    });
    expect(result.cost).toBe(0);
    expect(ModelAnswer.parse(result.value).claims[0]?.text).toBe("权限不可默认开启。");
    expect(ModelAnswer.parse(result.value).claims[0]?.evidenceIds).toEqual(["a".repeat(64)]);
    await expect(runtime.provider.generate({ ...pack, question: "未知证据" }, {
      signal: AbortSignal.timeout(5000), maxOutputTokens: 512, idempotencyKey: "bad",
    })).rejects.toMatchObject({ code: "INVALID_CITATION" });
    await expect(startLocalOllama("fixture:2", binary)).rejects.toThrow("UNAVAILABLE");
  } finally {
    runtime?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("cloud tags and remote URL syntax cannot become a local model name", () => {
  for (const name of ["remote/cloud", "qwen:cloud", "http://evil.invalid", "CloudModel:1"])
    expect(() => localModelName(name)).toThrow("VALIDATION");
});
