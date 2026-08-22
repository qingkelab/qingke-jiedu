# 链接转图文 · link2post

输入一篇 **论文 PDF 链接** 或 **任意网页链接**，一键生成：

1. 📄 **内容图片** —— PDF 逐页转 PNG / 网页全页截图（长页自动分段），可逐张下载、可打包 ZIP；
2. 📝 **解读文案** —— 面向公众号读者，**≤1000 字**，Markdown 结构化（小节标题 / 加粗 / 列表 / 引用），前端格式化渲染，支持「预览 / 源码」切换与纯文本复制；
3. 🔥 **爆款标题** —— 适合公众号传播，**≤20 字**（主标题 + 2 条备选）。

```
链接 → 抓取(PDF/HTML) → 转图 → 抽取正文 → AI 生成文案+标题 → 落盘 → 前端展示/下载
```

## 快速开始

环境要求：Node.js ≥ 20、macOS（网页截图默认用系统 Chrome）。

```bash
cd link2post
npm install --cache "$PWD/.npm-cache"   # 若全局 npm 缓存有权限问题，用本地缓存
npm start                                # 或 npm run dev（热重载）
# 浏览器打开 http://127.0.0.1:4780
```

> 网页截图依赖系统 Chrome，默认路径为
> `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，可用环境变量
> `CHROME_PATH` 覆盖。

## 配置文案模型（DeepSeek / OpenAI）

文案生成必须配置真实模型；未配置 key 时，处理会**明确报错**并提示（不再生成示例文案）。
复制 `.env.example` 为 `.env` 并填写：

```bash
cp .env.example .env

# DeepSeek（默认，OpenAI 兼容）
echo 'LLM_PROVIDER=deepseek' >> .env
echo 'DEEPSEEK_API_KEY=sk-xxx' >> .env

# 或任意 OpenAI-compatible 端点
# LLM_PROVIDER=openai
# OPENAI_BASE_URL=https://api.openai.com/v1
# OPENAI_API_KEY=sk-xxx
# OPENAI_MODEL=gpt-4o-mini
```

Provider 接口统一为 `generate({ source, limits }) => { title, titles, copy }`，
新增模型只需在 `src/ai/index.js` 的 `createProvider()` 里加一个分支。

## 目录结构

```
link2post/
├── server.js                 # Express 入口 + 静态/下载/处理路由
├── src/
│   ├── config.js             # 环境变量与默认配置
│   ├── fetchSource.js        # 下载并识别 PDF / 网页
│   ├── pdfjs.js              # pdfjs-dist 单例（Node 端 fake worker）
│   ├── pdfToImages.js        # PDF→PNG 渲染 + 正文/元数据抽取
│   ├── webToImages.js        # 网页→全页截图（分段），复用系统 Chrome
│   ├── extractText.js        # Readability 正文抽取（标题/作者/摘要）
│   ├── arxiv.js              # arXiv API 精确标题/作者
│   ├── textUtils.js          # 字数统计 / 按字符截断
│   ├── ai/
│   │   ├── index.js          # createProvider 工厂
│   │   └── openaiProvider.js # DeepSeek/OpenAI 兼容引擎
│   ├── pipeline.js           # 主流程编排
│   └── store.js              # 落盘 + ZIP/Markdown 打包
├── public/                   # 前端（index.html / app.js / style.css）
├── output/                   # 每次生成结果（id/001.png … images.zip summary.md）
└── .env.example
```

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/process` | `{"url":"…"}` → 返回完整结果（图片列表、文案、标题、下载地址） |
| GET | `/files/:id/:filename` | 内联访问生成的图片 / ZIP / Markdown |
| GET | `/download/:id/:filename` | 强制下载（`Content-Disposition: attachment`） |
| GET | `/api/health` | 健康检查（当前文案引擎） |
| POST | `/api/sync/wechat` | `{"id":"…"}` → 有凭证自动存公众号草稿，无凭证返回降级信息 |

## 同步发布（公众号贴图 / X）

参考 [doocs/cose](https://github.com/doocs/cose) 与「爱贝壳内容同步助手」的「打开编辑器 → 自动填充」思路。

- **公众号（贴图）**：配置 `WECHAT_APP_ID` + `WECHAT_APP_SECRET`（认证服务号）后，点「同步到公众号」会把
  选中的图片上传为永久素材，并用 `draft/add` 的 **`article_type: "newspic"`**（图片消息，即「贴图」）
  新建草稿——首图为封面、最多 20 张，标题为生成的爆款标题、正文为解读文案纯文本。未配置凭证时降级为
  **打包下载图片 + 打开公众号后台**，手动上传。
- **X**：点「同步到 X」打开 `twitter.com/intent/tweet` 发帖框并**预填标题**（无凭证可用）；
  图片需手动附图。长文同步到 X Articles 需走 X API 或浏览器自动化，暂未内置。

## 关键设计点

- **约束兜底 + 完整收尾**：标题用 `truncateTitle` 压到 `MAX_TITLE_CHARS`（20）并按词边界截断、
  超长时自动重写。文案通过三层保证「≤ `MAX_COPY_CHARS`（1000）且完整」：① 提示词强制按预算成稿、
  以结论收尾；② 超预算时自动做一次**压缩重试**（保留全部小节与结论）；③ 最后用 `truncateAtSentence`
  按**句边界**兜底，绝不截在词/句中间。前端按「不含空白的字符数」展示字数。
- **文案格式化**：文案统一用 Markdown 输出（`##` 小节、`**加粗**`、`-` 列表、`>` 引用），
  前端用内置的极简渲染器转成富文本（先 HTML 转义防 XSS），并提供「预览 / Markdown 源码」
  切换；「复制文案」自动剥离 Markdown 符号，得到可直接粘贴的纯文本。
- **PDF 渲染**：`pdfjs-dist`（legacy 构建）+ `@napi-rs/canvas` 纯 JS 栅格化，无系统依赖；
  `MAX_PDF_PAGES` 限制最多转图页数，`PDF_SCALE` 控制清晰度。
- **网页渲染**：`puppeteer-core` 直连系统 Chrome，`WEB_SEGMENT_HEIGHT` 把超长页切段，
  规避 Chrome 单图超高纹理上限。
- **文案引擎可插拔**：DeepSeek / OpenAI 共用同一接口，`LLM_PROVIDER` 一键切换。
- **机构与时效**：自动抽取「机构」与「发表时间」——arXiv 走 API 拿发布时间、PDF 首页抓机构名、
  网页读 meta/正文日期；提示词要求文案自然交代「XX 机构在 YYYY 年提出…」，信息缺失时不硬编。
- **解读方法论（参考 [paper-deep-reader-skill](https://github.com/Linwei-Chen/paper-deep-reader-skill)）**：
  文案采用「零背景可进入 + 技术足够硬」的双层讲解法——术语首次出现即白话解释、用一个最小
  例子走通机制、Before/After/Diff 最小差分、具体数字支撑并区分「作者主张 / 直接证据 / 推断」、
  证据强度分级、边界从论文具体缺口推出。已在模型提示词中落地。

## 部署到 Render / Railway（在线可访问）

GitHub Pages **不能**运行本应用（纯静态，无 Node / 无头 Chrome）。要在线运行，用连 GitHub 的
PaaS 即可，仓库里已备好 `Dockerfile`（Node 22 + Google Chrome + 中文字体）。

### Render（推荐，免费档）

1. 把代码推到 GitHub（见下方「推送到 GitHub」）。
2. 打开 [render.com](https://render.com) → New → **Blueprint**，选择该仓库（会用 `render.yaml` 自动配置）；
   或 New → **Web Service** → 选择仓库，Runtime 选 **Docker**。
3. 环境变量：`LLM_PROVIDER=deepseek`（默认）+ `DEEPSEEK_API_KEY`（部署后在 Render 面板填写，未填时文案生成会报错）；
   `CHROME_PATH` 已由镜像设好，无需改动。
4. 部署完成后得到 `https://xxx.onrender.com` 公网地址。

> 免费档无流量会休眠（首次访问冷启动约 30–50s），磁盘为临时盘：重启/重新部署后
> `output/` 里已生成的结果会被清空，属正常现象。

### Railway

1. 推代码到 GitHub 后，在 [railway.app](https://railway.app) 新建项目 → **Deploy from GitHub**。
2. Railway 会自动识别仓库根目录的 `Dockerfile` 并构建上线，同样返回公网地址。

### GitHub Actions（CI）

`.github/workflows/deploy.yml` 会在每次 push / PR 时用 `docker build` 校验镜像能否构建成功。
部署本身走 Render/Railway 的「Auto Deploy」即可；如需用 Actions 手动触发 Render 部署，
在仓库 Secrets 添加 `RENDER_DEPLOY_HOOK` 并取消工作流末尾注释。

### 推送到 GitHub

```bash
cd link2post
git init
git add .
git commit -m "link2post: 论文/网页 → 图片 + 解读 + 爆款标题"
git branch -M main
git remote add origin https://github.com/<你的用户名>/link2post.git
git push -u origin main
```

## 局限与后续

- 部分站点有反爬（如需要登录、Cloudflare 校验）会抓取失败；网页截图对动态渲染页面
  依赖 `networkidle2`，个别懒加载内容可能未展开。
- 文案生成依赖真实模型（需配置 `DEEPSEEK_API_KEY` 或 `OPENAI_API_KEY`）；未配置时接口会报错。
  标题与解读质量取决于模型与正文抽取质量。
- 可扩展点：任务队列 + SSE 进度、历史记录、PDF 图表智能裁剪、多链接批量处理。
