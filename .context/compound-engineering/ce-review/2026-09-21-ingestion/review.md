# 场景 02 代码审核

模式：`ce:review mode:autofix base:cdc4e73 plan:docs/plans/2026-09-21-003-feat-multi-source-ingestion-plan.md`。

按当前 AGENTS.md 的 Task/Subagent 映射，审核在主线程按不同视角串行进行，没有启动独立审核 agent，也没有以跨 agent 一致性提高置信度。范围包括新增文件、实际构建产物行为与既有治理接口改动。

意图：在场景 01 之上完成有界资料取得、固定原件和解析、来源提交与恢复；不接入搜索生成、Wiki 更新或收费 OCR。

覆盖视角：正确性、测试、可维护性、项目标准、接口可用性、已知经验、安全、性能、API 合同、迁移、可靠性、对抗输入、TypeScript 和前端竞态。没有已存在 PR，因此不检查 PR 历史评论。仓库没有 docs/solutions，沿用场景 01 的固定幂等命令、主端围栏和只读未知 schema 经验。

## 已修复的问题

| 严重度 | 文件 | 问题与修复 | 验证 |
|---|---|---|---|
| P1 | ingestion/manifest.ts | 复制期间变化的文件不得把暂存旧字节作为成功重试；保留 SNAPSHOT_CHANGED，要求新预览 | ingestion-manifest |
| P1 | ingestion/manifest.ts | 过期重试上限或其他入口取消作业后，批次不能永远显示运行中；读状态时协调为可重试／取消 | ingestion-manifest |
| P1 | ingestion/commit.ts | 回读解析必须检查正文哈希、块区间与片段哈希；撤回立即阻断原件与解析 | ingestion-commit |
| P1 | ingestion/routes.ts | 解析失败不能让原件失去取回入口；按批次条目提供原件读取，并沿用撤回门禁 | ingestion-commit |
| P1 | ingestion/manifest.ts | 耗时／RSS 不应改变解析身份；从指纹剔除采样指标 | 重复收录不增加解析测试 |
| P1 | ingestion/repository.ts | 本地 .git 外部 worktree／alternates 不属于目录授权；保留普通目录快照，不沿外部元数据读取 | 边界审查、代码快照回归 |
| P2 | views/ingestion.ts | 独立“重新获取”入口创建新 acquisition ID；普通重试复用旧 ID | 桌面流程、冻结清单测试 |
| P2 | storage/store.ts | schema 1 备份包含私密账本，显式设为 0600 | source-migration |
| P2 | writer/apply.ts | 缺少受管根时只能经插件创建固定来源目录；人工文件冲突不覆盖 | 真实 Obsidian 新建与编辑缓冲保护 |
| P2 | connection.ts | 临时 PDF 密码不进入客户端持久幂等键或服务 commands | 密码不落账本测试 |

## 需求核对

- I1 / R005—R010、R013—R015：已实现。身份与字节去重、冻结分母、部分失败恢复、新清单与本轮未发现记录均有覆盖。
- I2 / R011—R012、R084：已实现。7 个真实 HTTPS 页面、登录墙／脚本／表格静态测试、DNS 多地址拒绝和 ZIP／路径负例。
- I3 / R016—R021：已实现基础路线。实际 GitHub HEAD 固定提交、脏本地目录、产物、LFS／子模块说明、真实 PDF 页码／临时密码／缺口。OCR 是计划中的关闭路线。
- I4 / R007—R010：已实现来源新建提交。真实编辑缓冲区、半写、丢回执、坏哈希、取消、过期授权、重解析原件复用。场景 04 的完整 Wiki 更新 Writer 不在本次完成声明内。
- 30 份真实样本已通过；字符损失与表格结构无法定量确认的地方明确记为未知，不用零替换字符代替正确率。

## 迁移与部署

schema 2 与迁移 SQL 一致，无意外 schema 对象。schema 1 完整备份后事务升级；未知结构只读。正式检索只可消费 committed 来源，当前没有宣称索引已构建。

首批 10 个作业核对 `source.approved`、`source.committed`、`source.index_requested` 与文件回执；异常时停止收录并保留数据库，不自动拿旧备份覆盖新数据。具体 SQL 和负责人见实施验收记录。

## 覆盖与限制

50 项全量测试无跳过；真实 Obsidian 1.13.7 页面错误为零。实际解析器 OS profile 测试证明受限目录、文件写入、子进程和网络均被阻止。之前的调试配置留下的 macOS UE 记录及一次既有 worker 测试轮询超时如实写入验收文档。

解析支持平台仅 macOS。PDF 图表／布局、浏览器脚本、远端 OCR、真正的搜索索引均未启用；这是本轮明确边界。原件与解析是正式事实对象，不得只备份 Vault 而丢弃服务账本。

结论：修复验证后可用于隔离试点。无未解决的本场景代码问题；GitHub CLI 未认证，PR 发布状态另行报告。
