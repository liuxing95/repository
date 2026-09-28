import { expect, test } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { AnswerResult } from "@kb/contracts";
import { fixture } from "../helpers";
import { publish } from "../evidence-helpers";
import { parseWeb } from "../../apps/service/src/ingestion/web-parser";
import { EvidenceStore } from "../../apps/service/src/evidence/locator";
import { SearchService } from "../../apps/service/src/search/search";
import { AnswerService } from "../../apps/service/src/answers/answer";
import { startLocalOllama } from "../../apps/service/src/answers/local-model";
import { Policy } from "../../apps/service/src/security/policy";
import { LocalEmbeddings } from "../../apps/service/src/search/local-embeddings";

type Question = { question: string; expected: string[]; unanswerable?: boolean };
const p95 = (samples: number[]) => samples.length
  ? [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1]!
  : null;
const guide = process.env.KB_LONG_DOCUMENT_PATH;
const questionsPath = resolve(
  process.env.KB_LONG_DOCUMENT_QUESTIONS ??
    ".context/runtime-validation/long-document/questions.json",
);

test.skipIf(!guide)("real long document reports passage recall and abstention separately", async () => {
  const questions = JSON.parse(await readFile(questionsPath, "utf8")) as Question[];
  const bytes = await readFile(guide!);
  const parsed = parseWeb(bytes, "https://local.invalid/guide", "utf-8", true);
  const f = await fixture();
  let runtime: Awaited<ReturnType<typeof startLocalOllama>> | undefined;
  // Match the Obsidian client's 15-second heartbeat during slow local inference.
  const sessionHeartbeat = setInterval(() => f.sessions.heartbeat(f.token), 15_000);
  try {
    const artifact = publish(f, bytes.toString("utf8"), parsed.title, {}, [], parsed);
    const evidence = new EvidenceStore(f.registry);
    if (process.env.KB_LOCAL_MODEL_BIN) {
      runtime = await startLocalOllama(
        process.env.KB_LOCAL_MODEL_NAME ?? "qwen2.5:3b",
        process.env.KB_LOCAL_MODEL_BIN,
        process.env.KB_LOCAL_EMBED ? "qwen3-embedding:0.6b" : undefined,
      );
      f.registry.saveSettings({
        schemaVersion: 1,
        budget: { currency: "USD", timezone: "Asia/Shanghai", jobLimit: 10, dayLimit: 0, monthLimit: 0 },
        routes: [{ id: "local-ollama", purpose: "model", enabled: true, price: {
          version: "local-zero-1", expiresAt: Date.now() + 86400_000,
          inputPerMillion: 0, outputPerMillion: 0, fixedCost: 0,
          maxInputTokens: 32768, maxOutputTokens: 1024,
        } }, ...(runtime.embed ? [{ id: "local-vector", purpose: "embedding" as const, enabled: true, price: null }] : [])],
      }, f.registry.get().policyVersion);
      new Policy(f.registry).setSource({
        sourceId: evidence.register(artifact)[0]!.sourceId,
        retracted: false,
        routes: { read: ["local"], fetch: [], model: ["local-ollama"], ocr: [], embedding: runtime.embed ? ["local-vector"] : [], rerank: [], notification: [], calendar: [], publish: [] },
      });
      f.principal = f.sessions.refresh(f.token);
    }
    const search = new SearchService(evidence);
    const answers = new AnswerService(search);
    const modelAnswers = runtime ? new AnswerService(search, new Map([["local-ollama", runtime.provider]])) : undefined;
    const generation = await search.indexer.ensure();
    const indexedChunks = (f.store.db.prepare(
      "SELECT count(*) AS count FROM search_documents WHERE generation=?",
    ).get(generation.id) as { count: number }).count;
    const vectors = runtime?.embed && runtime.embeddingDigest
      ? new LocalEmbeddings(evidence, "local-vector", runtime.embeddingDigest, runtime.embed)
      : undefined;
    const vectorBuildStarted = performance.now();
    const vectorBuild = vectors ? await vectors.build(generation.id, f.principal) : undefined;
    const vectorBuildMs = vectors ? performance.now() - vectorBuildStarted : null;
    const modelLimit = Number(process.env.KB_LOCAL_MODEL_LIMIT ?? questions.length);
    const modelIndices = process.env.KB_LOCAL_MODEL_INDICES
      ? new Set(process.env.KB_LOCAL_MODEL_INDICES.split(",").map((value) => Number(value)))
      : undefined;
    const shouldGenerate = (index: number) => modelIndices ? modelIndices.has(index) : index < modelLimit;
    const rows = [];
    for (const [questionIndex, item] of questions.entries()) {
      const searchStarted = performance.now();
      const result = await search.search({ query: item.question, limit: 10 }, f.principal);
      const lexicalMs = performance.now() - searchStarted;
      const answer = await answers.answer(
        { snapshotId: result.snapshot.id, operationId: randomUUID() },
        f.principal,
      );
      let generated: AnswerResult | undefined;
      let modelError: string | undefined;
      if (modelAnswers && shouldGenerate(questionIndex)) {
        try {
          generated = await modelAnswers.answer(
            { snapshotId: result.snapshot.id, operationId: randomUUID(), routeId: "local-ollama" },
            f.principal,
          );
        } catch (error) {
          modelError = error instanceof Error ? error.message : String(error);
        }
      }
      const vectorStarted = performance.now();
      const ranked = vectors ? await vectors.rank(item.question, result.snapshot.generation, f.principal) : [];
      const vectorMs = vectors ? performance.now() - vectorStarted : null;
      const vectorHits = ranked.map((row) => evidence.read(row.evidenceId));
      rows.push({
        question: item.question,
        expected: item.expected.length,
        foundInHits: item.expected.filter((phrase) => result.hits.some((hit) =>
          hit.text.includes(phrase) || (hit.locator.heading ?? []).some((heading) => heading.includes(phrase)))).length,
        foundInAnswer: item.expected.filter((phrase) => answer.evidence.some((e) =>
          e.text.includes(phrase) || (e.locator.heading ?? []).some((heading) => heading.includes(phrase)))).length,
        unanswerable: !!item.unanswerable,
        abstained: answer.status === "insufficient",
        hitCount: result.hits.length,
        evidenceCount: answer.evidence.length,
        lexicalMs,
        vectorMs,
        foundInVectors: item.expected.filter((phrase) => vectorHits.some((hit) =>
          hit.text.includes(phrase) || (hit.locator.heading ?? []).some((heading) => heading.includes(phrase)))).length,
        model: generated ? {
          status: generated.status,
          mode: generated.mode,
          claimCount: generated.claims.length,
          chapterCoverage: item.expected.filter((phrase) => {
            const chapter = /^\d+(?:\.\d+)+/.exec(phrase)?.[0];
            return chapter && generated.claims.some((claim) => claim.text.includes(chapter));
          }).length,
          questionEcho: generated.claims.some((claim) => claim.text.trim() === item.question.trim()),
          claims: generated.claims.map((claim) => ({ kind: claim.kind, text: claim.text, evidenceIds: claim.evidenceIds })),
          gaps: generated.gaps,
        } : modelError ? { error: modelError } : null,
        hitHeadings: result.hits.map((hit) => hit.locator.heading?.at(-1) ?? ""),
        answerHeadings: answer.evidence.map((item) => item.locator.heading?.at(-1) ?? ""),
        answerSizes: answer.evidence.map((item) => item.text.length),
      });
    }
    const report = {
      measuredAt: new Date().toISOString(),
      documentBytes: bytes.length,
      parsedCharacters: parsed.text.length,
      parsedBlocks: parsed.blocks.length,
      indexedChunks,
      model: runtime?.provider.model ?? null,
      embeddingModel: runtime?.embeddingModel ?? null,
      vectorBuild: vectorBuild ?? null,
      vectorBuildMs,
      lexicalP95Ms: p95(rows.map((row) => row.lexicalMs)),
      vectorP95Ms: p95(rows.flatMap((row) => row.vectorMs === null ? [] : [row.vectorMs])),
      questions: rows,
    };
    await writeFile(
      resolve(".context/runtime-validation/long-document/evaluation.json"),
      JSON.stringify(report, null, 2),
    );
    expect(parsed.blocks.length).toBeGreaterThan(100);
    expect(rows.length).toBeGreaterThan(0);
    if (modelAnswers && questions.some((_item, index) => shouldGenerate(index)))
      expect(rows.some((row) => row.model && "status" in row.model)).toBe(true);
  } finally {
    clearInterval(sessionHeartbeat);
    runtime?.close();
    await f.close();
  }
}, 600_000);
