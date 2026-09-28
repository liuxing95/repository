import { z } from "zod";
import { Purpose, SourcePolicy, type Principal } from "@kb/contracts";
import type { AnswerService } from "./answer";
import { authorize } from "../http/auth";
import { AppError } from "../errors";
import { Policy } from "../security/policy";

export function setupLocalWriting(
  answers: AnswerService,
  value: unknown,
  p: Principal,
) {
  const input = z
    .object({
      snapshotId: z.string().uuid(),
      evidenceIds: z.array(z.string().length(64)).min(1).max(8),
    })
    .strict()
    .parse(value);
  const { search } = answers,
    { registry } = search.evidence;
  authorize(registry, p, ["admin"], p.policyVersion, true);
  if (!answers.providers.get("local-ollama")?.localOnly)
    throw new AppError("UNAVAILABLE", 503, "请先启动已安装的本机模型。");
  const s = search.snapshot(input.snapshotId, p);
  search.validate(s, p);
  const sources = [
    ...new Set(
      input.evidenceIds.map((id) => {
        if (!s.evidenceIds.includes(id)) throw new AppError("INVALID_CITATION");
        const item = search.evidence.read(id);
        if (!["original", "mirror", "reprint"].includes(item.profile.kind))
          throw new AppError("INVALID_CITATION", 400, "请选择已正式收录的原始资料。");
        return item.sourceId;
      }),
    ),
  ];
  registry.store.tx(() => {
    const settings = registry.settings();
    registry.saveSettings(
      {
        ...settings,
        budget: settings.budget ?? {
          currency: "USD",
          timezone: "Asia/Shanghai",
          jobLimit: 0,
          dayLimit: 0,
          monthLimit: 0,
        },
        routes: [
          ...settings.routes.filter((r) => r.id !== "local-ollama"),
          {
            id: "local-ollama",
            purpose: "model",
            enabled: true,
            price: {
              version: "local-free-v1",
              expiresAt: Date.now() + 365 * 86400000,
              inputPerMillion: 0,
              outputPerMillion: 0,
              fixedCost: 0,
              maxInputTokens: 30000,
              maxOutputTokens: 2048,
            },
          },
        ],
      },
      registry.get().policyVersion,
    );
    for (const sourceId of sources) {
      const old = SourcePolicy.parse(
        registry.store.get(`source:${sourceId}`) ?? {
          sourceId,
          retracted: false,
          routes: Object.fromEntries(
            Purpose.options.map((purpose) => [
              purpose,
              purpose === "read" ? ["local"] : [],
            ]),
          ),
        },
      );
      new Policy(registry).setSource(
        {
          ...old,
          routes: {
            ...old.routes,
            model: [...new Set([...old.routes.model, "local-ollama"])],
          },
        },
        p.id,
        "local-writing-explicit-selection",
      );
    }
  });
  return {
    sources: sources.length,
    policyVersion: registry.get().policyVersion,
  };
}
