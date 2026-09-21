import { createHash } from "node:crypto";
process.once("message", (input: unknown) => {
  if (
    !input ||
    typeof input !== "object" ||
    !("kind" in input) ||
    input.kind !== "diagnostic-check"
  ) {
    process.exit(1);
  }
  // Fixed bounded self-check: no note content, paths, credentials or user scripts.
  const ok =
    createHash("sha256").update("knowledge-task-center").digest("hex")
      .length === 64;
  process.send?.({ ok }, () => process.exit(ok ? 0 : 1));
});
setTimeout(() => process.exit(1), 10_000).unref();
