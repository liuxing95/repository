export function enhancementOptions(pages: number[] = []) {
  return {
    enabled: false,
    purpose: "ocr",
    pages,
    provider: null,
    estimatedMicroUsd: null,
    externalBytes: 0,
    reason:
      "尚未验证 OCR 路线；保留原件和缺口。可提供临时密码或选择编码，在本机重新解析。",
  };
}
