# 场景 01 代码审查

模式：`ce:review mode:autofix`；显式计划为场景 01，基线 `50dbc8d`。按用户提供的 AGENTS.md 在主线程顺序执行，不声称存在独立 reviewer agent。

## 审查范围

始终检查：正确性、测试、维护性、项目约定、Agent 可访问性、历史经验。条件检查：认证与策略需要安全／对抗检查；SQLite 与预算需要迁移／性能检查；API、超时与后台作业需要合同／可靠性检查；TypeScript 与设置页需要类型／界面竞态检查。`docs/solutions/` 不存在，未发现可复用历史修复。

CLI 与版本化 HTTP 提供本轮治理入口；通用外部 Agent 接入属于后续场景，不作为本轮缺项。迁移只初始化空数据库，版本或结构不符均只读。现有设计文档保留；未改动历史资料。

## 已修复并验证

| 等级 | 文件 | 问题与处理 |
| --- | --- | --- |
| P1 | `apps/obsidian-plugin/src/connection.ts:52` | 真实插件配对后的 refresh 被 Fastify 拒绝；plugin-connection 集成测试复现后修复。 |
| P1 | `apps/service/src/http/server.ts:59` | 响应丢失后重试配置不再二次推进策略版本；同键不同载荷冲突。 |
| P1 | `apps/service/src/security/policy.ts:28` | 已颁发的 grant 不能绕过连接撤销；测试证明提供方调用数为零。 |
| P1 | `apps/service/src/main.ts:116` | 真实 Obsidian 自检揭示输出路径不同；编译产物测试已覆盖实际子进程。 |
| P1 | `apps/service/src/main.ts:49` | 避免 preview 拒绝请求之前先在源 Vault 创建 state.db；包含符号链接别名的真实 CLI 用例通过。 |
| P1 | `apps/service/src/storage/store.ts:6` | 仅验证 user_version 会把相同版本号的未知数据库当作已知；现与迁移的完整 schema 比较。 |
| P2 | `apps/obsidian-plugin/src/views/settings.ts:149` | 等待请求时修改的草稿保留，并显示部分完成；UI 竞态测试通过。 |
| P1 | `apps/service/src/http/auth.ts:91` | 会话有 45 秒心跳门禁，心跳不会自动接受新策略或 epoch；时间推进及撤销测试通过。 |
| P1 | `apps/service/src/runtime/worker-broker.ts:111` | 不依赖提供方一定遵守 AbortSignal；超时不会允许重复派发，迟到费用仍结算。 |
| P2 | `apps/service/src/workspace/registry.ts:47` | 完整目录进入摘要；原插件配置只进备份，试点不自动加载；用例覆盖。 |

## 完整性与最终结论

G1—G5 均有代码与对应测试；编译产物、自有进程、真实 Docker、系统凭据库和真实 Obsidian 均已验证。权限与预算没有绕过测试失败的回退路径。没有剩余 P0／P1／P2 修复项。

当前仅交付治理基础；R002、A01、A35 等跨场景业务能力未冒充已实现。任意第三方脚本不对外开放；输出总量检查不是磁盘硬配额，未来业务适配器需再次验收。

验证命令、版本、截图和 Post-Deploy Monitoring & Validation 见 `docs/implementation/runtime-governance-validation.md`。重审只检查上述修复及其调用链，未扩大功能范围。

结论：**修复后可交付**。审查未产生需要延期处理的代码事项。
