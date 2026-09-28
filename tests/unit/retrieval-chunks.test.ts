import { expect, test } from "vitest";
import { retrievalChunks, MAX_CHUNK_CHARS } from "../../apps/service/src/search/chunks";
import type { ParseArtifact } from "@kb/contracts";

test("long text is bounded, overlapping and maps exactly to the parsed source", () => {
  const text = "条件😀。".repeat(1500);
  const parsed = {
    text,
    blocks: [{ text, start: 0, end: text.length, locator: { heading: ["条件"] } }],
  } as ParseArtifact;
  const chunks = retrievalChunks(parsed);
  expect(chunks.length).toBeGreaterThan(2);
  for (const [index, chunk] of chunks.entries()) {
    expect(chunk.text).toBe(text.slice(chunk.start, chunk.end));
    expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    expect(chunk.text).not.toMatch(/^[\uDC00-\uDFFF]/);
    expect(chunk.text).not.toMatch(/[\uD800-\uDBFF]$/);
    if (index) expect(chunk.start).toBeLessThan(chunks[index - 1]!.end);
  }
});
