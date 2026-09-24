import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import type { Block, Parsed } from "@kb/contracts";
import { hashBytes } from "./objects";
export function baseParsed(
  title: string,
  parser: string,
  encoding: string,
): Parsed {
  return {
    title,
    parser,
    encoding,
    locatorVersion: 1,
    text: "",
    blocks: [],
    gaps: [],
    links: [],
    canonicalClaim: null,
    declaredPublishedAt: null,
    confirmedPublishedAt: null,
    publicationEvidence: null,
  };
}
export function appendBlock(
  parsed: Parsed,
  text: string,
  kind: Block["kind"],
  locator: Block["locator"],
) {
  if (!text) return;
  const start = parsed.text.length;
  parsed.text += text;
  parsed.blocks.push({
    id: `b${parsed.blocks.length + 1}`,
    text,
    hash: hashBytes(text),
    start,
    end: parsed.text.length,
    kind,
    locator,
  });
  parsed.text += "\n";
}
export function parseText(
  bytes: Uint8Array,
  title: string,
  encoding: string,
  path?: string,
) {
  const parsed = baseParsed(title, "text-lines/1", encoding);
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    parsed.gaps.push(
      "ENCODING_INVALID：请选择正确编码后重新解析；原字节已保留。",
    );
    return parsed;
  }
  const lines = text.split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i += 40)
    appendBlock(
      parsed,
      lines.slice(i, i + 40).join("\n"),
      path ? "code" : "text",
      {
        lineStart: i + 1,
        lineEnd: Math.min(i + 40, lines.length),
        ...(path ? { path } : {}),
      },
    );
  if (!parsed.text.trim()) parsed.gaps.push("EMPTY：没有可用文字。");
  return parsed;
}
export function parseWeb(bytes: Uint8Array, url: string, encoding = "utf-8") {
  let html: string;
  try {
    html = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    const p = baseParsed(url, "readability-0.6.0/2", encoding);
    p.gaps.push("ENCODING_INVALID：原件保留，需选择编码重试。");
    return p;
  }
  // No scripts, resources, browser credentials, or rendered HTML leave this parser.
  const dom = new JSDOM(html, { url });
  const document = dom.window.document;
  const parsed = baseParsed(
    document.title || url,
    "readability-0.6.0/2",
    encoding,
  );
  parsed.canonicalClaim =
    document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ??
    null;
  const time = document.querySelector(
    'meta[property="article:published_time"], time[datetime]',
  );
  parsed.declaredPublishedAt =
    time?.getAttribute("content") ?? time?.getAttribute("datetime") ?? null;
  parsed.publicationEvidence = time ? time.outerHTML.slice(0, 500) : null;
  for (const a of document.querySelectorAll<HTMLAnchorElement>(
    "a[href], link[rel='alternate']",
  )) {
    if (parsed.links.length >= 1000) break;
    parsed.links.push({
      url: a.href,
      via: a.closest("nav") ? "navigation" : "link",
    });
  }
  if (
    document.querySelector('input[type="password"]') ||
    /sign in to continue|log in to (continue|read)|登录后.*(查看|阅读)/i.test(
      document.body.textContent ?? "",
    )
  )
    parsed.gaps.push("LOGIN_WALL：页面可能要求登录，未确认取得全文。");
  if (document.querySelector('[role="tab"], [role="tabpanel"]'))
    parsed.gaps.push("CODE_TABS：只取得静态标签页内容；未验证其他交互状态。");
  if (document.querySelector("canvas,iframe,video,svg,img"))
    parsed.gaps.push("MEDIA：图像、嵌入与图表未做文字识别。");
  const article = new Readability(document.cloneNode(true) as Document, {
    maxElemsToParse: 30000,
    charThreshold: 100,
  }).parse();
  const content = new JSDOM(
    article?.content ??
      document.querySelector("main,article")?.innerHTML ??
      document.body.innerHTML,
  );
  content.window.document
    .querySelectorAll("script,style,iframe,object,embed,form,nav,svg")
    .forEach((n) => n.remove());
  let headings: string[] = [];
  for (const node of content.window.document.querySelectorAll(
    "h1,h2,h3,h4,h5,h6,p,pre,table,li",
  )) {
    if (node.parentElement?.closest("pre,table,li,p")) continue;
    const text =
      node.tagName === "TABLE"
        ? [...node.querySelectorAll("tr")]
            .map((row) =>
              [...row.querySelectorAll("th,td")]
                .map((cell) => cell.textContent?.trim() ?? "")
                .join("\t"),
            )
            .join("\n")
        : (node.textContent?.trim() ?? "");
    const heading = /^H[1-6]$/.test(node.tagName);
    if (heading) {
      const level = Number(node.tagName[1]);
      headings = headings.slice(0, level - 1);
      headings[level - 1] = text;
    }
    appendBlock(
      parsed,
      text,
      heading
        ? "heading"
        : node.tagName === "PRE"
          ? "code"
          : node.tagName === "TABLE"
            ? "table"
            : "text",
      { heading: headings.filter(Boolean) },
    );
  }
  if (!parsed.blocks.length)
    appendBlock(
      parsed,
      content.window.document.body.textContent?.trim() ?? "",
      "text",
      {},
    );
  if (parsed.text.trim().length < 100)
    parsed.gaps.push(
      "SPARSE_OR_SCRIPT_SHELL：文字过少，可能是脚本壳或截断页面。",
    );
  // Completeness cannot be inferred from HTTP 200 or a successful extraction.
  parsed.gaps.push(
    "STATIC_COVERAGE：仅对本次取得的静态 HTML 负责，未确认上游全文完整。",
  );
  content.window.close();
  dom.window.close();
  return parsed;
}
