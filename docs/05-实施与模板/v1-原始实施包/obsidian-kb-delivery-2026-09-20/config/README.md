# 配置模板说明

`service.example.json` 是本方案设计的服务初始化输入，不是 Obsidian 原生配置，也不是某个上游插件的配置。当前包没有服务读取它。

`initialized=false`、`vaultId=null`、`runtimeRoot=null` 是有意的初始化状态，**正式服务启动必须拒绝未初始化配置**。未来 `init` 生成身份、规范化运行路径并设置 initialized；不能将 null 替换为随意字符串后绕过检查。

默认模型、编译器、所有写入、自动抓取、自动备份均关闭。M1 通过 Writer 验证后，由管理端同时开启 writes.enabled 与 allowSourceImports；M2 审核测试后才开启 allowWikiChanges。每次写入仍需要固定清单批准。

启用收费模型时设置确切 routeId/模型/凭据引用/价格表，由管理端确认预算；密钥不能写入本文件、Vault 或 Git。示例预算不是用户已同意费用。Asia/Singapore 是本方案的预算日/月切分时区，可由管理端改变并记录生效时间，不能在结算中途静默切换。

compiler.adapter 必须在 E00 后明确选择 atomic 或 native。目录映射、policy 与 route 配置需由 E01/E03 的 runtime schema 校验；所有开关均为 fail-closed。
