# 青稞解读 · QingKe JieDu

输入一篇 **论文 PDF 链接** 或 **任意网页链接**，一键生成内容并发布到多平台：

1. 📄 **内容图片** —— PDF 逐页转 PNG / 网页全页截图（长页自动分段），可逐张下载、可打包 ZIP；
2. 📝 **解读文案** —— 面向公众号读者，**≤1000 字**，Markdown 结构化（小节标题 / 加粗 / 列表 / 引用 / 表格），前端格式化渲染，支持「预览 / 源码」切换与纯文本复制；
3. 🔥 **爆款标题** —— 适合公众号传播，**≤20 字**（主标题 + 2 条备选）；
4. 📖 **论文深度解读** —— 读 arXiv 论文 HTML 版，图片以 CDN 嵌入，按「零背景可进入」六部分生成 Markdown 图文报告；
5. 📤 **多平台同步** —— 一键同步到多个公众号（贴图/文章，按账号配色）与 X。

```
阶段一（不依赖模型）  链接 → 抓取(PDF/HTML) → 转图 + 抽取正文 → 落盘 → 立即展示/下载
阶段二（依赖模型）    已落盘的正文 → AI 生成文案/标题 → 回写 → 展示/复制 → 同步发布
```

两个阶段是**两个独立接口**（`/api/images`、`/api/copy`）：模型没配 key、超时、报错，
都只影响「解读文案」那一块，**图片 / ZIP / summary.md 照常生成和下载**，页面上一键重试即可补上文案。
侧边栏还提供「只转图，不生成文案」开关：勾上后完全不调用模型，只出图片（省时间、省 token）。

## 快速开始

环境要求：Node.js ≥ 20、macOS（网页截图默认用系统 Chrome）。

```bash
cd link2post
npm install --cache "$PWD/.npm-cache"   # 若全局 npm 缓存有权限问题，用本地缓存
npm test                                 # 跑测试（切片 / 检索 / 地图 / 审计 / 降级 / provider）
npm start                                # 或 npm run dev（热重载）
# 浏览器打开 http://127.0.0.1:4780
```

> 网页截图依赖系统 Chrome，默认路径为
> `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，可用环境变量
> `CHROME_PATH` 覆盖。

## 配置文案模型（DeepSeek / OpenAI）

文案生成必须配置真实模型。未配置 key 时**只有文案这一步会失败**（不再生成示例文案）：
图片转图、下载、ZIP、公众号贴图同步照常可用，页面会提示失败原因并给出「重新生成文案」按钮。
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

## 两种模式

- **图文转图**（默认）：链接 → PDF/网页转图片（可下载）+ 1000 字内解读文案 + 20 字内爆款标题。
- **论文深度解读**：输入 arXiv 链接（abs/pdf/html），HTML → TeX 源码 → PDF 三级回退取源，
  **全文结构化理解 + 证据驱动生成**（见下节），输出 3000–6000 字 Markdown 图文报告，可下载 `.md` / 复制。

### 深度解读怎么工作（全文结构化 + 证据驱动）

```
抓取 → chunking 全文切片 → research_map 论文地图 → retrieval 检索式上下文
     → plan 大纲 → section 逐节写作 → audit 证据审计 → repair 定点修复 → finalize
```

- **chunking**：优先用 HTML 的真实 section 层次（`.ltx_section` / `figure` / `caption` / MathML `annotation` 里的 LaTeX），
  TeX 用 `## 章节 / 图注： / $$公式$$` 标记还原结构，PDF 用带换行正文里的编号标题分节；
  产出稳定 id 的 chunk（`c1`、`c2`…），带 section 标题、类型（段落/公式/图注/表格）与原文顺序。
  30k+ 字论文整篇参与分析，不再 `slice(0, 16000)`。
- **research_map**：写作前先做一次轻量结构化分析，产出 `problem / key_claims / method_components / equations /
  datasets / benchmarks / baselines / main_results / ablations / limitations / figures / evidence`，
  每条尽量带 `chunkIds`；模型给不出可用 JSON 时用本地关键词 + 数字抽取兜底。
- **retrieval**：每个小节按「标题 + 写作要点 + 论文地图」做词法检索（中文 2-gram / 英文词干，无 embedding 依赖），
  叠加章节角色先验（方法节偏爱方法/公式/架构图，结果节偏爱实验/表格/数字，局限节偏爱 limitation/ablation/失败案例），
  每节注入证据片段（带 chunk id）+ 少量全局上下文（摘要、图片索引、研究地图）。
- **audit**：成稿后核对数字/百分比能否在原文找到、模型与数据集名、main result 覆盖、消融与局限是否覆盖、
  公式是否被改写、`（图N）` 是否越界或与图注不符；产出内部 metadata（不进正文，另存 `deepread.audit.json`）。
- **repair**：审计不通过时**只重写有问题的那一节**（按 H2 标题定点替换）并复检，不整篇重生成。
- **降级**：切片不足 / 结构化流程整体失败 → 回退旧流程（Ollama 走 multipass、API 模型走整篇生成）；
  研究地图失败 → 本地地图；检索失败 → 本节 chunks；审计失败 → 只记 warning，不阻断报告。
  相关开关：`DEEPREAD_STRUCTURED`、`DEEPREAD_CHUNK_CHARS`、`DEEPREAD_EVIDENCE_CHARS`、
  `DEEPREAD_MAX_CHUNKS`、`DEEPREAD_MAP_CHARS`、`DEEPREAD_AUDIT`、`DEEPREAD_REPAIR`。

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
│   ├── arxiv.js              # arXiv API 精确标题/作者/时间
│   ├── arxivHtml.js          # arXiv HTML 版抓取 + 图片(CDN)抽取
│   ├── meta.js               # 机构/时间抽取
│   ├── textUtils.js          # 字数统计 / 按字符/句/词边界截断
│   ├── ai/
│   │   ├── index.js          # createProvider 工厂
│   │   ├── json.js           # 模型输出 JSON 宽松解析
│   │   └── openaiProvider.js # DeepSeek/OpenAI 兼容引擎
│   ├── deepread/             # 深度解读：全文结构化理解 + 证据驱动
│   │   ├── chunker.js        # HTML/TeX/PDF → section/chunk 结构化切片
│   │   ├── researchMap.js    # 论文地图（问题/主张/方法/公式/结果/消融/局限 + 证据定位）
│   │   ├── retrieval.js      # 词法检索选证据（章节角色先验 + 全局上下文）
│   │   ├── audit.js          # 证据审计（数字/实体/覆盖/公式/图）
│   │   ├── review.js         # 终稿审校护栏（防截断）
│   │   ├── prompts.js        # 各阶段提示词
│   │   ├── legacy.js         # 旧流程（multipass / 整篇生成）作为降级路径
│   │   └── index.js          # runDeepRead 编排
│   ├── pipeline.js           # 图文解读主流程编排
│   └── store.js              # 落盘 + ZIP/Markdown 打包
├── public/                   # 前端（index.html / app.js / style.css）
├── test/                     # node:test 测试（切片/检索/地图/审计/降级/provider）
├── output/                   # 每次生成结果（id/001.png … images.zip summary.md）
└── .env.example
```

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/images` | `{"url":"…"}` → **阶段一**：抓取 + 转图 + 抽取正文，返回图片列表 / ZIP / summary.md 地址（不调用模型） |
| POST | `/api/copy` | `{"id":"…","provider":"…","model":"…"}` → **阶段二**：对已落盘的结果生成解读文案 + 爆款标题，写回 `result.json` |
| POST | `/api/upload` | 上传 PDF / Markdown / 文本 → **阶段一**（PDF 转图，纯文本无图），文案同样走 `/api/copy` |
| POST | `/api/process` | `{"url":"…"}` → 一站式跑完两个阶段；模型不可用时返回 `200` + `copyStatus:"error"`，图片部分照常返回 |
| POST | `/api/deepread` | `{"url":"…"}` → arXiv 论文深度解读：建任务返回 `{id}`，用 SSE 订阅进度；结果含 `markdown` / `audit`（证据审计元数据）/ `pipeline` / `structure` |
| GET | `/api/deepread/events?job=…` | SSE 进度：`fetch → chunking → research_map → retrieval → plan → section → audit → repair → finalize` |
| GET | `/files/:id/:filename` | 内联访问生成的图片 / ZIP / Markdown |
| GET | `/download/:id/:filename` | 强制下载（`Content-Disposition: attachment`） |
| GET | `/api/health` | 健康检查（当前文案引擎 + 是否已配置 API key） |
| POST | `/api/sync/wechat` | `{"id":"…"}` → 有凭证自动存公众号草稿，无凭证返回降级信息 |

`result.json` 里 `copyStatus` 有三态：`pending`（只转了图）→ `done`（文案已生成）/ `error`（模型失败，`copyError` 存原因）。

## 同步发布（公众号贴图 / X）

参考 [doocs/cose](https://github.com/doocs/cose) 与「爱贝壳内容同步助手」的「打开编辑器 → 自动填充」思路。

- **公众号（多账号 + 贴图/文章）**：支持配置多个公众号（`WECHAT_APP_ID/SECRET`、`WECHAT2_APP_ID/SECRET`…，
  用 `WECHAT_NAME` / `WECHAT2_NAME` 命名），同步时下拉选择账号、切换「贴图 / 文章」类型：
  - **贴图**（`article_type: "newspic"`）：选中的图片上传为永久素材、首图为封面，标题 + 解读文案纯文本。
  - **文章**（`article_type: "news"`）：第一张图作封面，正文 Markdown 渲染为 HTML + 图片，存为图文草稿。
  未配置凭证时降级为**打包下载图片 + 打开公众号后台**，手动上传。
- **X**：点「同步到 X」打开 `twitter.com/intent/tweet` 发帖框并**预填标题**（无凭证可用）；
  图片需手动附图。长文同步到 X Articles 需走 X API 或浏览器自动化，暂未内置。

## 关键设计点

- **深度解读：全文结构化 + 证据驱动**：先切片（HTML/TeX 真实章节层次；PDF 编号标题），再建「论文地图」
  （问题/主张/方法/公式/结果/消融/局限 + chunkIds 证据定位），逐节写作改为**按小节从全文检索证据**
  （词法检索 + 章节角色先验），成稿后做证据审计，只在个别小节出问题时定点重写。
  每一步都有降级路径，`/api/deepread` 的 SSE 协议与前端进度不变（新增 chunking/research_map/retrieval/audit/repair 阶段）。
- **转图与文案解耦**：`prepareUrl/prepareUpload` 只做「抓取 + 转图 + 抽取正文」，先把图片写进
  `output/{id}/` 并打包；`generateCopy` 再单独读回正文生成文案。模型未配置 / 超时 / 报错只把
  `copyStatus` 标成 `error`，图片、ZIP、summary.md 不受影响，前端在「解读文案」卡片内提示失败并给出
  「重新生成文案」按钮（重试只重跑模型那一步，不重新下载与转图）。
- **约束兜底 + 完整收尾**：标题用 `truncateTitle` 压到 `MAX_TITLE_CHARS`（20）并按词边界截断、
  超长时自动重写。文案通过三层保证「≤ `MAX_COPY_CHARS`（1000）且完整」：① 提示词强制按预算成稿、
  以结论收尾；② 超预算时自动做一次**压缩重试**（保留全部小节与结论）；③ 最后用 `truncateAtSentence`
  按**句边界**兜底，绝不截在词/句中间。前端按「不含空白的字符数」展示字数。
- **文案格式化**：文案统一用 Markdown 输出（`##` 小节、`**加粗**`、`-` 列表、`>` 引用），
  前端用内置的极简渲染器转成富文本（先 HTML 转义防 XSS），并提供「预览 / Markdown 源码」
  切换；「复制文案」自动剥离 Markdown 符号，得到可直接粘贴的纯文本。
- **PDF 渲染**：`pdfjs-dist`（legacy 构建）+ `@napi-rs/canvas` 纯 JS 栅格化，无系统依赖；
  `MAX_PDF_PAGES` 限制最多转图页数，`PDF_SCALE` 控制清晰度。
  **中文 PDF 必须带 CMap/标准字体资源**：`src/pdfjs.js` 会把 `pdfjs-dist/cmaps` 与
  `standard_fonts` 目录传给 `getDocument`（`cMapUrl` / `cMapPacked` / `standardFontDataUrl`）。
  简中论文常用 CID 字体 + CMap 编码（UniGB-UCS2-H 等），缺这些资源时字体翻译会失败，
  中文会整段消失、只剩英文与公式。中文标题也从正文首行抽取（「递归循环 Transformer」），
  不再误取英文副标题/作者名。
- **网页渲染**：`puppeteer-core` 直连系统 Chrome，`WEB_SEGMENT_HEIGHT` 把超长页切段，
  规避 Chrome 单图超高纹理上限。
- **文案引擎可插拔**：DeepSeek / OpenAI 共用同一接口，`LLM_PROVIDER` 一键切换。
- **机构与时效**：自动抽取「机构」与「发表时间」——arXiv 走 API 拿发布时间、PDF 首页抓机构名、
  网页读 meta/正文日期；提示词要求文案自然交代「XX 机构在 YYYY 年提出…」，信息缺失时不硬编。
- **解读方法论（参考 [paper-deep-reader-skill](https://github.com/Linwei-Chen/paper-deep-reader-skill)）**：
  文案采用「零背景可进入 + 技术足够硬」的双层讲解法——术语首次出现即白话解释、用一个最小
  例子走通机制、Before/After/Diff 最小差分、具体数字支撑并区分「作者主张 / 直接证据 / 推断」、
  证据强度分级、边界从论文具体缺口推出。已在模型提示词中落地。

## Docker 运行（含 Ollama）

项目提供 `Dockerfile` 与 `docker-compose.yml`，会同时启动 link2post、Ollama，并自动拉取模型：

```bash
cd link2post
OLLAMA_MODEL=qwen3:8b docker compose up -d --build
# 首次启动会下载模型，浏览器打开 http://127.0.0.1:4780
```

数据保存在 Docker volume `ollama-data` 与 `link2post-output`。如使用已有 Ollama 服务，将 `OLLAMA_BASE_URL` 设置为宿主机可访问的 `http://host.docker.internal:11434/v1`。

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
- 文案生成依赖真实模型（需配置 `DEEPSEEK_API_KEY` 或 `OPENAI_API_KEY`）；未配置或调用失败时
  **只缺文案**，图片/ZIP 照常产出，可在页面上重试。标题与解读质量取决于模型与正文抽取质量。
- 可扩展点：任务队列 + SSE 进度、历史记录、PDF 图表智能裁剪、多链接批量处理。
