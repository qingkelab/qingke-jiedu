# 青稞解读 · 浏览器版（本目录即静态站点）

这一版把整个应用搬进浏览器：**不需要 Node 后端**，直接部署到 GitHub Pages。

- **API key 在页面上输入，只存内存**：刷新/关闭页面即失效，不写入 localStorage / Cookie / IndexedDB。
- LLM 请求从浏览器**直连**你配置的服务商（DeepSeek / OpenAI / 任意 OpenAI 兼容端点），不经过第三方服务器。
- PDF 转图用 [pdf.js]（CDN），网页正文用 [Readability]，深度解读完整复用仓库 `src/deepread` 的结构化管线（`web/index.html` 里的 import map 把 `jsdom` / `node:path` 等 Node 依赖垫成浏览器实现）。

## 功能对照（浏览器版 vs Node 版）

| 功能 | 浏览器版 | Node 版 |
| --- | --- | --- |
| PDF 转图（链接 / 上传） | ✅ pdf.js | ✅ pdf.js |
| 网页转图（整页截图） | ❌（无无头 Chrome，降级为抽正文出文案） | ✅ puppeteer |
| 解读文案 + 爆款标题 | ✅ | ✅ |
| 论文深度解读（arXiv） | ✅（同一套结构化管线） | ✅ |
| 最新论文搜索 | ✅（需 CORS 代理） | ✅ |
| 公众号凭证同步 | ❌（降级为复制 + 打开后台） | ✅ |
| 论文播客视频 | ❌（需要 TTS / ffmpeg） | ✅ |
| Ollama 本地模型 | ❌（浏览器跨域受限，可自行挂代理） | ✅ |

## 跨域（CORS）说明

- arXiv 的 PDF 与 HTML 全文页**带 `Access-Control-Allow-Origin: *`，可直连**；
- arXiv 搜索 API（export.arxiv.org）与绝大多数网页**不放 CORS**，需要在页面「接口设置」里填一个 CORS 代理
  （格式：`https://corsproxy.io/?url=` 或任何含 `{url}` 占位符的代理地址）。代理只转发公开网页，与 API key 无关。

## 本地预览

```bash
cd link2post
python3 -m http.server 8080   # 或 npx serve .
# 打开 http://127.0.0.1:8080/web/
```

## 部署

GitHub 仓库 → Settings → Pages → Build and deployment 选 **Deploy from a branch**，
Branch 选 `main` / 目录选 **`/ (root)`**。站点地址为 `https://<owner>.github.io/<repo>/web/`
（仓库根目录的 `index.html` 会自动跳转过去）。
