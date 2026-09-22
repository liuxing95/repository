// No third-party SDK is loaded in the service or given credentials. Adoption is an explicit gate.
export function compilerStatus() {
  return {
    selected: "native-evidence-page-v1",
    modelEnabled: false,
    externalRequests: 0,
    sdk: {
      enabled: false,
      inspectedCommit: "946451a3995e4a384a010acdbc5da3226c1df328",
      reason:
        "尚未通过本系统逐调用预算代理、固定引用与 OCI 隔离契约；不加载 SDK 或授予真实密钥。",
    },
    limits: { pages: 1, claims: 20, bytes: 128000 },
    message: "本地编排已有证据候选；真实模型提取与页面生成尚未启用。",
  };
}
