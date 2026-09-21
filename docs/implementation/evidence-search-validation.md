# 场景 03：实施验收记录

日期：2026-09-21。使用、接手、API 和恢复说明见 [证据检索与问答接入](evidence-search-answer.md)。本记录区分工程验证和真实效果验收，不把模型测试替身计作真实提供方。

## 本次验证

- `pnpm typecheck`、`pnpm lint` 通过。
- 全量验证命令：`KB_TEST_OCI=1 KB_TEST_BUILT=1 KB_TEST_CORPUS=1 pnpm test`。28 个测试文件、76 项测试全部通过，无跳过；最终一轮耗时 69.33 秒。
- `pnpm test:desktop` 在独立测试 Vault 和 Obsidian 配置中通过，页面错误数为零。实际操作包括配对、主端、自检、收录、编辑冲突保护、批准恢复、搜索、固定原文回读、原文整理、候选保存、模型未配置提示和知识检查。
- [检索界面](evidence/obsidian-search.png)、[原文证据整理](evidence/obsidian-evidence-answer.png)、[桌面操作记录](evidence/obsidian-search-app-info.json)。新增检索区之前的界面见 [场景 02 截图](evidence/obsidian-governance-ingestion.png)。

一次全量运行在原有真实 HTTP 收录测试中遇到默认 1 秒轮询超时，状态仍为 `running`；同轮其余 75 项通过。该断言验证真实进程最终完成，并非 1 秒性能门槛。已改为显式 5 秒等待，生产解析 20 秒上限不变；定向链路重新验证通过，最终全量 76 项通过，保留这次失败记录以说明修改原因。

## 新增验证覆盖

| 范围 | 断言 |
|---|---|
| 固定证据 | emoji 与 UTF-16、完整块回读、新修订不覆盖旧引用、损坏定位拒绝 |
| 范围和家族 | 不同版本/渠道不相交、未知不冒充重叠、家族循环拒绝、转载去重、派生页不能支持自身 |
| 检索 | 中文短词、可信别名、精确 `C++` / `Node.js` / 绝对路径，授权后取结果、集合/审核/版本筛选 |
| 索引和快照 | 半完成代不发布、原子切代、旧读者持有、失败保留旧代、范围变化令旧快照失效 |
| 时间 | 未确认时间与后发材料排除，派生页不能夹带历史时点之后的原始证据 |
| 回答 | 无答案、完整否定条件、五转载去重、结构错误拒绝、同范围冲突不按日期裁决 |
| 治理 | 模型测试适配器经过真实预算账本；缓存不重复收费；生成中撤回取消并保留未知费用预占 |
| 读取边界 | 原件、解析、证据 ID、旧快照、缓存和候选保存均受当前 read 与撤回约束，另一个会话不能复用结果 UUID |
| 迁移 | v1/v2 迁移保留原件与私有备份，v3 重开可写，未知结构保持只读 |
| 界面 | 旧权限轮询不能擦掉新查询；正文按文本渲染；新模型请求有有限且匹配提供方上限的客户端等待 |

## 检索性能与固定题基线

[万块热检索报告](evidence/search-benchmark.json)包含 10,000 块、1,196,900 字节的合成性能数据。环境为 Apple M3、16 GiB 内存、macOS arm64、Node 24.14.1。测量预热后的 20 次查询，本轮 p95 为 74.33 ms，性能门槛为 p95 <500 ms。报告中的实际值属于本机本轮，不是所有资料规模的延迟承诺。

[固定 20 题报告](evidence/search-evaluation.json)使用 7 份固定版本的真实项目文档和源码。17 道可回答题的来源家族 Recall@10 为 17/17，3 道库外问题均说明不足；可回答题中有 1/17 被过度拒答。由于来源家族总数只有 7，这个 Recall@10 指标很容易受小候选集影响，仅用于初始工程基线。

报告没有模型调用，没有人工重要主张语义支持率，也没有以模型自评分代替人工评审。引用回读、词法召回和真实生成质量是不同的指标。约 80 题扩展及 P7 增强对照仍未进行，因此增强保持关闭。

本次同时重跑场景 02 的真实资料语料检查，单独保存为 [场景 03 回归时的收录语料报告](evidence/ingestion-corpus-scene03.json)，不覆盖场景 02 当时的历史验收文件。

## Post-Deploy Monitoring & Validation

首轮观察负责人为试点主端操作者，窗口为升级后首批 10 个检索/证据整理操作及首次断连恢复，至少覆盖一次重建、一次范围修改和一次撤回。

只读检查：

```sql
PRAGMA user_version;
PRAGMA integrity_check;
SELECT id,state,watermark,fingerprint,blocks FROM search_generations;
SELECT value FROM kv WHERE key='search:active';
SELECT count(*) AS missing_evidence FROM search_documents d
LEFT JOIN evidence e ON e.id=d.evidence_id WHERE e.id IS NULL;
SELECT kind,count(*) FROM events
WHERE kind IN ('search.generation.published','source.index_requested','source.policy.changed')
GROUP BY kind;
SELECT state,count(*) FROM calls GROUP BY state;
```

健康信号：schema 为 3、完整性为 `ok`、活动代为 `complete`、缺失证据数为 0；提交新来源后搜索能完成新代，旧快照不会读取新正文。撤回后，已知证据和缓存接口拒绝正文，界面在下一次权限复核时清空。

故障搜索词：`HASH_MISMATCH`、`INDEX_FAILED`、`SNAPSHOT_EXPIRED`、`BASELINE`、`FORBIDDEN`、`UNKNOWN_COST`。当前没有外部监控平台，使用插件错误与脱敏诊断，不把私密正文或令牌写入日志。

出现未授权正文、错误历史时点、损坏引用仍被当成有效依据、或未知费用被静默重发时，停止新问答及外发、保留完整应用数据和诊断。索引故障优先重建索引；账本或原件异常时停止写入。回退前保留 schema 3 数据，迁移前备份只在独立副本中核对，不覆盖新产生的证据或候选。

## 尚未通过的验收

真实模型提供方和模型尚未确定，CLI 默认不加载适配器。要完成 E3，需要实际接入、真实费用回执及固定真实问题上的人工语义核对。E4 的大题集与真实增强收益报告也未完成。场景计划保持 `active`；当前交付的是可运行的本地检索与证据整理，以及经过工程测试的问答接口。
