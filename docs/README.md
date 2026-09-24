# 文档导航

## 接手当前工程

仓库目前已实现工程骨架、场景 01 工作区与运行治理、场景 02 多来源资料收录，并新增场景 03 的本地检索、固定证据和问答工程接口，以及场景 04 的候选审核、Wiki 更新与恢复、场景 05 的库内课题与原文报告、场景 06 的学习目标与实际尝试、场景 07 的 TaskNotes 和 Today、场景 08 的本地约束排程与人工采用、场景 09 的 macOS 本机提醒，以及场景 10 的本地备份撤回恢复与退出；真实模型、外部日历、关机后提醒、物理清除与人工语义验收仍待完成。开发入口如下：

| 需要了解什么 | 入口 |
|---|---|
| 首次运行、代码结构、开发测试、排障恢复 | [开发者接手指南](development/onboarding.md) |
| 项目安装与常用命令 | [项目 README](../README.md) |
| 完整需求与场景划分 | [PRD](brainstorms/2026-09-21-obsidian-knowledge-and-task-center-requirements.md)、[总体技术方案](plans/2026-09-21-001-feat-overall-knowledge-task-plan.md) |
| 工作区和运行治理的实际交付 | [场景 01 实施验收](implementation/runtime-governance-validation.md) |
| 多来源收录的实际交付 | [场景 02 实施验收](implementation/multi-source-ingestion-validation.md) |
| 本地检索、证据整理、问答接口和边界 | [场景 03 使用与维护](implementation/evidence-search-answer.md)、[验收记录](implementation/evidence-search-validation.md) |
| 候选保存、Wiki 审核与写入、人工观察和恢复 | [场景 04 使用与维护](implementation/wiki-review-commit.md)、[验收记录](implementation/wiki-review-validation.md) |
| 课题、历史时点、分章报告、快照更新与审核保存 | [场景 05 使用与维护](implementation/topic-research-report.md)、[验收记录](implementation/topic-research-validation.md) |
| TaskNotes、候选创建、Today 与离线核对 | [场景 07 使用与维护](implementation/task-today-reconciliation.md)、[验收记录](implementation/task-today-validation.md) |
| 本地可用时间排程、计划采用、撤销与笔记投影 | [场景 08 使用与维护](implementation/scheduling-calendar-sync.md)、[验证记录](implementation/scheduling-calendar-sync-validation.md) |
| 本机提醒规则、投递、取消与恢复 | [场景 09 接手说明](implementation/reminder-delivery-control.md)、[验证记录](implementation/reminder-delivery-control-validation.md) |
| 来源撤回、备份集、隔离恢复、清除清单与可读退出 | [场景 10 接手说明](implementation/backup-retraction-recovery.md)、[验证记录](implementation/backup-retraction-recovery-validation.md) |
| 学习目标、续学、复习建议与版本影响 | [场景 06 使用与维护](implementation/learning-practice-review.md)、[验收记录](implementation/learning-practice-validation.md) |
| 后续每次开发需要补什么说明 | [贡献与交付约定](../CONTRIBUTING.md) |

设计方案描述目标，实施说明记录实际完成范围；两者不同的地方以明确记录的实施边界为准。下面保留早期资料包的导航和当时状态。

## 原始调研资料包

**整理日期：2026-09-21｜整理范围：本次对话的全部 12 个文件记录及尚未单独成文的学习方式讨论**

这一部分是可离线阅读的原始资料交付包。专题设计、历史版本、原始模板、参考合同和核查记录按用途归档；资料包中的模板与代码片段本身不是完整软件。后续实现位于仓库的 `apps/` 和 `packages/`，运行方式见上面的开发入口。

## 先看什么

**第一次阅读：** [整套方案总览](00-总览与阅读导航/01-整套方案总览.md) → [版本关系与阅读顺序](00-总览与阅读导航/02-版本关系与阅读顺序.md) → [v2.1 设计基线候选](01-当前设计基线/Obsidian-KB-v2.1-Audit-and-Task-Planning-2026-09-21.md)。

**准备开发：** 先核对 [需求与交付对应表](00-总览与阅读导航/03-需求与交付对应表.md)，然后按资料、研究、任务三个主题读取详细方案。旧版 E00—E14 仅是历史工作分解，不代表当前全部需求。

**先试用人工 Vault：** 原始模板保存在 [starter-vault](05-实施与模板/v1-原始实施包/obsidian-kb-delivery-2026-09-20/starter-vault/90-System/首页.md) 所在目录；复制后可在 Obsidian 打开。它没有本项目的 AI、自动排程或在线提醒功能。不要将整个资料交付包当成可直接运行的应用。

## 目录

| 目录 | 内容 |
|---|---|
| `00-总览与阅读导航/` | 本次重新梳理的总览、版本关系、需求映射。 |
| `01-当前设计基线/` | v2.1 整体审查、任务系统设计及原始任务中心包。 |
| `02-完整调研/` | 初次完整调研报告、拆分报告、50 条来源记录及原核查说明。 |
| `03-资料收录与课题研究/` | 多格式材料收录、版本关系、Vite 案例与课题生成。 |
| `04-自动收录与学习编排/` | AI SDK 文档集合自动收录与学习方法的对话整理。 |
| `05-实施与模板/` | 新版任务中心起步清单；展开保留的 v1 实施包、模板 Vault、TS/SQL/配置和测试夹具。 |
| `06-来源索引/` | 历次来源入口去重汇总，保留每个入口出自哪份文档。 |
| `90-历史版本/` | v1 技术/落地/任务计划，以及 v2 审查草稿。 |
| `99-交付核验/` | 原始文件与 ZIP 成员映射、文件清单、SHA-256、包级检查记录。 |

## 版本与能力边界

最新的设计候选是 **v2.1（2026-09-21）**。它优先解释本轮已调整的范围、任务数据权威、计划和提醒；尚未冲突的证据、存储、安全与恢复细节继续参考相应专题/原技术方案。收录本包不等于用户已批准实施所有建议。

本次只整理既有成果，没有重新检索或更新第三方项目的版本、功能、价格与许可证。原文保留其形成日期，不能把旧文件日期改成整理日期后冒充重新验证。

前三个原始 ZIP 均已展开，全部成员文件原样保留；无需层层解压。ZIP 容器字节本身不重复嵌入。独立交付过的 Markdown 和包内副本可能重复，这是为了保留原始交付关系；它们的位置与哈希见 [原始交付对照](99-交付核验/原始交付对照.md)。

新增导航与学习整理不重写原始方案；原始方案及 ZIP 成员按字节保存。原文中的历史核查通过记录仅属于当时说明的范围，不是本次再次执行的系统测试。

## 原始资料整理时的未完成项

本节描述原始资料整理时的状态，不代表当前工程进度。当时没有现成 Knowledge Bridge/计划服务代码、编译产物、真实全站归档或完整上游源码，TaskNotes 集成、模型效果、手机提醒、跨端同步、真实来源解析仍待开发。原始配置、TS/SQL 示例和虚构用例是参考材料。后续已完成的工作区治理和真实来源解析见上方场景验收记录；TaskNotes 当前进度见上方场景 07；真实模型与提醒仍待验收。

未安装插件，未读取或修改真实日历/待办，未创建提醒，未上传回持久 Library。
