# 基于 Obsidian 的知识库：技术方案

**版本：1.0｜设计日期：2026-09-20｜主线：桌面单用户、TypeScript、本地文件、先审核后写入**

> 本文定义要开发的系统，不是已经部署的软件。配套的目录模板可以直接用于人工整理；服务、插件、API 和命令属于待实现合同。性能数字、费用限额与工时均为设计目标或计划假设，不是运行结果。

## 0. 本次到底定下什么

上一份调研解决了“有哪些项目可借鉴”。本次不再并列三条路线，而是确定一条主线：**Obsidian + 一个本地 TypeScript 服务 + 一个薄插件；编译器通过适配器复用，正式写入由自己的受控通道执行。**

先得到可用的资料库，再得到可维护的 Wiki。绝不能让向量库、复杂解析器、发布系统和多 Agent 平台成为首次使用的前置条件。

### 0.1 已知要求与设计假设

| 类别 | 约束 |
|---|---|
| 用户明确要求 | 基于 Obsidian；以 TypeScript 为主要实现语言；需要技术方案和落地方案 |
| 承接上轮 | 原始来源可追溯、知识提案可审核、人工笔记不被静默覆盖、Agent 可接入 |
| 本轮采用的假设 | 首位使用者是个人；首先服务技术资料研究；桌面是权威维护端 |
| 尚未测量 | 真实 Vault 规模、机器配置、模型提供商、月预算、已有插件与同步方式 |
| 为避免阻塞采用的默认值 | 新建隔离试点 Vault；前 30 份资料和 20 个真实问题；不导入整库；不启用自动收费 |
| 首轮平台基线 | macOS 桌面优先；服务保持可移植；Linux/Windows 需分别完成插件和路径测试，不能靠 Node 可运行推定整套兼容 |

这些默认值可修改，但修改预算、外发政策、写入目录必须由可信设置入口完成，不能让资料内容或模型决定。

### 0.2 对上轮方案的具体收敛

| 上轮开放项 | 本轮落地决定 |
|---|---|
| 多个候选系统 | atomicstrata 编译 SDK 作为首个技术验证对象；GD4AI 仅可在另一个沙盒 Vault 对照体验，不要求安装 |
| 多种导入方式 | V1 只正式支持 UTF-8 Markdown/TXT 与 Web Clipper 保存的 Markdown；PDF、代码仓库连接器、服务器抓网页放入 V1.1 |
| 多个基础组件 | 一个服务进程、一个串行任务调度器、SQLite；不部署 Redis、独立向量库、图数据库或消息中间件 |
| 十多个 workspace 包 | 只建立 `apps/service`、`apps/obsidian-plugin`、`apps/cli`、`packages/contracts`，领域能力先作为服务内模块 |
| 编译页数 3+8 | 试点每次最多 1 个新页、2 个更新页、20 条候选主张；超限拆批，不静默截断 |
| 发布、备份一起后置 | **备份、撤回、恢复属于 V1 上线门禁；公共发布后置** |
| 来源版本与解析版本混用 | 明确分开 SourceRevision 与 ParseArtifact，重新解析不改变旧引用 |
| 所有功能都用 SDK | 不直接使用上游 search/query/save 作为本系统查询与写入入口；独立保留离线词法检索和受控问答 |

## 1. 产品闭环与首版验收对象

### 1.1 日常使用闭环

```text
剪藏 / 导入
  → 检查内容是否完整与是否允许外发
  → 冻结来源版本
  → 关键词检索立即可用
  → 选择值得沉淀的资料
  → 生成 Wiki 变更提案
  → 对照原文检查 diff
  → 人工批准并应用
  → 提问、查看固定来源
  → 将值得保留的回答另存候选
```

**导入不等于编译，编译不等于批准，批准不等于已经落盘，回答不等于新增事实。** 界面和 API 必须分别表达这些状态。

### 1.2 六个首版用户故事

| 编号 | 用户动作 | 应观察到的结果 |
|---|---|---|
| US01 | 导入同一篇文档两次 | 不产生两份无法解释的来源和重复提案 |
| US02 | 导入同 URL 的新版本 | 保留旧版，新版具有新 revision，受影响知识待复审 |
| US03 | 搜“权限”或一个代码符号 | 无模型密钥时也能返回原文片段 |
| US04 | 编译三篇有关联的资料 | 看到拟新增/修改页面、原因、证据，而不是直接覆盖文件 |
| US05 | 审核期间手改目标文件 | 旧提案不能覆盖修改；界面说明基线冲突 |
| US06 | 关闭并重启服务 | 已导入资料仍可查，未完成任务可恢复或明确暂停 |

### 1.3 不在 V1 的能力

不支持多人同时写入、移动端自动编译、全网爬虫、任意 shell、公共站点自动发布、海量历史对话自动入库、复杂 PDF/OCR、自动认定用户决定，以及无界 Agent Loop。对这些能力返回明确“不支持的输入/操作”，而不是接收后假装成功。

## 2. 技术选型与采用条件

| 层 | 本轮选择 | 采用条件 |
|---|---|---|
| 工作台 | Obsidian 桌面版 | 不重写编辑器、链接图或同步协议 |
| 网页入口 | 官方 Web Clipper | 人检查正文覆盖；保存到 `00-Inbox`，不直接当已审核知识 [S01][S02] |
| 服务运行时 | Node.js 24 受测补丁版，TypeScript strict | 官方发布页将 24 列为 LTS；实施时锁精确补丁，而非浮动 latest [S03] |
| 工程 | pnpm workspace，ESM 服务 | 显式包依赖、提交 lockfile，CI frozen install [S04] |
| HTTP | Fastify | localhost API；业务 schema 由本系统维护 [S05] |
| 校验 | Zod 或等价的受信 runtime schema | 所有外部输入和模型输出运行时校验；不能只 `as Type` |
| 状态与索引 | better-sqlite3 + SQLite FTS5 | native 模块仅在外部服务使用；完成目标 OS 构建和备份测试 [S06][S07] |
| 编译器 | `llm-wiki-compiler` 适配器优先 | E00 验证通过后启用；不直接指向正式 Vault [S08][S09] |
| 替代编译器 | 有界两次模型调用的 native adapter | 仅在上游引用映射、预算控制或候选接口不通过时替代，不同时维护两套生产路径 |
| 词法检索 | 自有 tokenizer + FTS5 + exact-symbol 表 | 无模型、无网络仍可用 |
| 问答 | 自有 AnswerService → LlmPort | 输入只来自授权快照；结构化引用；不调用上游 save |
| 测试 | 单测、真实 SQLite 集成、故障注入、隔离 Obsidian 验收 | 单测不能替代真实插件测试 |

### 2.1 对上游 SDK 的事实边界

本轮读取的仓库 `package.json` 标为 `1.1.0`、ESM、Node `>=24`；这是读取快照，不是确认 npm 最新版，也不是安装验证。[S08]

维护者 SDK 文档有 `createWiki`、`ingestText`、`compile({review:true})` 等入口，但当前 review 文档也明确：普通 compile 可以直接写 Wiki，`query --save` 不经过同一审核政策。[S09][S10]

当前 facade 的 `search()` 会检查模型凭据，返回 `{pages, refs, warnings}`。因此它不承担本系统“无密钥仍可查”的基线能力。[S11]

**集成门禁：** 锁实际包版本、包完整性、源码 commit、模型配置；逐项验证候选读取、出处映射、内部调用计量、失败重启、没有正式 Vault 写入。缺一项不进入真实资料路径。任何不可控子调用都不能用“外层设置了超时”代替预算治理。

## 3. 部署架构和模块边界

```text
浏览器 Web Clipper                  外部 Agent（V1.1）
        │                                  │
        ▼                                  ▼
  00-Inbox / 文件选择              只读 MCP → 本地 API
        │                                  │
        └──────── Obsidian 薄插件 ───────────┤
                   │                       │
          文件快照上传 / 提问 / 批准          │
                   ▼                       ▼
           TypeScript 本地知识服务
       ┌──────────────────────────────────┐
       │ Auth / Policy / Budget / Jobs    │
       │ Capture → Parse → Index          │
       │ Compiler → Evidence → ChangeSet  │
       │ Retrieval → Context → Answer     │
       │ Commit coordinator / Recovery    │
       └───────┬──────────────┬────────────┘
               │              │
       state.db + objects    index.db（可重建）
               │
       冻结、批准过的写入任务
               ▼
       插件内唯一 Writer → Vault
```

### 3.1 部署只需两个常驻端

**服务端**运行 HTTP、任务调度和领域逻辑；SQLite 和对象库在 Vault 外。**插件端**展示 UI、上传用户选定内容、执行经过核验的写入。CLI 是管理客户端，不是第二个 Writer；MCP 将来也只调用服务。

默认服务不会递归扫描用户 Home，也不直接 `fs.writeFile` 活跃 Vault。需要读取资料时由插件上传固定内容；需要落盘时由插件执行。CLI 文件导入须用户明确给定文件，转换为上传内容，而不是把任意服务器路径交给模型。

### 3.2 模块分工

| 模块 | 主要文件 | 核心职责 |
|---|---|---|
| auth/policy | `modules/policy/{auth,egress,path-policy}.ts` | 验证身份、范围、模型外发策略 |
| source | `modules/source/{ingest,parse,registry}.ts` | 稳定来源身份、修订、解析产物 |
| runtime | `modules/runtime/{queue,lease,budget}.ts` | 持久任务、限额、恢复 |
| storage | `modules/storage/{db,objects,snapshots}.ts` | 数据关系、不可变对象、快照 |
| compiler | `modules/compiler/{port,atomic,native,validate}.ts` | 一次只启用一种编译实现 |
| writer | `modules/writer/{proposals,approvals,commit,recovery}.ts` | 审批摘要、提交清单、恢复 |
| retrieval | `modules/retrieval/{tokenize,fts,exact,search}.ts` | 无模型检索、版本过滤 |
| answer | `modules/answer/{context,generate,citations}.ts` | 上下文预算、有证据的回答 |
| operations | `modules/operations/{backup,restore,retract}.ts` | 备份、恢复、内容撤回 |

不要预先创建空 `native.ts` 或未启用的向量包；表中是功能归属，按任务需要创建。

## 4. 存储布局和数据归属

### 4.1 Vault

```text
Knowledge-Pilot/
├── 00-Inbox/                       # 人工剪藏，未接管
├── 10-Sources/
│   └── <sourceId>/
│       └── <sourceRevisionId>/
│           ├── original.md         # 本次实际收到的原始内容
│           └── <parseId>/
│               ├── content.md      # 固定 block ID 的正文
│               └── manifest.json
├── 20-Wiki/{concepts,systems,comparisons,decisions}/
├── 30-Notes/                       # 人工笔记，自动化只读
├── 40-Projects/                    # 人工项目资料，自动化只读
├── 50-Queries/                     # 保存的回答候选
├── 80-Review/                      # 可读提案摘要，不是审批凭证
└── 90-System/
    ├── Templates/
    ├── provenance/<pageId>/<pageRevisionId>.json
    └── 首页.md
```

V1 不强制接管现有大 Vault。先用独立 Pilot；正式采用时可以继续用它，不一定要并回旧库。

`original.md` 表示实际收到的字节：若来自 Clipper，记录 `captureKind=browser_clip`，不能宣称同时保存了网页完整 HTML、图片和动态内容。V1.1 的网页抓取器才能保存自己实际取得的 HTML。每个输入有 `coverage=full_text|excerpt|unknown`；这是采集覆盖描述，不由模型自行升级。

### 4.2 运行目录

```text
<runtimeRoot>/<vaultId>/
├── state.db                     # 不能丢：任务、审批、预算、提交
├── index.db                     # 可重建：词法索引与索引快照
├── objects/sha256/<prefix>/<hash> # 不能丢：来源、前后版本、提案对象
├── compiler-workspaces/         # 未提交编译工作区，可按任务清理
├── policy.json                  # 受信政策，不从 Vault 读取
├── config.json                  # 不含明文模型密钥
├── credentials.json             # 本地 bridge 凭据，0600，不同步
├── logs/                        # 只记录标识、状态、用量
└── backups/                     # 备份清单或独立备份位置引用
```

推荐 `runtimeRoot=~/.local/share/obsidian-kb` 作为示例；实际路径由首次配置指定。启动时校验它不位于 Vault 内、不是符号链接、不在已配置的同步目录中。凭据和模型密钥不能被复制到 `starter-vault`。

### 4.3 两个事实源，不是“一个真源，其他全可删”

知识内容的事实源是不可变来源、已提交 Markdown 与 provenance；**操作事实源是 state.db 和 objects**。后者记录人的批准和不确定的收费调用，不能靠扫描 Markdown 重建。index.db 才是可重建投影。

state.db 提交后写 outbox，索引器消费成功后推进 `indexSnapshotId`。查询只使用一个已经构建完成的索引快照和对应对象，不能用旧索引偏移截取当前磁盘的新文件。

## 5. 领域模型：来源、解析、主张、页面必须分开

完整接口草案在 `references/contracts.ts`，DDL 草案在 `references/001-state.sql` 和 `002-index.sql`。它们是可检查的设计附件，不是已经连接服务的数据库迁移。

| 对象 | 身份/关键字段 | 生命周期与不变量 |
|---|---|---|
| Source | sourceId、canonicalKey、title、policy | 逻辑来源；URL 变化可人工关联；转载保留独立来源 |
| SourceRevision | sourceRevisionId、sourceId、originalHash、capturedAt、publishedAt | 一次固定输入；相同 source+原文字节复用；不重写历史字节 |
| ParseArtifact | parseId、sourceRevisionId、parserFingerprint、normalizedHash | 解析器或规范化改变产生新 parseId |
| Evidence | evidenceId、parseId、blockId、UTF-16 半开区间、quoteHash | 引用绑定具体解析正文，不绑定“最新版” |
| Claim | claimId、origin、statement、scope、reviewState | 区分 sourced、inferred、user-stated；带版本与条件 |
| Page | pageId、path、type | 页面身份不随标题改变；V1 自动化不 rename |
| PageRevision | pageRevisionId、pageId、bodyHash、provenanceHash | 一个已观察/已提交版本；reviewed 不可由模型赋权 |
| ChangeSet | changeSetId、baseSnapshotId、proposalDigest、patches | 一份冻结提案；不能边看 diff 边被后台修改 |
| Approval | approvalId、digest、principalId、policyVersion、expiry | 绑定具体提案，不是长期通行证 |
| Snapshot | snapshotId、manifestHash、sequence | 当前可查询来源和页面的不可变映射 |
| Job/Attempt | jobId、operationKey、leaseFence、stage、outputHash | 重启可续，不承诺模型调用 exactly-once |

### 5.1 哈希和身份规则

原文字节使用 SHA-256；正文在 UTF-8 解码成功、统一生成 block ID 后冻结并计算哈希；拒绝无法合法解码的 V1 文本。证据区间是 JavaScript UTF-16 code units `[start,end)`，quoteHash 计算 `text.slice(start,end)` 的 UTF-8 字节。接口必须显式记录编码，不能混用 byte offset、code point 和 UTF-16。

目录与页面文件名由程序根据类型、slug 和 ID 产生；模型只提交 `pageId` 或受限新页标题，不提交任意路径。原文保留 CRLF/原始编码字节；normalized text 可统一为 LF，二者 hash 分开。

### 5.2 来源身份与去重

Web Clipper 的 URL 只作为匹配线索，保留影响版本的 query 参数。确认 canonicalKey 后，同 sourceId、同 originalHash 直接返回已有修订，不重复编译。相同正文来自两个网站时，可以共用对象字节，但不能当成两份独立实证。

TXT 无 URL 时，首次分配 sourceId；后续替换必须由用户选择“更新这个来源”，不能因同名文件就覆盖。已有同名笔记只触发冲突，不自动猜测来源归属。

## 6. 摄取和来源冻结

### 6.1 输入合同

```ts
interface IngestRequest {
  uploadId: string;
  sourceId?: string; // 明确更新已有来源时提供
  title: string;
  canonicalUrl?: string; // 元数据；V1 不据此自动抓取
  captureKind: 'file' | 'browser_clip' | 'user_note';
  coverage: 'full_text' | 'excerpt' | 'unknown';
  modelRouteIds: string[]; // 与可信政策取交集，不提升权限
}
```

原始文件先上传到对象仓，返回 uploadId 和 hash。上传上限默认 10 MiB；首次支持 `.md/.txt`，文件扩展名和实际文本解析都检查。空正文、登录导航、明显截断进入 `needs_review`。短文不因为字数少就自动失败，要求用户确认覆盖而非仅靠固定字符阈值。

### 6.2 流程

```text
上传 → 验证输入 → 存原始对象 → 解析规范化 → 生成证据块
  → 持久保存来源导入提案 → 插件显示导入清单
  → 用户点击“导入这份来源”
  → source-only 授权 → Writer 仅创建指定来源目录
  → 提交 snapshot → 索引 outbox → 来源可检索
```

导入授权只准创建该来源的固定文件，不准修改 `20-Wiki`。批量导入可以批准一个包含文件 hash 的导入清单，不把一次按钮扩大成全库写权。

插件离线时可完成上传和解析，但来源保持 `awaiting_writer`，不进入正式可检索快照。UI 明确解释“解析完成，等待 Obsidian 写入”，不返回 ingest success。

### 6.3 事件与清点

V1 不在每次文件保存后立即编译。默认用户主动点击“导入选中资料”。以后可选监听 Inbox 并只创建导入候选。

插件启动在 layout ready 后清点允许目录；监听事件做 1 秒去抖与内容 hash 去重，定期清点补偿。自动生成的 Wiki/provenance 只触发索引核对，不再次当新资料摄取。只靠 watcher 不足以构成持久任务队列。

## 7. 知识编译与增量更新

### 7.1 输入必须是冻结快照

一次编译记录：输入 parseIds、基础 snapshotId、已有页面版本、允许模型路线交集、compiler/model/prompt fingerprint、页数和调用预算。运行期间新导入的资料不偷偷加入本次任务；后续另起任务。

先限制为 1–3 份相关资料。真正过长的材料只分段提取；若总工作超过本 job 限额，拆成显式子任务，而不是截断后宣称完成全文编译。

### 7.2 上游适配器合同

`CompilerPort.propose(input, signal)` 返回 `CompileProposal`，内含结构化主张、新页/更新页内容、来源定位、未解决问题及 usage，不返回正式文件写入能力。

采用 atomicstrata 时：

1. 在 `compiler-workspaces/<jobId>` 复制上次**已提交**的工作快照，禁止 hardlink 到活跃 Vault。
2. 只将本次允许外发的规范化资料通过 `ingestText` 输入，保存上游 filename → parseId 映射。
3. 强制 review；缺失受控配置、候选无法读出或 ingest 被截断即失败。
4. 读取锁定版本的候选结构；把源行范围转换到本系统固定 Evidence；不能可靠转换时拒绝这条主张。
5. 将候选转换为自己的 ChangeSet；上游生成的路径、frontmatter 权限字段和任何批准状态都不直接采用。
6. 只有正式 ChangeSet committed 后，才推进适配器基线。被拒绝/失败工作区不能污染下次正式输入。

[S09][S10][S11]

**独立目录不是操作系统沙箱。** 同一用户进程理论上仍能访问其他路径。正式使用前，必须验证 SDK 实际执行模式；不启用可获得任意 shell/文件工具的执行模式。无法收窄模型工具或逐调用计量时改用 native adapter。强隔离要求额外使用受限 OS 身份/容器，并只挂载工作区；这不是 V1 默认“已经具备”的保证。

### 7.3 native adapter 的最小替代流程

仅当上游不通过 E00 才实现：

**第一次模型调用 Extract**：输入规范化正文及段落 evidenceId，输出最多 20 条 `{statement, origin, scope, evidenceIds, entityKeys}`。所有 evidenceId 必须属于输入白名单。模型不输出原文偏移，由确定性程序预先生成。

**确定性 Resolve/Impact**：按显式实体别名、来源反向依赖与页面标题选择候选。先精确匹配，再最多取 5 个词法候选；不确定就新建歧义记录，不把相似名字自动合并。

**第二次模型调用 Propose**：输入有效 claims、最多 2 个待更新页面的固定基线及 1 个新页预算；输出受限页面结构。没有必要新建时允许输出零页，不用页数当生产力指标。

**确定性 Validate**：schema、引用、hash、scope、路径、链接和页数全部通过才进入审核。允许一次结构修复，仍失败就停止。语义支持由用户在 diff 视图复核，不以模型 confidence 代替事实正确性。

### 7.4 新资料怎样修改旧知识

依赖链为 `sourceRevision → parse → evidence → claim → pageRevision`。新修订先让受影响旧主张显示“来源已更新，待复审”，但不简单认定旧版错误。

更新提案必须说明：改变的是版本、条件、数值还是结论；旧结论是否仍对旧版本有效；需要保留哪些分歧。时间更新不等于权威更新。V1 只做直接依赖影响分析，跨多层比较页列入待复审清单，不自动递归全库重写。

### 7.5 页面结构与人工内容

Wiki 页固定包含：定义/结论、适用版本、条件与例外、来源与分歧、相关知识。决策页只有明确批准后才能写“本项目决定”，模型只能生成建议。

人工感想放在 `30-Notes` 并链接 Wiki。用户仍可编辑受管页面，但插件发现 hash 变化后记录 human-observed revision，旧提案失效，页面进入 `needs_review`。未经审核的人改版本可被明确标注后查询，不能沿用旧页面的 reviewed 标签；撤回前的旧内容不得因为仍有旧快照而绕过 tombstone。

## 8. 引用、可信度与问答

### 8.1 引用不是一个外链

回答的每个重要外部事实绑定 `evidenceId → parseId → sourceRevisionId`。证据包含固定正文对象、区间和 quoteHash。正文显示用稳定脚注，插件点击脚注展示原文与来源时间；打开 Vault block 前核对本地正文 hash，损坏时退回服务固定快照，不展示错误位置。

三类内容分开标记：

- `sourced`：有原文支持，仍需校验条件和版本。
- `inferred`：系统推断，明确展示推断依据和不确定性。
- `user-stated`：用户笔记或决定，能证明“用户作过此判断”，不能自动证明外部事实。

AI 页可以互相链接导航，但证据链必须回到来源或明确的用户陈述。历史回答不能作为新的独立来源强化自己。

### 8.2 查询流程

```text
身份与外发政策
 → 确定单个 indexSnapshotId
 → query 规范化和精确符号匹配
 → FTS 召回与标题/别名匹配
 → 版本范围与来源状态检查
 → 按来源家族去重
 → 取固定对象与证据
 → 再次检查外发政策
 → 组装受限上下文
 → 模型结构化回答
 → 验证引用与输出状态
 → 渲染 Markdown
```

默认不上网补答案。没有资料支持时返回 `insufficient_evidence`；发现未解分歧返回 `conflicting_evidence`，并展示双方条件。不要为了回答率省略不利证据。

### 8.3 中文与代码词法基线

默认 tokenizer：`Intl.Segmenter('zh', {granularity:'word'})` 的词项，加连续汉字 bigram 补偿；tokenizer fingerprint 记录 Node/ICU 版本和配置。索引与查询使用相同规则。英文归一化只作用于索引；代码符号另存精确表，保留 `C++`、`Node.js`、`app.vault.process` 原貌。

SQLite FTS5 的 trigram 对不足三个 Unicode 字符的全文查询有明确限制，因此不能直接用它作为中文两字词基线。[S07]

词法候选默认 30，精确候选 10，去重后最多 8 个 evidence block、每个来源最多 3 个 block。FTS MATCH 表达式由代码构建和转义；SQL 使用参数绑定。FTS5 的 bm25 排序方向按官方行为处理，不能把“更大”当“更相关”。[S07]

向量、图扩展和重排均默认关闭。只有固定问题集证明纯词法存在明确缺口，再引入一个增强组件，保留消融结果。

### 8.4 上下文与输出预算

每次模型调用输入最多 12,000 tokens、输出最多 2,000 tokens；实际模型窗口较小时取更低者。输入中保留约 2,000 给规则/问题，2,000 给知识页，6,000 给原始证据，2,000 给定位和余量。这是初始配置，不代表所有任务必然适合。

不以字符数冒充精确 token 计量。无法取得匹配模型的 tokenizer 时采用保守上界，并在 provider 侧设置输出限额。长表格、代码与否定条件不能被半截切掉；无法安全装入就说明范围不足。

答案先输出 `{status, claims:[{text,evidenceIds}], warnings}`，渲染器生成脚注。未知 evidenceId、已撤回来源、正文 hash 不符全部阻断相应结论。结构合法不代表语义正确，人工支持率另测。

### 8.5 保存回答

“保存候选”写入 `50-Queries`，保存问题、answerId、snapshotId、证据链和模型 fingerprint。它必须经过同一提案与批准流程；不直接调用上游 `query --save`。提升为 Wiki 时重新去重和校验证据，不把保存动作当审核。

## 9. ChangeSet、审批与 Writer

### 9.1 冻结提案

ChangeSet 摘要覆盖：schemaVersion、vaultId、baseSnapshotId、文件路径/动作、before/after hash、provenance、输入来源、policyVersion、compiler/model/prompt fingerprint。规范化 JSON 后计算 SHA-256。payload 发生任何变化生成新的提案版本并使旧批准失效。

存储 after/before 对象后才发布提案。没有持久对象就不能显示可批准按钮。前端的 Markdown 文本、`publish:true`、reviewed 属性都不是授权凭证。

### 9.2 身份分离

服务首次由本地管理 CLI 生成一次性配对码；插件弹出用户确认后换取 desktop scope 的会话凭据，保存在 Vault 外受限文件，插件只在本机内存使用。Agent 使用另发的只读凭据，不能复用 desktop/admin 凭据。

配对码短期有效、一次使用；loopback API 验证 Authorization、Host，并拒绝非允许的浏览器 Origin。仅声明 CORS 不构成访问控制。更改预算/外发政策和授予 approve scope 仅限管理端；模型参数不能自报角色。

本方案防止模型和远程页面借接口越权，不声称抵御已经控制同一 OS 用户的恶意程序。社区插件也应作为可信代码审查，不能假设有独立权限沙箱。[S14]

### 9.3 插件写入协议

插件请求领取一个短期 writer session，绑定 vaultId、instanceId 和递增 epoch。服务为每个已授权写入发出一次性 grant，包含 changeSetId、digest、文件索引、afterHash、epoch、expiry。插件向服务复验 grant 并取受信对象；不接受模型给出的下载 URL 或文件内容替换。

同一 Vault 的提交串行化。旧 session/epoch 的领取请求被拒绝；重启后先恢复未完成提交，不立即领取新写入。插件离线时不切换成服务直接写文件。epoch/fence 只能限制服务协议请求，不能撤销已经开始的文件系统操作；旧 writer 存在未知在途写入时进入 reconciliation，先确认旧实例停止并核对文件，再让新实例执行，不能仅等 lease 到期就宣称完成安全接管。

### 9.4 单文件修改

使用 `Vault.process(file, synchronousCallback)` 在读改写环节比较基线；官方 API 的同步回调与单文件语义支持这一方式。[S12][S13]

```text
1. 核验真实批准、policyVersion、grant、before/after 对象。
2. 目标处于任一打开的 Markdown 编辑页时暂停，要求关闭后重试。
3. 在 process 回调里计算当前 hash：
   - 等于 after：仅同一已授权提交的恢复可视为已应用；
   - 等于 before：返回冻结 afterText；
   - 其他值：抛 BASE_REVISION_CONFLICT，不覆盖。
4. 写后重新读取核对 afterHash。
5. 发送回执，回执幂等键是 changeSetId + patchIndex。
```

`FilePatch.afterObjectHash` 对 UTF-8 文本补丁必须等于 `afterHash`；它是不可变对象键，不是下载 URL。create 必须检查目标不存在；存在但内容不同即冲突。V1 不自动 rename/delete，避免名称迁移和链接更新进入通用写路径。

关闭编辑页和 hash 检查减少协作型竞争，但不是阻止其他进程修改的强锁。发生第三种 hash 时保留人工内容，这是必须测试的底线。

### 9.5 多文件不是原子事务

知识页与 provenance 往往需多文件提交。采用 `PREPARED → APPLYING → COMMITTED` 的持久清单。允许磁盘暂时部分更新，但服务查询只读取最后完整提交的快照；不承诺 Obsidian 文件浏览看不到中间状态。

全部文件验证为 after 后，在一次 state.db 事务中更新 revision 指针、创建 snapshot 并写 outbox。索引构建完成才切 `indexSnapshotId`。若服务在回执前崩溃，恢复以文件内容和已冻结对象核对，不靠“上次请求成功过”猜测。

| 恢复时文件 | 动作 |
|---|---|
| 当前等于 before | 批准仍有效则可继续；过期则暂停，重新授权剩余动作 |
| 当前等于 after | 同一 ChangeSet 对象校验通过后补回执 |
| 第三种 hash | 标记冲突，保存用户内容，不自动回滚 |
| 原文件消失 | 视为并发删除，不能无条件恢复它 |
| 新建文件已存在且不同 | 命名冲突，停止 |

批准在中途过期时显示“部分文件已应用，剩余等待重新授权”。恢复界面展示已完成与未完成文件；可对同一冻结 digest 发出新的恢复批准。若出现第三种 hash，必须重新提案。逆向回滚也先比较当前仍等于 after，不能用旧备份覆盖用户后续修改。

## 10. 持久任务和幂等

V1 一个 active job、一个 active compile；无需先建设多 worker 平台，但仍保存租约以处理重启和重复进程。

```text
queued → running → succeeded
             ├→ awaiting_writer
             ├→ waiting_approval
             ├→ blocked_budget
             ├→ retry_wait
             ├→ conflict
             ├→ failed
             └→ cancelled
```

stage 单独记录 `validate/capture/parse/index/extract/propose/verify/apply`。等待批准不占运行租约，后续来源导入可继续。

`operationKey` 是 `vaultId + operation + inputRevisionDigest + processorFingerprint + policyVersion` 的摘要。外部 Idempotency-Key 另外绑定 requestBodyHash；同一 key 不同请求体返回 409。

数据库短事务领取任务，lease 30 秒、每 10 秒续租，递增 fence；任何状态/预算/提交请求都检查 fence。时钟采用受控依赖便于测试，机器休眠后先重新领取或暂停，不假装旧 lease 有效。

每步结果先持久化对象和 hash，再写 stage_outputs 并推进状态。重启复用相同输入 digest 的成功阶段。最多 3 次尝试仅用于明确可重试网络/限流错误；权限、引用、人工冲突不会被自动无限重试。

模型请求结果不明时写 `outcome_unknown` 并保留预算预占；重新请求可能重复计费，不宣称 exactly-once。取消阻止新的调用，不保证远端即时停止计算。

## 11. 接口与错误合同

所有 `/v1` 路由是本方案定义，不是 Obsidian 或 PandaWiki 自带 API。上传和请求都有大小上限；接口返回 ID，不接受模型提供任意服务端路径。

| 方法/路径 | 请求重点 | 返回与权限 |
|---|---|---|
| `GET /health` | 无内容参数 | 协议版本和存活状态，不暴露 vault 路径 |
| `POST /v1/pair` | 一次性配对码、客户端 ID | desktop 会话；不供 Agent 使用 |
| `POST /v1/uploads` | 二进制/text 上传 | uploadId/hash；ingest scope |
| `POST /v1/ingestions` | IngestRequest | 202/jobId；须 Idempotency-Key |
| `GET /v1/jobs/:id` | jobId | state/stage/warnings/usage |
| `POST /v1/compilations` | parseIds/baseSnapshotId | 202/jobId；只能提案 |
| `GET /v1/changesets/:id` | changeSetId | 固定 diff、digest、证据和剩余文件 |
| `POST /v1/changesets/:id/approve` | digest、policyVersion | approvalId；desktop 人工操作 |
| `POST /v1/changesets/:id/reject` | digest、reason | rejected；desktop scope |
| `POST /v1/changesets/:id/apply` | approvalId | 202/jobId；重新验证授权 |
| `POST /v1/writer/session` | vaultId/instanceId | epoch/lease；writer scope |
| `POST /v1/writer/next` | session/epoch | 固定 grant 或 empty |
| `POST /v1/writer/receipts` | grant/observedHash/result | 幂等回执；服务核对对象 |
| `POST /v1/search` | query/limit/snapshotId | hits/indexSnapshotId/warnings |
| `POST /v1/answers` | query/mode | answerId/status/citations/usage |
| `GET /v1/evidence/:id` | evidenceId | 固定正文与位置；撤回立即拒绝 |
| `POST /v1/answers/:id/save-proposal` | answerId | 202/候选任务，不直接写入 |
| `POST /v1/sources/:id/retract` | reason | tombstone；admin scope |
| `POST /v1/admin/backup` | 明确备份操作 | backupId；admin scope |

`GET /v1/jobs`、`GET /v1/changesets` 提供分页列表，使用稳定 cursor，不把数组无限返回。V1 UI 采用请求轮询：活跃任务约 1 秒、空闲约 5 秒，后台窗口退避。SSE/WebSocket 不作为 V1 依赖。

统一错误：`{code,message,retryable,jobId?,detailId?}`。常用码为 `AUTH_REQUIRED`(401)、`FORBIDDEN`(403)、`PAYLOAD_TOO_LARGE`(413)、`IDEMPOTENCY_CONFLICT`/`BASE_REVISION_CONFLICT`(409)、`BUDGET_EXHAUSTED`(409，业务阻塞)、`UNSUPPORTED_INPUT`(422)、`WRITER_OFFLINE`(409)。后台 job 可处于 waiting 状态，不能把等候当永久失败。

## 12. 模型政策、预算和密钥

### 12.1 默认不配置模型

交付的 `service.example.json` 将 `model.enabled=false`、`writes.enabled=false`。写入还分为 `writes.allowSourceImports` 与 `writes.allowWikiChanges`：M1 验证 Writer 后，仅开启全局开关和来源导入；M2 审核流程通过后，才开启 Wiki 修改。两个类别都必须通过相应清单批准，开关不是免审批授权。因此未配置模型也能完成手工整理和开发后的词法检索，但**不能编译或 AI 回答**。不可把关闭收费的配置描述成“已经配置本地模型”。

实施时通过可信设置配置一个模型路线，记录 routeId、provider、确切 modelId、baseURL、凭据引用、单价生效时间、contextLimit、timeout、输出上限和允许内容等级。模型名称与单价必须按实际账户核实；不在方案里预填未经验证的“最新最强模型”。

云模型只接收用户明确批准的资料。未设置 modelRouteIds 的来源默认不外发；用户有权本地读取不代表可发云端。编译多份资料时取路线交集，交集为空即 `NO_ALLOWED_MODEL_ROUTE`。不自动切换到更宽松 provider。

### 12.2 预算以整数微美元记账

成本单位 `microUSD`，1 USD = 1,000,000 microUSD；token 单价与最终舍入规则纳入 priceBookVersion，避免浮点累计漂移。配套示例只定义上限：单 job 500,000、每日 3,000,000、每月 50,000,000 microUSD；这些不是用户已确认预算，首次启用付费路线需确认。

预占在同一 state.db 事务内完成，检查 `settled + reserved + newReservation ≤ limit`，同时覆盖 job/day/month。返回用量后结算，取消或超时未知时保留预占。无价格表/无法计量的路线不准进入收费生产路径。

每个 job 最多 6 次模型调用，总输入最多 48,000 tokens，总输出最多 8,000 tokens；单次依然受 12,000/2,000 限制。运行时检查这些整数上限，而不靠提示词。

上游若存在绕过 LlmPort 的内部调用，需要 gateway/最小 provider 适配覆盖全部调用；覆盖不全则切换 native。应用限额无法绝对保证厂商账单封顶，应结合账户侧额度与用量核对，不把取消本地任务当作停止收费。

### 12.3 密钥边界

模型密钥只存在服务进程的受限环境变量或 OS 凭据设施。插件不持有模型密钥，日志不记录 prompt 全文和 Authorization。调试全文采样默认关闭，启用需单独授权、短保留期、受限目录。

## 13. Obsidian 插件设计

插件 ID 规划为 `personal-knowledge-bridge`；采用官方 sample plugin 的构建方式，`obsidian` 作为 external，不能将 better-sqlite3 或服务的 Node 原生依赖打进插件。[S15]

只实现四个界面：

| 界面 | 最少信息/动作 |
|---|---|
| 收件箱 | 选择资料、来源 URL、覆盖说明、外发授权、导入按钮 |
| 搜索/提问 | 关键词模式与 AI 模式区分；引用定位、快照时间、证据不足提示 |
| 审核 | 旧/新 diff、每个主张来源、风险与条件、批准/拒绝、已应用/未应用文件 |
| 任务/设置 | job stage、重试/恢复、预算、服务连接、写入总开关 |

插件命令固定为 `KB: 导入选中资料`、`KB: 搜索知识库`、`KB: 提出知识更新`、`KB: 审核待处理变更`、`KB: 查看任务与预算`。这些是待实现命令名，不是安装 Obsidian 后自然存在的功能。

审核 UI 使用应用自身 diff 视图，不把模型输出当 HTML 执行；外链和图片加载需受控，默认不自动获取远程图片。模型生成的“批准按钮”只是文本，只有可信 UI 的按钮产生批准请求。

插件关闭时取消轮询、注销事件；服务断连时禁用写入按钮但保留原生笔记编辑。真实打包产物为 `main.js`、`manifest.json` 和可选 `styles.css`，安装位置为 Vault 的 `.obsidian/plugins/<id>/`；具体 minAppVersion 由受测 API 版本确定，不能随便宣称兼容所有版本。[S15]

## 14. 运维、恢复和内容撤回

### 14.1 最少运行指标

记录 `traceId/jobId/stage/attempt/sourceRevisionId/parseId/changeSetId/snapshotId`。模型调用记录 route、modelId、tokens、预占/结算、providerRequestId。指标覆盖队列、失败阶段、索引落后、重复提案、写入冲突、单问成本和引用失效。

诊断不泄漏全文。UI 显示“目前查询快照为 N，最近已提交为 N+1”，而不是隐瞒索引尚未跟上。

### 14.2 备份一致性

备份前暂停新写入和编译提交，等待正在 APPLY 的任务到达可恢复点；复制 Vault 的固定版本、state.db 一致快照、objects、policy/config，生成 backup manifest 和 hash。SQLite 使用 Backup API/驱动 backup 能力或在干净关闭连接后备份，不在运行中仅复制 `.db` 忽略 WAL。[S06][S16]

暂停自动写入不能锁住人的编辑器或外部同步。备份窗口要求用户暂停编辑，复制前后比对文件 hash；发生变化则重试该备份或报告不一致，不能把 SQLite 一致快照夸大成整个 Vault 的原子快照。进行中的模型调用先停止新分发并登记已知/未知状态；恢复后未知费用仍要核对。

index.db 可不备份，恢复后重建。**备份失败不等于旧备份也失效，但不能在 UI 显示本次成功。** 建议每日快照、每周恢复演练；保留策略按磁盘容量设置，不能无限保留被请求清除的敏感正文。

### 14.3 恢复顺序

关闭自动写入 → 恢复 Vault+state+objects 的同一备份集 → integrity check/hash 核对 → reconciliation 未完成提交 → 旧批准过期则等待人 → 从空 index 重建 → 运行固定引用测试 → 人确认后开放写入。

state.db 损坏时不自动新建空库并继续“恢复”；进入只读诊断。数据库落后而磁盘已有较新文件时，不让队列直接覆盖它们。

### 14.4 撤回与清除

V1 必须支持撤回：先将 source 置为 retracted，在搜索、证据读取、模型上下文、答案保存处实时检查；再异步移除索引并标记派生页面 stale。查询旧 snapshot 也不能绕开撤回。

完全清除是独立管理流程：枚举原文、parse、before/after 对象、provenance、FTS、答案、日志、备份中的依赖；提交删除清单并给出完成/无法控制项。V1 可通过受控离线 purge 维护命令完成，不要求提供给 Agent。第三方已接收副本不保证可撤回；数据库删行也不等于物理介质不可恢复。[S07]

### 14.5 同步策略

试点不开同步。正式使用时只有一个权威自动化写端，同步只覆盖 Markdown/附件，不同步活动数据库、凭据、锁和工作区。其他设备默认阅读；需要在移动端手改受管知识时，主设备重连先清点和冲突处理，再自动写入。同步服务不是分布式事务系统。

## 15. 评测与发布门禁

| 维度 | V1 门禁（目标） | 失败处理 |
|---|---|---|
| 内容保护 | 故障/并发夹具中人工内容丢失 0 次 | 禁止真实 Vault 写入 |
| 引用机械有效 | 固定测试引用 100% 可回读，hash/版本一致 | 阻断生成/发布该答案 |
| 证据召回 | 试点人工标注 evidence-family Recall@10 ≥90% | 先分析分词和别名，再考虑向量 |
| 语义支持 | 重要主张人工判定支持率 ≥95% | 修改提示、切块和证据流程 |
| 不足识别 | 无答案题中正确说明不足 ≥90% | 同时报告可回答题正确率，防全拒答取巧 |
| 隐私 | 测试中的云外发/越权读取 0 次 | 发布阻断，不能用平均分抵消 |
| 恢复 | 定义 crash point 全部恢复或明确冲突 | 写入保持关闭 |
| 成本 | 每次调用有计量/未知记录，限额触顶不发新请求 | 不允许生产编译 |
| 性能 | 先记录机器、doc/chunk/bytes；约 1 万 chunk 热检索 p95 <500ms | 目标而非本次测量；不把回答延迟混进检索 |

随包的 synthetic 数据用于工程断言，不代替真实资料质量评估。Pilot 先建 20 个真实问题，扩大到 80 个再做模型/检索升级基线。

## 16. 工程结构与开发顺序

```text
obsidian-kb/
├── apps/service/src/{main.ts,routes/,modules/}
├── apps/obsidian-plugin/src/{main.ts,bridge.ts,review-view.ts,search-view.ts,task-view.ts,writer.ts}
├── apps/cli/src/main.ts
├── packages/contracts/src/{domain.ts,schemas.ts,ports.ts}
├── tests/{unit,integration,faults,evals,fixtures}/
├── docs/{spec,operations,decisions}/
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
└── package.json
```

必须建立 `typecheck`、`test:unit`、`test:integration`、`test:faults`、`eval:pilot`、`build`、`doctor` 的项目脚本；仅下载本文件不会获得这些命令。服务输出 `dist/service/main.js`，CLI 输出 `dist/cli/main.js`，插件输出 `dist/plugin/*`，部署手册只引用这些固定产物。

最短顺序：**E00 验证编译复用 → E01 合同/工程 → E02 账本 → E03 权限 → E04 bridge → E05 Writer → E06 来源 → E07 检索 → E08 模型预算 → E09 编译 → E10 问答 → E11 UI → E12 备份 → E13 撤回/故障 → E14 Pilot 发布。**

E00 失败不阻塞 E01–E07 的资料库价值；它只决定 E09 使用哪个编译器。MCP 在 E15 扩展，向量在 E16，PDF/发布在 E17 另行设计，不挤进 V1。

## 17. 扩展边界

**MCP：** 先只开放 `kb.search`、`kb.read`、`kb.evidence`、`kb.ask`，复用服务，不重新实现授权。Agent 不具备 approve、任意写路径或运行 shell。工具名和 annotations 不是授权系统；外部 Agent 若另有整个 Vault 写权限，仍可绕过本服务，运行环境也必须限制。[S17]

**复杂文档：** 解析器子进程输入只读、无模型密钥、默认禁网，输出规范化正文和定位；PDF 图表覆盖不可靠时进入人工检查，不能仅抽文字后声称理解全页。

**向量：** 先有关键词失败案例，再接单一 adapter。索引要绑定 embedding fingerprint 和来源 revision，检索/重排前执行外发政策，升级重建新 generation。

**发布：** 独立 export 目录和批准清单，扫描正文/附件/链接/搜索索引。PandaWiki 或 Quartz 只接收已批准副本，不直接读取整个私人 Vault，也不自动反向覆盖。

## 18. 技术决策结论

V1 真正自研的是**小型知识治理运行时**，不是新的笔记软件，也不是完整通用 Agent 平台。先用 30 份资料证明“能找到、能解释、能安全更新”，再增加规模和输入格式。

开发者应同时阅读《02-落地手册》和《03-开发任务与验收》。单独实现一次 LLM 调用、一次 Markdown 写入或一个聊天窗口，都不算本方案的知识闭环已经完成。

---

## 参考资料

[S01]: https://github.com/obsidianmd/obsidian-clipper
[S02]: https://obsidian.md/help/web-clipper/templates
[S03]: https://nodejs.org/en/about/previous-releases
[S04]: https://pnpm.io/workspaces
[S05]: https://fastify.dev/docs/latest/Reference/TypeScript/
[S06]: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md
[S07]: https://www.sqlite.org/fts5.html
[S08]: https://raw.githubusercontent.com/atomicstrata/llm-wiki-compiler/main/package.json
[S09]: https://raw.githubusercontent.com/atomicstrata/llm-wiki-compiler/main/docs/guides/sdk.mdx
[S10]: https://raw.githubusercontent.com/atomicstrata/llm-wiki-compiler/main/docs/configuration/review-policy.mdx
[S11]: https://raw.githubusercontent.com/atomicstrata/llm-wiki-compiler/main/src/sdk/wiki.ts
[S12]: https://docs.obsidian.md/Plugins/Vault
[S13]: https://raw.githubusercontent.com/obsidianmd/obsidian-api/master/obsidian.d.ts
[S14]: https://obsidian.md/help/plugin-security
[S15]: https://github.com/obsidianmd/obsidian-sample-plugin
[S16]: https://sqlite.org/backup.html
[S17]: https://modelcontextprotocol.io/specification/2025-11-25/server/tools
