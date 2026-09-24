import { fixture, settings } from "./helpers";
import { publish } from "./evidence-helpers";
import { EvidenceStore } from "../apps/service/src/evidence/locator";
import { SearchService } from "../apps/service/src/search/search";
import { Policy } from "../apps/service/src/security/policy";
export async function modelFixture() {
  const f = await fixture();
  const p = publish(f, "仅在开发模式下，权限不允许默认开启。", "权限");
  const e = new EvidenceStore(f.registry),
    search = new SearchService(e);
  const ref = e.register(p)[0]!;
  f.registry.saveSettings(
    {
      ...settings,
      routes: [
        {
          ...settings.routes[0]!,
          price: { ...settings.routes[0]!.price, maxInputTokens: 10000 },
        },
      ],
    },
    f.registry.get().policyVersion,
  );
  new Policy(f.registry).setSource({
    sourceId: ref.sourceId,
    retracted: false,
    routes: {
      read: ["local"],
      fetch: [],
      model: ["test-model"],
      ocr: [],
      embedding: [],
      rerank: [],
      notification: [],
      calendar: [],
      publish: [],
    },
  });
  f.principal = f.sessions.refresh(f.token);
  return { f, e, search, ref };
}
