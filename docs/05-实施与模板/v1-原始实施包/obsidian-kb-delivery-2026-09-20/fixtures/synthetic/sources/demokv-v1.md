---
fixture: true
source_key: demokv-v1
source_role: simulated_primary
version: "1"
---
# DemoKV v1 配置（虚构）

本文件完全是合成测试资料。DemoKV 不是本文声称存在的实际产品。

在 DemoKV 1.x 中，默认请求超时为 500 毫秒。配置名为 requestTimeoutMs。

1.x 的权限检查发生在执行写入之前。未授权写入返回 DEMO_FORBIDDEN。
