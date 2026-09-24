# 场景 09 验证记录：本机提醒

记录日期：2026-09-24。范围以[场景 09 接手说明](reminder-delivery-control.md)和[设计方案](../plans/2026-09-21-010-feat-reminder-delivery-control-plan.md)为准。本文件只记录当前实现和本轮执行；不继承场景 08 的验收结果。

| 核查对象 | 本轮证据 | 仍需核对 |
|---|---|---|
| 本机规则与状态 | 身份、夏令时、当日去重、明确重发、稍后提醒、勿扰、暂停今天、事实过旧与迟到的单元／故障测试 | 用户实际通知权限和系统展示 |
| 计划与任务取消 | 计划改期、任务完成／确认删除、旧计划重放、取消和投递并发的测试 | 真实用户任务的交互验收 |
| 崩溃与旧备份 | 在途变 `outcome_unknown` 且不盲目重发；数据库与同目录栅栏一起回滚时，父目录锚点仍使发送暂停；schema 8→9 前备份权限和内容经测试 | 旧备份自动合并未交付；整台主机一起回滚仍须外部核对 |
| 独立本机执行端 | 设置页登记、关闭规则的真实 Obsidian 合成 Vault 流程；单独 Node 服务在 Obsidian 未运行时向 macOS 通知命令提交一条通用测试消息，账本记 `accepted` | 命令成功不证明系统实际展示、手机收到或已读；电脑睡眠／关机时不会执行 |
| 远程 relay 与手机 | 未实现 | P6 部署、端到端投递、两端权威切换和设备离线验收；A30、A37 远端部分未通过 |

本机自动化包含 `tests/unit/reminder-identity.test.ts`、`tests/faults/reminder-dispatch.test.ts`、`tests/faults/reminder-restore.test.ts`、`tests/integration/reminder-routes.test.ts` 和 schema 迁移测试。实机命令使用 `KB_TEST_NOTIFICATION=1 pnpm exec vitest run tests/devices/local-reminder.test.ts`，该命令会在本机产生一条通用通知；本轮通过 1/1。该测试先写入合成试点规则，关闭测试代码持有的数据库，再单独启动构建后的服务进程，没有启动 Obsidian；它核对服务写入的发送尝试，不声称用户已看到横幅。

`KB_TEST_TASKNOTES=1 KB_TEST_VALIDATION_DIR=.context/runtime-validation/tasknotes-v9-final pnpm test:desktop` 使用独立合成 Vault 和应用配置，验证插件配对、主端、提醒登记与关闭，并继续运行任务与排程回归。提醒界面截图保存在不提交的 `.context/runtime-validation/tasknotes-v9-final/obsidian-reminders.png` 和 `obsidian-reminders-result.png`。初次全新桌面配置遇到 Obsidian 的仓库信任弹窗，测试脚本加入显式确认后重跑通过；这是测试环境初始化条件，不是业务发送结果。截图中的状态只证明插件展示了服务账本。

本轮 `pnpm check` 通过：62 个测试文件通过、3 个跳过；173 项测试通过、6 项跳过；构建后服务故障测试 2/2 通过。桌面回归重跑通过，并确认切换为任务提醒时不显示晨间／晚间专用字段。独立本机通知测试在最终代码上重跑 1/1 通过。设计验收 A29 仅能标记**本机进程运行时的提交**已验证；电脑休眠／关机、系统通知权限变化和手机离线没有设备级验证。A31 的本机抑制、补发、去重由自动化覆盖。A37 的本机提醒没有知识来源正文依赖，来源撤回不会把摘要再发送；如果未来引入来源摘要或远端排期，必须补做撤回、取消确认和外部副本测试。
