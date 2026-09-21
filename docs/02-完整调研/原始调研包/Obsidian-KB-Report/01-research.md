# 基于 Obsidian 的 AI 知识库：调研报告

**调研日期：2026-09-20｜定位：个人优先、本地文件优先、可审计的知识编译与检索系统｜实现语言：TypeScript 为主**

> 本文与《02-typescript-implementation-plan.md》配套。本文解释选型依据与取舍；实现方案给出数据协议、处理流程、一致性边界、工程任务及验收方法。文中的「建议」「目标」「默认值」是设计决策，不是上游项目已经实现的能力或本次实测结果。

## 1. 结论先行

建议采用：**Obsidian Vault 保存知识文件，Obsidian 插件承担阅读、审核和受控落盘，独立 TypeScript 服务承担资料摄取、知识编译、检索问答与任务治理。**

这里的知识库不应只是「给 Obsidian 加一个聊天窗口」，也不应变成「把所有资料自动改写成海量 AI 笔记」。核心价值是：原始资料可以追溯；跨资料结论可以积累；新资料能够修订旧结论；人工笔记不会被自动覆盖；任何重要答案都能回到实际证据。

推荐的知识工作闭环：

```text
收藏 / 导入
  → 保存原始版本与来源
  → 解析、建立可检索证据
  → 生成知识变更提案
  → 校验与人工审核
  → 更新 Wiki 页面
  → 检索、阅读原始证据、回答问题
  → 将有价值的答案另存为候选知识
  → 审核后沉淀
```

**不建议把 RAG 与 LLM Wiki 当成必须二选一的技术路线。** 前者主要解决「此刻如何找证据并回答」，后者主要解决「哪些综合理解值得长期维护」。本方案用 Wiki 做长期知识表达，用检索找 Wiki 与原始证据，再通过版本和审批管理回写。

具体采用策略是：先用隔离测试 Vault 评估现成的 LLM Wiki 插件；需要 TypeScript 集成时，优先评估 `atomicstrata/llm-wiki-compiler` 的 SDK，而不是从零重写编译器。自研范围集中在 Obsidian 集成、可信审批、文件一致性与运行治理；只有上游接口无法满足验收项时，才替换相应模块。[R44][R45]

不要重写 Markdown 编辑器、图谱界面、同步协议或文档解析引擎。

## 2. 需求解释、假设与边界

### 2.1 已知要求

本次明确要求是：基于 Obsidian；参考指定的 X 文章、LLM Wiki、PandaWiki 及 GitHub Wiki 项目；可使用 TypeScript；交付完整调研和实现方案。

结合技术使用场景，方案重点覆盖技术文档、网页、Markdown、PDF、代码仓库研究记录和经过选择的 Agent 产出。代码知识以「指定版本的文件、符号和设计结论」为对象，不默认把整个仓库逐行变成知识页面。

### 2.2 为落地而采用的假设

| 项目 | 本方案假设 | 假设改变后的影响 |
|---|---|---|
| 使用者 | 首先是一个人，桌面端是主要维护入口 | 多人同时写入需要权威写服务或 PR 合并，不只是增加账户 |
| 内容规模 | 首轮 100 份真实资料；下一阶段用 1 万份 Markdown/资料片段做容量验证 | 更大规模需要重新测量索引、重排和增量编译成本 |
| 模型 | 可配置本地或云模型；默认不批准私密内容外发 | 全离线需要额外验证本地模型质量与硬件资源 |
| 编辑习惯 | 保留已有人工目录，不强制迁移 PARA / Zettelkasten 等组织法 | 全量改目录必须单独设计迁移和链接兼容 |
| 团队与发布 | 扩展项，不作为第一个可用版本前提 | 真正团队权限必须在内容进入模型前过滤 |
| 预算 | 用户尚未给出硬预算 | 方案给出可配置预算与示例计算，不替用户承诺实际费用 |

### 2.3 第一版不做什么

不做通用多 Agent 平台，不做实时协同编辑，不做全网自动爬虫，不自动修改人工决策，不让模型执行任意 shell，不要求 Neo4j、Redis、Kubernetes 或独立向量数据库，不把自动发布互联网设为默认行为。

这些并不是永远不需要，而是不能挤占最先要验证的价值：**同一批资料，使用者是否更快找到正确证据，并且不用担心笔记被破坏。**

## 3. 调研方法与证据强度

本次优先使用官方文档、原作者说明和项目维护者仓库。证据分为四类：

| 等级 | 含义 | 本报告怎样使用 |
|---|---|---|
| A | 官方 API 定义、协议或具体配置文件 | 支撑接口与平台边界判断 |
| B | 维护者 README、发布说明、项目结构文档 | 支撑「项目宣称具备某能力」，不等于完成运行验证 |
| C | 原作者概念文章 | 用于解释方法，不当成性能或可靠性证明 |
| D | 本报告自行提出的工程设计 | 明确标为建议、约束、验收目标 |

**本次没有安装或部署候选项目，也没有进行同语料横向跑分或全仓安全审计。** 代码层核对包括 Obsidian 官方 API 类型定义、atomicstrata 的 SDK 导出与 facade，以及部分项目配置、目录说明。第三方项目的中文召回率、低配机器运行效果、失败恢复正确性仍需按实现方案中的评测集验证。

不提供容易误导的 Star 排名：Star 不能证明引用可靠、同步安全或适合个人 Vault；网页快照也不能代替经过固定的 release/commit。正式采用项目时，必须保存实际验证的版本、提交、许可证和依赖锁文件。

### 指定 X 文章的读取范围

已识别到文章《从0到1，搭建起你的个人知识库》，并读取到关于知识保存、检索、Agent 使用及 RAG / LLM Wiki 分类的部分正文。长文抓取存在截断，因此**没有将未完整取得的具体搭建步骤、工具清单归因给作者**。下文的技术结论另外使用官方和仓库资料核实。[R31]

## 4. 先区分六个容易混在一起的概念

### 4.1 Obsidian：文件工作台，不是自动知识治理系统

Obsidian 提供基于本地文件的笔记体验、链接、图谱、Canvas 等能力。它适合作为可长期持有的知识界面，但安装它并不会自动得到来源版本、事实审核、模型预算或可恢复任务队列。[R01]

### 4.2 Vault：知识内容的持久载体

本方案中的 Vault 不只是文章目录，还保存来源快照、编译后的页面、人工笔记、明确的引用和机器可读溯源文件。不过「文件是知识事实源」不意味着所有数据库都可以删除：**操作账本、审批记录和未完成任务状态也是重要持久数据**；只有检索索引应设计为可以重建。

### 4.3 LLM Wiki：维护知识页面的方法

Karpathy 的原始材料是一个 idea file，而非必须安装的官方软件。其重要区分是：原始来源、由模型维护的 Wiki、组织规则，以及摄入、提问、维护这些操作。它把整理工作前移，让跨资料理解作为文件留下。[R08]

### 4.4 RAG：回答时使用外部证据的机制

「RAG 每次都从零开始，不能积累知识」只能描述某些朴素实现，不能当作所有 RAG 的定义。GraphRAG 的索引过程就包含结构提取与社区摘要，说明检索增强也可以使用预计算知识。[R35]

因此，本方案的 Wiki 页面也可以成为 RAG 的检索对象；区别在于它们必须保留来源关系，并且不能取代原始证据。

### 4.5 链接图不等于事实图

`[[连接]]` 表明两篇笔记之间存在导航关系，并不自动表明「支持」「否定」「版本替代」。图上的高中心性也不能证明某条主张更真实。

本方案区分两种边：笔记导航边用于发现相关内容；带出处、版本、时间及关系类型的证据边用于解释结论。第一版用 SQLite 边表即可，不要求引入图数据库。

### 4.6 知识库不等于 Agent 的完整运行记忆

对话过程、未完成任务、一次临时搜索结果，不应全部成为长期 Wiki。这里的知识库接收的是经过选择的资料、明确的观察、审核后的决策和可复用结论。Agent 的短期 Scratchpad、执行状态与工具轨迹仍由它自己的 Runtime 管理。

## 5. Obsidian 当前能力与真正的工程边界

| 能力 | 本轮核实的能力 | 对架构的影响 |
|---|---|---|
| Web Clipper | 官方浏览器扩展，将网页内容保存到 Vault；有模板与变量机制 | 第一版直接复用，不重造浏览器采集器 [R06] |
| Bases | 核心插件，以本地 Markdown 和 properties 形成数据库式视图；视图可保存在 `.base` 文件 | 适合资料、待审核、过期知识面板，不把业务记录藏进专有数据库 [R05] |
| Plugin API | 提供 Vault、Workspace、MetadataCache 等接口 | 插件负责 UI 与受控落盘，服务负责重计算 [R02] |
| `Vault.process` | 官方定义为原子读取、修改、保存单篇笔记；回调同步返回新文本 | 可在回调中检查基线内容；不是跨文件事务 [R03] |
| 重命名 | 官方提示要自动更新链接，应使用 `FileManager.renameFile` 而不是直接 `Vault.rename` | 不使用文件系统 rename 冒充完整链接迁移 [R03] |
| CLI | 控制桌面应用，要求应用运行；未运行时可由命令启动 | 适合桌面自动化，不等同无 GUI 后端 [R04] |
| Headless | 独立于桌面运行的官方客户端，文档标为 open beta | 可用于服务器取得同步副本，不是通用知识编译器 [R07] |
| Headless Sync | 需要有效 Sync 订阅；官方明确同设备不要同时运行桌面 Sync 与 Headless Sync | 每个设备选择一种同步方式，不能用双同步提高「可靠性」 [R09] |
| 社区插件安全 | 官方说明无法可靠实施插件细粒度权限限制，插件继承应用访问能力 | 插件须按可信代码管理，不能把它当安全沙箱 [R10] |

**非常重要：本地存储不等于模型不联网；配置云模型后，传给模型的内容仍会离开设备。** 同步加密也不会自动约束模型服务商、第三方插件或发布流程。来源级外发政策必须独立实施。

## 6. GitHub 项目选型矩阵

下表的「适配」是针对本需求的判断，不是通用项目评分。

| 项目 | 实际定位 | 与 Obsidian 的关系 | 可借鉴 / 复用 | 本方案结论 |
|---|---|---|---|---|
| Karpathy LLM Wiki | 概念模式 | 以 Markdown Wiki 为核心，适配文件工作台 | 来源 / Wiki / 规则分层 | 方法论起点，不是现成后端 [R08] |
| `GD4AI/obsidian-llm-wiki` | Obsidian 内的知识编译与查询插件 | 直接作用于 Vault；当前 README 另指向用户 CLI 仓库 | 知识页生成、维护面板、图检索工作流 | **优先做插件路线试点**，不要误称只能依赖插件 UI [R11][R12] |
| `atomicstrata/llm-wiki-compiler` | TypeScript 知识编译器、CLI / SDK / MCP | 生成 Markdown Wiki；不是 Obsidian 插件 | 来源追踪、增量编译、review、context pack | **TS 服务底座的第一复用候选**，在隔离 workspace 中接入 [R44][R45] |
| `nashsu/llm_wiki` | 独立桌面知识库应用 | 输出可与 Obsidian 兼容的 Wiki，不是 Obsidian 插件 | 审核、来源与知识区分、活动记录 | 很好的产品原型参照；含 Rust 后端，不是纯 TS [R13][R14] |
| `ekadetov/llm-wiki` | Claude Code 插件 / 工作流 | 在 Vault 内维护 raw/wiki | 将 ingest 与 compile 分开、query/lint、变更记录 | 适合验证交互方法，不替代持久任务系统 [R15] |
| `2233admin/obsidian-llm-wiki` | 面向审核与团队记忆的 MCP/CLI/插件组合 | Markdown、候选产出、review/promote | 知识提升流程、Host 无关接口 | 参考治理思想；功能面宽，须进一步核实版本与运行依赖 [R16] |
| `tobi/qmd` | 本地文档搜索引擎 | 能索引 Markdown，不依赖 Obsidian 编辑器 | 关键词、向量、重排与 MCP | **检索增强候选**，不是来源治理与写入系统 [R17][R18] |
| Smart Connections | 相关笔记与语义发现 | Obsidian 插件 | 写作时发现相近笔记的体验 | 可体验；当前 source-available 许可证需单独审查 [R19] |
| Obsidian Copilot | Obsidian 中的 AI / Agent 交互 | 插件 | 上下文选择、交互入口 | 用于比较助手体验；不能仅凭聊天能力推定具备知识编译治理 [R20] |
| Local REST API | Vault 的 REST 与 MCP 接口 | 插件中运行，能读写 Vault 和使用实时元数据 | 快速打通已有 Agent | 当前已有内置 MCP；不必无条件再套一层 MCP，但仍需收窄权限 [R21] |
| Quartz | Markdown 网站发布工具 | 将笔记发布为网站 | 已批准知识的静态发布 | 作为可替换发布端，不做知识存储主系统 [R22] |
| PandaWiki | 自托管 AI 文档 / FAQ / 网站系统 | 支持导入 Markdown 等内容，不等同 Vault 原生存储 | 对外展示、导入渠道、站点问答体验 | **发布端或产品体验参考**，不建议作为 Vault 写入核心 [R23][R24] |
| GitHub Wiki topic 下其他项目 | 广泛的 Wiki、协作、笔记应用 | 数据模型和存储方式不一 | 找到编辑、协作与发布能力参考 | Topic 是发现入口，不是同构产品排行榜 [R25] |

### 6.1 GD4AI：最值得先体验，但要把营销表述还原为工程条件

其 README 描述了基于页面标题、别名、关键词和 PPR 图扩展的检索路线，以及 ingest、query、lint 等操作。这里「不用 embedding」并不意味着不做检索，也不意味着查询没有模型调用成本。[R11]

对本项目最有价值的验证是：同一概念的中英文别名能否正确连接；新来源是否改对旧页面；来源定位是否足以支撑答案；重复 ingest 是否产生新副作用；手改后的页面会不会被覆盖。不能用其自有语料上的表现直接替代这些测试。

需要注意入口变化：当前 README 将用户 CLI 指向独立的 `green-dalii/obsidian-llm-wiki-cli`，仓库里的 `tools/dev-instrument` 则是开发测量工具。不能把旧发布说明里的路径当成当前安装入口；本轮未完成独立 CLI 仓库的运行核验。命令可运行和任务可恢复也属于不同验收项。[R11][R12]

### 6.2 nashsu：更像完整产品，不是 TS 后端现成模板

项目维护者明确列出 Tauri/Rust 后端、React/TypeScript 前端，并说明来源、Wiki、审核等产品能力。它很适合观察「用户怎样检查编译过程」，但选择它意味着接受独立桌面应用及混合语言实现，而不是在 Obsidian 内单独安装一个插件。[R13][R14]

若目标是尽快使用、并不坚持自己实现服务，它应进入试用名单；若目标是把知识能力嵌入现有 TypeScript Agent Runtime，则优先学习接口和工作流，不直接搬整套桌面应用。

### 6.3 PandaWiki：问题不在能力弱，而在系统中心不同

PandaWiki 的 README 面向文档站、FAQ、AI 写作、搜索和问答，并列出 URL、Sitemap、RSS、离线文件等导入方式；项目结构文档说明后端为 Go，前端为 Node.js/React。[R23][R24]

这些能力很适合「给别人访问的知识站」，但本需求首先是「保留 Obsidian 为个人长期工作台」。本轮资料不足以证明它能无损双向同步 Vault 的 wikilinks、block ID、properties 与人工编辑。因此，不能把「导入 Markdown」写成「和 Obsidian 双向兼容」。

推荐边界：Obsidian 是知识维护端，PandaWiki 只接收审核过的发布副本；网站端修改不自动反向覆盖 Vault。接入其具体 API 前另做版本与字段往返测试，不在方案中杜撰上游接口。

### 6.4 QMD：值得复用搜索，不要顺便让它拥有写权

QMD 的维护者资料描述了本地 BM25、向量语义检索、模型重排以及 MCP 接口。它可以作为检索提供者接入，而不必让整个知识系统依赖其内部索引格式。[R17][R18]

接入时只给它经过访问控制的内容范围，并校验返回文件的身份与修订。中文术语、两字词、代码符号和跨语言问题应进入本地评测，不能因为有「hybrid」字样就假设已经解决。

### 6.5 工作流模板：借鉴流程，不把提示词当执行保证

`ekadetov` 展示了较轻的 raw/wiki 工作流；`2233admin` 强调 capture、compile、ask、file、review、promote。它们对交互设计很有启发，但说明文档中的约定仍需要运行时校验与写入协议实现。[R15][R16]

特别是后者的 README 同时出现不同默认依赖的描述，本轮没有完成其代码路径一致性验证。因此不把其中任何「零配置」「无数据库」表述直接移植为本方案架构事实。

### 6.6 许可证不能按历史印象判断

| 项目 | 本轮资料所列许可证 / 状态 | 对采用方式的提示 |
|---|---|---|
| GD4AI | Apache-2.0 | 可进入源码复用评估，仍需检查依赖与 NOTICE [R11] |
| nashsu | GPL-3.0 | 使用、修改、分发的方案应分别审查 [R13] |
| PandaWiki | AGPL-3.0 | 对外服务方案应单独核对许可证义务 [R23][R24] |
| ekadetov | MIT | 更容易复用流程脚本，但不能跳过依赖审计 [R15] |
| atomicstrata | MIT；本轮 package.json 指定 Node >=24 | 优先评估 SDK 复用，固定真实安装版本 [R45] |
| QMD / Quartz | MIT | 仍应固定实际采用版本 [R18][R22] |
| Smart Connections | Smart Plugins License，source available | 不应继续按历史印象称为无额外限制的开源底座 [R19] |

本表是采用风险提示，不构成针对具体分发、商用或服务方式的法律结论。

### 6.7 atomicstrata：与 TypeScript 实现要求最直接匹配的候选

仓库提供可编程的 `createWiki` SDK，以及 CLI/MCP、增量知识编译、来源引用、审核候选和 context pack。本轮读取到的 package.json 标为 1.1.0、MIT、Node >=24；这是所读快照，不宣称已经验证 npm 发布包与主分支完全一致。[R44][R45]

从源码核对到 `src/index.ts` 导出 `createWiki`，`src/sdk/wiki.ts` 将 ingest、compile、query、context 等操作接到实际函数，不只是 README 宣称存在 SDK。[R49][R50] 因此它应进入 TS 路线第一轮试用，不能只围绕 Obsidian 插件和 Go 网站系统做选择。

不过，不能将它直接挂到真实 Vault 后就认为完成了安全集成。其 SDK 文档明确提醒 `ingest({source})` 会读本地文件或抓取 URL；不可信输入应优先由自己的受限采集器处理后传 `ingestText`。review 文档也说明普通 compile 默认可直接写入，`query --save` 不受同一 review policy 管理。[R46][R47]

还有值得进入兼容测试的文档漂移：SDK 指南将 search 返回值描述成页面数组，当前 facade 源码实际返回 `{pages, refs, warnings}`。适配层应以锁定版本的类型、源码与契约测试为准，不能从介绍页复制接口就上线。[R46][R50]

建议：在隔离编译 workspace 运行 SDK，强制审核模式，将候选结果转换为本系统 ChangeSet，再由 Obsidian 写入器提交。若只是个人体验，可直接使用它维护测试 Vault；若嵌入正式 Agent 系统，必须验证所有写入口、预算钩子、恢复行为和出处转换，而不是重新实现它已经具备的全部功能。

## 7. 三种可实施路线

### 路线 A：现成插件 + 规范化 Vault

使用 Obsidian、官方 Web Clipper，以及一个经过评估的 LLM Wiki 插件。以隔离 Vault 开始，人工查看每次 ingest 的修改。

优点是最少自研、容易体验；代价是治理能力受上游约束。适合资料不多、愿意监督每次修改、主要追求个人使用价值的阶段。

### 路线 B：薄插件 + 独立 TypeScript 知识服务——推荐的长期架构

Obsidian 不承载长任务和模型编译的核心状态。服务产出 ChangeSet，插件显示证据与 diff；用户批准后由唯一写入通道应用。检索、CLI 与 MCP 复用同一服务。

它增加了一个需要维护的本地进程，却能把预算、索引、持久任务、来源修订和写入权限集中管理。**这是配套实现方案的主线。** 首先做到单用户、单权威写入端，不提前实现团队分布式写入。编译实现优先用 atomicstrata SDK 适配，配套方案中的自研 compiler 是可替换合同与未通过上游验收时的替代路线，不要求两套引擎同时建设。

### 路线 C：独立 AI Wiki 应用或网站系统

接受 nashsu 一类桌面应用作为主要界面，或以 PandaWiki 为主站，Obsidian 只做导入 / 导出端。

适合愿意改变工作台、或首要目标是对外知识站的情况。它并非不好，只是「基于 Obsidian」的程度不同，不能包装成路线 B 的同义替代。

## 8. 关键架构决策记录

| 决策 | 本方案选择 | 原因 |
|---|---|---|
| 内容事实源 | 原始资料版本 + Markdown 页面 + 溯源文件 | 保留独立于应用的可读产物 |
| 运行事实源 | 独立持久操作库 | 审批、预算与未完成任务不能靠重新向量化恢复 |
| 第一版知识写入 | 先提案后批准 | 减少错误知识固化与人工内容损坏 |
| 人工内容 | 独立目录、自动化默认只读 | 比全篇混合编辑更容易给出正确性保证 |
| 检索 | 精确 / 全文为底线，向量可选，图有限扩展 | 能先建立可测的基线，不依赖单一检索范式 |
| 查询回写 | 另存候选，不自动成为证据根 | 防止 AI 自己引用自己的循环强化 |
| 编译模式 | 有预算和状态机的确定性流程，局部使用 LLM | 不需要让 Agent 无限制决定下一步 |
| 同步 | 每设备一种同步方式；一个权威写入端 | 同步冲突不能由进程内锁解决 |
| 发布 | 审核后单向导出 | 公私边界、撤回和链接处理更明确 |
| 系统扩展 | 稳定领域接口，按需求加组件 | 第一版不引入完整分布式平台 |

## 9. 试点决策：先拿真实问题验证，不看演示选型

选取约 100 份有代表性的资料，包含中文技术文档、代码符号、不同版本的说明、重复网页、一个无法解析的文件，以及几份绝不能外发的笔记。在测试 Vault 中分别验证现成插件路线与自研最小检索基线。

记录五类结果：能否找到原始证据；引用是否支持结论；资料更新后旧结论是否仍被当成现状；写入失败是否可解释和恢复；每次摄取、编译和回答实际消耗多少模型资源。

当现成插件已经满足这些要求时，没有必要为了「自己有一套架构」而重建。只有不足集中在服务集成、可恢复写入、来源治理和预算控制时，再投入路线 B。

**最终判断：值得搭建，但第一优先级不是更漂亮的图谱，而是可相信的知识生命周期。** 配套方案将这个生命周期拆解为明确接口、文件结构、数据关系和验收任务。



<!-- SOURCE-DEFINITIONS -->
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
