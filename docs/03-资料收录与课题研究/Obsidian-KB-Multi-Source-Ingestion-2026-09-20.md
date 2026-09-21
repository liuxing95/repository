# Obsidian 知识库：代码、网页、文档站与 PDF 的统一收录方案

**日期：2026-09-20｜性质：对原技术方案的增补设计｜主实现语言：TypeScript**

> 本文定义需要开发的资料摄取能力，不代表已经安装或运行。原《Obsidian-KB-Technical-Spec-2026-09-20.md》§0.2 将首版输入限定为 Markdown/TXT；用户现已明确需要代码、文章、官方文档地址、PDF 等输入，因此该限制不再作为满足实际需求的验收口径。本文不覆盖修改原文件，也不声称转换器能够无损理解任意材料。

## 0. 核心结论与需求调整

用户不负责把所有材料转换成 Markdown。系统应提供一个统一导入入口，内部按来源与格式路由，保留原始材料、结构和出处，再进入统一的检索与知识编译流程。

```text
拖入文件 / 粘贴网址 / 选择目录 / 粘贴代码
                  ↓
     识别来源、预览收录范围、检查权限
                  ↓
       连接器获得实际内容并冻结版本
                  ↓
    格式解析器 → 统一结构 → 质量与覆盖检查
                  ↓
        批量确认来源导入 → 可检索证据
                  ↓
     按需分析关联、编译知识、生成研究内容
```

新的首个“满足用户需求”的版本至少覆盖：单篇网页、限定范围的官方文档站、仓库/本地代码/代码压缩包、文字型 PDF。扫描 PDF、复杂表格和图片必须能保存原件、识别处理缺口并进入受控增强队列；未完成增强前不能宣称全文可用于准确问答。

“已上传”“已归档”“已解析”“已索引”“已编译”“已审核”分开表达。把所有状态压成一个“导入成功”，会掩盖最重要的失败。

## 1. 用户界面：一个入口，四种主要操作

### 1.1 导入入口

```text
添加材料

[拖入文件] [粘贴网址] [选择本地目录] [粘贴文本或代码]

可选：所属课题、收藏理由、已知的软件版本
必须核对：收录范围、内容完整度、模型外发权限

系统预览：材料类型、预计数量、排除项、限制、需要处理的问题
```

URL 粘贴后可以识别 GitHub 仓库、普通网页、疑似文档站或可下载文件，但自动识别只负责建议。一般 URL 默认只收录当前页面；不能因为像文档站，就自动遍历整站。仓库根目录与文档站入口显示范围预览，用户可批量确认，无须逐页批准。

本地目录只能由用户通过本机文件选择器或 CLI 明确指定，再上传选定快照。模型和远程请求不能提交任意服务端文件系统路径。

### 1.2 来源与格式不是一回事

| 维度 | 例子 | 决定什么 |
|---|---|---|
| 入口 | 上传、网址、目录、浏览器剪藏 | 如何获得内容和授权 |
| 容器 | 文档站、Git 仓库、ZIP、文件夹 | 如何发现和枚举子材料 |
| 物理格式 | HTML、PDF、MDX、TS、DOCX | 选择哪种解析器 |
| 内容类型 | 正文、代码、表格、公式、图片 | 切分、索引和引用如何处理 |
| 语义角色 | 官方说明、实现源码、教程、评论、用户决定 | 可以支持哪类主张 |

例如“官方 PDF 地址”既是 URL 入口，也是 PDF 格式；“仓库里的 MDX”既是仓库文件，也是文档。不要给每种组合写一套完全独立的系统。

## 2. 统一摄取流水线与授权

### 2.1 获取与提交分两段

```text
A. 准备与获取
接收入口 → 限定范围 → 获得获取授权 → 枚举/下载
        → 原始对象进入受限暂存区 → 解析 → 固定导入清单

B. 正式纳入
用户确认来源清单 → source-only 导入批准
        → 插件提交可读来源投影和 manifest
        → 创建可查询快照 → 索引 → 返回实际覆盖报告
```

“获取授权”允许在限定域名、目录、数量和费用内读取资料，不等于 Wiki 写入授权。来源导入批准绑定具体内容清单、哈希及政策；一个批次可以一次确认。后续编译修改 Wiki 仍走独立 ChangeSet 与批准。

解析器输出只进入工作区/对象仓，不能直接写正式 Vault。服务只读写运行对象；Obsidian 插件继续作为活跃 Vault 的唯一自动化写入通道。插件离线时可继续获取和解析，状态是 `awaiting_writer`，不把未提交来源加入正式查询快照。

### 2.2 非模型处理先行

获取、解压、文件类型识别、文本解析、语法解析、哈希、目录枚举和关键词索引默认不需要生成式 LLM。复杂布局解析可能运行本地模型，必须计入资源限制，但不能据此认定一定发生云调用。

LLM 主要用于需要语义理解的实体/主张提取、解释、关联候选和按需视觉理解。图片、OCR、重排和摘要的外发政策与回答模型相同，不能以“只是预处理”为由绕过权限。

## 3. 单篇文章或普通网页怎么收录

### 3.1 公开静态文章

推荐路径：受限 HTTP 获取 → 保存实际响应正文 → 页面类型识别 → 正文提取 → 标题/段落/代码/表格映射 → 规范化结构。

保存的元数据包括请求 URL、最终 URL、捕获时间、HTTP 状态、Content-Type、内容哈希、取得的响应头子集和正文覆盖状态。Authorization、Cookie、会话令牌不能进入知识材料、日志或模型上下文。正文内可能有个人信息和令牌，先置于受限区并做检查，不能仅扫描响应头。

普通长文可采用 Mozilla Readability；它负责正文提取，不负责 HTML 安全清洗，官方建议配合清洗工具，并保持 jsdom 脚本和远程资源加载关闭。[S01]

文章中的代码块保持语言和相邻解释；不能只保留 prose 丢掉样例。脚注、否定条件和版本标识进入结构化正文。发布日期未知时保留未知，HTTP Last-Modified 不等价于作者更新时间。

### 3.2 动态页面

静态正文不足时才按明确策略升级浏览器渲染。浏览器使用隔离上下文，不继承用户本机浏览器、服务密钥或整个 Home 目录。所有子请求、重定向、下载和弹出窗口均受网络/资源政策管理，不只是检查首次 URL。

浏览器渲染会执行远端网页 JavaScript；这与正文解析阶段“不开脚本”是两个不同安全域。渲染得到 DOM 快照只能证明当时实际加载的内容，不能保证隐藏标签、懒加载、交互展开项全部覆盖。

Crawlee 提供 TypeScript 的 HTTP/浏览器抓取接口、持久 URL 队列和重试等能力，可作为连接器底层；它不替代本系统的范围、预算、来源和授权规则。[S02]

### 3.3 登录页面、付费内容和无法获取的长文

优先由用户在自己有权访问的浏览器中使用官方 Web Clipper 或导出功能保存可见内容。官方 Clipper 将剪藏保存为可离线读取的 Markdown。[S03]

不能要求把个人浏览器全部 Cookie 交给研究 Agent，也不绕过登录、付费或访问限制。受限站点无法读取时返回 `needs_auth`、`blocked` 或 `excerpt`。用户剪藏的选区就是节选，不能自动改成“完整文章”。

链接中包含 PDF 等下载资源时，受限获取器先取得字节，再按实际格式路由；后缀、服务端 MIME 都只是线索，需要结合内容签名验证。指向下载文件的页面并不等于文件已经获取。

## 4. 官方文档地址：按资料集合收录，不把首页当全文

### 4.1 SourceCollection 与 CollectionSnapshot

一个文档站是来源集合。每个页面独立保留 Source、SourceRevision 和 ParseArtifact，集合快照保存本次选定的页面到具体修订的映射。

```text
Docs Collection
 ├─ scope：域名、允许路径、语言、版本线、数量上限
 ├─ discovery：导航/sitemap/内部链接/官方索引
 ├─ CollectionSnapshot
 │   ├─ 页面 A → 固定 sourceRevision + parseId
 │   ├─ 页面 B → 固定 sourceRevision + parseId
 │   └─ 页面 C → failed / excluded / pending
 └─ 覆盖报告与获取时间窗口
```

sitemap、导航树以及站点公开的文档索引用于发现 URL；它们不是“站点完整性证明”。如果站点提供 Markdown、llms.txt 或类似机器可读索引，可以利用，但仍需校验具体页面、语言、版本及输出覆盖。

### 4.2 范围预览

用户输入文档首页后，显示如下设计中的预览：

```text
模式：文档集合
允许域名：已验证的目标文档域名
允许路径：/guide/、/config/
语言：用户选定的一个语言版本
软件版本：按站点证据记录；无法确认则 unknown
外部链接：不自动扩展
页面预算：首批最多 100 页（试点参数，不是强制产品上限）
更新方式：默认手动检查更新
```

跨到其他子域、旧版本、其他语言、源码站或外部教程时，产生候选建议，不自动扩大本次范围。路径只是限制和版本线索，最终软件适用范围仍落到主张上。

### 4.3 技术文档用结构化抽取，不只用文章阅读器

优先提取 main 内容、标题树、提示块、API 表、代码标签页及锚点，保留 breadcrumb、版本选择和语言信息。Readability 可作为回退，但不得无声丢掉 API 参数表或 tab 中的其他语言样例。

对于 Vue/React 示例标签、npm/pnpm/yarn 安装标签，应记录实际提取了哪些 tab；无法展开的标 `interactive_content_not_captured`。MDX 源文件按语法解析，保留未知组件或标缺口，不编译执行 JSX，也不直接运行文档站构建脚本。

### 4.4 完整性报告

以下数字仅为界面示例，不是一次真实抓取：

```text
发现候选：120 页
在本次授权范围内选定：100 页
未纳入：20 页（越界或达到预算）
已抓取并通过正文检查：92 页
失败：5 页
需要人工核对：3 页

结论：已完成本次计划的部分收录；不能标记“整站已完整学习”。
```

一个网站在抓取过程中可能更新，批次冻结保证本地结果可重现，不保证这些页面在源站上曾于同一瞬间共同存在。记录开始/结束时间和页面各自时间，优先使用固定版本的文档。若需要严格版本一致性，取得并验证对应文档 release/commit；拿不到则明确证据边界。

### 4.5 增量更新

后续仅对选定集合做变更检查。相同正文保留修订，改变产生新修订；ETag/Last-Modified 可优化获取，但不能替代内容哈希。抓取失败、403 或暂时 404 不直接证明来源已永久删除，不自动清除旧证据。

版本化文档和 rolling 文档分别管理。新页面出现仍需要在已授权范围内；超出范围或上限时要求范围确认。更新后的旧主张标待复审，不直接覆盖其历史适用性。

## 5. 代码怎么收录：固定快照、按文件与符号保留

### 5.1 四种代码入口

| 用户提供 | 获取策略 | 能可靠保留的范围 |
|---|---|---|
| 仓库地址 | 解析指定 tag/branch 为 commit，再列文件 | 该 commit 的选定文件；不是所有历史与依赖 |
| 单文件地址 | 固定到具体 commit 和文件 | 实际取得文件及其定位 |
| ZIP 或本地目录 | 安全枚举，冻结每个文件和总 manifest | 这次收到的目录快照；不虚构 Git commit |
| 粘贴代码 | 保存片段、语言候选、用户说明 | 片段本身；上下文可能不足 |

GitHub 官方说明分支文件链接会随提交变化，而 commit permalink 指向确切版本；因此来源引用不只保存 `main`。[S04]

用户没指定 ref 时，可以解析当前默认分支并在导入预览中显示实际 commit。但这只代表当次开发分支快照，不代表当前稳定 release，更不能擅自标成某个已发布软件版本。tag 也要记录实际解析出的 commit。

### 5.2 本地目录与工作树

有 Git 元数据时记录 base commit 和工作树是否存在修改；实际分析内容仍以收到的文件哈希清单为准。未提交改动不能冒充该 commit 的内容。复制期间文件改变则重试或标记不一致，不能把逐文件复制宣称为原子工作树快照。

本机绝对路径不直接对外展示或发给模型；保存相对路径和受控来源 ID。ZIP 中的 `../`、绝对路径、符号链接、嵌套炸弹和超大解压体积需要拒绝或进入隔离审核。ZIP 文件名不构成真实来源或版本证明。

### 5.3 收录过滤分 profile，不能无条件排除 dist

`source-repository` 默认选择源码、README、版本说明、清单、锁文件、配置和相关测试；排除 `.git` 内部、依赖安装目录、密钥、缓存和不相关大二进制。

`published-artifact` 用于用户明确给出打包产物的情况。此时 `dist`、`.d.ts`、包入口、exports、source map 和实际发布元数据是主要研究对象，不能沿用源码仓库排除规则而把输入主体丢掉。源码与发布物建立候选关联，但不未经核验就视为一致。

锁文件通常保留为依赖快照数据，不把每一行当普通知识段落去 embedding。排除清单要出现在预览和最终 manifest 中，用户显式选择的文件不得静默排除。

### 5.4 结构解析与切分

推荐采用 Tree-sitter 做多语言语法节点与定位抽取，TS/JS 需要更深入的符号或类型信息时可使用 TypeScript Compiler API/ts-morph。Tree-sitter 构建的是语法树，本身不是完整跨语言类型分析或运行时调用图。[S05][S06]

切分优先按模块、类、函数、接口和配置区块，保留签名、附近注释、导入和所属路径。过大的函数可拆成多个子块，但保留共同父符号与连续范围。解析失败时回退到带行号文本检索，并标 `syntax_parse_failed`，不丢弃原文。

每个代码证据至少有：repository/collection 身份、固定文件对象哈希、相对路径、行范围、可选 commit、可选符号名和解析器 fingerprint。源码原始字节不格式化覆盖；格式化显示稿单独存储映射。

### 5.5 静态证据的能力边界

源码出现一个 import 只说明存在该语法/依赖线索；是否是默认调用路径，还需解析条件、入口、配置和必要的运行证据。静态分析无法解析的动态引用保存为候选，不标确定事实。

测试文件入库不等于测试已通过。导入时不运行 `npm install`、build、test、Rust build script 或项目自定义脚本，不加载项目内 Agent 指令为系统规则。读取 package/config 文件不等于执行配置。

需要运行验证时单独建立授权任务，固定环境、依赖、命令和结果，并将运行记录作为另一种来源。用户授权读取代码不等于授权执行代码。

### 5.6 仓库覆盖报告

报告分别列：manifest 中的文件数、选定数、排除数、下载数、语法解析成功数、文本回退数、缺失数和超限数。Git LFS 指针、submodule 引用和被排除的外部依赖不能冒充实际内容已经获取。

只选了一个 package 时，回答范围就是这个 package 及实际取得的上下文。不能因整个仓库名出现在集合标题中，就宣称已审查全仓库。

## 6. PDF 怎么收录：保存原件，按页和元素解析

### 6.1 PDF 路由

```text
收到 PDF 字节 → 文件与密码检查 → 保存原件 → 页数与结构检查
   ├─ 文字层可用、结构简单：数字文字抽取
   ├─ 双栏/复杂布局/表格：布局与表格解析
   ├─ 扫描或局部缺字：只对必要页/区域做 OCR
   └─ 图表/公式承担结论：保留图像，按需视觉核验
```

PDF.js 提供 PDF 加载、文本内容和页面渲染等基础接口，可作为 TypeScript 基线；其文本抽取不等于自动正确重建表格、公式和论文阅读顺序。[S07]

Docling 提供布局、阅读顺序、表格、图片和统一文档表示，以及 OCR/视觉扩展，可作为复杂文档 worker 的主要候选。它声明的能力仍要用实际中文、扫描和表格样本验证，不能写成已实测 100% 准确。[S08][S09]

### 6.2 保存哪些结果

原始 PDF 是持久证据，不被 Markdown 替代。解析结果至少包含：每页处理状态、正文元素、标题层级、表格单元格或结构、图片/图注、必要页图或裁剪图、元素定位、警告和解析器版本。

页码统一使用文件物理页的 1-based 编号；印刷页码如 i、ii、1 单独记录。bbox 使用明确坐标系和单位，例如旋转规范化后页面左上角原点的 0..1 范围；保存变换信息。解析器不提供可信 bbox 时，降级到页级定位，不虚构区域。

跨页表格和跨页段落允许有多个原始定位。提取文本偏移、PDF bbox 和代码行号不能放在同一个未声明单位的 offset 字段中。

### 6.3 表格、图表和公式

表格不能只转换成一串数字。保留列头、行头、单位、跨行跨列关系和脚注，并维持回到 PDF 页面的能力。重要数值必须和单位、测试条件同时进入证据包。

图表保存原图区域和可见图注；视觉模型生成的说明属于 `model-description` 派生字段，不能变成“原作者原文”。数字不能从模糊图像中猜出。问题涉及图表时，读取相应原图或原表验证；当前模型不支持/不允许处理该图像时，明确不能回答该图表问题。

公式解析不可靠时保留区域图与邻近解释。不要只留下看似可读但符号错误的 LaTeX，并据此做数学或性能结论。

### 6.4 OCR 按需，不全量无条件运行

优先使用已有数字文字；扫描页、局部图中文字或明显抽取缺口才进入 OCR。中文、英文、混合公式与代码的识别质量分别验证。OCR confidence 是识别器信号，不是事实可信度。

模型权重预先下载和固定，解析 worker 默认不临时联网下载或上传文档。用户未批准云 OCR/视觉路线时不得自动回退到云端。无可用解析器时原件可归档，但正文状态必须是 `pending` 或 `unavailable`。

密码保护文档使用用户有权提供的密码，密码作为短期秘密而不是来源元数据。无法打开时归档结果不能显示为“内容已读”。

### 6.5 允许局部可用，禁止假装整篇完成

以下为设计示例：一份 30 页 PDF，24 页文字可用，4 页需要 OCR，2 页图表待核验。用户批准后可索引已处理部分，并显示精确缺口。仅使用合格段落回答局部问题；关于整份论文结论、实验全面比较或“不存在某项结果”的问题，必须考虑未读页，必要时返回资料不足。

“原件完整保存”与“文本/表格/图片完整理解”是两套覆盖指标，不能互相替代。

## 7. 其他类型如何扩展

DOCX、PPTX、HTML、EPUB 等可复用文档 worker。MarkItDown 是多格式到 Markdown 的轻量工具，适合便捷文本转换，但维护者明确其目标并非高保真面向人阅读的格式还原；需要精细定位时不能仅依赖它的 Markdown。[S10]

图片记录原图、尺寸、文字抽取和派生描述；音视频如以后需要接入，记录原始媒体和转写时间码。语音转写不是原始音频本身，不能作为已核实的逐字引文而不保留时间定位。

表格文件要保留工作表、单元格、公式/显示值以及是否重算，不扁平化成无单位数字。Office 宏、外部数据连接和文档内脚本默认不执行。其他格式使用与本方案相同的来源、权限和覆盖合同，未安装对应 parser 时明确不支持解析。

## 8. 统一成什么：结构化中间表示，不是只有 Markdown

### 8.1 四层数据

| 层 | 保存内容 | 可否作为原始证据 |
|---|---|---|
| Raw | 实际取得的 HTML/PDF/代码/文件及 manifest | 是，但需检查真实性与适用范围 |
| Parsed | 结构化元素、文本、表格、语法节点、定位 | 原件的解析表达，需保存变换与质量 |
| Enrichment | 摘要、图片说明、指代消歧、实体/主张候选 | 派生信息；不能冒充原文 |
| Presentation/Index | Obsidian Markdown、搜索词项、向量 | 阅读/检索投影，不是替代原件 |

Markdown 很适合 Obsidian 阅读，但它不完整表达 PDF 页坐标、代码符号关系、跨页表格和解析警告。因此让所有解析器输出统一元素结构，再从结构生成 Markdown，而不是把 Markdown 当唯一内部交换格式。

### 8.2 版本与身份

沿用 `Source → SourceRevision → ParseArtifact → Evidence`，增加 `SourceCollection → CollectionSnapshot`。来源修订是实际材料字节版本；解析修订是解析策略版本；软件适用版本是语义字段，三者继续分开。

每次获取另外记录 AcquisitionObservation。即使原始字节相同，也可能具有不同的抓取时间、正文覆盖或页面状态；不要为了复用 SourceRevision 就丢掉获取记录。

同字节多来源可以复用存储对象，但保留来源家族和授权边界。二进制重排、PDF 元数据变化会导致文件哈希变化而正文相同，解析缓存与事实变更应分别判断。

### 8.3 切分保留上下文

文章按标题/段落，代码按符号/语法区域，PDF 按版面和逻辑元素，表格按可解释的行组/列头。块大小是性能参数，不是切坏定义、代码或表格的理由。

块继承来源版本、层级、所属集合、捕获时间、权限和明确的版本线索。跨段的“此版本”“它”等解释写进 enrichment，不改原文；推断范围未确认不能进入硬版本事实。

## 9. TypeScript 领域合同示例

以下代码是设计合同，未连接数据库、Obsidian 或实际解析器。`string` ID/hash/URL 和数值在实现时必须使用 runtime schema 校验。常量接口不是供应商现成 API。

```ts
export type Sha256 = string;
export type ID = string;

export interface Limits {
  maxItems: number;
  maxTotalBytes: number;
  maxPdfPages: number;
  maxUnpackedBytes: number;
  maxModelCalls: number;
}

export type ImportInput =
  | { kind: 'upload'; uploadId: ID }
  | { kind: 'text'; text: string; languageHint?: string }
  | { kind: 'web-page'; url: string }
  | {
      kind: 'docs-site'; rootUrl: string;
      allowedOrigins: string[]; allowedPathPrefixes: string[];
      locale?: string; versionHint?: string;
    }
  | {
      kind: 'git'; remoteUrl: string; requestedRef?: string;
      include: string[]; exclude: string[];
      profile: 'source-repository' | 'published-artifact';
    }
  | { kind: 'folder-snapshot'; uploadId: ID };

export interface ImportRequest {
  input: ImportInput;
  topicId?: ID;
  collectionId?: ID;
  limits: Limits; // 与可信账户政策取更严格值
  requestedModelRouteIds: ID[]; // 不授予权限
}

export type OriginalLocator =
  | { kind: 'web'; documentObjectHash: Sha256; headingPath: string[]; anchor?: string }
  | {
      kind: 'code'; fileObjectHash: Sha256; path: string;
      commit?: string; lineStart: number; lineEndInclusive: number;
      symbol?: string;
    }
  | {
      kind: 'pdf'; pdfObjectHash: Sha256; page: number; printedLabel?: string;
      bbox?: { coordinateSystem: 'top-left-normalized'; x0: number; y0: number; x1: number; y1: number };
    }
  | { kind: 'text'; originalObjectHash: Sha256 };

export interface ParsedElement {
  elementId: ID;
  parseId: ID;
  kind: 'heading' | 'paragraph' | 'code' | 'table' | 'figure' | 'formula';
  parentId?: ID;
  textObjectHash?: Sha256;
  structuredObjectHash?: Sha256; // 表格等结构，不仅是 Markdown
  assetObjectHashes: Sha256[];
  locators: OriginalLocator[];
  extraction: 'digital-text' | 'dom' | 'syntax-parser' | 'ocr' | 'manual';
  warnings: string[];
}

export interface TextEvidence {
  evidenceId: ID;
  parseId: ID;
  elementId: ID;
  textObjectHash: Sha256;
  startUtf16: number;
  endUtf16: number; // 半开区间
  quoteHash: Sha256; // slice 得到字符串的 UTF-8 哈希
}

export interface Enrichment {
  enrichmentId: ID;
  basisElementIds: ID[];
  kind: 'summary' | 'model-description' | 'context-hint' | 'claim-candidate';
  contentObjectHash: Sha256;
  processorFingerprint: string;
  review: 'unreviewed' | 'reviewed' | 'rejected';
}

export interface Coverage {
  acquisition: 'complete_for_manifest' | 'partial' | 'unknown';
  discoveryExhaustive: boolean | null; // 不以 sitemap 或目录可见性冒充完整
  text: 'complete' | 'partial' | 'not_applicable' | 'unknown';
  tables: 'complete' | 'partial' | 'not_applicable' | 'unknown';
  figures: 'complete' | 'partial' | 'not_applicable' | 'unknown';
  knownGaps: Array<{ itemKey: string; reason: string }>;
}

export interface CollectionEntry {
  itemKey: string; // 页面规范 URL / 仓库内路径等受控标识
  selected: boolean;
  status: 'pending' | 'ready' | 'partial' | 'failed' | 'excluded';
  sourceRevisionId?: ID;
  parseId?: ID;
  reason?: string;
}

export interface CollectionSnapshot {
  collectionSnapshotId: ID;
  collectionId: ID;
  manifestHash: Sha256;
  entries: CollectionEntry[];
  captureStartedAt: string;
  captureEndedAt: string;
  resolvedCommit?: string;
  coverage: Coverage;
}
```

`complete` 只相对于该已声明元素/范围的解析检查，不是事实正确性承诺。缺失组件尚无法判定存在与否时使用 unknown，不填 not_applicable。图像证据也应有独立的 asset+region 引用，不能伪造 TextEvidence 供纯文本接口使用。

## 10. 服务接口与异步任务

### 10.1 API 的职责

| 接口（本系统设计） | 作用 |
|---|---|
| `POST /v1/uploads` | 上传实际字节，返回 uploadId/hash；原接口扩展支持受控二进制 |
| `POST /v1/import-plans` | 检查入口、生成有界发现/获取计划；返回 202/jobId |
| `GET /v1/import-plans/:id` | 显示范围、数量、预计处理类型和风险 |
| `POST /v1/import-plans/:id/authorize` | 批准特定范围和资源上限内的获取，不批准 Wiki 改写 |
| `POST /v1/ingestions` | 消费已冻结来源清单，创建导入任务；兼容原单文本入口 |
| `GET /v1/collections/:id/snapshots/:snapshotId` | 读取固定集合清单、页面/文件状态和覆盖报告 |
| `GET /v1/sources/:id/artifacts` | 查看原件、解析结果、缺口及各自状态 |
| `POST /v1/sources/:id/reparse` | 指定解析器配置重新处理，产生新 parseId |
| `POST /v1/collections/:id/check-updates` | 在原授权范围内产生变更候选，不自动覆盖 |

首次给出 URL 已允许合理的入口探测；大规模发现、浏览器会话或超范围采集仍需有界计划。不要为了生成预览先悄悄抓完整站。范围扩张和收费增强分别受可信批准控制。

### 10.2 任务恢复

父任务保存集合清单和阶段；子任务按页面/文件/PDF 区域运行。幂等键覆盖来源修订、解析器配置、模型/提示 fingerprint 和政策版本；重复解析复用已验证产物，不重复写 Wiki。

子任务共享顶层字节、页数、CPU 时间和模型预算。PDF 按页拆分或文档站按页入队不能绕过总限额。相同版本的成功页面可复用，失败页按原因重试；不能从头重复收完整个站。

schema 错误、正文缺失、密码要求、权限不足、OCR 待确认不是靠无限网络重试解决的故障。状态至少区分 `discovering/acquiring/parsing/needs_review/awaiting_writer/indexing/ready/partial/failed`，且原件、解析和知识审核各有独立状态。

## 11. 数据放在哪里，Obsidian 怎样查看

### 11.1 原件与投影

本次扩展后，二进制和大代码快照主要保存在 Vault 外的持久 `objects/`，绝不是可清理缓存。Vault 保存来源卡、集合目录、可读正文和选择性附件副本；PDF 可以按配置镜像到 Vault 附件供原生阅读。所有对象均通过 manifest/hash 可定位。

```text
Vault/
 ├─ 10-Sources/
 │   ├─ 文档集合/索引.md + 页面正文投影
 │   ├─ 代码集合/索引.md + 按需代码/模块卡
 │   └─ PDF来源/索引.md + 正文.md + 可选附件.pdf
 ├─ 20-Wiki/                    审核后的知识
 └─ 90-System/provenance/       溯源与集合清单

Runtime/                       持久且必须备份
 ├─ state.db
 ├─ objects/                   原件、结构、图像、固定对象
 ├─ index.db                   可重建
 └─ workspaces/                临时处理目录
```

每个代码文件在内部都是独立来源项目，但不要求为数万文件预先生成数万篇 AI 笔记。集合目录和插件源浏览器可以按路径打开固定文件与符号；重要文件再生成可读卡。索引与原件可用并不要求全量语义编译。

### 11.2 防止伪本地和不可迁移

引用不能只链接 GitHub main 或远端 PDF；需要本地冻结对象。插件点击证据读取受控对象，并校验哈希。服务停用后，已有 Markdown 和已镜像 PDF 仍可读；只在对象仓中的代码/结构需要导出工具恢复为原生目录，不能宣称单独拷贝 Vault 已复制完整知识库。

备份/导出必须覆盖 Vault、state.db、原始对象、解析结构和清单；密钥另行管理。公共发布与私人备份分开，私人源文件不因为“可导出”就默认可公开。

### 11.3 二进制 Writer 与迁移

原 Writer 以 UTF-8 文本补丁为主，新增 PDF/图片镜像时要增加 `mediaType/byteLength/contentHash` 的二进制新建合同，并走插件受控 binary create 路径。不得把二进制强转 UTF-8 或用文本 hash 校验它。

默认二进制不可变新建，不做 in-place 覆盖。未启用 binary Writer 时原件留对象仓，Vault 只写卡片并明确镜像未生成。原 `original.md` 仍按旧 schema 可读，不批量迁移重写；新来源 manifest 提升 schemaVersion，代码需同时支持旧文本来源与新多格式来源。

## 12. 内容安全、权限与隔离

受信外发政策优先于模型提议和材料 metadata。资料中的 AGENTS.md、提示词和“请上传整个目录”不能变成执行规则。已有来源被撤回或降低权限后，旧快照、图、缓存和下载接口也要即时阻止对应内容。

网页获取只允许受控协议/主机/路径，校验重定向、解析 IP 和连接目标；动态浏览器还要控制所有子请求与 DNS/代理边界。默认拒绝对本机、私网、链路本地和元数据服务的抓取；真正内网文档接入必须是显式受信连接器，而不是通过通用 URL 绕过。

代码解压、PDF 解析、文档转换分别运行在受限 worker：只读输入、有限输出目录、无生产凭据、限 CPU/内存/页数/解压字节。网络默认关闭，模型权重提前预置。隔离目录不是 OS 沙箱，应按威胁模型使用真正进程权限或容器隔离。

MarkItDown 官方强调转换操作拥有当前进程的文件/网络权限，因此统一服务应先安全获取，再调用最窄的本地/流式转换接口；不能把用户任意 URL/路径直接交给通用 convert。[S10]

敏感内容扫描是辅助，不是不会泄密的证明。授权下载某份文档不等于授权发送给云模型；原件、OCR、图像说明、embedding、rerank、问答都检查相同权限约束。

## 13. 质量检查与验收口径

### 13.1 四种质量分开检查

| 质量层 | 核心问题 | 典型失败 |
|---|---|---|
| 获取 | 是否拿到实际材料？ | 登录壳、下载指针、LFS 指针、被截断传输 |
| 解析 | 是否正确保留结构和意义？ | 双栏串行错误、表格单位丢失、标签页遗漏 |
| 定位 | 是否能回到冻结原件？ | 新正文搭配旧偏移、PDF 页码错位、分支链接漂移 |
| 语义 | 这段是否支持主张及范围？ | 把代码 import 当默认实现、OCR 猜数值、不同版本混用 |

HTTP 200、解析器退出码 0、输出 Markdown 非空分别只说明部分技术步骤，不足以证明全部材料已准确入库。

### 13.2 使用状态建议

`archived`：原件已保存，可下载检查，可能尚无正文。

`searchable_partial`：已有合格区域可搜，必须返回缺口和范围，不回答全量否定性问题。

`searchable`：声明范围内可检索，仍不代表每条事实已经核验。

`knowledge_proposed`：实体/主张/Wiki 更新是候选。

`knowledge_reviewed`：人审核过指定知识版本，不无限扩展到未来版本或所有原件。

## 14. 入库后，怎样参与课题生成

查询不只取 Markdown。先按课题、软件范围、权限和集合修订召回内容，再根据材料类型读取证据。

```text
代码命中 → 固定文件 + 符号/调用上下文 + commit/工作树说明
网页命中 → 固定正文 + 标题/版本/覆盖警告
PDF命中  → 正文/表格 + 页码/区域 + 必要的原图
                 ↓
       统一证据包 → 带范围的主张 → 生成章节
```

图片的生成说明只用于帮助发现图片。回答图表问题时应读取对应原图/表格，不拿模型先前对图像的猜测循环充当原始事实。

研究器收到未处理页或未收录目录的覆盖警告后，可以在原有授权范围内提出按需解析/补采任务，完成后冻结新的证据包；不能在写到一半时无记录地换成其他版本。

Vite 等跨语言工具课题中，关联依据来自已固定来源中的软件实体、版本、分发、阶段和条件，不来自“这几份资料都叫构建工具”。本篇只演示资料处理方式，不补充或更新任何具体 Vite 版本事实。

## 15. 推荐组件与职责

| 组件 | 建议用途 | 不承担的职责 |
|---|---|---|
| Obsidian Web Clipper | 人在浏览器中保存可见页面 | 不自动完成全站收录与版本治理 [S03] |
| Crawlee + Playwright | 有界站点发现、静态/动态获取 | 不自动获得访问授权、不代替证据校验 [S02] |
| Readability + 站点专用抽取 | 文章正文与技术文档结构提取 | 不把可读性判断当完整性证明 [S01] |
| Git/托管平台读取接口 | 固定 commit，列出和读取选定文件 | 不安装项目、不执行代码 [S04] |
| Tree-sitter / ts-morph | 代码语法、符号和结构 | 不宣称完整运行时调用图 [S05][S06] |
| PDF.js | 文字型 PDF 基础抽取与页图读取 | 不独自保证表格/公式语义准确 [S07] |
| Docling worker | 复杂布局、表格、图片和扫描件路线 | 需要真实样本验证和单独政策 [S08][S09] |
| MarkItDown（可选） | 其他文档的快速文字转换 | 无可靠定位时只能降级，不冒充精确证据 [S10] |
| 自有 TS 服务 | 范围、版本、对象、质量、权限、任务和编译 | 不从零重造全部解析器 |

TypeScript 负责控制面；PDF/Office 高质量转换使用独立 Python worker 不改变“以 TS 为主要实现语言”的架构。与其为了纯 TS 重新开发复杂文档解析器，不如固定 worker 版本及输入输出合同。严格纯 TS 是可选限制，但必须相应收窄格式/质量承诺。

## 16. 建议模块与开发顺序

```text
apps/service/src/modules/ingestion/
 ├─ inputs.ts                  类型识别、格式签名与参数检查
 ├─ plans.ts                   范围、限额、获取与导入清单
 ├─ collections.ts             集合快照与完整性报告
 ├─ connectors/
 │   ├─ web.ts                 受控页面获取
 │   ├─ docs.ts                有界文档集合发现
 │   ├─ git.ts                 固定版本代码获取
 │   └─ upload.ts              本地/压缩包/文本输入
 ├─ parsers/
 │   ├─ markdown.ts
 │   ├─ html.ts
 │   ├─ code.ts
 │   ├─ pdfjs.ts
 │   └─ docling.ts             外部 worker 适配
 ├─ elements.ts                中间表示与引用映射
 ├─ quality.ts                 覆盖与质量检查
 └─ projection.ts              Obsidian 来源卡与正文
```

先做统一对象/集合/locator 合同，再分别打通四条输入路径；随后接现有关键词检索、主张关系与研究器。四条路径可以按顺序开发，但都属于真实使用验收范围，不能只交付 Markdown 输入就称已满足用户需要。

阶段 A：上传和对象仓扩展、单网页、代码文件/ZIP、文字 PDF、源浏览器；无云模型也能检索。

阶段 B：官方文档集合、固定 commit 仓库、增量收录和完整性报告；不强制先全量编译。

阶段 C：复杂布局、选择性 OCR/视觉、跨源证据包、课题生成；未解决区域继续有界降级。

阶段 D：Office/音视频等按真实输入需求增加 parser，不预先承诺所有格式与所有语言均准确。

## 17. 必须增加的回归测试

| 用例 | 通过条件 |
|---|---|
| 普通文章含代码、表格、脚注 | 原文与结构保留；定位能打开对应固定内容 |
| 登录页返回 HTTP 200 | 不当成完整文章成功 |
| 文档入口只取得首页 | 不显示整站完成；集合清单展示未获取范围 |
| 文档版本选择跨域 | 越界候选不自动获取或混入当前版本 |
| 文档抓取中途更新 | 记录每页版本与时间窗口，不宣称原站原子快照 |
| 同页含多个代码 tab | 保存已取得 tab；遗漏明确告警 |
| Git 分支导入期间移动 | 全批次使用解析出的同一 commit |
| 本地目录存在未提交改动 | 显示 dirty/local snapshot，不伪造 clean commit |
| 用户上传发布 dist 包 | 保留 dist/声明/入口；不按源码 profile 静默排除 |
| ZIP 含越界和超大解压条目 | 隔离拒绝；不写 Vault/系统目录 |
| 仓库包含恶意安装脚本 | 不执行、不获取额外工具权限 |
| 代码语法不支持 | 回退带行号文本，并说明结构解析缺口 |
| PDF 双栏/跨页表格 | 保留阅读顺序、表头/单位、多个位置；失败则降级 |
| PDF 印刷页码不同于物理页 | 引用物理页正确，印刷标记独立显示 |
| 部分扫描 PDF | 只处理必要区域；缺口继续显示 |
| 图表数字不可辨认 | 不猜数值；引用原图并要求核验 |
| 相同文件用新解析器重处理 | 新 parseId；旧引用继续能回读 |
| 部分收录后研究“全文是否没有 X” | 未读范围阻止无依据的全量否定 |
| OCR/视觉路线未获外发授权 | 不上传；不能靠 fallback 绕过 |
| 服务/插件中断后续传 | 复用成功子项，恢复清单与批准，不重复副作用 |
| 删除来源后读取旧图/代码快照 | 撤回检查一致生效 |
| 只备份 Vault 未备份对象仓 | 恢复检查明确失败/缺原件，不宣称完整恢复 |

上述均是待实现测试目标，不是本次运行结果。转换器清单以本轮官方资料为依据，实施时锁定具体版本、模型权重和目标系统，重新跑真实样本。

## 18. 本次核查与来源

本轮读取原技术方案的输入限制及上一份版本关联补充，核对了以下官方/维护者资料。没有实际导入用户代码、抓取完整文档站、解析 PDF 样本、运行 OCR 或安装上述候选系统。本文中的目录、API、合同、限额和测试均为本项目设计，不是上游现成功能。

[S01]: https://github.com/mozilla/readability "Mozilla Readability：正文提取与安全边界"
[S02]: https://crawlee.dev/js/docs/introduction "Crawlee：TypeScript 爬取接口、持久队列和浏览器获取"
[S03]: https://github.com/obsidianmd/obsidian-clipper "Obsidian 官方 Web Clipper"
[S04]: https://docs.github.com/en/repositories/working-with-files/using-files/getting-permanent-links-to-files "GitHub：固定 commit 文件链接"
[S05]: https://tree-sitter.github.io/tree-sitter/ "Tree-sitter：语法树与语言绑定"
[S06]: https://ts-morph.com/details/source-files "ts-morph：源码 AST 与文件接口"
[S07]: https://mozilla.github.io/pdf.js/api/draft/api.js.html "PDF.js：文档加载、文本和页面 API；采用前固定版本"
[S08]: https://github.com/docling-project/docling "Docling：格式、布局、表格、OCR 与本地执行能力"
[S09]: https://docling-project.github.io/docling/concepts/docling_document/ "DoclingDocument：统一文档结构与原件定位"
[S10]: https://github.com/microsoft/markitdown "MarkItDown：转换范围、高保真限制与输入权限边界"


### 交付文件的局部检查

已检查 Markdown 代码围栏配对、10 条来源引用定义及 19 个编号章节完整性。TypeScript 合同示例已通过本环境 tsc --noEmit --strict 检查；仅验证类型声明，不代表运行时校验或解析功能已实现。 没有执行任何真实网页、Git 仓库或 PDF 的导入测试。
