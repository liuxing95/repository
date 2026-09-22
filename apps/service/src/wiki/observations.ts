import { randomUUID } from "node:crypto";
import type { Principal } from "@kb/contracts";
import { z } from "zod";
import { Proposals } from "../review/proposals";
import { hashBytes } from "../ingestion/objects";
import { AppError } from "../errors";
export const ObservationInput = z
  .object({
    pageId: z.string().uuid(),
    content: z.string().max(128000).nullable(),
  })
  .strict();
export function observe(proposals: Proposals, value: unknown, p: Principal) {
  proposals.write(p);
  const input = ObservationInput.parse(value);
  const page = proposals.page(input.pageId);
  if (!page) throw new AppError("NOT_FOUND", 404);
  for (const id of page.evidenceIds) proposals.evidence.read(id);
  const hash = input.content === null ? null : hashBytes(input.content);
  const previous = proposals.observation(page.pageId);
  if (previous?.hash === hash || (!previous && page.hash === hash))
    return { changed: false };
  return proposals.store.tx(() => {
    const id = randomUUID();
    const observation = {
      id,
      pageId: page.pageId,
      baseRevision: page.revisionId,
      content: input.content,
      hash,
      at: proposals.now(),
      principalId: p.id,
      review: "unverified",
    };
    proposals.store.db
      .prepare("INSERT INTO wiki_observations VALUES(?,?,?,?)")
      .run(id, page.pageId, hash, JSON.stringify(observation));
    proposals.store.db
      .prepare("INSERT INTO wiki_impacts VALUES(?,?)")
      .run(
        id,
        JSON.stringify({
          pageId: page.pageId,
          observationId: id,
          reason: "manual-change",
          evidenceIds: page.evidenceIds,
        }),
      );
    proposals.store.event("wiki.observed", page.pageId);
    return { changed: true, id, review: "unverified" };
  });
}
