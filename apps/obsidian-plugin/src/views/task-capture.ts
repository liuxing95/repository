import type { TaskCommand, TaskDraft } from "@kb/contracts";
import type { Connection } from "../connection";
export function renderTaskCapture(
  root: HTMLElement,
  connection: Connection,
  refresh: () => Promise<void>,
) {
  const form = document.createElement("div");
  root.append(form);
  const text = (tag: string, value: string) => {
    const n = document.createElement(tag);
    n.textContent = value;
    form.append(n);
    return n;
  };
  text("h4", "确认一个普通任务");
  text(
    "p",
    "无需模型或资料。期望日期、最早开始、硬截止分别填写；“明天学”不会自动成为硬截止。",
  );
  const field = (name: string, type = "text") => {
    const l = document.createElement("label");
    l.textContent = name;
    const i = document.createElement("input");
    i.type = type;
    l.append(i);
    form.append(l);
    return i;
  };
  const title = field("任务标题"),
    desired = field("期望日期", "date"),
    earliest = field("最早开始", "date"),
    due = field("硬截止日期", "date"),
    minutes = field("预估分钟", "number"),
    zone = field("任务时区");
  zone.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
  minutes.min = "1";
  minutes.max = "1440";
  const detailsLabel = document.createElement("label");
  detailsLabel.textContent = "任务说明";
  const details = document.createElement("textarea");
  detailsLabel.append(details);
  form.append(detailsLabel);
  const preview = document.createElement("pre"),
    message = document.createElement("p"),
    check = document.createElement("input");
  check.type = "checkbox";
  const label = document.createElement("label");
  label.append(
    check,
    document.createTextNode("我已核对标题、日期含义与时区，确认登记创建"),
  );
  form.append(preview, label, message);
  let draft: TaskDraft | undefined,
    signature = "",
    operationId = crypto.randomUUID(),
    busy = false;
  const input = (): TaskDraft => ({
    title: title.value,
    desiredDay: desired.value || null,
    earliestDay: earliest.value || null,
    deadlineDay: due.value || null,
    timezone: zone.value,
    minutes: minutes.value ? Number(minutes.value) : null,
    details: details.value,
  });
  const button = (name: string, fn: () => Promise<void>) => {
    const b = document.createElement("button");
    b.textContent = name;
    b.onclick = () => {
      if (busy) return;
      busy = true;
      const controls = [...form.querySelectorAll("input,textarea,button")];
      controls.forEach((n) => ((n as HTMLInputElement).disabled = true));
      void fn()
        .catch((e) => {
          message.textContent =
            e?.message ?? "操作未确认；保留草稿，检查连接后重试。";
        })
        .finally(() => {
          busy = false;
          controls.forEach((n) => ((n as HTMLInputElement).disabled = false));
        });
    };
    form.append(b);
  };
  const sentence = field("一句话输入（可选）");
  button("从一句话生成候选", async () => {
    const result = await connection.request<{
      input: TaskDraft;
      provenance: Record<string, string>;
    }>("/v1/tasks/text-draft", "POST", {
      text: sentence.value,
      timezone: zone.value,
    });
    title.value = result.input.title;
    desired.value = result.input.desiredDay ?? "";
    earliest.value = "";
    due.value = "";
    minutes.value = String(result.input.minutes ?? "");
    draft = undefined;
    check.checked = false;
    preview.textContent = Object.values(result.provenance).join("\n");
    message.textContent = "已填入建议，请检查每个字段，再预览当前候选并确认。";
  });
  button("预览任务候选", async () => {
    const value = await connection.request<{
      input: TaskDraft;
      provenance: Record<string, string>;
      deadlineExclusive: number | null;
    }>("/v1/tasks/draft", "POST", input());
    draft = value.input;
    signature = JSON.stringify(input());
    check.checked = false;
    preview.textContent = `标题：${draft.title}\n期望：${draft.desiredDay ?? "未填"}\n最早：${draft.earliestDay ?? "未填"}\n硬截止：${draft.deadlineDay ?? "未填"}（${draft.timezone}）\n预估：${draft.minutes ?? "未填"} 分钟\n依据：用户填写；没有模型推断。`;
  });
  button("确认登记任务", async () => {
    if (!check.checked || !draft || signature !== JSON.stringify(input()))
      throw Error("请先预览当前内容并勾选确认。");
    const c = await connection.request<TaskCommand>(
      "/v1/tasks/commands",
      "POST",
      { operationId, input: draft },
    );
    message.textContent = `已登记 ${c.taskId}，等待本机 TaskNotes 创建；尚无正式任务回执。`;
    operationId = crypto.randomUUID();
    draft = undefined;
    check.checked = false;
    await refresh();
  });
}
