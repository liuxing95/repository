import { expect, test } from "vitest";
import { fixture } from "../helpers";
import { publish } from "../evidence-helpers";
import { EvidenceStore } from "../../apps/service/src/evidence/locator";
import { SearchService } from "../../apps/service/src/search/search";
import { LocalEmbeddings } from "../../apps/service/src/search/local-embeddings";
import { Policy } from "../../apps/service/src/security/policy";

test("local vectors are built and ranked only for sources with the embedding route", async () => {
  const f = await fixture();
  try {
    const allowed = publish(f, "认证令牌保存在本机。", "认证");
    const denied = publish(f, "私密令牌不得参与向量索引。", "私密");
    const evidence = new EvidenceStore(f.registry);
    const allowedId = evidence.register(allowed)[0]!.sourceId;
    const deniedId = evidence.register(denied)[0]!.sourceId;
    f.registry.saveSettings({
      schemaVersion: 1,
      budget: null,
      routes: [{ id: "local-vector", purpose: "embedding", enabled: true, price: null }],
    }, f.registry.get().policyVersion);
    const policy = new Policy(f.registry);
    const routes = (embedding: string[], read = ["local"]) => ({
      read, fetch: [], model: [], ocr: [], embedding,
      rerank: [], notification: [], calendar: [], publish: [],
    });
    policy.setSource({ sourceId: allowedId, retracted: false, routes: routes(["local-vector"]) });
    policy.setSource({ sourceId: deniedId, retracted: false, routes: routes([]) });
    f.principal = f.sessions.refresh(f.token);
    const search = new SearchService(evidence);
    const generation = (await search.indexer.ensure()).id;
    const inputs: string[] = [];
    const vectors = new LocalEmbeddings(evidence, "local-vector", "a".repeat(64), async (text) => {
      inputs.push(text);
      return text.includes("认证") ? [1, 0] : [0, 1];
    });
    expect((await vectors.build(generation, f.principal)).count).toBe(1);
    expect(inputs).toEqual(["认证令牌保存在本机。"]);
    expect((await vectors.rank("认证", generation, f.principal))[0]?.sourceId).toBe(allowedId);
    expect(inputs).toHaveLength(2);
    policy.setSource({ sourceId: allowedId, retracted: false, routes: routes(["local-vector"], []) });
    f.principal = f.sessions.refresh(f.token);
    expect(await vectors.rank("认证", generation, f.principal)).toEqual([]);
    expect(inputs).toHaveLength(2);
    policy.setSource({ sourceId: allowedId, retracted: true, routes: routes([]) });
    f.principal = f.sessions.refresh(f.token);
    expect(await vectors.rank("认证", generation, f.principal)).toEqual([]);
    expect(inputs).toHaveLength(2);
  } finally {
    await f.close();
  }
});
