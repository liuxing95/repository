# 场景 02：实施与验收记录

第一次接手请先读 [开发者接手指南](../development/onboarding.md)，完成独立样例、了解代码入口与排障方式。本文保留本场景的实现边界、接口和验收证据。

已完成[多来源收录计划](../plans/2026-09-21-003-feat-multi-source-ingestion-plan.md)的 I1—I4。用户可以限定范围、取得原件、核对覆盖、查看固定定位，最后批准来源文件。只有所有必要文件回执齐全，来源与解析产物才进入正式来源列表。

本次补齐了场景 04 支撑来源新建所需的批准摘要、短期 WriterGrant、逐文件回读和恢复协议。Writer 当前仅写不可变 `KB-Sources/<parseId>.md`；Wiki 页面更新、编译、人工观察与影响传播继续由场景 04 完成，其计划没有被标记为完成。实际搜索和索引构建仍由场景 03 接入，当前仅登记 `source.index_requested`。

## 用户可见行为

| 场景 | 已实现行为 | 验证 |
|---|---|---|
| 文本与剪藏 | 明确路径授权、原字节保存、UTF-8/UTF-16/GB18030、节选标记；错误编码不静默替换 | I1、I2；A02、A03 |
| 网页与集合 | 原 URL／最终 URL／canonical 声明分离；查询串保留；有界导航发现、路径排除、冻结清单和固定分母 | A02、A04、A08 |
| 仓库与发布产物 | GitHub ref 固定 commit；本地实际文件清单及脏状态；源码与产物筛选；LFS、子模块、二进制缺口 | A05、A06 |
| PDF | PDF.js 6.3.289 真解析；物理页、印刷标签、文字坐标；密码只走本次管道输入 | A07 |
| 来源提交 | 预览与批准分离；摘要绑定路径、正文、源修订、解析、政策和主端；只由插件写入 | I4 |
| 恢复 | afterHash 识别已应用；不同内容报冲突；失败项重试复用成功对象；旧版本不因更新失败消失 | A08 |
| 安全 | 不执行网页／仓库指令；DNS 全地址校验并固定连接 IP；跳转重验；ZIP／符号链接边界；撤回阻断原件和解析读取 | A33 |

同源同字节复用来源修订；解析指纹包含解析器、编码、定位版本与结果，性能采样值不参与去重。相同正文换标题不会被当成不同来源依据；不同入口同标题不会合并。重新解析不修改原件或旧解析；刷新上游用新的 acquisition ID，旧清单不增页。复制期间变化的文件必须重新预览。

代码身份是仓库＋路径，commit 和快照哈希记录实际取得版本。本地 Git 元数据位于外部 worktree／alternates 时，保留目录快照并标记无可确认 commit，不沿引用读取其他目录。

网页完整度只能相对本次静态响应与批准清单解释。`llms.txt` 和导航是发现线索，不能证明全站完整；版本和语言必须通过授权路径明确限定。PDF 表格／公式／列顺序均未作为可靠结构宣称完整，页面缺口一直可见。无需模型密钥，付费外发调用数为零。

## 工程与存储

- macOS 14.4 arm64，Node 24.14.1，pnpm 10.33.0，Obsidian 1.13.7，SQLite 3.53.4。
- 解析依赖：Readability 0.6.0、jsdom 30.0.1、PDF.js 6.3.289；ZIP 使用 yauzl 3.4.0。固定版本在 lockfile 中。
- schema 1 → 2：迁移前 `VACUUM INTO` 完整备份，文件权限 0600；迁移在事务中应用。已有未知表／版本进入只读诊断。
- 原件按 SHA-256 存入 SQLite BLOB 对象表；修订、解析、清单、批准和回执同属权威账本。服务不直接写正式 Vault。
- 新建来源投影将资料放在足够长的代码围栏中，避免来源 Markdown 被当作嵌入、链接指令或可执行页面。插件详情一律 `textContent`。
- 解析进程仅接收原字节与配置，密码走 stdin 管道，不进 argv、DB、事件、临时文件或持久幂等记录。macOS Seatbelt 拒绝网络、写入、子进程以及用户资料目录读取；Node 权限进一步限制读取。受信的 canvas 原生依赖仍属于计算基座，V8 堆限制不等于总 RSS 限制。

## 实际验证

`KB_TEST_OCI=1 KB_TEST_BUILT=1 KB_TEST_CORPUS=1 pnpm test`：**50 项通过，无跳过**。包含原治理测试、真实 OCI 限制、编译后服务进程、新解析进程、来源提交故障，以及实际 GitHub HTTPS 固定提交获取。类型检查、lint 和构建也通过。

一次中间回归运行遇到原有 worker-recovery 用例的 3 秒轮询超时；该用例单独重跑及包含所有开关的完整回归均通过，没有修改其超时时间掩盖问题。

[30 份真实资料报告](evidence/ingestion-corpus.json)涵盖 7 份 Markdown、7 个实际 HTTPS 网页、8 份代码／发布二进制、8 份真实 PDF。每类都有部分可用样本。全部原件可回读，3,660 个块的 UTF-16 区间和片段哈希校验无错误；7 份文本的换行规范化比较未发现字符损失，所有样本提取结果中 U+FFFD 数量为零。网页与 PDF 没有逐字人工金标准，因此报告中不把“零替换字符”写成“零字符损失”。PDF 表格结构遗漏标记为待核对。

本机这一轮原件总量约 6.61 MB，整个语料测试约 22 秒。逐进程 RSS 与解析时长记录在 JSON 中；峰值约 380 MiB。该数据仅说明固定样本表现，不作为大文件或所有站点的性能承诺。

真实 Obsidian 验证使用独立测试 Vault 和独立应用配置。实际点击配对、主端、预览、冻结、解析、批准、写入、来源回读；打开目标 Markdown 并写入编辑缓冲区时 Writer 拒绝修改，关闭并处理测试冲突后沿原批准恢复。页面错误数为零。

- [收录完成与原文定位](evidence/obsidian-ingestion.png)
- [编辑缓冲区冲突保护](evidence/obsidian-ingestion-conflict.png)
- [治理界面新增能力](evidence/obsidian-governance-ingestion.png)；修改前界面见[场景 01 截图](evidence/obsidian-governance.png)。

早期 macOS 隔离配置探针曾使用过严的全局文件读取拒绝，产生 5 个系统未回收的 `UE` 进程记录。已向这些探针发送 SIGKILL；记录仍由内核保留，每个约 48 KB、CPU 为零，未继续处理资料。最终配置不使用该规则，实际解析／桌面／完整回归均已正常退出。没有为清理这些内核记录重启用户机器。

## 本地接口

所有接口沿用回环 Host／Origin／Bearer 校验。写操作需要 admin/user、当前主端及政策版本；reader 只读。外部 writer 角色不能生成用户批准。批准、冻结、取消、回执和完成使用持久命令幂等键；preview 自带 acquisition ID，reparse 为防密码进入幂等记录单独处理。

| 接口 | 含义 |
|---|---|
| `POST /v1/ingestion/preview` | 有界发现与原件暂存，不写 Vault |
| `GET /v1/ingestion`、`GET /v1/ingestion/:id` | 清单、覆盖、失败原因与恢复状态 |
| `POST /v1/ingestion/:id/freeze` | 绑定预览摘要与用户选定条目，创建批量作业 |
| `POST /v1/ingestion/:id/retry`、`cancel` | 失败项恢复／停止后续处理 |
| `POST /v1/ingestion/:id/reparse` | 原件复用；编码和可选临时密码 |
| `GET /v1/ingestion/:id/original/:entryId` | 解析失败仍可取回已取得原件 |
| `GET /v1/parses/:id`、`GET /v1/originals/:id` | 校验解析定位／原件字节，并复核撤回状态 |
| `POST /v1/ingestion/:id/prepare` | 固定逐文件来源投影 |
| `GET /v1/changes/:id` | 读取固定变更与已登记回执 |
| `POST /v1/changes/:id/approve` | 批准固定摘要，10 分钟有效 |
| `POST /v1/changes/:id/grant` | 当前会话逐文件授权，最多 60 秒有效 |
| `POST /v1/changes/:id/receipt`、`finish` | 回读哈希／全部文件完成后提交 |
| `GET /v1/sources` | 只返回完整提交且未撤回的来源与解析 |
| `GET /v1/ingestion-enhancement` | 明确返回 OCR 未启用，不发起外发 |

## 运行检查与回退

首轮在隔离单主端试点使用。负责人为本地主端操作者，观察窗口为启动后首批 10 个收录作业及首次断连恢复。

```sql
SELECT state, stage, count(*) FROM jobs WHERE kind='ingestion' GROUP BY state,stage;
SELECT kind, count(*) FROM events WHERE kind IN ('source.approved','source.committed','source.index_requested','changeset.committed') GROUP BY kind;
SELECT id FROM source_revisions WHERE committed=1 AND NOT EXISTS (SELECT 1 FROM parse_artifacts WHERE revision_id=source_revisions.id AND committed=1);
PRAGMA integrity_check;
```

正常信号：取得后出现逐项解析结果；批准后回执完整，来源提交与索引请求同时登记；第三条查询无结果；`integrity_check` 为 `ok`。插件离线、文件编辑或不同哈希时暂停属于预期状态。

若发生人工字节被覆盖、未批准来源进入正式列表、原件哈希损坏、解析器访问受限目录／网络，立即停止收录并退出服务，保留 DB、WAL、原件与诊断。不要用旧备份覆盖已产生新来源的数据库。需要退回 schema 1 时只对迁移前备份创建独立数据副本，配合旧版本运行；现有 schema 2 和已写入的来源文件保留供核对。解析缺口、登录墙或站点变更优先用新预览／手工剪藏处理，不扩大自动权限。

调研依据：[Readability 安全说明](https://github.com/mozilla/readability#security)、[PDF.js API](https://mozilla.github.io/pdf.js/api/draft/api.js.html)、[Obsidian Vault API](https://docs.obsidian.md/Plugins/Vault)。版本与真实回归记录优先于对上游 API 的推断。
