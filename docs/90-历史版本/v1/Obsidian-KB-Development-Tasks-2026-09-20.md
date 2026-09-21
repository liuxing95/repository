# Obsidian 知识库：开发任务与验收计划

**日期：2026-09-20｜基线：技术方案 1.0｜范围：E00–E14 为 V1；E15–E17 为可选扩展**

> 本文件交给开发者或 Coding Agent 执行。先读《01-Obsidian知识库技术方案.md》和《02-Obsidian知识库落地手册.md》。下面的服务、测试夹具函数、CLI 命令和工程路径属于待实现仓库，不是下载本方案后已能运行的软件。

**Goal：** 用 30 份资料和 20 个真实问题，交付可追溯、可检索、可审核、可恢复的个人知识库。

**Architecture：** 一个本地 TypeScript 服务负责领域与账本，一个桌面 Obsidian 插件负责交互和唯一受控写入；CLI 是管理客户端。来源、页面与检索使用固定快照，模型没有批准和任意写文件能力。

**Tech Stack：** Node 24 受测补丁、TypeScript strict、pnpm workspace、Fastify、运行时 schema、better-sqlite3/FTS5、Obsidian Plugin API、Vitest。

**Spec：** `01-Obsidian知识库技术方案.md`；领域接口参考 `references/contracts.ts`；数据库草案参考 `references/001-state.sql`、`references/002-index.sql`。

## 1. 全局约束

首次只接入新建的 Pilot Vault；服务运行目录在 Vault 外；模型调用和自动写入默认关闭；现有人工笔记不移动、不覆盖。所有模型调用经过政策与预算检查；Agent 不能 approve。第一版只支持 UTF-8 MD/TXT 和 Clipper Markdown，不用未完成的 PDF/网页抓取功能接收真实资料。

每次变更最多 1 新页、2 更新页、20 条候选主张。一次模型调用上限 input 12,000/output 2,000 tokens；一个 job 最多 6 次调用、input 48,000/output 8,000 tokens；任何重试和结构修复都计入。配置更低时取更低值。

`state.db` 与 `objects/` 必须持久化；只有 `index.db` 可删除重建。插件断连时写入等待，不能由服务直接写 Vault。应用只保证自身通道的顺序与恢复，不声称能锁住其他编辑器、恶意插件或同步进程。

## 2. 测试审查重点

| 高风险输入/状态 | 用户应看到的行为 | 任务归属 |
|---|---|---|
| 两字中文、英文缩写、带标点代码符号 | 无模型密钥仍可找到实际原文 | E07 |
| 同一资料新版本、同一原文重新解析 | 不覆盖旧引用，不把旧版直接当现状 | E06、E09、E10 |
| 写后回执丢失、人工第三种版本、批准中途过期 | 幂等补记、保留人工修改、明确暂停 | E05、E13 |
| 私密资料经重排/编译/问答外发 | 网络请求前拒绝，不靠返回后删结果 | E03、E08、E10 |
| 并发预占、网络中断、恢复旧账本 | 不凭空释放未知费用，不自动恢复旧授权 | E08、E12、E13 |

## 3. 仓库地图与固定构建产物

```text
obsidian-kb/
├── apps/
│   ├── service/src/
│   │   ├── main.ts
│   │   ├── routes/
│   │   └── modules/{policy,storage,runtime,source,writer,retrieval,compiler,answer,operations}/
│   ├── obsidian-plugin/src/{main,bridge,writer,review-view,search-view,task-view}.ts
│   └── cli/src/main.ts
├── packages/contracts/src/{domain,schemas,http}.ts
├── tests/{unit,integration,faults,evals,fixtures}/
├── docs/{decisions,operations}/
├── pnpm-workspace.yaml
└── pnpm-lock.yaml
```

按任务建立文件，不预先创建所有空模块。构建产物固定为 `dist/service/main.js`、`dist/cli/main.js`、`dist/plugin/main.js`、`dist/plugin/manifest.json`、`dist/plugin/styles.css`。CLI 和服务的相对依赖打包/部署方式必须一起测试，不得只证明入口文件存在。

测试工程先采用单一根 Vitest 配置与路径分组，建立 `pnpm test:unit`、`pnpm test:integration`、`pnpm test:faults`、`pnpm eval:pilot`。以下 `pnpm exec vitest run <file>` 只有 E01 建立工程后才有效。

### 统一执行纪律

每项任务都经历五个动作：写下列具体断言的失败测试；运行并确认失败原因；实现该项最小能力；运行该项测试及依赖回归；检查 diff 后独立提交。禁止通过 `.skip`、空断言、修改 fixture 预期或 mock 掉被测安全边界把失败变成功。

每项完成记录包含 commit、测试命令、退出码、测试数、未测平台与真实插件检查状态。单测成功不等于 Obsidian 集成成功；模拟用量不等于模型真实计费已验证。

## 4. 任务依赖与里程碑

```text
E00 上游验证 ───────────────────────────────→ E09 编译器选择
E01 合同 → E02 账本 → E03 政策 → E04 bridge → E05 Writer
                                                   ↓
                                             E06 来源 → E07 检索
E03 + E02 → E08 模型预算 ──────────────────────┬───────┘
                                              ↓
                                         E09 编译 → E10 问答
                                              └─────┬─────┘
                                                    E11 UI
E02 + E05 + E06 → E12 备份 → E13 撤回/故障 ────────────┤
                                                    E14 Pilot
```

E00 失败不阻塞资料库功能。E07 完成达到 M1；E09–E11 完成达到 M2；E12–E14 完成且全部门禁通过才达到正式使用 M3。

---

## E00：决定编译器是接入还是替代

**产物：** `docs/decisions/compiler-selection.md`、`tests/fixtures/upstream/`、`tests/integration/upstream-contract.test.ts`。独立临时评估项目可以先运行，不要求正式服务已实现。

**输入：** 锁定的实际 npm 包、仓库 commit、三份不含秘密的来源，以及 `CompilerPort` 需要的输出。

**输出：** `adapter=atomic` 或 `adapter=native` 的有证据决定；包版本、完整性、模型配置、失败项和兼容映射。

- [ ] 建立不包含正式 Vault 的临时目录，固定包版本并记录 lockfile；安装脚本执行前检查来源和脚本，不在真实资料目录尝试。
- [ ] 运行三份来源的 ingestText 与审核编译；检查 `truncated`、候选文件清单、引用定位及 SDK 返回形状。
- [ ] 重放同输入、拒绝候选后再编译、模拟中途停止、故意配置未知 review 值；记录实际行为。
- [ ] 观察全部模型调用；证实每次调用可阻断、可预占、可记账。仅统计 `compile()` 总耗时不算通过。
- [ ] 产出适配映射：上游文件名→parseId，上游来源位置→Evidence，上游候选→CompileProposal；无法映射列为失败，不虚构 evidenceId。
- [ ] 写结论并提交。源码直接访问失败或包不存在时保留事实；不能因为 README 有功能就判定通过。

**明确通过条件：** 引用和候选可读、正式 Vault 零写入、未批准状态不污染基线、内部调用可治理。某一核心条件无法满足时，E09 用 native 有界实现；不扩大为完整自研 Agent 平台。

**检查文件字段：** `packageVersion`、`integrity`、`commit`、`modelRoute`、`candidateFormatVersion`、`citationMap`、`budgetHook`、`replayResult`、`decision`。

## E01：合同、最小工程和 CLI 基本入口

**文件：** `packages/contracts/src/{domain,schemas,http}.ts`；三个 app 的 package.json、入口与根配置；`tests/unit/contracts.test.ts`；`tests/integration/cli-init.test.ts`。

**接口：** 采用附件领域类型；`kb init --runtime-root <path> --name <name> --config <template>` 创建 vaultId、初始空快照、运行配置；`doctor` 只检查不修改。

**失败测试：** 非 64 位小写 hash、负 token、超出 safe integer 的 microUSD、未知字段、错误状态、空来源范围必须拒绝；init 对已有目录默认不覆盖，第二次相同配置返回现有身份；运行目录位于 Vault 内时拒绝。

- [ ] 先建立 schema 边界测试，再实现严格解析；不能把入站 body `as IngestRequest`。
- [ ] 固定 Node/pnpm/TS/依赖版本，显式 workspace 依赖；frozen install 在 CI 验证。
- [ ] 实现 init 的“预览/创建/已存在”状态；默认不生成模型密钥、不启用写入；输出真实 `CONFIG_PATH`。
- [ ] doctor 检查版本、FTS5、自定义目录、文件权限、配置已初始化状态；未配置模型只说明模型不可用，不阻止词法模式。
- [ ] 构建并在无源码目录验证 CLI 可启动，检查插件不打入数据库 native 模块。

**命令：** `pnpm exec vitest run tests/unit/contracts.test.ts tests/integration/cli-init.test.ts`；`pnpm typecheck`；`pnpm build`。

**完成证据：** 无 AI 密钥仍可初始化；无任何 Vault 人工文件改变；所有未来命令有 help、错误码和测试。

## E02：对象仓、SQL 账本与持久队列

**文件：** `modules/storage/{db,objects,snapshots}.ts`、`modules/runtime/{queue,lease,outbox}.ts`；`tests/integration/storage.test.ts`；`tests/faults/job-restart.test.ts`。

**输入/输出：** 受信请求→`Job`；原始字节→不可变 hash 对象；已验证提交→Snapshot+outbox。相同 operationKey 对应同一逻辑任务。

**实现接口：** `ObjectStore.put(bytes): Promise<Sha256>`；`read(hash): Promise<Uint8Array>`；`JobStore.enqueue(operationKey,payloadHash): Job`；`claim(owner,nowMs): Job|null`；`saveStage(jobId,fence,inputDigest,outputHash)`。实现时在模块公共接口文件定义这些签名，避免跨模块直读任意表。

- [ ] 在真实临时 SQLite 和真实临时对象目录写失败测试：对象 hash 错、FK 缺失、同 source 重复原文、旧 fence 更新、同请求键异 body 均拒绝。
- [ ] 对象写入使用临时文件→flush/关闭→原子移动→必要的目录持久化；SQLite 只有对象持久化后才引用它。平台持久化能力需实测并记录边界。
- [ ] 初始化空 snapshot；短事务领取任务，lease 30 秒、心跳 10 秒、fence 递增；重启后过期任务重新领取。
- [ ] 阶段输出按 job+stage+inputDigest 唯一；对象损坏进入失败诊断，不能推进阶段。
- [ ] 状态提交和 outbox 在同一 state.db 事务；消费者重复消费无重复可见版本。

**命令：** `pnpm exec vitest run tests/integration/storage.test.ts tests/faults/job-restart.test.ts`。

**完成证据：** 每个 crash point 的最后可恢复阶段可解释；SQLite 和 objects 缺一项不能宣称恢复成功。

## E03：身份、受管路径与模型外发政策

**文件：** `modules/policy/{auth,egress,path-policy}.ts`；`routes/auth.ts`；`tests/integration/policy.test.ts`。

**输入/输出：** 认证凭据产生 Principal；`authorize(principal,action,resource)` 和 `allowEgress(routeId,sourcePolicies)` 返回 allow/deny；不接受请求体自报 principal/role/scopes。

- [ ] 先测 reader/agent-reader 调 approve 返回 403；伪造 `role=admin` 不改变结果。
- [ ] 测目标路径绝对路径、`..`、`.obsidian`、policy 文件、符号链接、大小写/NFC 碰撞；拒绝后检查没有新建文件。
- [ ] 本人可以本地读取 private note，但云 route 未在全部来源交集时，LLM mock 的调用次数必须为零。
- [ ] 实现本地一次性配对码、短期会话、admin 与 desktop/reader 的权限分离；校验 loopback Host/Origin/Authorization。
- [ ] 凭据只写 Vault 外受限文件，日志输出不可包含凭据或资料全文；拒绝来自网页的未授权请求。

**代表性政策单测草案：** `policy` 是本项应实现的测试夹具，不是附件现成 API；这条单测只证明决策，E08/E10 还必须用真实调用路径验证拒绝时网络请求数为零。

```ts
it('denies a route absent from the source policy', () => {
  const decision = policy.allowEgress('cloud-a', [
    { visibility: 'private', allowedModelRouteIds: [] },
  ]);
  expect(decision.allowed).toBe(false);
});
```

**命令：** `pnpm exec vitest run tests/integration/policy.test.ts`。

**完成证据：** 身份不是模型参数；路径校验不是简单 `startsWith`；政策拒绝无网络/文件副作用。

## E04：最小插件与服务桥接

**文件：** `apps/obsidian-plugin/src/{main,bridge}.ts`；`modules/writer/session.ts`；`routes/writer.ts`；`tests/integration/bridge.test.ts`。

**接口：** health/capabilities、配对、writer session、grant 领取、receipt 发送；协议版本、vaultId、instanceId、epoch 必须一致。

- [ ] 先测两个实例领取只保留一个有效 writer；过期 epoch 无法领取新 grant；断连不能显示同步成功。
- [ ] 依据官方 sample plugin 建 manifest、desktop-only 标记及构建；不要把服务入口打包到插件。
- [ ] 插件 onload 注册事件、onunload 注销定时器/监听/连接；重载不会重复导入或重复提交。
- [ ] 实现“服务离线/只读已连接/可审核/等待写入”状态；连接成功不默认开启写权限。
- [ ] 旧实例有未知在途写入时，不因 lease 到期立即放行新写入；先停止旧实例并核对文件。epoch 不是可撤销磁盘操作的原语。
- [ ] 在隔离 Vault 手工检查：打开、关闭、重载、错误 vaultId、协议不兼容；保存测试记录。

**命令：** `pnpm exec vitest run tests/integration/bridge.test.ts`；`pnpm build`。

**完成证据：** mock 测试和真实 Obsidian 人工检查分栏；桌面-only 插件在移动端不被描述成支持自动化。

## E05：审批摘要、单文件 CAS 和多文件恢复

**文件：** `modules/writer/{proposals,approvals,commit,recovery}.ts`；`apps/obsidian-plugin/src/writer.ts`；`tests/faults/writer.test.ts`。

**接口：** `ChangeSet`、`Approval`、`WriterGrant`、`FilePatch`、`WriterReceipt`；应用顺序严格按冻结 patchIndex。afterObjectHash 对文本补丁必须等于 afterHash，禁止指向可变化的 URL。

- [ ] 先测摘要覆盖文件内容、before/after、来源、政策与快照；修改任意字段后旧批准失效。
- [ ] 在内存 Vault 模拟器测 before→after、after→补回执、第三种 hash→conflict、create 存在不同内容→conflict。
- [ ] 在真实插件用同步 `Vault.process` 回调比 hash；任何打开编辑页中的目标都暂停，不猜 dirty flag。
- [ ] 实现 PREPARE→APPLY→COMMIT→INDEX；对每个写入前/后、回执前/后、commit 前/后注入断电式进程退出。
- [ ] 批准中途过期后停止未执行文件；展示已应用/剩余；只有人对相同冻结清单发出恢复批准才能继续。第三种 hash 必须新提案。
- [ ] 所有文件 verify 后提交快照并写 outbox；失败期间问答只能读取旧快照。

**纯判断测试示意：** 哈希函数、断言函数由本项实现，插件适配器再单独集成。

```ts
it('preserves a human edit rather than replaying old approval', () => {
  const patch = { beforeHash: hash('before'), afterHash: hash('after') };
  const decision = decideUpdate(hash('human edit'), patch);
  expect(decision).toEqual({ action: 'conflict' });
});
```

**命令：** `pnpm exec vitest run tests/faults/writer.test.ts`。

**完成证据：** 人工第三版本零覆盖；断连不改用 fs；恢复日志可以逐文件说明状态；不宣称跨文件原子性。

## E06：来源导入、解析版本和证据定位

**文件：** `modules/source/{ingest,parse,registry}.ts`；`routes/ingestions.ts`；`tests/integration/ingestion.test.ts`。

**接口：** 技术方案 IngestRequest→202/jobId→SourceRecord/SourceRevision/ParseArtifact/Evidence；导入 source-only ChangeSet，不更新 Wiki。

- [ ] 先测重复字节复用 revision；同来源内容变化产生新 revision；新 parserFingerprint 产生新 parseId，不改变旧 Evidence。
- [ ] 保存实际收到的原始 MD/TXT，不把 Clipper 摘录当完整网页；UTF-8 无效、空输入、超限、HTML/PDF/zip 均明确拒绝或要求人工处理。
- [ ] 规范化正文添加稳定 blockId，再冻结 hash；测试中文、emoji、CRLF、代码块，UTF-16 区间可回读相同 quoteHash。
- [ ] source-only 清单批准只允许指定新目录；未写入时 awaiting_writer，不进入默认检索快照。
- [ ] 首次无 URL 文本分配 sourceId；后续同名输入默认不覆盖。更新来源要明确 sourceId。

**命令：** `pnpm exec vitest run tests/integration/ingestion.test.ts`。

**完成证据：** 从任一 evidenceId 可定位原始修订；所有来源均能解释 captureKind/coverage/模型外发权限。

## E07：独立词法检索、精确符号和快照一致性

**文件：** `modules/retrieval/{tokenize,fts,exact,search}.ts`；`routes/search.ts`；`tests/integration/search.test.ts`。

**接口：** `{query,limit,snapshotId?}`→SearchHit[]、实际 snapshotId、索引进度；对象读取通过 hash，不读取活动文件偏移。

- [ ] 先用 fixture 测“权限”“重排”“知识”、MCP、C++、Node.js、app.vault.process；禁用所有模型仍成功。
- [ ] 固定词法规则、汉字 bigram、符号表和 ICU fingerprint；query 与入库使用同一规则，不改原文。
- [ ] 参数绑定 SQL，并由代码生成转义后的 MATCH 表达式；恶意 MATCH 输入不触发 SQL 或越界扩展。
- [ ] FTS 与 documents 的写入在同一 index.db 事务；完成后切 indexSnapshotId。旧快照结果必须返回旧对象。
- [ ] 测 outbox 重复、索引删除重建、索引落后、来源 tombstone、重命名漏事件的清点补偿。

**命令：** `pnpm exec vitest run tests/integration/search.test.ts`。

**完成证据：** M1 可用；无模型密钥可搜索；所有命中携带真实 revision/snapshot，不能以“搜索成功”掩盖版本错配。

## E08：模型端口、计量、预算预占与未知结果

**文件：** `modules/runtime/budget.ts`；`modules/models/{port,provider}.ts`；`routes/settings.ts`；`tests/integration/budget.test.ts`。

**接口：** `LlmPort.generate(LlmRequest,signal)`→unknown data+ModelUsage；所有上游内部模型调用也必须进入同等政策和计量通道。

- [ ] 先测 model.enabled=false 时无网络；无有效价格表和未确认预算时不能启用付费 route。
- [ ] 同一事务对 job/day/month 条件预占，测试两个并发请求争夺最后额度只有一个被允许。
- [ ] 调用前记录 reserved/dispatched，返回后真实结算；用量未知保留预占，不因本地 timeout 释放全部金额。
- [ ] 任何重试/repair 计入模型调用总数和 token 上限；非重试错误直接失败；provider fallback 不放宽数据外发政策。
- [ ] 实际用量超过估计时如实记录并阻止新调用，不能用数据库 CHECK 把真实账单隐藏；管理端对账保留审计。

**预算事务骨架（待纳入服务实现）：** 对所有 bucket 在同一个 BEGIN IMMEDIATE 中执行，任一失败整体回滚。

```sql
UPDATE budget_buckets
SET reserved_microusd = reserved_microusd + :amount
WHERE id = :id
  AND spent_microusd + reserved_microusd + :amount <= limit_microusd;
```

执行器检查每次 UPDATE 的 affected rows=1；不能先在事务外查剩余再调用模型。外部服务计费规则、未观测远端消耗不能由应用单方面保证绝对封顶。

**命令：** `pnpm exec vitest run tests/integration/budget.test.ts`。

**完成证据：** 本地收费账本可解释；只测试假 provider 时明确标为模拟验证；接真实模型另记录请求 ID 和账单抽样。

## E09：编译器适配与知识变更提案

**文件：** `modules/compiler/{port,validate,impact}.ts` 和 E00 选中的 `atomic.ts` 或 `native.ts`；`tests/integration/compiler.test.ts`。

**接口：** CompilerPort 的输入输出严格采用 contracts；程序分配文件路径与新 pageId，模型不能直接给授权字段。

- [ ] 先测没有证据的主张、未知 ID、超限页数、人工目录 patch、被撤回来源、版本条件消失均不能进入可批准提案。
- [ ] atomic 路线实现工作区拷贝、ingestText、review、候选读取、Evidence 映射、基线推进；不依赖 SDK search/query/save。
- [ ] native 路线实现 Extract→确定性 Resolve/Impact→Propose→Validate；固定最多两次主调用加一次可选结构修复，仍受 E08 总预算约束。
- [ ] 用 DemoKV v1/v2 fixture 生成版本区分；用 unofficial-v2 fixture 保留冲突；用户决定标 user-stated。
- [ ] 新来源让相关旧 claim 待复审；未批准候选不进入检索；拒绝候选不推进编译器正式基线。

**命令：** `pnpm exec vitest run tests/integration/compiler.test.ts`。

**完成证据：** 每个 patch 能解释改动理由和固定来源；强制中止 compiler 后正式 Vault 不变；结果为空是合法结果而非失败。

## E10：有证据问答与候选保存

**文件：** `modules/answer/{context,generate,citations}.ts`；`routes/answers.ts`；`tests/integration/answers.test.ts`。

**接口：** `{query,mode,snapshotId?}`→Answer；`save-candidate` 再产生 ChangeSet，不绕过 Writer。

- [ ] 先测未命中资料返回 insufficient；未解版本分歧返回 conflicting；虚构 evidenceId 不显示为可信引用。
- [ ] context 只读取同一快照，原始证据优先，保留条件/否定；Token 不足时缩小范围，不截坏段落再补编。
- [ ] 生成后机械检查 ID、区间、quoteHash、来源状态；有效 citation 不等于语义正确，支持率由评测另测。
- [ ] 保存候选经过批准，只写 50-Queries；升级 Wiki 时继续引用原始来源，不能把旧答案变成独立事实。
- [ ] 测来源在检索后/发模型前被撤回：最后一次外发检查拒绝；请求已经发出则报告无法撤回远端已接收内容，不伪称零暴露。

**命令：** `pnpm exec vitest run tests/integration/answers.test.ts`。

**完成证据：** 答案能打开实际修订；失败不伪装成回答；所有模型调用都可追到 E08 账本。

## E11：Obsidian 用户界面与纵向闭环

**文件：** `apps/obsidian-plugin/src/{review-view,search-view,task-view}.ts`；`tests/integration/ui-contract.test.ts`；`docs/operations/manual-plugin-check.md`。

**接口：** API 返回驱动状态；用户动作驱动显式导入/批准/拒绝，不能从 Markdown 文本触发受信 action。

- [ ] 先测旧 digest 的按钮失效、断连按钮禁用、waiting_approval 不显示落盘成功、预算阻塞不显示解析失败。
- [ ] 提供五个入口：导入来源、搜索/问答、编译所选来源、审核提案、任务/预算。使用原生 Markdown 展示，不重写编辑器。
- [ ] diff 显示路径、before/after、改动原因、来源；证据侧栏显示版本和 coverage，点击前核对 hash。
- [ ] 用一份普通来源走完整闭环；再测同名/新版本/手改/预算耗尽；每一步记录实际截图或人工观察，不以 UI mock 代替。
- [ ] 卸载/禁用插件后，全部已导入 Markdown 仍可阅读，用户内容不删除。

**命令：** `pnpm exec vitest run tests/integration/ui-contract.test.ts`；`pnpm build`。

**完成证据：** M2 可用，但没有 E12–E14 仍不建议接管大 Vault。

## E12：一致备份、恢复与只读灾难模式

**文件：** `modules/operations/{backup,restore}.ts`；CLI backup/restore/doctor；`tests/faults/backup-restore.test.ts`。

**接口：** backup 返回冻结清单、DB 快照、objects/Vault 文件 hashes；restore 默认写入全新目标目录，不覆盖现有运行环境。

- [ ] 先测写入进行中拒绝普通备份，或在协调暂停后进行；不能只 cp 活动 state.db 忽略 WAL。
- [ ] 通过 SQLite 备份能力创建一致 DB 副本，同时冻结写入/对象 GC；复制受清单引用的对象及 Vault，校验 manifest。
- [ ] 恢复时停用模型和写入；核验 schema、对象、已提交快照及未完成提交；旧批准不自动续期。
- [ ] 从备份还原到独立 Restore-Test Vault，重建空索引并跑同一查询集；恢复测试成功前不宣称备份有效。
- [ ] state.db 损坏时只读诊断，不创建空库吞掉历史任务；备份缺对象时明确失败并输出缺失 ID。

**命令：** `pnpm exec vitest run tests/faults/backup-restore.test.ts`。

**完成证据：** 一次真实恢复演练；记录恢复范围、耗时、数据损失窗口和未恢复项。不得把“已压缩出一个 ZIP”当作恢复通过。

## E13：撤回、完整性与故障集合

**文件：** `modules/operations/retract.ts`；`tests/faults/retraction.test.ts`；`tests/faults/system-recovery.test.ts`；`docs/operations/incidents.md`。

**接口：** 可信撤回请求→tombstone+受影响 claim/page 清单；读 API、索引结果、answer cache 均即时检查来源状态。

- [ ] 先测撤回后仍留旧索引/旧缓存/旧 snapshot，读取仍被拒绝；知道 evidenceId 也不能绕过。
- [ ] 将依赖的 claim/page 标 stale，产生修订建议，不自动在历史中删除全部审计。
- [ ] 测磁盘满、对象缺失、SQLite 锁超时、服务重启、旧 writer、source 文件被手改；失败必须有明确状态。
- [ ] 插件实际崩溃后回执恢复，手工改第三 hash，旧批准过期；复验 E05 的关键跨进程条件。
- [ ] 编写清除请求手册，区别撤回与物理清除。完整物理清除需覆盖对象/备份/日志/派生知识，V1 若未实现就不得提供虚假的“彻底删除”按钮。

**命令：** `pnpm test:faults`。

**完成证据：** 已定义故障点均恢复或明确冲突；没有静默覆盖和无来源复活。

## E14：Pilot 验收、配置锁定与发布

**文件：** `tests/evals/pilot.jsonl`、`tests/evals/run.ts`、`docs/operations/release-gates.md`、发布清单及升级说明。

**输入：** 30 份自己的真实资料、20 个人工编写问题；附件 synthetic 集合仅作工程测试，不能替代真实效果评测。

- [ ] 先完成关键词基线，再运行模型问答；记录硬件、实际资料字节/块数、模型、提示、价格表与全部配置。
- [ ] 逐题人工标注正确证据、必要条件、禁止结论、应答状态；保存失败题，不为通过而事后移除。
- [ ] 对应答题算 evidence-family Recall@10；对生成答案算重要主张支持率；单列无答案题、版本题、敏感题。
- [ ] 执行恢复演练、模型关闭降级、预算触顶和人工编辑冲突；安全门禁任一失败都不放量。
- [ ] 交付安装包+版本清单+配置+备份/撤回手册；先维持 30 份，达到门禁后按 100/300 份逐级增加。

**命令：** `pnpm typecheck && pnpm test:unit && pnpm test:integration && pnpm test:faults && pnpm build`；再执行 `pnpm eval:pilot -- --dataset tests/evals/pilot.jsonl`。

**通过门禁：** 机械引用全部可回读；人工字节丢失 0；禁止外发测试网络调用 0；重复提交无重复写副作用；预算/恢复/撤回都通过。内容质量按手册分母计算，不把 20 题写成大样本统计结论。

---

## 5. 可选任务：必须用真实缺口驱动

### E15：只读 MCP

新增 `apps/mcp` 只提供 search/read/evidence/ask，调用同一服务。要求逐调用身份和预算；没有 approve、publish、任意 path 或 shell。测试 Agent 伪造 scope、读撤回证据、重复 ask、断连重连，不绕过 E03/E08。只有外部 Agent 确实需要统一接口时实施。

### E16：单一检索增强器

先收集 E14 的词法失败题，选择一个向量或 QMD adapter，不一起堆三种检索组件。按相同语料比较基线与增强的召回、延迟、成本和外发范围；低收益则关闭。升级 fingerprint 触发新索引构建，不能混合向量空间。

### E17：解析或发布扩展——分别立项

PDF/Office 和公共发布不是一个任务。实际需要 PDF 时另写解析质量/定位/资源隔离子方案；实际需要 PandaWiki/Quartz 时另写批准导出、资源扫描和撤回子方案。不得因为输入“都是文档”就把私密 Vault 全量交给网站构建器。

## 6. 需求覆盖与交接清单

| 需求 | 最小实现任务 | 必须保留的证据 |
|---|---|---|
| TS 服务和薄插件 | E01、E04、E11 | 真实构建和插件检查 |
| 来源版本与引用 | E06、E10 | 原文 hash、parse、逐证据回读 |
| 零模型词法基线 | E07 | 禁网/无密钥测试 |
| 编译治理 | E00、E08、E09 | 候选映射与逐调用账本 |
| 人工保护与恢复 | E05、E13 | 全部故障点与第三 hash 保留 |
| 私密数据外发 | E03、E08、E10 | 出站请求计数与拒绝原因 |
| 日常可用 | E11、E14 | 用户纵向闭环、真实问题评测 |
| 备份/退出 | E12、E13 | 独立恢复演练和格式可读性 |

开发者每次交接附：本次任务 ID、实际修改文件、测试证据、没有覆盖的边界、下一任务输入。未通过的安全问题不得只写进“后续优化”就发布；可后置的只有明确不在当前输入/操作范围中的功能。
