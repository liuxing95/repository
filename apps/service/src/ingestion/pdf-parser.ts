import { getDocument, version } from "pdfjs-dist/legacy/build/pdf.mjs";
import { appendBlock, baseParsed } from "./web-parser";
export async function parsePdf(
  bytes: Uint8Array,
  title: string,
  password?: string,
) {
  const parsed = baseParsed(title, `pdfjs-${version}/1`, "pdf-text");
  const task = getDocument({
    data: new Uint8Array(bytes),
    password,
    useSystemFonts: false,
    disableFontFace: true,
    useWasm: false,
    useWorkerFetch: false,
    stopAtErrors: true,
  });
  try {
    const pdf = await task.promise;
    parsed.pages = pdf.numPages;
    const labels = await pdf.getPageLabels();
    parsed.pageLabels = Array.from(
      { length: pdf.numPages },
      (_, i) => labels?.[i] ?? null,
    );
    for (
      let pageNumber = 1;
      pageNumber <= Math.min(pdf.numPages, 200);
      pageNumber++
    ) {
      try {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        let chars = 0;
        for (const item of content.items) {
          if (!("str" in item)) continue;
          chars += item.str.length;
          appendBlock(parsed, item.str, "text", {
            page: pageNumber,
            pageLabel: labels?.[pageNumber - 1] ?? null,
            rect: [
              item.transform[4]!,
              item.transform[5]!,
              item.width,
              item.height,
            ],
          });
          if (parsed.text.length > 2_000_000) throw new Error("TEXT_LIMIT");
        }
        if (!chars)
          parsed.gaps.push(
            `SCAN_OR_EMPTY：物理页 ${pageNumber} 无可提取文字，未执行 OCR。`,
          );
        parsed.gaps.push(
          `LAYOUT_UNVERIFIED：物理页 ${pageNumber} 的表格、列顺序、公式和图像未确认；请核对原页。`,
        );
        page.cleanup();
      } catch {
        parsed.gaps.push(`PAGE_FAILED：物理页 ${pageNumber} 解析失败。`);
      }
    }
    if (pdf.numPages > 200)
      parsed.gaps.push("PAGE_LIMIT：只解析前 200 页；其余页原件保留。");
  } catch (error) {
    parsed.gaps.push(
      error instanceof Error && error.name === "PasswordException"
        ? "PASSWORD_REQUIRED：需要本次处理的临时密码。"
        : "PDF_INVALID：原件保留，无法解析。",
    );
  } finally {
    await task.destroy();
  }
  return parsed;
}
