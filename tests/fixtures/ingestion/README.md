# PDF 兼容性样本

文件取自 Mozilla PDF.js 的 `test/pdfs`，固定提交与逐文件 SHA-256 见 `pdf-provenance.json`。这些是上游真实 PDF，不是用纯文本伪装的扩展名。

- `basicapi.pdf`：可提取文字与位置。
- `labelled_pages.pdf`：物理页与印刷标签不一致，空白页标签仍保留。
- `encrypted-attachment.pdf`：无密码与临时密码的区别；上游测试密码为 `000000`，仅用于这份公开样本。
- `empty_protected.pdf`：有保护但可无密码读取的空页，不能误判为密码错误。
- `images.pdf`、`scan-bad.pdf`：图像与扫描混合资料，文字提取不能替代图像理解。
- `rotation.pdf`、`bad-PageLabels.pdf`：旋转与异常标签。
- `tracemonkey.pdf`：真实多页技术论文，包含复杂版式与表格。

PDF.js 仓库许可证保留在 `LICENSE.pdfjs.txt`。每份原件内部的原作者与版权声明保持不变。测试不执行 PDF 脚本、不获取嵌入附件，也不启用 OCR。
