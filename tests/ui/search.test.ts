// @vitest-environment jsdom
import { test, expect, vi } from "vitest";
import { Scope, type SearchResult } from "@kb/contracts";
import { renderSearch } from "../../apps/obsidian-plugin/src/views/search";
import { Connection } from "../../apps/obsidian-plugin/src/connection";
function result(id: string, query: string): SearchResult {
  return {
    snapshot: {
      id,
      generation: "generation",
      principalId: "principal",
      createdAt: 0,
      expiresAt: Date.now() + 60000,
      parseIds: [],
      revisionIds: [],
      pageRevisions: [],
      evidenceIds: [],
      evidenceState: "",
      warnings: [],
      policyVersion: 1,
      input: { query, scope: Scope.parse({}), limit: 10 },
    },
    hits: [],
    index: {
      generation: "generation",
      state: "complete",
      blocks: 0,
      fingerprint: "fixture",
    },
    warnings: [],
  };
}
test("an old permission poll cannot erase a newer query; displayed query is the frozen input", async () => {
  vi.useFakeTimers();
  const root = document.createElement("section");
  document.body.append(root);
  const connection = new Connection(
    async () => ({ status: 200, json: {} }),
    "/fixture",
    "device",
  );
  let rejectOld: (error: Error) => void = () => {};
  const request = vi.spyOn(connection, "request");
  request.mockResolvedValueOnce(result("first", "旧问题"));
  const draft = { query: "旧问题", version: "", collection: "" };
  renderSearch(root, connection, draft);
  const search = [...root.querySelectorAll("button")].find(
    (b) => b.textContent === "搜索原文",
  )!;
  search.click();
  await vi.waitFor(() => expect(root.textContent).toContain("快照 first"));
  request.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectOld = reject;
      }),
  );
  await vi.advanceTimersByTimeAsync(5000);
  draft.query = "<img src=x onerror=alert(1)>";
  request.mockResolvedValueOnce(result("second", draft.query));
  search.click();
  await vi.waitFor(() => expect(root.textContent).toContain("快照 second"));
  rejectOld(new Error("old session"));
  await Promise.resolve();
  await Promise.resolve();
  expect(root.textContent).toContain("快照 second");
  expect(root.querySelector("img")).toBeNull();
  root.remove();
  await vi.advanceTimersByTimeAsync(5000);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("model response budget outlasts the provider timeout while retaining a finite client deadline", async () => {
  vi.useFakeTimers();
  try {
    const connection = new Connection(
      () => new Promise(() => {}),
      "/fixture",
      "device",
    );
    const response = connection.request("/v1/answers", "POST", {});
    const failure = expect(response).rejects.toThrow("CONNECTION_TIMEOUT");
    await vi.advanceTimersByTimeAsync(35000);
    await failure;
  } finally {
    vi.useRealTimers();
  }
});
