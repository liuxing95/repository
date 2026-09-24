import type { Principal, PublicationInput, WikiPage } from "@kb/contracts";
import { AppError } from "../errors";
import { EvidenceStore } from "../evidence/locator";
import { Proposals } from "../review/proposals";
import { Policy } from "../security/policy";
import { readPage } from "../wiki/impact";
import { hashBytes } from "../ingestion/objects";
import { dependencies, transformPage } from "./transform";
import { readPublicAttachment } from "./attachments";

export class PublicationManifestBuilder {
  readonly proposals: Proposals;
  constructor(readonly evidence: EvidenceStore) {
    this.proposals = new Proposals(evidence);
  }
  pages(revisionIds: string[], principal: Principal) {
    if (new Set(revisionIds).size !== revisionIds.length)
      throw new AppError("VALIDATION", 400);
    return revisionIds.map((revisionId) => {
      const page = readPage(this.proposals, revisionId, principal);
      const current = this.proposals.store.db
        .prepare("SELECT revision_id FROM wiki_pages WHERE id=?")
        .get(page.pageId) as { revision_id: string } | undefined;
      if (current?.revision_id !== revisionId || page.review !== "reviewed")
        throw new AppError(
          "BASELINE",
          409,
          "仅能导出当前已审核且未被人工改动的 Wiki 修订。",
        );
      return page;
    });
  }
  inspect(revisionIds: string[], principal: Principal) {
    const pages = this.pages(revisionIds, principal);
    return {
      pages: pages.map((p) => ({
        pageId: p.pageId,
        revisionId: p.revisionId,
        title: p.title,
        sourceIds: this.sourceIds(p),
      })),
      dependencies: pages.flatMap((p) => dependencies(p.pageId, p.content)),
    };
  }
  sourceIds(page: WikiPage) {
    return [
      ...new Set(page.evidenceIds.map((id) => this.evidence.read(id).sourceId)),
    ].sort();
  }
  prepare(
    input: PublicationInput,
    principal: Principal,
    requirePublish = true,
  ) {
    const pages = this.pages(input.revisionIds, principal);
    const sourceIds = [
      ...new Set(pages.flatMap((page) => this.sourceIds(page))),
    ];
    if (!sourceIds.length)
      throw new AppError("FORBIDDEN", 403, "没有可核验的正式来源，不能发布。");
    if (requirePublish)
      new Policy(this.evidence.registry).allow(
        principal,
        this.evidence.registry.get().policyVersion,
        "publish",
        input.routeId,
        sourceIds,
      );
    const included = new Map<string, ReturnType<typeof readPublicAttachment>>();
    for (const page of pages)
      for (const dep of dependencies(page.pageId, page.content)) {
        if (
          input.decisions[dep.token]?.action === "include" &&
          !included.has(dep.token)
        ) {
          if (included.size >= 4)
            throw new AppError("LIMIT", 409, "单次最多公开四个文本附件。");
          included.set(
            dep.token,
            readPublicAttachment(
              this.evidence.registry.get().vaultPath,
              dep.token,
            ),
          );
        }
      }
    const includedPaths = Object.fromEntries(
      [...included].map(([token, attachment]) => [token, attachment.path]),
    );
    const transformed = pages.map((page) => ({
      page,
      ...transformPage(
        page.pageId,
        page.content,
        input.decisions,
        includedPaths,
      ),
    }));
    return {
      pages: transformed.map(({ page, body }) => ({
        pageId: page.pageId,
        revisionId: page.revisionId,
        title: page.title,
        kind: page.kind,
        sourceIds: this.sourceIds(page),
        bodyHash: hashBytes(body),
        body,
        file: `${page.pageId}.html`,
      })),
      dependencies: transformed.flatMap((t) => t.dependencies),
      outboundLinks: [
        ...new Set(transformed.flatMap((t) => t.outboundLinks)),
      ].sort(),
      attachments: [...included.values()],
    };
  }
}
