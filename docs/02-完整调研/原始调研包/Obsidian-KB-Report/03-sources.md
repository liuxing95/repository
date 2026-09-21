# 来源索引与证据说明

**核查日期：2026-09-20。** 资料以官方页面、维护者文档和选定源码文件为主。部分抓取来自搜索缓存；上游 main 分支可能继续变化，正式采用需另行固定实际发布包、commit 与依赖锁文件。

本目录保存的是来源元数据和链接，不是上游全文或源码归档。没有对全部候选项目完成安装、横向跑分、许可证法律审查或完整安全审计。R31 的 X 长文仅获得部分正文；关于未读部分不作推断。

| 编号 | 来源 | 证据类型与使用边界 |
|---|---|---|
| [R01] | Obsidian 官方主页 | 官方产品介绍。本地文件知识工作台的定位。 |
| [R02] | Obsidian Plugin API | 官方开发接口。Vault、Workspace、MetadataCache 与插件约束。 |
| [R03] | Obsidian API 类型定义 | 官方类型源码。核对 Vault.process、renameFile 及文件事件；不是全应用源码审计。 |
| [R04] | Obsidian CLI | 官方帮助。桌面应用依赖和 CLI 适用边界。 |
| [R05] | Introduction to Bases | 官方帮助。本地 Markdown/properties 的数据库式视图。 |
| [R06] | Obsidian Web Clipper | 官方帮助。网页采集与模板入口。 |
| [R07] | Obsidian Headless | 官方帮助。独立客户端、open beta 状态；与 CLI 区别。 |
| [R08] | Karpathy：LLM Wiki idea file | 原作者概念材料。仅使用原始正文解释方法，不把评论区内容当作者结论。 |
| [R09] | Headless Sync | 官方帮助。同步订阅、运行方式及同设备双同步限制。 |
| [R10] | Plugin security | 官方安全说明。社区插件权限与信任边界。 |
| [R11] | GD4AI / obsidian-llm-wiki | 维护者 README。插件、PPR 检索、许可证及当前用户 CLI / 开发工具区分；不采用其竞品比较作为其他项目事实。 |
| [R12] | GD4AI releases | 维护者发布说明。历史 CLI 和功能演进；当前入口以所选版本 README 为准。 |
| [R13] | nashsu / llm_wiki | 维护者 README。独立桌面应用、来源/Wiki/审核、许可证。 |
| [R14] | nashsu package.json | 项目配置源码。核对前端/桌面相关工程配置，不代表全后端代码审计。 |
| [R15] | ekadetov / llm-wiki | 维护者 README。轻量 raw/wiki、ingest/compile/query/lint 工作流。 |
| [R16] | 2233admin / obsidian-llm-wiki | 维护者 README。review/promote 思路；默认依赖描述尚需代码一致性核验。 |
| [R17] | QMD | 维护者 README。本地关键词、向量、重排、CLI 与 MCP。 |
| [R18] | QMD LICENSE | 项目许可证。MIT；许可证文件不单独证明搜索能力。 |
| [R19] | Smart Connections | 维护者 README 与许可证。相关笔记；source-available 状态。许可证正文另见同仓库 LICENSE。 |
| [R20] | Obsidian Copilot | 维护者 README。助手交互比较对象，不推定全部治理能力。 |
| [R21] | Obsidian Local REST API | 维护者 README / 官方插件目录。当前内置 MCP；权限范围需收窄。 |
| [R22] | Quartz | 维护者 README。Markdown 静态发布候选；不保证全部 Obsidian 扩展语法。 |
| [R23] | PandaWiki | 维护者 README。AI 文档/问答/发布和导入能力，AGPL-3.0。 |
| [R24] | PandaWiki 项目结构 | 维护者工程说明。Go 后端、Node.js/React 前端及目录边界。 |
| [R25] | GitHub Wiki topic | 项目发现入口。用于发现项目，不作为性能榜单或能力证据。 |
| [R26] | SQLite FTS5 | 官方技术文档。tokenizer、trigram 短词限制、索引一致性与删除残留。 |
| [R27] | sqlite-vec | 维护者仓库。可选本地向量适配器，不是第一版必选。 |
| [R28] | Mozilla Readability | 维护者仓库。网页正文抽取组件。 |
| [R29] | Docling | 维护者仓库。复杂文档解析候选，独立 worker。 |
| [R30] | Microsoft MarkItDown | 维护者仓库。文档转换候选。 |
| [R31] | Lab 305：从0到1，搭建起你的个人知识库 | 用户指定 X 长文；仅部分正文。已取得标题和 RAG/LLM Wiki 分类等片段，全文抽取截断，不归因未读的搭建步骤。 |
| [R32] | MCP Tools specification | 官方协议。工具协议与 annotations 信任边界；不声称该日期是协议最新版本。 |
| [R33] | Vercel AI SDK | 官方仓库。可选 TypeScript 模型调用适配器。 |
| [R34] | Node.js Releases | 官方发布计划。运行时支持版本选择；报告建议固定受测版本。 |
| [R35] | GraphRAG Indexing overview | 官方项目文档。RAG 也可以包含预计算结构与摘要。 |
| [R36] | Obsidian sample plugin | 官方模板。插件工程起点，实施时固定版本。 |
| [R37] | Fastify TypeScript / validation | 官方文档。HTTP 层候选；schema 信任说明另见同站 Validation-and-Serialization。 |
| [R38] | Zod | 官方文档。运行时 schema 与 TS 类型推导。 |
| [R39] | Vitest test API | 官方文档。领域、集成与回归测试工具。 |
| [R40] | Mozilla PDF.js | 维护者仓库。JavaScript PDF 解析/渲染候选；本轮未进行 PDF 样本评测。 |
| [R41] | unified Learn | 官方项目文档。Markdown AST 流程候选。 |
| [R42] | better-sqlite3 | 维护者仓库。Node SQLite 驱动候选；部署需要固定二进制兼容版本。 |
| [R43] | pnpm workspace | 官方文档。工作区与显式包依赖。 |
| [R44] | atomicstrata / llm-wiki-compiler | 维护者 README。TypeScript 编译器、CLI/SDK/MCP、知识维护能力。 |
| [R45] | atomicstrata package.json | 项目配置源码。读取快照为 1.1.0、MIT、Node >=24，不等于实测 npm 包。 |
| [R46] | atomicstrata SDK guide | 维护者 SDK 文档。ingestText、review、输入信任与服务集成边界；search 返回值与 facade 有漂移。 |
| [R47] | atomicstrata review policy | 维护者行为文档。默认 compile 写入、review all、query save 不同门禁。 |
| [R48] | atomicstrata compiler internals guide | 维护者架构文档。两阶段编译、增量与检索；不沿用其对所有 RAG 的泛化表述。 |
| [R49] | atomicstrata SDK public exports | 项目源码。核对 createWiki 等真实公开导出。 |
| [R50] | atomicstrata SDK facade | 项目源码。核对方法调用与 search 返回形状；不代表全链路运行验证。 |

## 补充直达页

- Smart Connections 许可证：<https://github.com/brianpetro/obsidian-smart-connections/blob/main/LICENSE>。
- Local REST API 官方插件目录：<https://community.obsidian.md/plugins/obsidian-local-rest-api>。
- Fastify 验证安全说明：<https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/>。

## 如何复核

先检查链接对应的真实仓库与版本，再读取与结论直接相关的文档或实现；项目自述的 benchmark、兼容性和安全性只能作为待测假设。报告中的路径、HTTP/MCP 接口、阈值与成本数字多数是本方案设计，不是上游现成功能。

[R01]: https://obsidian.md/ "Obsidian 官方主页"
[R02]: https://github.com/obsidianmd/obsidian-api "Obsidian Plugin API"
[R03]: https://raw.githubusercontent.com/obsidianmd/obsidian-api/master/obsidian.d.ts "Obsidian API 类型定义"
[R04]: https://obsidian.md/help/cli "Obsidian CLI"
[R05]: https://obsidian.md/help/bases "Introduction to Bases"
[R06]: https://obsidian.md/help/web-clipper "Obsidian Web Clipper"
[R07]: https://obsidian.md/help/headless "Obsidian Headless"
[R08]: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f "Karpathy：LLM Wiki idea file"
[R09]: https://obsidian.md/help/sync/headless "Headless Sync"
[R10]: https://obsidian.md/help/plugin-security "Plugin security"
[R11]: https://github.com/GD4AI/obsidian-llm-wiki "GD4AI / obsidian-llm-wiki"
[R12]: https://github.com/GD4AI/obsidian-llm-wiki/releases "GD4AI releases"
[R13]: https://github.com/nashsu/llm_wiki "nashsu / llm_wiki"
[R14]: https://raw.githubusercontent.com/nashsu/llm_wiki/main/package.json "nashsu package.json"
[R15]: https://github.com/ekadetov/llm-wiki "ekadetov / llm-wiki"
[R16]: https://github.com/2233admin/obsidian-llm-wiki/blob/main/README.md "2233admin / obsidian-llm-wiki"
[R17]: https://github.com/tobi/qmd "QMD"
[R18]: https://github.com/tobi/qmd/blob/main/LICENSE "QMD LICENSE"
[R19]: https://github.com/brianpetro/obsidian-smart-connections "Smart Connections"
[R20]: https://github.com/logancyang/obsidian-copilot "Obsidian Copilot"
[R21]: https://github.com/coddingtonbear/obsidian-local-rest-api "Obsidian Local REST API"
[R22]: https://github.com/jackyzha0/quartz "Quartz"
[R23]: https://github.com/chaitin/PandaWiki "PandaWiki"
[R24]: https://raw.githubusercontent.com/chaitin/PandaWiki/main/PROJECT_STRUCTURE.md "PandaWiki 项目结构"
[R25]: https://github.com/topics/wiki "GitHub Wiki topic"
[R26]: https://sqlite.org/fts5.html "SQLite FTS5"
[R27]: https://github.com/asg017/sqlite-vec "sqlite-vec"
[R28]: https://github.com/mozilla/readability "Mozilla Readability"
[R29]: https://github.com/docling-project/docling "Docling"
[R30]: https://github.com/microsoft/markitdown "Microsoft MarkItDown"
[R31]: https://x.com/haoran_tang97/status/2101381110186000858 "Lab 305：从0到1，搭建起你的个人知识库"
[R32]: https://modelcontextprotocol.io/specification/2025-11-25/server/tools "MCP Tools specification"
[R33]: https://github.com/vercel/ai "Vercel AI SDK"
[R34]: https://nodejs.org/en/about/previous-releases "Node.js Releases"
[R35]: https://microsoft.github.io/graphrag/index/overview/ "GraphRAG Indexing overview"
[R36]: https://github.com/obsidianmd/obsidian-sample-plugin "Obsidian sample plugin"
[R37]: https://fastify.dev/docs/latest/Reference/TypeScript/ "Fastify TypeScript / validation"
[R38]: https://zod.dev/ "Zod"
[R39]: https://vitest.dev/api/test "Vitest test API"
[R40]: https://github.com/mozilla/pdf.js "Mozilla PDF.js"
[R41]: https://unifiedjs.com/learn/ "unified Learn"
[R42]: https://github.com/WiseLibs/better-sqlite3 "better-sqlite3"
[R43]: https://pnpm.io/workspaces "pnpm workspace"
[R44]: https://github.com/atomicstrata/llm-wiki-compiler "atomicstrata / llm-wiki-compiler"
[R45]: https://raw.githubusercontent.com/atomicstrata/llm-wiki-compiler/main/package.json "atomicstrata package.json"
[R46]: https://raw.githubusercontent.com/atomicstrata/llm-wiki-compiler/main/docs/guides/sdk.mdx "atomicstrata SDK guide"
[R47]: https://raw.githubusercontent.com/atomicstrata/llm-wiki-compiler/main/docs/configuration/review-policy.mdx "atomicstrata review policy"
[R48]: https://raw.githubusercontent.com/atomicstrata/llm-wiki-compiler/main/docs/concepts/how-it-works.mdx "atomicstrata compiler internals guide"
[R49]: https://raw.githubusercontent.com/atomicstrata/llm-wiki-compiler/main/src/index.ts "atomicstrata SDK public exports"
[R50]: https://raw.githubusercontent.com/atomicstrata/llm-wiki-compiler/main/src/sdk/wiki.ts "atomicstrata SDK facade"
