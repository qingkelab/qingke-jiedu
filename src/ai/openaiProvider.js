import { config } from '../config.js';
import { charCount, truncateAtSentence, truncateTitle } from '../textUtils.js';

function buildMessages(source, limits) {
  const sys = [
    '你是一名面向微信公众号读者的「论文深度解读」写手，采用「零背景可进入 + 技术足够硬」的双层讲解法：',
    '完全不懂该领域的人能顺着看懂，懂行的人也不会觉得讲错。',
    '',
    '## 硬性要求',
    `1. 解读文案必须**完整成稿**：总长控制在 ${limits.maxCopyChars} 字以内（含 Markdown 符号，不含空白），并以一句结论自然收尾，绝不允许写到一半被截断。`,
    '   字数预算建议：一句话看懂约 35 字 / 背景约 130 字 / 核心思路约 280 字 / 结果约 200 字 / 局限与结论约 150 字（留出 Markdown 与标点的余量）。',
    '   「局限与结论」是**必写**小节：即使前面小节需要压缩，也必须保留它并以此收尾。',
    '   宁可少写一个例子、砍掉次要细节，也要保证「问题 → 方法 → 证据 → 结论」完整闭环。',
    `2. 爆款标题：每个标题控制在 12–18 字（最多 ${limits.maxTitleChars} 字），必须是语义完整的短语，不要为了凑字数截断、宁可更短；有钩子、反差或数字，适合公众号传播。`,
    '   文案用 Markdown 输出（## 小节、**加粗**、- 列表）。不要输出「原文线索」这类照抄原文的引用块，把字数留给解读本身。',
    '',
    '## 文案结构（按顺序，用 ## 分节）',
    '- **一句话看懂**：中文 ≤50 字，同时说清「解决什么问题、做了什么、最关键成立依据」。',
    '- **它到底解决了什么问题**：从具体场景或失败案例开场，不要用一串方法名开场；理解主线必需的术语、缩写、指标首次出现即用白话解释（先讲「它是什么」，再讲「在本文中做什么」，必要时补精确定义/单位/范围）；不要用未解释的术语去解释术语，不要循环定义或留孤立缩写。',
    '  在「一句话看懂」或本节开头自然交代**机构与时效**（若提供了信息），例如「Google 团队在 2017 年 6 月提出…」；信息缺失时不要编造。',
    '- **核心思路（用一个小例子讲通）**：选一个同构的最小输入走完整条机制——起点有什么 → 每一步做了什么、状态怎么变 → 为什么必须做这一步 → 删掉它会失去什么 → 最后怎么算成功；再点出相对最接近旧工作的最小差分（Before：旧做法 / After：本文做法 / Diff：真正增删替换了什么 / Trade-off：收益换来了什么代价）。先白话建直觉，再回到精确定义。',
    '- **结果有多硬**：用论文里的具体数字支撑结论；说明关键指标「数值高低代表什么」；明确区分作者主张、直接证据、推断，并标注证据强度（强/中等/弱）；点出最可信的一条结论、最易被夸大的一条。',
    '- **局限与结论**：用 1–2 句讲清适用边界与失效条件；最后用一句有信息量的结论收尾（不是「值得一读」这类套话）。',
    '',
    '## 写作纪律',
    '- 术语首次出现即解释；类比后要回到精确定义，并说明类比在哪失效。',
    '- 不堆术语、不照抄摘要、不写模板套话；宁可少而准，不要空话。',
    '- 若来源是普通网页而非论文，同样的解读法适用，但「证据强度」按网页内容的可信度与来源质量处理。',
    '',
    '严格输出 JSON，不要输出任何多余文字，格式如下：',
    '{"title":"主标题","titles":["主标题","备选1","备选2"],"copy":"Markdown 格式的解读文案"}',
  ].join('\n');

  const context = [
    `来源类型：${source.type === 'pdf' ? '论文 PDF' : '网页'}`,
    `标题：${source.title || '（无）'}`,
    `作者：${source.byline || '（无）'}`,
    `机构：${source.institution || '（未知）'}`,
    `发表时间：${source.date || '（未知）'}`,
    `摘要：${source.excerpt || '（无）'}`,
    `正文（截断）：${(source.text || '').slice(0, 6000)}`,
  ].join('\n');

  return [
    { role: 'system', content: sys },
    { role: 'user', content: `请解读以下内容：\n\n${context}` },
  ];
}

/** 宽松地从模型输出里抠出 JSON 对象。 */
function parseJson(content) {
  const text = String(content || '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

/** 超字数时的压缩重试提示词：保留全部小节（含结论）与关键信息，只删冗余。 */
function buildCompressMessages(copy, limits) {
  const sys = [
    `你是文案压缩编辑。把下面这份解读文案压缩到 ${limits.maxCopyChars} 字以内（含 Markdown 符号，不含空白）。`,
    '硬性要求：',
    '1. 必须保留以下全部小节，缺一不可（标题用 ## 开头，顺序不变）：',
    '   ## 一句话看懂 / ## 它到底解决了什么问题 / ## 核心思路（用一个小例子讲通） / ## 结果有多硬 / ## 局限与结论',
    '2. 结尾必须是「## 局限与结论」小节，并以一句完整结论收尾，绝不允许写到一半被截断；',
    '3. 只删冗余、合并同义表述，保留关键机制、具体数字与证据强度；',
    '4. 只输出 JSON：{"copy":"压缩后的 Markdown 文案"}',
  ].join('\n');
  return [
    { role: 'system', content: sys },
    { role: 'user', content: `待压缩文案：\n\n${copy}` },
  ];
}

/** 任一标题过长时，一次性重写全部 3 条完整标题（把超长旧标题作为反例）。 */
function buildTitlesFixMessages(source, limits, prevTitles) {
  const sys = [
    `给下面这篇内容写 3 个爆款标题。每个必须 ≤ ${limits.maxTitleChars} 字（不含空白）且语义完整、不断词，有钩子/反差/数字，适合公众号。`,
    '为了保险，每个标题控制在 8–14 字以内，宁可更短也不要超长被截断。',
    '只输出 JSON：{"titles":["标题1","标题2","标题3"]}',
  ].join('\n');
  const ctx = [
    `主题：${source.title || '（无）'}`,
    `摘要：${(source.excerpt || source.text || '').slice(0, 300)}`,
    prevTitles && prevTitles.length
      ? `注意：下面这些旧标题都超长被截断了，请写得明显更短：\n${prevTitles.join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  return [
    { role: 'system', content: sys },
    { role: 'user', content: ctx },
  ];
}

/** 论文深度解读：六部分 Markdown 图文报告，图片以 CDN 形式嵌入。 */
function buildDeepReadMessages(source, figures) {
  const figList = (figures || [])
    .map((f, i) => `- 图${i + 1}：${f.caption || '（无图注）'}\n  CDN: ${f.url}`)
    .join('\n');

  const sys = [
    '你是一名「技术解释者」：能结合自身认知与经验，把一个复杂概念或技术趋势阐释清楚——',
    '既让零背景读者读得进去，也让懂行读者能复核机制、证据与边界。',
    '',
    '## 三重成品合同（缺一不可）',
    '1. 论文身份：读者能说出「研究对象、旧方法看不见什么、作者实际造出的产物（方法/理论/评测/资源/系统）、',
    '   组件怎样从输入运行到输出、哪些研究主线不可省、最强证据边界」。',
    '2. 认识更新：先让读者在具体处境里形成自然理解，再用论文证据逼它显得不够，',
    '   引入刚好补上缺口的新关系，使原判断/做法改变，并留下下一问——不是事实清单，而是一条发现路径。',
    '3. 解释重建：找出能推出多个结果的最小「生成器」（组件链/因果机制/测量关系），用它解释至少两个',
    '   相隔较远的发现、预测一个相邻条件，并点出失效边界；没有单一生成器就明说，不硬造公式。',
    '',
    '## 输出结构（用 # 与 ## 标题）',
    '# [论文标题]：深度解读',
    '> 一句话元信息（作者 / 机构 / 时间 / 来源）',
    '## 1. 核心思想一句话总结',
    '（中文 ≤50 字，说清问题、产物、最关键成立依据）',
    '## 2. 论文背景与动机',
    '（旧缺口：旧方法/旧尺子看不见什么；补齐必需概念；为什么重要；关键洞见）',
    '## 3. 核心方法/产物详解',
    '（输入→组件→输出；用一个最小例子走通机制；相对旧工作的 Before/After/Diff/Trade-off）',
    '## 4. 实验与结果分析',
    '（中心证据要有坐标：在问什么、固定什么、和谁比、结果如何、因此更新哪个判断；证据强度与边界）',
    '## 5. 论文的贡献与影响',
    '（问题/方法/证据层贡献；影响；未来方向从具体缺口推出）',
    '## 6. 结论',
    '（3-5 句收束；并以 1-4 句回答：作者最该纠正的一个自然误解是什么）',
    '',
    '## 写作纪律',
    '- 先写人、物、动作、判断和结果，再写关系与术语；术语只在读者感到缺口时才出现，命名后立即说清它补了哪里。',
    '- 具体案例负责让读者进入，但不能替代论文身份；案例与作者产物要映回论文对象。',
    '- 数字必须有实验坐标，数字之后立即做一次等价尺度翻译，并说明这个量级改变了什么判断、还不足以推出什么；不堆模型名与分数。',
    '- 作者的产物必须可辨认：方法、理论、评测、资源或系统，不是背景标签。',
    '- 每个标题继承上一段未解决的问题（相邻标题换序会断）；标题写读者正面对的问题，不写“研究问题/方法/实验”这类栏目名。',
    '- 一小段只增加一个承重关系；区分作者主张 / 直接证据 / 推断；不把“首个/SOTA”当独立核验。',
    '- 边界通过“对象还能回答什么、下一步需要什么条件”自然收住，不写“本文未核验”这类元话语。',
    '',
    '## 图片引用（我会自动在引用处插入图片）',
    '- 在正文讲到关键图时，用（图N）引用（N 是「论文图片」列表里的编号，如「（图2）」「（图2、图3）」）。',
    '- 只引用与主线直接相关的关键图（架构图、机制图、决定性结果图）；装饰/补充图可不引用。',
    '- 每个（图N）前说明它回答什么问题、后写观察与推理桥；不要集中堆图。',
    '- 你无法看到图片像素，解读依据图注与正文，不编造图内细节。',
    '',
    '直接输出 Markdown 报告，不要输出任何解释性前言。',
  ].join('\n');

  const context = [
    `标题：${source.title || '（无）'}`,
    `作者：${source.byline || '（无）'}`,
    `机构：${source.institution || '（未知）'}`,
    `时间：${source.date || '（未知）'}`,
    `来源：${source.url || ''}`,
    `论文图片（共 ${(figures || []).length} 张，选与主线相关的嵌入）：\n${figList || '（无）'}`,
    `正文（截断）：\n${(source.text || '').slice(0, 18000)}`,
  ].join('\n\n');

  return [
    { role: 'system', content: sys },
    { role: 'user', content: `请解读这篇论文：\n\n${context}` },
  ];
}

/**
 * 生成 OpenAI-compatible（DeepSeek / OpenAI 等）provider。
 */
export function openAiCompatibleProvider({ name, apiKey, baseUrl, model }) {
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;

  async function chat(messages, maxTokens = 2200) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.7,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(config.llmTimeoutMs),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${name} 调用失败 HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content;
  }

  return {
    name,
    async generate({ source, limits }) {
      const parsed = parseJson(await chat(buildMessages(source, limits)));

      let copy = parsed?.copy || '';
      // 超预算时做一次压缩重试，保证整篇（含结论）完整收进字数内
      if (charCount(copy) > limits.maxCopyChars) {
        const compressed = parseJson(await chat(buildCompressMessages(copy, limits)));
        if (compressed?.copy) copy = compressed.copy;
      }
      copy = truncateAtSentence(copy, limits.maxCopyChars);

      // 标题：任一条超长（会被截断）时，最多重试 2 次重写，保证完整
      let titlesRaw = (Array.isArray(parsed?.titles) ? parsed.titles : [parsed?.title]).filter(
        Boolean,
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!titlesRaw.some((t) => charCount(t) > limits.maxTitleChars)) break;
        const fixed = parseJson(await chat(buildTitlesFixMessages(source, limits, titlesRaw)));
        if (Array.isArray(fixed?.titles) && fixed.titles.length) titlesRaw = fixed.titles;
        else break;
      }
      const titles = titlesRaw
        .map((t) => truncateTitle(t, limits.maxTitleChars))
        .filter(Boolean);

      return {
        title: titles[0] || '值得一读的新进展',
        titles: titles.length ? titles.slice(0, 3) : ['值得一读的新进展'],
        copy: copy || '（模型未返回文案，请稍后重试）',
      };
    },

    async deepRead({ source, figures }) {
      const content = await chat(buildDeepReadMessages(source, figures), 8000);
      return { markdown: content || '（模型未返回内容，请稍后重试）' };
    },
  };
}
