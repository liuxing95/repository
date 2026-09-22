import { randomUUID } from "node:crypto";
import {
  ProposalInput,
  type Principal,
  type WikiChangeSet,
  type WikiPage,
} from "@kb/contracts";
import { Candidates } from "./candidates";
import { compileCandidate } from "../wiki/bounded-compiler";
import { EvidenceStore } from "../evidence/locator";
import { digest } from "../workspace/registry";
import { hashBytes } from "../ingestion/objects";
import { AppError } from "../errors";
import { authorize } from "../http/auth";
export function proposalDigest(c: WikiChangeSet) {
  const {
    id,
    candidateId,
    candidateHash,
    destination,
    purpose,
    patches,
    evidence,
    deferred,
    policyVersion,
    epoch,
    createdBy,
    createdAt,
  } = c;
  return digest({
    id,
    candidateId,
    candidateHash,
    destination,
    purpose,
    patches,
    evidence,
    deferred,
    policyVersion,
    epoch,
    createdBy,
    createdAt,
  });
}
export class Proposals {
  readonly candidates: Candidates;
  constructor(
    readonly evidence: EvidenceStore,
    readonly now = Date.now,
  ) {
    this.candidates = new Candidates(evidence);
  }
  get store() {
    return this.evidence.store;
  }
  write(p: Principal, version = p.policyVersion) {
    this.evidence.checkPrincipal(p);
    authorize(this.evidence.registry, p, ["admin", "user"], version, true);
  }
  raw(id: string): WikiChangeSet {
    const row = this.store.db
      .prepare("SELECT value FROM wiki_changes WHERE id=?")
      .get(id) as { value: string } | undefined;
    if (!row) throw new AppError("NOT_FOUND", 404);
    const c = JSON.parse(row.value) as WikiChangeSet;
    if (proposalDigest(c) !== c.digest) throw new AppError("HASH_MISMATCH");
    c.receipts = (
      this.store.db
        .prepare(
          "SELECT sequence FROM wiki_receipts WHERE change_id=? ORDER BY sequence",
        )
        .all(id) as { sequence: number }[]
    ).map((r) => r.sequence);
    return c;
  }
  read(id: string, p: Principal) {
    const c = this.raw(id);
    this.evidence.checkPrincipal(p);
    this.references(c);
    return c;
  }
  references(c: WikiChangeSet) {
    for (const e of c.evidence) {
      const current = this.evidence.read(e.id);
      if (digest(e) !== digest(current)) throw new AppError("BASELINE");
    }
    const row = this.store.db
      .prepare("SELECT value FROM answer_candidates WHERE id=?")
      .get(c.candidateId) as { value: string } | undefined;
    if (!row || digest(JSON.parse(row.value)) !== c.candidateHash)
      throw new AppError("BASELINE");
  }
  save(c: WikiChangeSet) {
    this.store.writable();
    this.store.db
      .prepare("UPDATE wiki_changes SET value=? WHERE id=?")
      .run(JSON.stringify(c), c.id);
  }
  observation(pageId: string) {
    return this.store.db
      .prepare(
        "SELECT id,hash,value FROM wiki_observations WHERE page_id=? AND json_extract(value,'$.baseRevision')=(SELECT revision_id FROM wiki_pages WHERE id=wiki_observations.page_id) ORDER BY rowid DESC LIMIT 1",
      )
      .get(pageId) as
      { id: string; hash: string | null; value: string } | undefined;
  }
  page(pageId: string): WikiPage | undefined {
    const row = this.store.db
      .prepare(
        "SELECT r.value FROM wiki_pages p JOIN wiki_revisions r ON p.revision_id=r.id WHERE p.id=?",
      )
      .get(pageId) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as WikiPage) : undefined;
  }
  baseline(c: WikiChangeSet) {
    for (const patch of c.patches) {
      const current = this.page(patch.pageId);
      if ((current?.revisionId ?? null) !== patch.beforeRevision)
        throw new AppError("BASELINE");
      const observation = this.observation(patch.pageId);
      // Observing our own applied bytes is permitted; a third version invalidates the approval.
      if (
        observation &&
        observation.id !== patch.observationId &&
        observation.hash !== patch.afterHash
      )
        throw new AppError("BASELINE");
    }
  }
  prepare(value: unknown, p: Principal) {
    this.write(p);
    const input = ProposalInput.parse(value);
    return this.store.tx(() => {
      const key = `${p.id}:${input.operationId}`,
        inputHash = digest(input);
      const old = this.store.db
        .prepare("SELECT id,input_hash FROM wiki_changes WHERE operation_key=?")
        .get(key) as { id: string; input_hash: string } | undefined;
      if (old) {
        if (old.input_hash !== inputHash) throw new AppError("CONFLICT");
        return this.read(old.id, p);
      }
      const candidate = this.candidates.get(input.candidateId, p);
      if (
        input.destination === "wiki" &&
        !this.store.db
          .prepare(
            "SELECT id FROM wiki_changes WHERE json_extract(value,'$.candidateId')=? AND json_extract(value,'$.destination')='candidate' AND json_extract(value,'$.state')='committed'",
          )
          .get(candidate.id)
      )
        throw new AppError(
          "CANDIDATE_NOT_SAVED",
          409,
          "先审核并写入候选区，再单独提升为 Wiki。",
        );
      const compiled = compileCandidate(candidate, input);
      const matchKey = digest({
        kind: input.kind,
        title: input.title.normalize("NFKC").toLowerCase(),
      });
      const existing =
        input.destination === "wiki"
          ? (this.store.db
              .prepare("SELECT id FROM wiki_pages WHERE match_key=?")
              .get(matchKey) as { id: string } | undefined)
          : undefined;
      const stableId = `${matchKey.slice(0, 8)}-${matchKey.slice(8, 12)}-4${matchKey.slice(13, 16)}-8${matchKey.slice(17, 20)}-${matchKey.slice(20, 32)}`;
      const pageId =
        existing?.id ??
        (input.destination === "candidate" ? candidate.id : stableId);
      const page = this.page(pageId);
      if (page)
        for (const evidenceId of page.evidenceIds)
          this.evidence.read(evidenceId);
      const observation = this.observation(pageId);
      const beforeContent = observation
        ? (JSON.parse(observation.value) as { content: string | null }).content
        : (page?.content ?? null);
      const w = this.evidence.registry.get();
      const c: WikiChangeSet = {
        id: randomUUID(),
        candidateId: candidate.id,
        candidateHash: digest(candidate),
        destination: input.destination,
        purpose: `${input.destination === "candidate" ? "保存候选" : "提升或更新 Wiki"}：${input.title}`,
        patches: [],
        evidence: [
          ...new Map(
            [
              ...candidate.answer.evidence,
              ...(page?.evidenceIds ?? []).map((id) => this.evidence.read(id)),
            ].map((e) => [e.id, e]),
          ).values(),
        ],
        deferred: compiled.deferred,
        digest: "",
        policyVersion: w.policyVersion,
        epoch: w.epoch,
        createdBy: p.id,
        createdAt: this.now(),
        state: "prepared",
        approvedBy: null,
        approvalId: null,
        expiresAt: null,
        receipts: [],
        rejection: null,
      };
      const previouslySaved =
        input.destination === "candidate" &&
        this.store.db
          .prepare(
            "SELECT id FROM wiki_changes WHERE json_extract(value,'$.candidateId')=? AND json_extract(value,'$.destination')='candidate' AND json_extract(value,'$.state')='committed'",
          )
          .get(candidate.id);
      if (
        previouslySaved ||
        (page?.hash === hashBytes(compiled.content) &&
          (observation ? observation.hash : page.hash) === page.hash)
      )
        c.state = "no_change";
      else
        c.patches = [
          {
            sequence: 0,
            path: `${input.destination === "wiki" ? "KB-Wiki" : "KB-Candidates"}/${pageId}.md`,
            pageId,
            revisionId: randomUUID(),
            title: input.title,
            kind: input.kind,
            beforeRevision: page?.revisionId ?? null,
            beforeContent,
            beforeHash:
              beforeContent === null ? null : hashBytes(beforeContent),
            afterHash: hashBytes(compiled.content),
            content: compiled.content,
            observationId: observation?.id ?? null,
            evidenceIds: candidate.answer.evidence.map((e) => e.id),
            claims: compiled.claims,
          },
        ];
      c.digest = proposalDigest(c);
      this.store.db
        .prepare("INSERT INTO wiki_changes VALUES(?,?,?,?)")
        .run(c.id, key, inputHash, JSON.stringify(c));
      this.store.event("wiki.prepared", c.id);
      return c;
    });
  }
  list(p: Principal) {
    this.evidence.checkPrincipal(p);
    return (
      this.store.db
        .prepare("SELECT id FROM wiki_changes ORDER BY rowid DESC LIMIT 100")
        .all() as { id: string }[]
    ).flatMap(({ id }) => {
      try {
        const c = this.read(id, p);
        return [
          {
            id,
            state: c.state,
            purpose: c.purpose,
            receipts: c.receipts.length,
            total: c.patches.length,
          },
        ];
      } catch (e) {
        if (e instanceof AppError) return [];
        throw e;
      }
    });
  }
}
