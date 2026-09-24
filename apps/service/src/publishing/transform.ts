import type { PublicationDecision, PublicationDependency } from "@kb/contracts";
import { AppError } from "../errors";

const tokenPattern =
  /!?\[\[[^\]\n]{1,500}\]\]|!?\[[^\]\n]{0,500}\]\([^\n)]{1,500}\)|\bhttps?:\/\/[^\s<>()[\]]+|file:\/\/[^\s<>]+|(?:\/Users\/|\/home\/|KB-Sources\/|KB-Candidates\/)[^\s<>]+/g;
export const TRANSFORM_VERSION = "public-plain-v1";

export function dependencies(
  pageId: string,
  content: string,
): PublicationDependency[] {
  const found = new Map<string, PublicationDependency>();
  for (const token of content.match(tokenPattern) ?? []) {
    const kind =
      token.startsWith("![[") || token.startsWith("![")
        ? "attachment"
        : token.startsWith("[[")
          ? "embed"
          : token.startsWith("http")
            ? "external"
            : "link";
    found.set(token, {
      pageId,
      token,
      kind,
      action: "blocked",
      replacement: null,
    });
  }
  return [...found.values()];
}

export function transformPage(
  pageId: string,
  content: string,
  decisions: Record<string, PublicationDecision>,
  included: Record<string, string> = {},
) {
  const found = dependencies(pageId, content);
  const resolved = found.map((item) => {
    const decision = decisions[item.token];
    if (!decision) return item;
    if (decision.action === "replace") {
      const url = new URL(decision.url);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !url.hostname
      )
        throw new AppError(
          "VALIDATION",
          400,
          "替换链接只能是无账号信息的 HTTPS 地址。",
        );
    }
    if (
      decision.action === "include" &&
      (item.kind !== "attachment" || !included[item.token])
    )
      throw new AppError("VALIDATION", 400, "只能纳入已核验的公开文本附件。");
    if (decision.action === "retain") {
      if (item.kind !== "external")
        throw new AppError(
          "VALIDATION",
          400,
          "仅能原样保留明确的 HTTPS 裸链接。",
        );
      const url = new URL(item.token);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new AppError(
          "VALIDATION",
          400,
          "仅能原样保留明确的 HTTPS 裸链接。",
        );
    }
    return {
      ...item,
      action: decision.action,
      replacement:
        decision.action === "replace"
          ? decision.url
          : decision.action === "include"
            ? included[item.token]!
            : decision.action === "retain"
              ? item.token
              : null,
    };
  });
  if (resolved.some((item) => item.action === "blocked"))
    throw new AppError(
      "PUBLICATION_DEPENDENCY",
      409,
      "存在未处理的链接或附件；先选择移除或替换。 ",
    );
  let body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  // Internal evidence IDs are navigation handles, not public citations.
  body = body.replace(
    /^证据：[\da-f,-\s]+$/gim,
    "证据：已在内部审核，公开副本不提供原件。",
  );
  body = body.replace(tokenPattern, (token) => {
    const item = resolved.find((d) => d.token === token)!;
    return item.action === "remove"
      ? "[引用已移除]"
      : item.action === "include"
        ? `公开附件：${item.replacement}`
        : item.action === "retain"
          ? token
          : `公开链接：${item.replacement}`;
  });
  return {
    body,
    dependencies: resolved,
    outboundLinks: resolved.flatMap((d) =>
      (d.action === "replace" || d.action === "retain") && d.replacement
        ? [d.replacement]
        : [],
    ),
  };
}
