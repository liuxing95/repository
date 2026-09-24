# 增加 TaskNotes 任务核对与 Today

普通任务和到期复习建议现在可以经用户确认创建为真实 TaskNotes 任务，并在 Today 查看最新事实和继续原学习尝试。接管、改名、重复副本、离线清点与回执丢失都有明确状态；结果未知不重发。

本分支此前已交付多来源收录、证据搜索、Wiki 审核写入、课题报告和学习记录。本次在这些能力上接入固定的 TaskNotes 4.13.4 Runtime API，增加 schema 7 的观察历史、命令、循环实例映射、计划失效和取消 outbox。任务字段仍归 TaskNotes，自动更新关闭。

验证：完整 OCI 与编译后进程回归 139 通过、2 个真实语料跳过；类型和 lint 通过；真实 Obsidian 1.13.7 的 31 项桌面检查通过、页面错误 0。合成尝试只做时间老化，以验证到期复习；真实 TaskNotes 创建与 Today 恢复走正式链路。1,000 任务的服务核对加 Today 读取 p95 约 363 ms，不含桌面磁盘扫描。

说明与截图：`docs/implementation/task-today-reconciliation.md`、`docs/implementation/task-today-validation.md`、`docs/implementation/evidence/task-today.png`；README、导航与开发者接手指南同步更新。

## 上线后观察与验证

先在隔离试点升级服务与插件；schema 6 到 7 自动生成 0600 快照。检查最后完整清点、unknown/conflict 命令和取消 outbox。未知结果只核对，不清库或重发。固定版本不匹配时暂停桥接。

场景 08/09 的正式排程、日历覆盖和实际提醒取消仍未接入；方案 T4 保留未完成。P6 远程入口可选且关闭。不以本轮验证宣称跨插件原子 CAS 或真实模型语义能力。

Compound Engineered with GPT-6 · Codex.

> 当前 GitHub CLI 未认证，本文件是待创建 PR 的说明草稿，并非已有 PR。
