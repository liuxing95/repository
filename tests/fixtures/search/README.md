# 检索评测资料

这里固定保存仓库提交 `bacff36` 中的 7 份真实文档与源码，原路径、提交和 SHA-256 在 `provenance.json`。`questions.json` 是围绕该版本接手和维护操作整理的 20 个固定问题：17 个可回答、3 个库外问题。预期来源家族按文件人工编写，运行时不由模型打分。

这是一套范围有限的工程检索基线。它不代表开放领域问答，也不替代方案要求的人工重要主张支持率验收。当前只有 7 个来源家族，Recall@10 很容易受候选集合规模影响，必须与规模更大的真实库和后续约 80 题一起评估升级。新增问题应追加版本记录，不根据失败结果删除难题。

运行：`pnpm exec vitest run tests/evaluation/retrieval-comparison.test.ts`。报告输出到忽略提交的 `.context/runtime-validation/search-evaluation.json`，正式验收时将对应结果复制到 `docs/implementation/evidence/`。
