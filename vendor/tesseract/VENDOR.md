# 本地截图识别依赖

截图文字识别在浏览器本地运行，不从CDN加载，也不把图片发往服务端或模型。以下文件于2026年11月1日用 `npm pack` 从 npm 官方仓库取得压缩包，未执行安装脚本，只保留页面实际加载的部分。

| 文件 | 来源包 | 许可 | 字节 | SHA-256 |
| --- | --- | --- | --- | --- |
| `tesseract.esm.min.js` | `tesseract.js@7.0.0` `dist/` | Apache-2.0 | 63220 | `64871d76c75609fd5413b88a8171e2ef40deedd77d5875ba23df104b2d05eb29` |
| `worker.min.js` | `tesseract.js@7.0.0` `dist/` | Apache-2.0 | 111307 | `576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d` |
| `tesseract-core-simd-lstm.wasm.js` | `tesseract.js-core@7.0.0` | Apache-2.0 | 3899472 | `c58b46a4c796c0b8afccf77591d5b875b6896b45d402bbce8caa6f5362447b38` |
| `lang/chi_sim.traineddata.gz` | `@tesseract.js-data/chi_sim@1.0.0` `4.0.0_best_int/` | 包为MIT；数据源自Tesseract tessdata（Apache-2.0） | 1718768 | `b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c` |

许可证全文：`LICENSE-tesseract.js.md`、`LICENSE-tesseract.js-core`。

取舍：

- 只保留SIMD+LSTM引擎，并把`corePath`直接指向该文件。tesseract.js 7会在支持relaxed SIMD的浏览器上改选另一构建，直接指定文件可避免为此再带约4MB；代价是不支持WebAssembly SIMD的旧浏览器无法识别，页面会显示失败并保留原有输入。
- 中文数据选体积较小的`best_int`（1.7MB），未附英文数据；通知中的数字和少量拉丁字母由中文模型一并识别，可能出错，识别结果必须由用户对照截图修改。
