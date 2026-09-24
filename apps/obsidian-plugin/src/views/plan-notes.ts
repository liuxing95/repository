import type { WriterGrant } from "@kb/contracts";
import type { Connection } from "../connection";
import { applyGrant, type WriterHost } from "../writer/apply";

export async function syncPlanNotes(connection: Connection, host: WriterHost) {
  await connection.refresh();
  const ids = await connection.request<string[]>("/v1/planning/notes/pending");
  for (const id of ids) {
    const grant = await connection.request<WriterGrant>(
      `/v1/planning/notes/${id}/grant`,
      "POST",
      {},
    );
    const afterHash = await applyGrant(host, connection, grant);
    await connection.request(`/v1/planning/notes/${id}/receipt`, "POST", {
      token: grant.token,
      afterHash,
    });
  }
}
