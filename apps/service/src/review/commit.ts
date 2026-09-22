import type { Principal, WikiPage } from "@kb/contracts";
import { Proposals } from "./proposals";
import { Approvals } from "./approval";
import { digest } from "../workspace/registry";
import { AppError } from "../errors";
import { tokenize } from "../search/tokenizer";
export class WikiCommit {
  constructor(readonly proposals: Proposals) {}
  finish(id: string, hashes: string[], p: Principal) {
    return this.proposals.store.tx(() => {
      const c = this.proposals.read(id, p);
      this.proposals.write(p);
      if (c.state === "committed") return c;
      new Approvals(this.proposals).check(c, p);
      if (
        c.receipts.length !== c.patches.length ||
        hashes.length !== c.patches.length ||
        c.patches.some((patch, i) => patch.afterHash !== hashes[i])
      )
        throw new AppError("INCOMPLETE");
      if (c.destination === "wiki")
        for (const patch of c.patches) {
          const page: WikiPage = {
            pageId: patch.pageId,
            revisionId: patch.revisionId,
            path: patch.path,
            title: patch.title,
            kind: patch.kind,
            content: patch.content,
            hash: patch.afterHash,
            evidenceIds: patch.evidenceIds,
            claims: patch.claims,
            committedAt: this.proposals.now(),
            review: "reviewed",
          };
          this.proposals.store.db
            .prepare("INSERT INTO wiki_revisions VALUES(?,?,?,?)")
            .run(page.revisionId, page.pageId, c.id, JSON.stringify(page));
          const matchKey = digest({
            kind: page.kind,
            title: page.title.normalize("NFKC").toLowerCase(),
          });
          this.proposals.store.db
            .prepare(
              "INSERT INTO wiki_pages VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision_id=excluded.revision_id",
            )
            .run(page.pageId, page.path, matchKey, page.revisionId);
          for (const evidenceId of page.evidenceIds)
            this.proposals.store.db
              .prepare("INSERT INTO wiki_edges VALUES(?,?)")
              .run(page.revisionId, evidenceId);
          this.proposals.store.db
            .prepare(
              "INSERT INTO wiki_fts(revision_id,title,terms) VALUES(?,?,?)",
            )
            .run(
              page.revisionId,
              [
                ...tokenize(page.title, true).terms,
                ...tokenize(page.title, true).symbols,
              ].join(" "),
              [
                ...tokenize(page.content, true).terms,
                ...tokenize(page.content, true).symbols,
              ].join(" "),
            );
        }
      c.state = "committed";
      this.proposals.save(c);
      this.proposals.store.event("wiki.committed", id);
      if (c.destination === "wiki") {
        this.proposals.store.set("wiki:snapshot", c.id);
        this.proposals.store.event("wiki.index_ready", id);
      }
      return c;
    });
  }
}
