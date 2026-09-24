import { test, expect } from "vitest";
import { Scope } from "@kb/contracts";
import {
  compareScope,
  matchScope,
} from "../../apps/service/src/evidence/scope";
import {
  tokenize,
  matchExpression,
} from "../../apps/service/src/search/tokenizer";
test("scope comparisons distinguish unknown, overlapping and disjoint versions/channels", () => {
  const known = Scope.parse({
    topic: "Node",
    version: "24",
    channel: "stable",
    stage: "runtime",
    configuration: "default",
    modality: "text",
    sourceType: "docs",
  });
  expect(compareScope(known, known)).toBe("overlap");
  expect(compareScope(known, { ...known, version: "22" })).toBe("disjoint");
  expect(compareScope(known, { ...known, channel: "preview" })).toBe(
    "disjoint",
  );
  expect(compareScope(known, Scope.parse({ version: "24" }))).toBe("unknown");
  expect(matchScope(Scope.parse({ version: "24" }), known)).toBe("overlap");
});
test("tokenization keeps precise symbols and never changes evidence offsets", () => {
  expect(tokenize("C++ Node.js parseValue /src/a.ts").symbols.length).toBe(4);
  expect(tokenize("权限").terms.length).toBe(3);
  expect(matchExpression("permissions")).toContain(tokenize("权限").terms[1]);
  expect(matchExpression('" OR *')).not.toContain('" OR *');
});
