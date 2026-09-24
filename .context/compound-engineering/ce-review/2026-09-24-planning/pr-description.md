# 增加本地约束排程与人工采用

用户现在可以在 TaskNotes 完整清点后输入明确的可用时间，预览新旧安排与未排原因，并经确认采用一个正式 PlanRevision。采用后的时间块立即进入 Today；主端 Writer 异步写入不可变 `KB-Plans` 笔记并独立记录回执。撤销会根据当前任务和可用时间生成新候选，不恢复已完成任务或抹除工作日志。

本次新增时区明确的规划合同、只读忙闲覆盖状态、有界启发式与独立硬约束验证器、schema 8 的候选/正式版本/投影账本、主端接口和 Obsidian 评审界面。外部日历读取失败保持未知；正常服务尚未接入 Google OAuth，自动委托和日历事件写入仍按 P6 独立门槛关闭。

验证：`pnpm check` 类型、lint、构建、159 项常规测试与 2 项编译产物测试通过；5 项既有可选测试跳过。`KB_TEST_TASKNOTES=1 pnpm test:desktop` 用真实 Obsidian 1.13.7、TaskNotes 4.13.4 与合成 Vault 验证预览、采用、Today、笔记回执、撤销预览。操作与排障见 `docs/implementation/scheduling-calendar-sync.md`，结果见同目录验证记录。

## Post-Deploy Monitoring & Validation

试点升级后检查 `state.db` 的 `plan_revisions` 最新版本、`plan_outbox` 中 `note` 的 pending/applied/stale，以及 Today 的任务事实时间与计划风险提示。健康信号是一次用户采用只有一个新版本，主端写入 `KB-Plans` 后 `projection_receipts` 为 applied；任务变动只隐藏受影响的未来块。若候选反复 BASELINE，先核对 TaskNotes 完整清点及主端；若笔记待写，核对编辑器占用和 Writer 冲突，不删除正式账本。验证窗口为试点首次采用和次日核对，由试点维护者执行。Google 日历与自动委托未启用，不把本次试点看作其验收。
