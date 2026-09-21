# 知识与任务中心

面向 Obsidian 的本地服务与薄插件。目前完成工程骨架及[场景 01：工作区接入与运行治理](docs/plans/2026-09-21-002-feat-workspace-runtime-governance-plan.md)：隔离试点、会话、主设备、用途权限、作业队列、预算账本、诊断与第三方执行隔离。

资料导入、搜索、TaskNotes、Writer、模型、通知、日历和发布属于后续场景，界面会明确显示未启用。本轮只运行不读笔记正文的本地自检作业。配置路线不会自动安装或启用业务适配器。

## 开发与检查

首个验收平台为 macOS。受测环境：Node.js **24.14.1**、pnpm **10.33.0**、Obsidian **1.13.7**。实际 SQLite 内核为 **3.53.4**；启动时要求至少 3.51.3。依赖精确版本由 `pnpm-lock.yaml` 固定。原生依赖首次安装可能需要 Xcode Command Line Tools。

```sh
pnpm install --frozen-lockfile
pnpm check
```

`check` 包含类型检查、lint、常规测试、构建和编译产物的真实进程测试。OCI 与桌面测试分别运行：

```sh
docker pull node:24.14.1-alpine@sha256:8510330d3eb72c804231a834b1a8ebb55cb3796c3e4431297a24d246b8add4d5
pnpm test:oci
pnpm test:desktop
```

桌面测试使用 `/Applications/Obsidian.app`，创建独立测试资料与应用配置，完整操作真实插件。结果放在 `.context/runtime-validation/`，该目录不提交。默认端口 27124 需要空闲。没有 Docker 时，普通治理与自检可用，第三方隔离路线保持关闭。

## 创建第一个试点

先构建，然后预览一个明确选定的 Vault：

```sh
pnpm build
pnpm service preview --source "/你的/资料库"
```

预览会返回文件数、目录、已发现的插件版本、冲突代码和 `digest`。复制该摘要确认接入：

```sh
pnpm service adopt --source "/你的/资料库" --confirm "预览返回的 digest"
```

程序在应用数据目录创建 `pilot` 和逐文件校验的 `backup`，输出它们的绝对路径。原资料库不移动、不覆盖。备份保留原插件配置；试点不自动加载原 `.obsidian` 与 `.git`，以免运行未知插件。空目录也会保留。

默认应用数据目录：`~/Library/Application Support/KnowledgeTaskCenter`。可在所有命令中用同一 `--data "/绝对路径"` 指定另一个本地目录，**必须在 Vault 外，且不要放进同步盘**。一个数据目录对应一个工作区。

扫描上限为单文件 20 MB、总量 512 MB、20,000 个文件、5,000 个目录、40 层目录。超过上限时停止接入；先选取较小的试点资料。符号链接、特殊文件、重复 `taskId`、已有受管目录、大小写或 Unicode 同名冲突均需先处理。当前受管目录为 `KB-Sources`、`KB-Wiki`、`KB-Candidates`、`KB-Plans`；可先另建不冲突的试点来源目录。

## 安装插件并连接

1. 在 Obsidian 中打开上一步输出的 `pilot` 目录。
2. 将 `apps/obsidian-plugin/dist/` 内的 `main.js`、`manifest.json`、`styles.css` 复制到该试点的 `.obsidian/plugins/knowledge-task-center/`。
3. 在 Obsidian 的第三方插件设置中启用“知识与任务中心”。
4. 启动服务，再打开插件设置页，输入终端显示的一次性配对码：

```sh
pnpm service serve
```

配对码 5 分钟有效，只能使用一次；在本机终端显示，不要写进笔记或共享日志。会话最长 1 小时，插件每 15 秒发送心跳，失联 45 秒后暂停后台执行。会话令牌只留在插件内存，重启插件后重新配对；Vault 的插件数据只保存设备 ID。

首次连接后点击“登记当前设备为主端”，再运行本地自检。主端交接必须先取消或完成作业、核对所有未结算费用，再由旧端释放。旧端不可用时不会自动接管。只读客户端可用 `serve --role reader` 签发配对码；可选角色为 `admin`、`user`、`writer`、`reader`。首期 `writer` 保留给后续受控写入适配器，不获得配置权限。

当前插件固定连接 `http://127.0.0.1:27124`。服务的 `--port` 用于自动化测试或自有客户端，不会同步修改插件配置。服务只监听回环地址，检查 Host、Origin 和 Bearer；无远程开放模式。

## 配置与费用

设置页的“读取配置／保存配置”是配置管理员入口。初始配置为：

```json
{
  "schemaVersion": 1,
  "budget": null,
  "routes": []
}
```

金额为微美元整数，`1 USD = 1,000,000`。启用收费路线需要单作业、日、月额度、时区、有效价格版本、输入／输出上限和受信业务适配器。具体 schema 见 `packages/contracts/src/policy.ts`。每个来源按 read、fetch、model、ocr、embedding、rerank、notification、calendar、publish 分别授权；多来源取允许路线交集，撤回立即阻断。

每次外部调用先在真实 SQLite 事务中预占三层额度。所有子任务、重试共用根预算。请求发出后回执未知，预占仍保留；跨日和重启不释放。结算按唯一提供方请求号去重；超出估计时记录真实费用并停止该根作业的后续收费调用。当前没有接入任何真实付费提供方。

提供方密钥由 `credential --reference <路线引用>` 从标准输入写入操作系统凭据库，服务仅保留引用，worker 不获得密钥。不要把密钥直接放进命令行参数或 JSON 配置。插件会话采用内存保存，避免把设备凭据写入 Vault。

## 运行、诊断与恢复

- `pnpm service diagnose` 输出脱敏版本、队列计数和费用汇总，不包含正文、Vault 路径、会话令牌或提供方密钥。未知数据库版本仅允许诊断，不猜测迁移。
- `state.db` 是权威账本，位于本机应用数据目录，WAL + FULL 同步；应用目录权限 0700、数据库与备份文件 0600。备份不是加密文件，磁盘加密和系统账户权限由主机负责。
- 三条队列各一个独立 worker：交互、通知、批量。自有 worker 是受信静态程序；第三方执行必须走固定 OCI 镜像、禁网、非 root、只读输入与专用输出，不挂载 Vault、主目录或容器 socket。
- 取消阻止后续步骤，已发生的远端费用仍可结算。过期 worker 的旧栅栏结果会被拒绝；过期租约最多尝试 3 次。失败自检可在列表重试，仍关联原根作业。
- 服务通过应用数据目录内的 `service.lock` 阻止重复启动。正常退出会清理锁；崩溃后，先读取锁内 PID，用 `ps -p <PID> -o command=` 核对旧服务确已退出，再删除该锁文件。不要删除数据库或账本来“恢复额度”。
- 本轮没有生成搜索索引和业务对象；它们在后续资料／搜索场景中创建，不能把 `state.db` 当作可丢弃索引。

公开接口与验证记录见[场景 01 实施验收](docs/implementation/runtime-governance-validation.md)。完整产品设计从[总体技术方案](docs/plans/2026-09-21-001-feat-overall-knowledge-task-plan.md)进入。
