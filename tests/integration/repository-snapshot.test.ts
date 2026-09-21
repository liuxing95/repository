import { expect, test } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture } from "../helpers";
import { Ingestion } from "../../apps/service/src/ingestion/manifest";
import { localRevision } from "../../apps/service/src/ingestion/repository";
import { SourceCommit } from "../../apps/service/src/ingestion/commit";
const exec = promisify(execFile);
test("local Git snapshots freeze commit and dirty content; artifact mode keeps dist and never runs scripts", async () => {
  const f = await fixture();
  try {
    const git = (...args: string[]) => exec("git", ["-C", f.source, ...args]);
    await git("init");
    await git("add", "note.md");
    await git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
    const commit = (await git("rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(f.source, "note.md"), "dirty snapshot");
    await mkdir(join(f.source, "dist"));
    await writeFile(
      join(f.source, "dist/index.js"),
      "throw new Error('must never execute');",
    );
    await writeFile(
      join(f.source, "large.txt"),
      "version https://git-lfs.github.com/spec/v1\noid sha256:abcdef\nsize 10000\n",
    );
    await writeFile(
      join(f.source, ".gitmodules"),
      '[submodule "external"]\npath = external\nurl = https://example.com/private\n',
    );
    const ingestion = new Ingestion(f.registry, f.jobs);
    const source = await ingestion.preview(
      { id: randomUUID(), kind: "repository", entry: f.source },
      f.principal,
    );
    expect(
      source.entries.find((e) => e.metadata.path === "dist/index.js")?.selected,
    ).toBe(false);
    const artifact = await ingestion.preview(
      {
        id: randomUUID(),
        kind: "repository",
        entry: f.source,
        sourceType: "artifact",
      },
      f.principal,
    );
    expect(
      artifact.entries.find((e) => e.metadata.path === "dist/index.js")
        ?.selected,
    ).toBe(true);
    expect(
      artifact.entries
        .filter((e) => e.selected)
        .every(
          (e) => e.metadata.commit === commit && e.metadata.dirty === true,
        ),
    ).toBe(true);
    ingestion.freeze(
      artifact.id,
      artifact.digest,
      artifact.entries.filter((e) => e.selected).map((e) => e.id),
      f.principal,
    );
    await ingestion.run(
      f.jobs.claim("batch", 30000, "ingestion")!,
      new AbortController().signal,
    );
    const done = ingestion.get(artifact.id);
    const entry = done.entries.find((e) => e.metadata.path === "large.txt")!;
    expect(
      new SourceCommit(ingestion).parse(entry.parseId!).gaps.join(),
    ).toContain("LFS_POINTER");
    expect(await readFile(join(f.source, "dist/index.js"), "utf8")).toContain(
      "must never execute",
    );
    await git("add", "note.md");
    await git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "new head",
    );
    expect(ingestion.get(artifact.id).entries[0]!.metadata.commit).toBe(commit);
    const gitConfig = join(f.source, ".git/config");
    await writeFile(
      gitConfig,
      (await readFile(gitConfig, "utf8")) +
        "\n[include]\npath = /outside/authorized/root\n",
    );
    expect((await localRevision(f.source, "HEAD")).commit).toBeNull();
  } finally {
    await f.close();
  }
});

test.skipIf(process.env.KB_TEST_CORPUS !== "1")(
  "public GitHub import resolves HEAD once and fetches fixed-commit bytes",
  async () => {
    const f = await fixture();
    try {
      const ingestion = new Ingestion(f.registry, f.jobs);
      const batch = await ingestion.preview(
        {
          id: randomUUID(),
          kind: "repository",
          entry: "https://github.com/octocat/Hello-World",
          allowedHosts: ["api.github.com", "raw.githubusercontent.com"],
          maxPages: 3,
        },
        f.principal,
      );
      const entry = batch.entries.find((e) => e.selected)!;
      expect(entry.metadata.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(entry.final).toContain(`/${entry.metadata.commit}/`);
      expect(entry.objectHash).toMatch(/^[a-f0-9]{64}$/);
      ingestion.freeze(
        batch.id,
        batch.digest,
        batch.entries.filter((e) => e.selected).map((e) => e.id),
        f.principal,
      );
      await ingestion.run(
        f.jobs.claim("batch", 30000, "ingestion")!,
        new AbortController().signal,
      );
      expect(
        ingestion.get(batch.id).entries.find((e) => e.selected)?.status,
      ).toBe("acquired");
    } finally {
      await f.close();
    }
  },
);
