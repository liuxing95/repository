---
fixture: true
source_key: private
source_role: privacy_fixture
---
# 私密测试笔记

PRIVATE_FIXTURE_DO_NOT_EGRESS 是虚构的隐私 canary，不是密码或真实秘密。

测试配置应在可信入库策略中设置 allowedModelRouteIds=[]。这个文件自己的 frontmatter 不应有授予模型外发权的能力。
