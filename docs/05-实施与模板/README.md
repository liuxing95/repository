# 实施材料与模板

## 当前起步材料

先读 [任务中心起步清单](Obsidian-KB-Task-Center-Rollout-2026-09-21.md)，配合 [v2.1 设计](../01-当前设计基线/Obsidian-KB-v2.1-Audit-and-Task-Planning-2026-09-21.md)。W01—W12 覆盖任务中心新增工作，不等于整套系统的所有代码都已设计/实现。

## 原始实施包（v1 参考，不是当前完整工程）

原 ZIP 的 42 个成员保持布局、名称与字节：

- [原包阅读说明](v1-原始实施包/obsidian-kb-delivery-2026-09-20/00-阅读与执行顺序.md)
- [starter-vault 首页](v1-原始实施包/obsidian-kb-delivery-2026-09-20/starter-vault/90-System/首页.md)
- [TypeScript 合同](v1-原始实施包/obsidian-kb-delivery-2026-09-20/references/contracts.ts)
- [state DDL 草案](v1-原始实施包/obsidian-kb-delivery-2026-09-20/references/001-state.sql)
- [索引 DDL 草案](v1-原始实施包/obsidian-kb-delivery-2026-09-20/references/002-index.sql)
- [旧服务配置示例](v1-原始实施包/obsidian-kb-delivery-2026-09-20/config/service.example.json)
- [虚构测试资料说明](v1-原始实施包/obsidian-kb-delivery-2026-09-20/fixtures/synthetic/README.md)

原包还含来源登记表、模型路线登记表、上线验收表、决策/概念/系统/比较/审核模板、局部检查脚本与历史结果。全部保留以便追溯。

**使用前的四点限制：**

1. 旧版仅 MD/TXT 的验收范围已不足，应按当前多来源设计迁移合同；不能直接运行旧检查后宣布 v2.1 通过。
2. 复制 starter-vault 可以开始人工阅读与笔记，不会自动安装 TaskNotes 或 Knowledge Bridge。
3. 配置和目录中的示例字段、假任务、虚构来源均不代表用户已授权、已导入或已安排。
4. 旧检查脚本是随原包保留的参考，未在本次重新执行；不自动运行其中任何代码，不把检查结果当生产测试。

整份合集只提供设计、历史示例和模板。没有 pnpm 可直接启动的完整应用，也不含私密凭据、模型权重和第三方插件二进制。
