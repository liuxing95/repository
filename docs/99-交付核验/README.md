# 交付核验说明

`original-artifacts.json` 记录本次对话的 12 个原交付记录；9 份独立 Markdown 与 3 个 ZIP 的全部 54 个成员按原始字节保留，分别记录映射、大小及 SHA-256。原 ZIP 容器字节不重复嵌入。

`manifest.json` 记录本合集全部载荷文件的路径、大小、SHA-256；仅排除自身与 `SHA256SUMS`，避免循环计算。`SHA256SUMS` 还记录 manifest 的哈希，仅不记录自身。

`packaging-checks.json` 和 `VALIDATION.md` 记录本次实际执行的整理检查。历史包中的检查结果按原样保留；没有在本次重新执行旧 Python、TypeScript、SQL、插件、模型或服务测试。

解压到一个空目录后，可以用 Python 3 运行：

```bash
python3 99-交付核验/verify_package.py
```

运行位置应为合集根目录；脚本只读文件并核对清单，不安装依赖、不联网、不运行原始包中的代码、不修改用户文件。用户自行修改模板或笔记后，原始 hash 检查会提示变更，这是预期结果。

这些 hash 可检测相对于清单的内容变化，不是发布者数字签名。ZIP 的外层 SHA-256 另存于下载 ZIP 旁的 `.sha256` 文件。

本轮检查的是资料交付完整性，不是知识库已经运行或已经通过生产验收。
