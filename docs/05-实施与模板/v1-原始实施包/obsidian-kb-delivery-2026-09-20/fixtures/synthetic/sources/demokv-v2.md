---
fixture: true
source_key: demokv-v2
source_role: simulated_primary
version: "2"
---
# DemoKV v2 配置（虚构）

本文件完全是合成测试资料。只描述虚构的 DemoKV 2.x。

在 DemoKV 2.x 中，默认请求超时改为 800 毫秒。配置名仍为 requestTimeoutMs。

超时不代表写入肯定失败；客户端需要查询同一个 operationId 的操作状态。本资料没有给出吞吐量或恢复耗时测试。
