# 场景 06：实施与验收记录

日期：2026-09-22。使用与接手入口见[学习、尝试与复习说明](learning-practice-review.md)。方案仍区分已实现的本地流程与依赖场景 07 的真实任务、Today 集成。

## 已交付

- 固定目标、单元及叶子验收项；参考库与显式学习选择分开，不按资料页数建立任务。
- 原始尝试、提示层级、产物引用、自报和遗留问题；人工、程序、模型评价分别登记。
- 继续学习时回到固定资料和原始尝试；撤回资料隐藏关联正文，保留时间、类型与身份。
- 可配置、每次最多 3 项的复习建议；选择持久保存，未知创建不重发。
- SQLite 事务容量预留与受信任务接口；并发、超时、重启、时区边界的工程验证。
- 历史基线不清零，取消不删分母，新版本实质差异由人确认补学。
- schema 6 私有备份及迁移，README、接手说明、流程和架构图。

## 自动化验证

在仓库根目录执行。首次专项发现测试使用了错误的来源政策样例和中文错误文本断言；修正为实际合同及错误代码后，学习、迁移和界面 15 项专项通过。

顺序审查中为以下问题先补失败用例，再修复并确认通过：关闭容量后换时区绕过记录、创建尚未返回时提前核对释放预留、同一时刻跨尝试评价的顺序，以及确认响应丢失后更换操作编号重复建目标。修复后的相关 11 项专项通过。最后由桌面测试复现旧输入框在刷新期间仍可编辑的问题，补失败断言后禁用在途输入，界面与版本回归 3 项通过。

```bash
pnpm check
pnpm typecheck
pnpm lint
KB_TEST_OCI=1 KB_TEST_BUILT=1 pnpm test
pnpm test:desktop
```

第一轮 `pnpm check`：类型检查、lint 通过；常规 117 项通过、5 项环境专项跳过；编译后服务 2 项通过。最终代码再次通过类型检查和 lint，开启 OCI 与编译后进程的回归为 **121 项通过、2 项跳过**，45 个测试文件通过、1 个文件跳过，耗时 38.55 秒。

两项跳过是未启用的真实语料测试。本轮没有改解析器，也没有重跑 `KB_TEST_CORPUS`；场景 04 的历史真实语料问题继续保留，不能被本轮成功覆盖。

| 测试 | 受测结果 |
|---|---|
| `learning-scope.test.ts` | 正式归档 100 份资料仍只有选定两单元；无自动任务／尝试／掌握；取消不改总权重，删叶子项被拒绝 |
| `learning-resume.test.ts` | 真实 HTTP 与 Connection 保存、重试去重、首次与继续；提示及遗留保留；伪造程序来源被拒绝；撤回后原始正文不返回 |
| 同上 | 自报和模型评分不计通过；模型缺少身份信息被拒绝；受信检查与人工评价分开；同一时刻最新登记结果生效 |
| `review-capacity.test.ts` | 缺设置／适配器零预留；跳过不反复生成；并发共享额度；未知结果重启不重发；明确未创建释放，超时保留 |
| 同上 | 外部已观察任务占 WIP；不完整观察阻断；自然日按时区；关闭后换时区和在途核对的回归 |
| `learning-version-impact.test.ts` | 新基线增加分母并单列新增项，旧通过仍可读；版本不匹配不补学，匹配且原文变化仅给候选，显式确认仍不建任务 |
| `source-migration.test.ts` | 旧 schema 升到 6，研究数据保留；v5 备份权限 0600、内容仍为 v5，新库重开可写 |
| `learning.test.ts` | 草案异步旧响应不能恢复确认；不可信标题按文本展示；响应丢失重试使用同一操作编号 |

版本影响测试使用正式提交的测试原文，再在测试账本中关联第二修订以控制变化，不是对外网站点的更新测试。TaskNotes 测试适配器不代表真实插件契约验证。

## 桌面验证

首轮真实 Obsidian 1.13.7 桌面完成 25 项检查，页面错误 0。之后改善评价文字并复测，复用的测试库出现同名目标，脚本精确定位匹配两项而失败；改用本轮唯一测试名称后通过。之后补充旧尝试的明确目标版本时，复测暴露刷新期间旧输入仍可编辑，人工评价在返回前被清空，因此未登记评价、通过权重仍为 0。修复请求期间的控件禁用后再次复测，最终结果见下段。

最终桌面 **25 项通过，页面错误 0**。学习部分覆盖确认固定基线、选择当前单元、首次开始、保存实际表达及提示、中断后继续、保留遗留问题、人工评价与自报分开，以及没有规则时不自动产生任务。此流程使用本地设置页，没有调用 TaskNotes 或真实模型。

证据：[学习恢复截图](evidence/learning-resume.png)、[桌面检查清单](evidence/learning-desktop-checks.json)。完整审查及修复见[顺序审查记录](../../.context/compound-engineering/ce-review/2026-09-22-learning/review.md)；依仓库工具映射在主线程完成，不是独立子 agent 审核。

## 尚未验收

TaskNotes 的真实 ID 保留、上游最终未创建证明、跨应用并发及 Today 入口尚未实现，属于场景 07 的 T1—T3。当前没有真实模型评分、自动检查器、自动提示／笔记生成、自动命令执行、提醒或排程。本轮证明本地记录与服务预留边界，不宣称学习效果或完整 A41 已通过。

## Post-Deploy Monitoring & Validation

负责人：隔离试点的主端操作者。窗口：升级后的首次目标、首次尝试、首次新基线，以及前 10 次复习建议／任务创建意图。当前 CLI 没有任务适配器，正常情况下 `learning_task_intents` 为空。

```sql
PRAGMA user_version;
PRAGMA integrity_check;
SELECT count(*) FROM learning_baselines;
SELECT goal_id,baseline_id,count(*) FROM learning_attempts GROUP BY goal_id,baseline_id;
SELECT json_extract(value,'$.origin') AS origin,count(*) FROM learning_evaluations GROUP BY origin;
SELECT json_extract(value,'$.state') AS state,count(*) FROM learning_task_intents GROUP BY state;
SELECT json_extract(value,'$.day') AS day,json_extract(value,'$.state') AS state,sum(json_extract(value,'$.minutes')) FROM learning_task_intents GROUP BY day,state;
SELECT kind,count(*) FROM events WHERE kind LIKE 'learning.%' GROUP BY kind;
```

健康信号：schema 6、完整性 `ok`；尝试绑定固定基线，用户自报不生成程序评价；无适配器时建议不会进入 creating/created；未知意图仍占预留；权限撤回后正文不可读取，重新打开旧基线仍能看到身份及历史口径。

出现无尝试却增加通过权重、取消删分母、未经选择创建任务、未知请求重复派发、时区重置额度或撤回后仍显示旧正文时，停止新学习写入／任务创建，保留 SQLite、Vault 和复现时间。不要删除意图、评价或基线来修复界面。迁移前备份只能在独立副本核对，不能覆盖升级后的研究、来源与费用。
