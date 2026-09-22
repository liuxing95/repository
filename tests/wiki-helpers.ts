import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./helpers";
import { publish } from "./evidence-helpers";
import { EvidenceStore } from "../apps/service/src/evidence/locator";
import { SearchService } from "../apps/service/src/search/search";
import { AnswerService } from "../apps/service/src/answers/answer";
import { Proposals } from "../apps/service/src/review/proposals";
import { Approvals } from "../apps/service/src/review/approval";
import { WriterSession } from "../apps/service/src/review/writer-session";
import { WikiCommit } from "../apps/service/src/review/commit";
import { Connection } from "../apps/obsidian-plugin/src/connection";
import {
  applyGrant,
  type WriterHost,
} from "../apps/obsidian-plugin/src/writer/apply";
import type { WikiChangeSet } from "@kb/contracts";
export async function wikiFixture() {
  const f = await fixture();
  const artifact = publish(
    f,
    "权限默认关闭。未经批准不能自动写入。",
    "权限说明",
  );
  const evidence = new EvidenceStore(f.registry),
    search = new SearchService(evidence),
    answers = new AnswerService(search);
  const result = await search.search({ query: "权限" }, f.principal);
  const answer = await answers.answer(
    { snapshotId: result.snapshot.id, operationId: randomUUID() },
    f.principal,
  );
  answers.candidate(answer.id, f.principal);
  let now = Date.now();
  const proposals = new Proposals(evidence, () => now),
    approvals = new Approvals(proposals),
    writer = new WriterSession(proposals),
    commit = new WikiCommit(proposals);
  const connection = new Connection(
    async () => {
      throw new Error("unused");
    },
    f.registry.get().vaultPath,
    f.deviceId,
  );
  connection.principal = f.principal;
  connection.workspace = f.registry.get();
  let editing = false;
  const host: WriterHost = {
    root: connection.vaultPath,
    isEditing: () => editing,
    read: async (path) => {
      try {
        return await readFile(join(connection.vaultPath, path), "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
    create: async (path, content) => {
      await writeFile(join(connection.vaultPath, path), content, {
        flag: "wx",
      });
    },
    process: async (path, fn) => {
      const target = join(connection.vaultPath, path);
      writeFileSync(target, fn(readFileSync(target, "utf8")));
    },
  };
  const prepare = (destination: "candidate" | "wiki", title = "权限概念") =>
    proposals.prepare(
      { operationId: randomUUID(), candidateId: answer.id, destination, title },
      f.principal,
    );
  const apply = async (c: WikiChangeSet) => {
    approvals.approve(c.id, c.digest, f.principal);
    for (const patch of c.patches) {
      const g = writer.grant(c.id, patch.sequence, f.principal);
      writer.receipt(
        g.token,
        await applyGrant(host, connection, g),
        f.principal,
      );
    }
    return commit.finish(
      c.id,
      c.patches.map((p) => p.afterHash),
      f.principal,
    );
  };
  return {
    ...f,
    artifact,
    evidence,
    search,
    answers,
    answer,
    proposals,
    approvals,
    writer,
    commit,
    connection,
    host,
    prepare,
    apply,
    setEditing: (v: boolean) => {
      editing = v;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}
