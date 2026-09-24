import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { parseIsolated } from "../../apps/service/src/ingestion/parser";
import { enhancementOptions } from "../../apps/service/src/ingestion/enhancement";
const parse = async (name: string, password?: string) =>
  parseIsolated({
    bytes: await readFile(`tests/fixtures/ingestion/${name}`),
    kind: "pdf",
    url: "",
    title: name,
    encoding: "utf-8",
    password,
  });
test("real PDF physical pages, printed labels, coordinates and layout gaps remain separate", async () => {
  const pdf = await parse("labelled_pages.pdf");
  expect(pdf.pages).toBeGreaterThan(1);
  expect(
    pdf.pageLabels?.some((label, i) => label && label !== String(i + 1)),
  ).toBe(true);
  const textPdf = await parse("basicapi.pdf");
  expect(textPdf.blocks.length).toBeGreaterThan(0);
  for (const block of textPdf.blocks) {
    expect(block.locator.rect).toHaveLength(4);
    expect(textPdf.text.slice(block.start, block.end)).toBe(block.text);
  }
  expect(pdf.gaps.join()).toContain("LAYOUT_UNVERIFIED");
});
test("encrypted and image PDFs preserve gaps without any OCR route", async () => {
  const encrypted = await parse("encrypted-attachment.pdf");
  expect(encrypted.gaps.join()).toContain("PASSWORD_REQUIRED");
  const opened = await parse("encrypted-attachment.pdf", "000000");
  expect(opened.pages).toBeGreaterThan(0);
  expect(opened.gaps.join()).not.toContain("PASSWORD_REQUIRED");
  const scan = await parse("scan-bad.pdf");
  expect(scan.gaps.join()).toContain("LAYOUT_UNVERIFIED");
  const empty = await parse("empty_protected.pdf");
  expect(empty.gaps.join()).toContain("SCAN_OR_EMPTY");
  expect(enhancementOptions([1])).toMatchObject({
    enabled: false,
    externalBytes: 0,
    provider: null,
  });
});
