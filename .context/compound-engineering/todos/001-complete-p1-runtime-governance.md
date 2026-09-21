---
status: complete
priority: p1
issue_id: "001"
tags: [implementation, runtime]
dependencies: []
---

# Runtime governance implementation

## Problem Statement

执行场景 01，建立可运行工程及默认关闭的能力治理。

## Findings

仓库暂无应用实现。Node 24、Docker 与 Obsidian 可用，需验证真实 SQLite、凭据和隔离环境。

## Proposed Solutions

沿用单服务、薄插件和共享合同，按 G1 → G2 → G3 → G4/G5 顺序实现。

## Recommended Action

完成当前计划的全部单元；不实现相邻资料／任务业务。

## Acceptance Criteria

- [x] 工程骨架、构建与开发说明
- [x] G1 扫描、试点、配对、主设备和版本门禁
- [x] G2 用途权限、认证、网络与路径边界
- [x] G3 SQLite 作业、预算、恢复与队列
- [x] G4 设置界面、输入保留与脱敏诊断
- [x] G5 真实容器隔离与受控 broker
- [x] 完整测试、代码审查与计划回填

## Work Log

2026-09-21：读取计划，创建 codex/workspace-runtime-governance 分支；按仓库指引在主线程顺序实施。

2026-09-21：完成工程与 G1—G5；真实 SQLite、双进程预算竞争、编译产物、Docker、系统凭据库与 Obsidian 桌面均完成验证。审查记录见 ce-review/2026-09-21-runtime。
