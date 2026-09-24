# 场景 08 验证记录

记录日期：2026-09-24。设计目标见[场景方案](../plans/2026-09-21-009-feat-scheduling-calendar-sync-plan.md)，操作与代码见[接手说明](scheduling-calendar-sync.md)。本文件只记录本次实际执行，不沿用旧场景的测试结果。

| 核查项 | 结果 | 边界 |
|---|---|---|
| 本地快照、时间语义、求解、独立校验 | 已通过自动化测试 | 明确偏移、夏令时、部分覆盖、依赖环、锁定块、节点上限 |
| PlanRevision 事务与撤销 | 已通过自动化测试 | 两个旧候选只有一个采用，重复采用同版本；任务修订改变使候选失效 |
| 笔记投影授权与回执 | 已通过服务逻辑与真实桌面测试 | 合成 Vault 的 `KB-Plans` 文件创建成功，Today 回执为 applied |
| Google 日历读写与自动委托 | 未启用 | 缺生产 OAuth、专用测试日历与 P6 独立验收，日历/提醒 outbox 为 disabled |
| 桌面可读性与场景 A21—A28 | 合成 Vault 流程通过；真实用户任务仍待人工验收 | A25、A27 的真实 Google 部分、A28 的远程输入尚未验收 |

初次本地运行 `pnpm check`：55 个测试文件通过，2 个跳过；144 个测试通过，5 个跳过；编译产物测试 2 个通过。该结果发生在场景 08 后续约束测试和文档更新前；最终回归结果需在完成后追加，不能把这行视为最终检查。

2026-09-24 后续回归：`pnpm check` 类型检查、ESLint、构建均通过；58 个测试文件通过、2 个跳过；155 个测试通过、5 个跳过；编译产物测试 2 个通过。`KB_TEST_TASKNOTES=1 pnpm test:desktop` 在独立合成 Vault 中验证了预览、人工采用、Today、计划笔记与回执、撤销预览；截图保存在不提交的 `.context/runtime-validation/tasknotes-v7/obsidian-planning-preview.png` 和 `obsidian-planning-undo-preview.png`。曾出现“再次清点推进代数却无事实变化”导致采用误失效，经逐任务修订比较修复并在真实桌面重测通过。普通 `pnpm test:desktop` 也通过现有治理冒烟。

2026-09-24 最终回归：补齐固定会议、可证明的连续窗口容量和重叠资源窗口后，`pnpm check` 通过：58 个测试文件通过、2 个跳过，159 个测试通过、5 个跳过，编译产物测试 2 个通过；类型、lint、构建均通过。再次运行 `KB_TEST_TASKNOTES=1 pnpm test:desktop`，真实插件的预览、采用、Today、笔记回执与撤销预览全部通过。桌面结果只覆盖合成试点，不代替真实 Google 日历与用户任务验收。
