import { expect, test } from "vitest";
import { focusedModelPack, modelLocationSupported, type EvidencePack } from "../../apps/service/src/answers/evidence-pack";
import type { Claim, EvidenceRead } from "@kb/contracts";

test("a two-part chapter question sends both relevant sections without later noise", () => {
  const evidence = [
    { id: "first", text: "切块与证据单元", locator: { heading: ["4.4 切块、结构关系与证据单元"] } },
    { id: "second", text: "可回答性与拒答", locator: { heading: ["4.8 可回答性、冲突、时效与拒答"] } },
    { id: "noise", text: "附近的检索话题", locator: { heading: ["4.9 迭代检索"] } },
  ];
  const pack = {
    question: "切块、结构关系与证据单元，以及可回答性和拒答，分别在哪里讨论？",
    evidence,
    answerable: true,
    gaps: [],
  } as unknown as EvidencePack;
  const focused = focusedModelPack(pack);
  expect(focused.evidence.map((item) => item.id)).toEqual(["first", "second"]);
  expect(focused.answerable).toBe(true);
  expect(focused.gaps).toContain("本机模型只接收优先覆盖问题要点的证据；其余命中仍可在原文整理中核对。");
});

test("a model's chapter claim cannot be marked supported by a different cited chapter", () => {
  const evidence = [{ id: "fixed", locator: { heading: ["4.7 证据与引用"] } }] as EvidenceRead[];
  const claim = (text: string) => [{ text, evidenceIds: ["fixed"] }] as Claim[];
  expect(modelLocationSupported("证据与引用在哪些章节？", claim("在 4.7 章节"), evidence)).toBe(true);
  expect(modelLocationSupported("证据与引用在哪些章节？", claim("在 4.8 章节"), evidence)).toBe(false);
  expect(modelLocationSupported("证据与引用在哪些章节？", claim("证据与引用"), evidence)).toBe(false);
});
