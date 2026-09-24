import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Purpose } from "@kb/contracts";
import { wikiFixture } from "../wiki-helpers";
import { Policy } from "../../apps/service/src/security/policy";
import { Publications } from "../../apps/service/src/publishing/release";
import { Retraction } from "../../apps/service/src/lifecycle/retraction";
import { hashBytes } from "../../apps/service/src/ingestion/objects";
import { catalogue } from "../../apps/service/src/lifecycle/backup";

test.skipIf(process.env.KB_TEST_OCI !== "1")(
  "real Wiki revision builds in OCI, approved bytes reach local site and retract with the source",
  async () => {
    const f = await wikiFixture();
    try {
      await f.apply(f.prepare("candidate"));
      const wiki = await f.apply(f.prepare("wiki"));
      const page = f.proposals.page(wiki.patches[0]!.pageId)!;
      const sourceId = f.evidence.read(page.evidenceIds[0]!).sourceId;
      f.registry.saveSettings(
        {
          schemaVersion: 1,
          budget: null,
          routes: [
            {
              id: "local-site",
              purpose: "publish",
              enabled: true,
              price: null,
            },
          ],
        },
        f.registry.get().policyVersion,
      );
      new Policy(f.registry).setSource({
        sourceId,
        retracted: false,
        routes: Object.fromEntries(
          Purpose.options.map((purpose) => [
            purpose,
            purpose === "read"
              ? ["local"]
              : purpose === "publish"
                ? ["local-site"]
                : [],
          ]),
        ),
      });
      const principal = f.sessions.refresh(f.token);
      const publications = new Publications(f.evidence);
      const preview = await publications.build(
        {
          operationId: randomUUID(),
          revisionIds: [page.revisionId],
          routeId: "local-site",
          decisions: {},
        },
        principal,
      );
      publications.approve(
        preview.manifest.id,
        preview.manifest.digest,
        preview.manifest.outputDigest,
        principal,
      );
      const release = await publications.release(
        preview.manifest.id,
        randomUUID(),
        preview.manifest.digest,
        preview.manifest.outputDigest,
        principal,
      );
      expect(release.state).toBe("published-local");
      for (const item of preview.manifest.output)
        expect(
          hashBytes(
            await readFile(join(f.data, "public-site", "current", item.path)),
          ),
        ).toBe(item.hash);
      expect(
        (await catalogue(f.data)).some((file) =>
          file.path.startsWith("public-site/"),
        ),
      ).toBe(false);
      const impact = new Retraction(f.registry).retract(
        sourceId,
        principal.id,
        "撤回公开权",
      );
      expect(impact.publications).toMatchObject([
        { releaseId: release.id, state: "withdrawn" },
      ]);
    } finally {
      await f.close();
    }
  },
  60_000,
);
