export function enhancementStatus() {
  return {
    enabled: false,
    mode: "keyword",
    fingerprint: null,
    externalRequests: 0,
    reason: "尚无固定同题对照证明收益，向量、重排与图增强保持关闭。",
  };
}
export type Comparison = {
  questions: number;
  baselineRecall: number;
  enhancedRecall: number;
  p95Ms: number;
  costMicroUSD: number;
  externalBytes: number;
  fingerprint: {
    model: string;
    dimensions: number;
    chunking: string;
    normalization: string;
  };
};
export function assessEnhancement(
  report: Comparison,
  allowedExternal: boolean,
) {
  const f = report.fingerprint;
  return {
    eligible:
      report.questions >= 20 &&
      report.enhancedRecall > report.baselineRecall &&
      report.enhancedRecall >= 0.9 &&
      report.p95Ms < 500 &&
      report.costMicroUSD >= 0 &&
      (report.externalBytes === 0 || allowedExternal) &&
      !!f.model &&
      f.dimensions > 0 &&
      !!f.chunking &&
      !!f.normalization,
    enabled: false,
  };
}
