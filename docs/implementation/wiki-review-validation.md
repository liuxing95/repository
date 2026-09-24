# 场景 04：实施与验收记录

日期：2026-09-22。运行、接手、接口和恢复说明见 [Wiki 审核与写入](wiki-review-commit.md)。本记录只描述实际执行的验证，不将本地编排称为真实模型编译。

## 本轮范围

完成固定提案与摘要、明确批准或拒绝、短期逐项授权、公共 Writer 更新、完整提交、候选区与 Wiki 分离、不可变页面修订、人工观察和分批影响清单。已完成的页面更新可以生成反向提案；首次新建不自动删除文件。

W4 的真实模型提取、页面生成、费用回执和 SDK 隔离验收仍未完成。当前采用确定性的原文编排，零模型调用；SDK 未安装、未执行，不能把未运行的隔离测试记为通过。

## 验证结果

`pnpm typecheck`、`pnpm lint` 通过。首次包含全部可选专项的运行共 91 项：90 项通过，真实收录语料专项 1 项失败。该专项单独复测达到 180 秒上限，仍未通过；详细记录见下文。最终代码另跑 `KB_TEST_OCI=1 KB_TEST_BUILT=1 pnpm test`：92 项中 87 通过、3 失败、2 跳过。失败为 OCI 的 `SANDBOX_LIMIT`、收录清单的 20 秒超时、网页收录的 30 秒超时。桌面验证结束后单独重跑这三个文件，8 项中 6 通过、2 失败：OCI 已通过，两个收录超时仍存在。因此本次不能宣称全量回归通过。 随后单独运行本场景 9 个测试文件：17 项通过、1 项恢复测试达到 20 秒上限，另有 UI worker 启动超时（该文件未执行）；此前完整回归中的同一组场景测试通过。保留两次结果，不把最后一次失败隐藏为通过。运行期间系统负载从约 31—37 升至 106，但没有证据将失败全部归因于负载，解析与收录问题仍待排查。

最终代码的真实 Obsidian 验证通过 17 项操作检查，`pageErrors` 为空。流程覆盖配对、主端、资料收录、编辑冲突保护、来源提交、搜索、原文候选保存，以及候选区单独批准、Wiki 提升、人工编辑观察、打开编辑缓冲时拒写、重新审核后的 `Vault.process` 更新和正式检索。

桌面验证过程中修正了两类问题：脚本误用设置窗口而非 Vault 窗口读取应用对象；新提案异步生成时旧审核控件仍可点击。后者原本被服务的基线校验拒绝，未覆盖人工内容；现在生成新提案时立即移除旧控件，操作期间锁定按钮，并增加界面回归测试。长内容区域增加滚动边界，保持审核按钮可操作。

## 必须保持的断言

| 范围 | 验证内容 |
|---|---|
| 审核绑定 | 路径、正文、证据、beforeHash 任一变化使摘要失效；错误摘要、旧政策、拒绝后的提案均不能继续授权 |
| 短期授权 | 会话不匹配、批准过期、重新批准后旧 grant、迟到回执均拒绝 |
| Writer | 路径穿越、符号链接目录或文件、硬链接、新建碰撞、打开编辑叶和同步回调中的第三哈希均不覆盖人工内容 |
| 提交与恢复 | 写前、写后无回执、回执后未提交、数据库关闭重开均有恢复路径；两文件测试中最后事务前正式检索始终不可见 |
| 不可变历史 | 更新同一页面新增修订，不覆盖旧修订；反向提案需要新批准并保留原历史 |
| 候选与 Wiki | 未保存候选不能提升；保存与提升分别批准；重复输入允许零变更，先匹配同类同标题 |
| 编译边界 | 恶意资料只作为代码围栏中的文本；最多 20 条主张，剩余显式列出；决定页需明确用户决定；不产生提供方费用 |
| 读取门禁 | 撤回后候选、完整前后差异、已知修订 ID 和检索均不能返回受限正文 |
| 人工观察 | CRLF、emoji 与完整字节保留；新观察使旧批准失效；已提交更新不继续沿用上一版本的人工观察 |
| 有限影响 | 每批最多 100 页，101 页测试返回后续 offset；新修订只提醒检查范围，不自动取代旧页 |
| 迁移 | v1/v2/v3 升级到 4，原数据保留；v3 的私有备份仍为 3；v4 重开可写；未知结构只读 |

[桌面操作检查记录](evidence/wiki-desktop-checks.json)和[审核入口截图](evidence/wiki-review-entry.png)保存在本目录。截图只展示入口，不代替写入结果断言。全部使用独立合成资料与单主端试点，未操作用户日常 Vault。

## Post-Deploy Monitoring & Validation

首轮负责人为试点主端操作者。窗口为升级后首次候选保存、首次 Wiki 新建、首次更新和一次主动中断恢复；再观察前 10 次提交。需核对插件与服务一起升级，且主端心跳正常。

只读检查：

```sql
PRAGMA user_version;
PRAGMA integrity_check;
SELECT json_extract(value,'$.state') AS state,count(*) FROM wiki_changes GROUP BY state;
SELECT change_id,count(*) AS applied FROM wiki_receipts GROUP BY change_id;
SELECT p.id FROM wiki_pages p LEFT JOIN wiki_revisions r ON r.id=p.revision_id WHERE r.id IS NULL;
SELECT kind,count(*) FROM events WHERE kind IN ('wiki.prepared','wiki.approved','wiki.file_applied','wiki.committed','wiki.observed') GROUP BY kind;
SELECT state,count(*) FROM calls GROUP BY state;
```

健康信号：schema 为 4、完整性为 `ok`、不存在缺失的当前修订；已提交 Wiki 可检索，未完整提交的文件不能进入正式结果；本地编排没有增加收费调用。人工修改产生观察记录，源撤回后读取立即拒绝。

故障代码：`WRITER_EDITING`、`WRITER_CONFLICT`、`WRITER_PATH`、`APPROVAL_EXPIRED`、`BASELINE`、`HASH_MISMATCH`、`INCOMPLETE`。编辑冲突是可预期保护，不通过删除人工文件来消除；授权或基线变化需重新审核。

出现未批准写入、人工字节丢失、部分页面进入正式检索、受限正文继续返回时，立即停止新的写入，保留应用数据、Vault 和操作时间；不清空账本。回退必须使用匹配 schema 的服务，迁移前备份仅在隔离副本核对，不能覆盖本轮新记录。

## 验证边界

本轮是受测 macOS、Obsidian 桌面、独立试点与单主端。没有模拟所有第三方同步插件或其他应用同时改文件的竞争，也不承诺文件系统跨文件事务。插件打开编辑页时保守暂停；读权限撤回不删除已经写出的笔记。

真实模型编译与语义验收需在提供方明确、系统凭据配置和预算授权完成后补做。候选来自既有回答，不通过 llmwiki query-save 写入正式知识。后续研究报告若要接入，需要复用同样的固定候选合同，不增设旁路写入。

### 真实收录语料专项的本轮失败

命令：`KB_TEST_OCI=1 KB_TEST_BUILT=1 KB_TEST_CORPUS=1 pnpm test`。首轮 90 项通过、1 项失败，总耗时 221.10 秒；失败在既有 `ingestion-corpus.test.ts` 的原件可回读断言。报告中 `https://ai-sdk.dev/docs/introduction` 状态为 `PARSE_FAILED`，未形成测试所需来源修订；不能据此宣称抓取字节丢失，也不能把它记为通过。

随后仅重跑 `KB_TEST_CORPUS=1 pnpm exec vitest run tests/integration/ingestion-corpus.test.ts`，180 秒超时，未生成完整新报告。本轮没有修改生产解析器、放宽解析超时或移除原断言。真实语料兼容性仍需后续排查；本场景单独的 Writer、审核、恢复与桌面结果分别记录。

[首轮语料报告](evidence/ingestion-corpus-scene04-attempt.json)保留实际失败；场景 02 和 03 的历史验收文件未改写。不要把首轮报告中的部分解析状态当作完整语料解析验收。
