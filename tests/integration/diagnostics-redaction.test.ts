import { expect, test } from "vitest";
import { fixture } from "../helpers";
import { diagnostics } from "../../apps/service/src/runtime/diagnostics";
import { problem } from "../../apps/service/src/errors";
test("diagnostics and errors never echo paths, tokens, bodies or upstream error text", async () => {
  const f = await fixture();
  try {
    const output =
      JSON.stringify(diagnostics(f.registry)) +
      JSON.stringify(problem(new Error(`${f.token} 人工私密正文 ${f.source}`)));
    for (const secret of [
      f.token,
      f.source,
      f.registry.get().vaultPath,
      "人工私密正文",
    ])
      expect(output).not.toContain(secret);
    expect(output).toContain("sqlite");
  } finally {
    await f.close();
  }
});
