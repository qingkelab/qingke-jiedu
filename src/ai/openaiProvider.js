import { config } from '../config.js';
import { charCount, truncateAtSentence, truncateTitle } from '../textUtils.js';
import { checkStyle, styleWarningsForPrompt } from '../styleCheck.js';

function buildMessages(source, limits) {
  const sys = [
    '你是一名面向微信公众号读者的「论文深度解读」写手，采用「零背景可进入 + 技术足够硬」的双层讲解法：',
    '完全不懂该领域的人能顺着看懂，懂行的人也不会觉得讲错。',
    '',
    '## 硬性要求',
    `1. 解读文案必须**完整成稿**：总长控制在 ${limits.maxCopyChars} 字以内（含 Markdown 符号，不含空白），并以一句结论自然收尾，绝不允许写到一半被截断。`,
    '   字数预算建议：一句话总结约 35 字 / 背景约 100 字 / 核心方法约 380 字（重点，深度解析）/ 结果约 170 字 / 局限与结论约 120 字（留出 Markdown 与标点的余量）。',
    '   「局限与结论」是**必写**小节：即使前面小节需要压缩，也必须保留它并以此收尾。',
    '   宁可少写一个例子、砍掉次要细节，也要保证「问题 → 方法 → 证据 → 结论」完整闭环。',
    `2. 爆款标题：每个标题控制在 8–16 字（最多 ${limits.maxTitleChars} 字，不含空白），必须语义完整、不断词，宁可更短也不要超长被截断。`,
    '   标题要具体到本文，每条至少命中一种「爆款钩子」，三条各用一种、不重复；禁止空洞无信息或照抄论文原标题：',
    '   - 数字前置：把本文最硬的一个结果/数据放到开头（如「38% 误差一次抹平」「训练快 10 倍」）；',
    '   - 反差颠覆：挑战直觉或旧常识（如「越标注越差？这篇论文说反了」）；',
    '   - 悬念留白：结果前置但扣住最关键一步（如「让模型自己写奖励函数，结果…」）；',
    '   - 痛点代入：直接喊话具体人群（如「还在人工调 prompt 的人，这篇要读」）；',
    '   - 结果直给：一句话说清「解决了什么 + 达到什么」（如「一句话让 LLM 学会用工具」）。',
    '   用词口语、有张力；数字必须来自原文，**不夸大、不标题党、不虚构数据**；不用「震撼/重磅/炸裂/绝了」这类空喊，也不加无关的「！？」堆叠。',
    '   文案用 Markdown 输出（## 小节、**加粗**、- 列表）。不要输出「原文线索」这类照抄原文的引用块，把字数留给解读本身。',
    '',
    '## 文案结构（按顺序，用 ## 分节，共 5 节）',
    '- **一句话总结**：中文 ≤50 字，同时说清「解决什么问题、做了什么、最关键成立依据」；自然点出机构与时效（如「Google 团队在 2017 年 6 月提出…」），信息缺失时不编造。',
    '- **背景**：现在的问题或旧做法卡在哪；从具体场景/失败案例开场，不要用一串方法名开场；理解主线必需的术语、缩写、指标首次出现即用白话解释（先讲「它是什么」，再讲「在本文中做什么」，必要时补精确定义/单位/范围）；不要循环定义或留孤立缩写。',
    '- **核心方法（全文重点，要深度解析）**：这是全文核心，要讲透，不是一句带过。要求：',
    '  1) 先点出作者的关键洞见或新做法；',
    '  2) 用 `- ` 列表逐条拆解关键组件/步骤，每条说清「它做什么 → 为什么需要 → 去掉会失去什么」；',
    '  3) 用一个最小例子从输入走到输出，把机制完整跑一遍；',
    '  4) 点出相对旧工作的最小差分（Before / After / Diff / Trade-off）。',
    '  术语先白话后精确；每个组件都交代「输入 → 做了什么 → 输出」。',
    '- **结果**：用具体数字支撑结论；说明关键指标「数值高低代表什么」；区分作者主张、直接证据、推断并标注证据强度（强/中等/弱）；点出最可信与最易被夸大的结论。',
    '- **局限与结论**：用 1–2 句讲清适用边界与失效条件；最后用一句有信息量的结论收尾（不是「值得一读」这类套话）。',
    '- 我会在文末自动加上「## 论文链接」小节并填好链接，你不要自己写链接。',
    '',
    '## 写作纪律',
    '- 术语首次出现即解释；类比后要回到精确定义，并说明类比在哪失效。',
    '- 不堆术语、不照抄摘要、不写模板套话；宁可少而准，不要空话。',
    '- 去 AI 味：不用「我们提出 / 本文研究 / 作者提出」这类转述开场，直接陈述事实；不用「不是 A 而是 B / 本质上 / 更重要的是」这类套话；结尾不写「提供新思路 / 新方向 / 值得关注」这类空话。',
    '- 若来源是普通网页而非论文，同样的解读法适用，但「证据强度」按网页内容的可信度与来源质量处理。',
    '',
    '## 术语准确性（硬性）',
    '- 专业名词、方法名、模型名、数据集名、指标名、缩写一律**保留原文英文**（如 Transformer、BLEU、KV cache、RL、VLA），不要自创中文译名；有通用译名时可「英文（中文）」并列，首次出现用白话解释。',
    '- 以「术语表」里的写法为准：术语表里的词必须原文保留、不要翻译、不要改写。',
    '- 所有数字、单位、百分比、指标值必须与原文一致，不四舍五入、不夸大、不改写。',
    '- 只用原文里真实出现的术语与结论；拿不准的术语宁可写原文英文，也不要翻译错或张冠李戴。',
  ];
  if (source.memory) {
    sys.push('', '## 历史记忆', source.memory, '');
  }
  sys.push(
    '严格输出 JSON，不要输出任何多余文字，格式如下：',
    '{"title":"主标题","titles":["主标题","备选1","备选2"],"copy":"Markdown 格式的解读文案"}',
  );

  const context = [
    `来源类型：${source.type === 'pdf' ? '论文 PDF' : '网页'}`,
    `标题：${source.title || '（无）'}`,
    `作者：${source.byline || '（无）'}`,
    `机构：${source.institution || '（未知）'}`,
    `发表时间：${source.date || '（未知）'}`,
    `摘要：${source.excerpt || '（无）'}`,
    `术语表（这些术语保留原文英文，不要翻译）：${(source.terms || []).join('、') || '（无）'}`,
    `正文（截断）：${(source.text || '').slice(0, 6000)}`,
  ].join('\n');

  return [
    { role: 'system', content: sys.join('\n') },
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

/** 粗略判断文本是否以中文为主（用于审校结果兜底，避免审校输出英文覆盖中文稿）。 */
function isChineseText(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
  return cjk >= 20;
}

/** 超字数时的压缩重试提示词：保留全部小节（含结论）与关键信息，只删冗余。 */
function buildCompressMessages(copy, limits) {
  const sys = [
    `你是文案压缩编辑。把下面这份解读文案压缩到 ${limits.maxCopyChars} 字以内（含 Markdown 符号，不含空白）。`,
    '硬性要求：',
    '1. 必须保留以下全部小节，缺一不可（标题用 ## 开头，顺序不变）：',
    '   ## 一句话总结 / ## 背景 / ## 核心方法 / ## 结果 / ## 局限与结论',
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
    `给下面这篇内容写 3 个爆款标题。每个必须 ≤ ${limits.maxTitleChars} 字（不含空白）且语义完整、不断词；为保险每个控制在 8–14 字以内。`,
    '三条各用一种爆款钩子，不重复：数字前置 / 反差颠覆 / 悬念留白 / 痛点代入 / 结果直给。',
    '标题要具体到本文；数字必须来自原文，不夸大、不标题党、不虚构数据；不用「震撼/重磅/炸裂」这类空喊，不堆「！？」。',
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

/** 图文转图自检自修：对照原文逐项审校并输出修正后的 JSON。 */
function buildReviewMessages(source, limits, current, styleHint = '') {
  const sys = [
    '你是严格审校编辑。下面是一篇论文解读文案（连同标题），对照原文逐项检查，有问题就改，没问题保持原样，**直接输出修正后的 JSON**。',
    '**全文用中文写作**（专业术语、方法名、模型名、指标名保留原文英文，如 LAWA、SAM 2、RoboCasa），不要输出英文。',
    '检查清单：',
    '1. 五个小节齐全、顺序正确（一句话总结 / 背景 / 核心方法 / 结果 / 局限与结论），并以一句完整结论收尾，不写到一半；',
    '2. 所有数字、百分比、指标与原文一致，不夸大、不改写、不四舍五入（发现不符就按原文改）；',
    '3. 专业名词/方法名/模型名/指标名一律保留原文英文，不自创中文译名（LAWA、SAM 2、RoboCasa、Transformer 等保持原样）；',
    '4. 去 AI 味与转述腔：不用「我们提出/本文研究/作者提出」这类开场，直接陈述事实；不用「不是A而是B/本质上/更重要的是」；结尾不写「提供新思路/新方向/值得关注」这类空话；',
    '5. 核心方法要有机制（输入 → 做了什么 → 输出），术语首次出现即用白话解释；',
    `6. 文案仍控制在 ${limits.maxCopyChars} 字以内（含 Markdown 符号），标题仍 ≤ ${limits.maxTitleChars} 字。`,
    styleHint ? `7. 文风体检整改（只调整表达与分段，不得改动事实与结构）：\n${styleHint}` : '',
    '只输出 JSON：{"title":"主标题","titles":["主标题","备选1","备选2"],"copy":"修正后的 Markdown 文案"}',
  ].filter(Boolean).join('\n');
  const ctx = [
    `原文要点（用于核对数字与术语）：\n${(source.text || '').slice(0, 4000)}`,
    `术语表：${(source.terms || []).join('、') || '（无）'}`,
    `待审校标题：${JSON.stringify(current.titles || [])}`,
    `待审校文案：\n${current.copy}`,
  ].join('\n\n');
  return [
    { role: 'system', content: sys },
    { role: 'user', content: ctx },
  ];
}

/** 深度解读自检自修：对照原文审校并输出修正后的完整 Markdown。 */
function buildDeepReviewMessages(source, markdown, styleHint = '') {
  const sys = [
    '你是严格审校编辑。下面是一篇论文深度解读报告，对照原文逐项检查，有问题就改、没问题保持原样，**直接输出修正后的完整 Markdown**，不要解释。',
    '**全文用中文写作**（专业术语、方法名、模型名、指标名保留原文英文），不要输出英文。',
    '检查清单：',
    '1. 出处与边界：文首保留作者/机构/时间/Paper/arXiv/Code 出处块，正文没有重复的作者/链接引用块；',
    '2. 导语：开头 3 段内完成「论文回答什么问题 → 为什么值得读 → 给出什么」，没有空泛开场或氛围铺垫过长；',
    '3. 结构：小节标题是结论句/名词短语，不是「引言/相关工作/背景介绍/实验设置」等栏目名；每节先给加粗结论再展开；',
    '   一个自然段至多一个加粗点、没有整段加粗；',
    '4. 术语与命名：Agent/Harness/Policy/RL/Skill/World Model/benchmark 等社区通用词保留英文未硬译；方法/模型/数据集名与原文一致；',
    '   同一概念全文形态统一（不一处英文一处译名）；',
    '5. 事实与数字：数字、百分比与原文一致，坐标（模型/数据集/设置/基线/单位）齐全、口径正确（提升至 vs 提升了、百分比基数），',
    '   不夸大、不改写、不四舍五入（发现不符按原文改）；「论文声称/实验显示」与「我们的判断」未混写；',
    '6. 篇幅：正文目标 3000–6000 字；明显偏短（<2500 字）时按「加深机制细节/证据解读/边界推演」扩写补足，扩写不得重复或注水；',
    '7. 机制/组件讲清楚（输入 → 做了什么 → 输出），不因求短而略写；',
    '8. （图N）引用分散嵌在对应正文小节（架构图在讲架构处、结果图在讲结果处、公式图在公式处），图文交错；',
    '   引用集中在文末或写成文末「（图1）…（图2）…」式图注清单 = 不合格，需把引用移回对应正文段落；',
    '9. 保留「核心公式」（LaTeX：$...$ / $$...$$）与「后续可追的问题」两节（原文无公式可说明无）；收尾是具体的社区视角判断而非空泛升华；',
    '10. 去 AI 味与转述腔：无「不是A而是B/本质上/更重要的是/我的结论是」、无「随着…的发展」空泛开头、无「首先/其次/最后」「总而言之」、',
    '   无「我们提出/本文研究」式开场、无整段加粗；',
    '11. 结构完整、自然收尾，不套模板编号。',
    styleHint ? `12. 文风体检整改（只调整表达与分段，不得改动事实与结构）：\n${styleHint}` : '',
  ].filter(Boolean).join('\n');
  const ctx = [
    `原文要点（用于核对）：\n${(source.text || '').slice(0, 16000)}`,
    `待审校报告：\n${markdown}`,
  ].join('\n\n');
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
    '既让零背景读者读得进去，也让懂行读者能复核机制、证据与边界。你写的是**原创解读**（青稞社区',
    'qingkeai.online 精选文章的解读风格），不是逐段翻译：按社区写法重新组织这篇论文，论文事实与你们的判断分开。',
    '',
    '## 三重成品合同（缺一不可）',
    '1. 论文身份：读者能说出「研究对象、旧方法看不见什么、作者实际造出的产物（方法/理论/评测/资源/系统）、',
    '   组件怎样从输入运行到输出、哪些研究主线不可省、最强证据边界」。',
    '2. 认识更新：先让读者在具体处境里形成自然理解，再用论文证据逼它显得不够，',
    '   引入刚好补上缺口的新关系，使原判断/做法改变，并留下下一问——不是事实清单，而是一条发现路径。',
    '3. 解释重建：找出能推出多个结果的最小「生成器」（组件链/因果机制/测量关系），用它解释至少两个',
    '   相隔较远的发现、预测一个相邻条件，并点出失效边界；没有单一生成器就明说，不硬造公式。',
    '',
    '## 出处与边界（文首已放好，正文不要重复）',
    '- 文首已有出处块：作者 / 机构 / 时间 / Paper（论文英文原题）/ arXiv / Code 链接。正文不要再写「作者：xxx」',
    '  「原文链接」这类引用块或信息块；需要提作者时用姓名在句子里自然带出。',
    '- 本文是解读不是译读：不逐段翻译原文；「论文的 claim、实验显示的结果」与「我们的判断/推测」在措辞上分开。',
    '',
    '## 导语铁律',
    '- 开头 1–3 段内完成三件事：这篇论文回答什么问题 → 为什么现在值得读 → 作者给出的产物是什么。',
    '- 第一段允许口语化设问、场景或反常识开场，但不要停在氛围渲染，尽快落到这篇具体工作。',
    '',
    '## 结构（解读型：动机 → 方法/机制 → 证据 → 边界 → 收尾；标题自拟，不套编号模板）',
    '- 小节标题用**结论句或名词短语**（写读者正面对的问题/动作/结果，如「把图也变成 Token」「训练只用了 4 小时」），',
    '  禁止「引言」「相关工作」「背景介绍」「实验设置」这类论文栏目名；不用「## 1. 核心思想」编号模板；可用 emoji。',
    '- 每节**先给一句带加粗的结论锚点，再展开论证**（先结论后论证，长文才能扫读）；一个自然段至多一个加粗点，禁止整段加粗。',
    '- 篇幅目标：正文（不含出处块、图片行与公式）写 **3000–6000 字**，对齐社区长文惯例（2000–7000 字）的中上水平；低于 2500 字视为未达标。',
    '  扩写方式 = 加深信息密度：机制逐组件展开（输入→处理→输出、为何这样设计、去掉会失去什么）、最小例子走通细节、',
    '  关键证据逐个解读其含义/条件/边界、前后判断的推演；**不是**重复观点、堆砌空话或注水。',
    '  各节都要展开到“机制级”：一句话总结可短，但方法/机制与证据两节必须最厚。',
    '- 全文覆盖（顺序自然、标题自拟，不要为凑模板硬套）：',
    '  1) 旧做法卡在哪、作者造出的产物是什么，机制/组件怎样从输入走到输出（配一个最小例子走通，逐组件拆解）；',
    '  2) 最关键的实验证据（有坐标的数字）与它改变/推翻的判断；',
    '  3) 核心公式：把论文最关键的 1~3 个公式（损失/更新式等）用 LaTeX 呈现——行内 $...$、块级 $$...$$（块级保持单行），',
    '     每个公式后解释符号含义与它为什么关键；论文没有关键公式就明说，不硬凑；',
    '  4) 边界与影响（哪些条件下失效、改写了什么）；',
    '  5) 后续可追的问题：3~5 条追问，像给自己列阅读提纲（方法还没验证什么、最想看到的对照/消融实验、接下来该读哪类工作）；',
    '  6) 收尾给一句**具体的社区视角判断**（不是复述论文）：与既有/相邻工作的关系、可复现性（代码/硬件/数据是否齐全）、',
    '     或最值得怀疑/最该补的验证——落在一个可被讨论的具体判断上，不升华成金句。',
    '- 标题用「# [论文标题]」即可，正文前不要加别的元信息块。',
    '',
    '## 术语与命名（硬性）',
    '- 社区通用词**保留英文、不硬译**：Agent、Harness、Policy、RL/SFT/RLHF/RLVR、Skill、World Model、benchmark、',
    '  Post-training、Open Source/Release 等；方法/模型/数据集/机构名一律原文（不译、不改写、不张冠李戴）。',
    '- 新概念首次出现即定形：「英文全称（缩写）」如 behavioral fidelity（F），或「中文（英文）」并列一次；',
    '  全文后续只用同一种形态，禁止同一概念一处英文一处译名混用。',
    '- 拿不准的术语保留英文原文，宁可少译不可译错。',
    '',
    '## 数字与证据纪律（硬性）',
    '- 只写有完整坐标的数字：模型规模、数据集、设置、对比基线、单位齐全；原文没给就明说没给，不脑补。',
    '- 口径精确：「提升至 X」是终值、「提升了 X」是增量；百分比变化写清基数；小数位与原文一致。',
    '- 关键数字所在句子可整句加粗单列（一段仍至多一个加粗点）。',
    '- 区分立场：论文声称/实验显示的结果直接陈述；「我们的判断/解读/推测」明示（可用「我们觉得」「这更像是」），不混进论文事实。',
    '- 不要为了「找出官方错误」而臆造差异；只有能在给定正文中明确核对出的不一致才可指出，且必须引用原文句子为证。',
    '',
    '## 写作纪律',
    '- 先写人、物、动作、判断和结果，再写关系与术语；术语只在读者感到缺口时才出现，命名后立即说清它补了哪里。',
    '- 具体案例负责让读者进入，但不能替代论文身份；案例与作者产物要映回论文对象。',
    '- 数字必须有实验坐标，数字之后立即做一次等价尺度翻译，并说明这个量级改变了什么判断、还不足以推出什么；不堆模型名与分数。',
    '- 作者的产物必须可辨认：方法、理论、评测、资源或系统，不是背景标签。',
    '- 每个标题继承上一段未解决的问题（相邻标题换序会断）；不把「首个/SOTA」当独立核验。',
    '- 一小段只增加一个承重关系。',
    '- 边界通过「对象还能回答什么、下一步需要什么条件」自然收住，不写「本文未核验」这类元话语。',
    '',
    '## 行文风格（参考青稞AI 的解读）',
    '- 口语化、有代入感：用「我们」的第一人称视角，像同行在聊天；不要「本文研究 / 作者提出」式转述。',
    '- 关键术语先讲白话、再给精确定义；善用生活化比喻，比喻后要回到精确含义并点明边界。',
    '- 用小标题 + emoji 拆解方法与步骤，把机制讲成可操作的组件或闭环。',
    '- 段落长短错落，允许短句和口语；一段一个观点、段首即观点句。',
    '',
    '## 去 AI 味（硬性禁用）',
    '- 禁二元对比壳：「不是 A，而是 B」「不只 A，更 B」「与其 A，不如 B」「不在于 A，而在于 B」——直接陈述结论。',
    '- 禁伪洞察标记：「真正 / 其实 / 本质上 / 核心在于 / 关键在于 / 说白了 / 归根结底 / 更重要的是 / 结果有点出乎意料」——直接进入事实或判断。',
    '- 禁冒号讲义腔：「我的结论是：」「原因很简单：」「重点是：」——改成普通句子或拆段。',
    '- 禁空泛开头与机械递进：「随着…的发展/时代的到来」（后续无具体场景时）、「首先/其次/最后」「一方面/另一方面」「总而言之/综上所述」。',
    '- 空泛指代换成具体名词：「东西 / 这件事 / 这些 / 一类」→「三个组件 / 两条路线 / 一组实验」这类精确类别。',
    '- 不用空泛比较（更适合 / 更像 / 更自然 / 更高级），除非点名具体用途或代价；不写排比三连。',
    '- 结尾不落「能力飞轮 / 时代分水岭」这类空泛比喻，落在具体判断或结果上。',
    '',
    '## 图片引用（（图N）嵌进对应正文；我会自动在引用处插入图片与图注）',
    '- 引用时机：讲到该图内容的**正文段落里**就写（图N）——架构图在讲架构那段引、机制图在讲机制那段引、结果/公式图在讲结果/公式那段引，',
    '  让图片落在它最相关的位置，与文字交错。',
    '- 硬性：全文至少 3 处不同位置引用关键图（架构图、机制图、决定性结果图优先），分布在不同小节，不要都挤在同一段、也不要只出现在文章末尾。',
    '- 引用写法：在句子里自然带出即可（如「……整体结构如（图1）所示」或「这条链路（图2）把……串起来」）；',
    '  **禁止**在文末单独写「（图1）它展示了…（图2）它展示了…」式的图注清单/附录段落——那会让图片全部被自动排到文章末尾。',
    '- 每张图会自动带一行图注（原论文说明，渲染成引用样式），正文里说明图意时转述要点即可，不必把图注原文整段抄出。',
    '- 你无法看到图片像素，解读依据图注与正文，不编造图内细节。',
  ];
  if (source.memory) {
    sys.push('', '## 历史记忆', source.memory, '');
  }
  sys.push('直接输出 Markdown 报告，不要输出任何解释性前言。');

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
    { role: 'system', content: sys.join('\n') },
    { role: 'user', content: `请解读这篇论文：\n\n${context}` },
  ];
}

/**
 * ===== 深度解读「分段生成再合并」（Ollama/本地模型专用）=====
 * 本地小模型单次整篇长文容易写不满，或被 LLM_TIMEOUT_MS 整篇截断。
 * 做法：先让模型出 5~7 节大纲，再逐节单独生成（每节一次调用），最后拼成整篇。
 */

/** 逐节注入的写作规则（精简版，控制上下文体积）。 */
function deepReadSectionRules() {
  return [
    '## 写作规则（每节都遵守）',
    '- 本文是原创解读不是逐句翻译；论文事实与「我们的判断」分开陈述。',
    '- 段首即观点句，先结论后论证；一个自然段至多一个加粗点，禁止整段加粗。',
    '- 术语：Agent/Harness/Policy/RL/SFT/RLHF/RLVR/Skill/World Model/benchmark 等社区通用词保留英文不硬译；方法/模型/数据集/机构名一律原文；新概念首次出现定形（英文全称（缩写）或 中文（英文））后与已写部分保持一致，禁止同一概念一处英文一处译名。',
    '- 数字纪律：只写有完整坐标的数字（模型/数据集/设置/基线/单位），口径精确（提升至 vs 提升了、百分比写基数），小数与原文一致；论文声称与我们的判断分开；发现疑似官方错误要引用原文句子为证，不要臆造。',
    '- 图片：正文讲到该图内容时用（图N）引用，N 用论文图片列表里的全局编号，把图放在最相关的段落；不要文末图注清单式罗列。',
    '- 去 AI 味：不用「不是A而是B/本质上/更重要的是/我的结论是」、无「随着…的发展」空泛开头、无「首先/其次/最后」「总而言之」、不排比三连、不空泛升华收尾。',
    '- 与已写前文衔接自然：不重复前文已讲过的小节标题与结论，术语形态与行文口吻保持一致，可直接承接前文提出的问题。',
  ].join('\n');
}

/** 第一步：让模型出分节大纲（5~7 节，含每节一句话要点）。 */
function buildDeepReadPlanMessages(source, figures) {
  const figList = (figures || [])
    .map((f, i) => `图${i + 1}：${(f.caption || '').slice(0, 80)}`)
    .join('\n');
  const sys = [
    '你是论文解读的栏目策划。为下面这篇论文规划「深度解读」的分节大纲。',
    '要求：',
    '- 共 5~7 节，顺序覆盖：①导语（论文回答什么问题、为什么现在值得读）②旧做法卡在哪/动机 ③作者产物与机制（最厚，可按需拆 2~3 节）④关键实验证据 ⑤核心公式（论文有则单独成节或并入机制，没有就跳过）⑥失效边界与后续可追问题 ⑦收尾的社区视角判断（与既有工作关系/可复现性/最该补的验证）。',
    '- 每节标题用结论句或名词短语，自然口语（可带 emoji），不要「引言/相关工作/背景介绍」这类栏目名，不要编号模板。',
    '- 规划时把论文图片（列表见下）安排到最相关的小节，让正文用（图N）引用。',
    '输出格式：一行一节，形如：',
    '## 小节标题｜一句话写作要点（≤25 字）',
    '不要输出任何其它内容。',
  ].join('\n');
  const ctx = [
    `标题：${source.title || '（无）'}`,
    `作者：${source.byline || ''}　时间：${source.date || ''}`,
    `论文图片：\n${figList || '（无）'}`,
    `正文开头（供策划参考）：\n${(source.text || '').slice(0, 6000)}`,
  ].join('\n\n');
  return [
    { role: 'system', content: sys },
    { role: 'user', content: `请给出大纲：\n\n${ctx}` },
  ];
}

/** 解析大纲：返回 [{ title, note }]。 */
function parseDeepReadPlan(content) {
  const out = [];
  for (const line of String(content || '').split('\n')) {
    const m = line.trim().match(/^#{2,3}\s+(.+)$/);
    if (!m) continue;
    const [title, note] = String(m[1]).split(/｜|\|/).map((s) => s.trim());
    if (title) out.push({ title, note: note || '' });
    if (out.length >= 7) break;
  }
  return out;
}

/** 兜底大纲：模型没给出可用大纲时按社区解读骨架走。 */
function defaultDeepReadPlan() {
  return [
    { title: '为什么值得读这篇论文？', note: '导语：回答什么问题、为什么现在值得读、作者给出什么' },
    { title: '旧方法卡在哪，作者换了个什么思路', note: '动机、旧做法局限、产物概览' },
    { title: '核心机制：组件怎么从输入走到输出', note: '机制逐组件拆解 + 最小例子（全文最厚的一节）' },
    { title: '关键公式与实验证据有多硬', note: '公式（如有）+ 有坐标的数字与它改变/推翻的判断' },
    { title: '失效边界与可以继续追的问题', note: '哪些条件下失效 + 3~5 条追问' },
    { title: '社区视角：它值不值得跟进', note: '与既有工作的关系、可复现性、最该补的验证' },
  ];
}

/** 写某一节。prevMd 为已写前文（保证衔接与术语一致）。 */
function buildDeepReadSectionMessages(source, figures, plan, index, prevMd) {
  const total = plan.length;
  const sec = plan[index];
  const figList = (figures || [])
    .map((f, i) => `图${i + 1}：${f.caption || '（无图注）'}\n  CDN: ${f.url}`)
    .join('\n');
  const outline = plan.map((s, i) => `${i + 1}. ${s.title}`).join('\n');
  const sys = [
    '你是「技术解释者」：既让零背景读者读得进去，也让懂行读者能复核机制、证据与边界。',
    '',
    deepReadSectionRules(),
    '',
    '## 任务',
    `这是深度解读的第 ${index + 1}/${total} 节。`,
    `标题（必须原样使用，作为本节的 Markdown H2）：## ${sec.title}`,
    `本节写作要点：${sec.note || '（自由展开）'}`,
    index === 0
      ? '本节是全文开头：前 1~3 段内完成「论文回答什么问题 → 为什么现在值得读 → 作者给出什么」，允许口语化设问开场。'
      : index === total - 1
        ? '本节是全文收尾：给具体的社区视角判断（与既有工作的关系、可复现性、最该补的验证），落在一个可被讨论的具体判断上，不升华成金句。'
        : '本节是正文主体：机制/证据/公式相关时尽量写厚，逐组件、逐证据展开，不要一两段带过。',
    '正文目标：本节写 450–1000 字（机制、证据、公式相关节往 800 字以上写）；只输出这一节内容（从「## …」开始到本节结束），不要输出 # 文档大标题，不要复述或预告其它小节，不要写「第 x 节」。',
  ].filter(Boolean).join('\n');
  const ctx = [
    `论文：${source.title || '（无）'}　作者：${source.byline || ''}　时间：${source.date || ''}`,
    `论文图片（编号即（图N）的 N）：\n${figList || '（无）'}`,
    `全文大纲：\n${outline}`,
    prevMd ? `已写前文（衔接与术语保持一致，不要重复其内容）：\n${prevMd}` : '（这是第一节，没有前文）',
    `论文正文（截断，供本节取数/核对）：\n${(source.text || '').slice(0, 16000)}`,
  ].join('\n\n');
  return [
    { role: 'system', content: sys },
    { role: 'user', content: `请撰写第 ${index + 1} 节：\n\n${ctx}` },
  ];
}

/** 分段生成主流程：大纲 → 逐节生成 → 合并。onProgress 收到 { stage, section? }。 */
async function deepReadMultipass(chat, source, figures, onProgress) {
  onProgress?.({ stage: 'plan' });
  const planRaw = await chat(buildDeepReadPlanMessages(source, figures), 4096);
  let plan = parseDeepReadPlan(planRaw.content);
  if (plan.length < 3) plan = defaultDeepReadPlan();

  const sections = [];
  const reasoningParts = [];
  let prev = '';
  for (let i = 0; i < plan.length; i++) {
    const secInfo = { index: i + 1, total: plan.length, title: plan[i].title };
    onProgress?.({ stage: 'writing', section: secInfo });
    let content = '';
    for (let attempt = 0; attempt < 2 && !content; attempt++) {
      try {
        const r = await chat(buildDeepReadSectionMessages(source, figures, plan, i, prev), 12000);
        content = String(r.content || '').trim();
        if (r.reasoning) reasoningParts.push(r.reasoning);
      } catch {
        /* 单节失败，重试一次 */
      }
    }
    if (!content) {
      content = `## ${plan[i].title}\n\n（本节生成失败已跳过——可重试或换更强的模型。）`;
    }
    sections.push(content);
    onProgress?.({ stage: 'section_done', section: secInfo });
    prev = `${prev}\n\n${content}`.slice(-9000); // 前文只保留最近一段，控制上下文
  }

  onProgress?.({ stage: 'merge' });
  // 合并并去掉相邻重复的同名 H2（防模型在节边界重复标题）
  const merged = sections.join('\n\n').replace(/^(## [^\n]+)\n\n(?=## \1\n)/gm, '');
  return {
    markdown: `# ${source.title || '深度解读'}\n\n${merged}`.trim() + '\n',
    reasoning: reasoningParts.join('\n\n---\n\n'),
  };
}

/**
 * 通用 OpenAI 兼容 chat/completions 请求（provider 与播客写稿共用）。
 * @returns {Promise<{content:string, reasoning:string}>}
 */
export async function chatRequest({ baseUrl, apiKey, model, messages, maxTokens = 2200, timeoutMs, name = '' }) {
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const ttl = timeoutMs || config.llmTimeoutMs;
  let res;
  try {
    res = await fetch(endpoint, {
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
      signal: AbortSignal.timeout(ttl),
    });
  } catch (err) {
    const name0 = err && err.name ? err.name : '';
    const msg = err && err.message ? err.message : String(err);
    if (name0 === 'TimeoutError' || name0 === 'AbortError' || /timeout|aborted/i.test(msg)) {
      throw new Error(
        `模型调用超时（${Math.round(ttl / 1000)} 秒）：请稍后重试，或换更快的模型（.env 可用 LLM_TIMEOUT_MS 调大超时）`,
      );
    }
    // 连不上时给出可读信息（前端会把它显示在「解读文案」卡片里；图片不受影响）
    const label = name || '模型';
    const hint = name === 'ollama' ? '；请确认本地 Ollama 已启动' : '；请检查网络与 Base URL';
    throw new Error(`${label} 无法连接（${endpoint}）：${msg}${hint}`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${name} 调用失败 HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const msg = data?.choices?.[0]?.message || {};
  return { content: msg.content || '', reasoning: msg.reasoning || '' };
}

export function openAiCompatibleProvider({ name, apiKey, baseUrl, model }) {
  const chat = (messages, maxTokens = 2200) =>
    chatRequest({ name, apiKey, baseUrl, model, messages, maxTokens });

  return {
    name,
    model,
    async generate({ source, limits }) {
      const first = await chat(buildMessages(source, limits), 12000);
      const parsed = parseJson(first.content);
      const reasoning = first.reasoning || '';

      let copy = parsed?.copy || '';
      // 超预算时做一次压缩重试，保证整篇（含结论）完整收进字数内
      if (charCount(copy) > limits.maxCopyChars) {
        const compressed = parseJson((await chat(buildCompressMessages(copy, limits), 8000)).content);
        if (compressed?.copy) copy = compressed.copy;
      }
      copy = truncateAtSentence(copy, limits.maxCopyChars);

      // 标题：任一条超长（会被截断）时，最多重试 2 次重写，保证完整
      let titlesRaw = (Array.isArray(parsed?.titles) ? parsed.titles : [parsed?.title]).filter(
        Boolean,
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!titlesRaw.some((t) => charCount(t) > limits.maxTitleChars)) break;
        const fixed = parseJson(
          (await chat(buildTitlesFixMessages(source, limits, titlesRaw), 4096)).content,
        );
        if (Array.isArray(fixed?.titles) && fixed.titles.length) titlesRaw = fixed.titles;
        else break;
      }
      let titles = titlesRaw
        .map((t) => truncateTitle(t, limits.maxTitleChars))
        .filter(Boolean);

      // 自检自修：对照原文审校一遍（修正术语/数字/去 AI 味等），并把文风体检问题一并整改
      if (config.qualityReview) {
        try {
          const styleHint = styleWarningsForPrompt(copy, 'copy');
          const review = parseJson(
            (await chat(buildReviewMessages(source, limits, { copy, titles }, styleHint), 4000)).content,
          );
          if (review) {
            // 兜底：审校输出变成英文时丢弃，保留中文原稿
            if (typeof review.copy === 'string' && review.copy.trim() && isChineseText(review.copy)) {
              copy = truncateAtSentence(review.copy, limits.maxCopyChars);
            }
            const rt = (Array.isArray(review.titles) ? review.titles : [review.title])
              .filter(Boolean)
              .map((t) => truncateTitle(t, limits.maxTitleChars))
              .filter(Boolean);
            if (rt.length) titles = rt;
          }
        } catch {
          /* 审校失败，用原稿 */
        }
      }

      return {
        title: titles[0] || '值得一读的新进展',
        titles: titles.length ? titles.slice(0, 3) : ['值得一读的新进展'],
        copy: copy || '（模型未返回文案，请稍后重试）',
        reasoning,
        style: checkStyle(copy, 'copy'),
      };
    },

    async deepRead({ source, figures, onProgress }) {
      const emit = typeof onProgress === 'function' ? onProgress : () => {};

      // 本地小模型：分段生成再合并，绕开「单次整篇写不满 / 被 LLM_TIMEOUT_MS 整篇截断」
      if (config.deepreadMultipass && name === 'ollama') {
        try {
          const mp = await deepReadMultipass(chat, source, figures, emit);
          if (mp.markdown && mp.markdown.length > 300) {
            return {
              markdown: mp.markdown,
              reasoning: mp.reasoning || '',
              style: checkStyle(mp.markdown, 'deepread'),
            };
          }
        } catch (err) {
          console.error('[deepread/multipass]', (err && err.message) || err);
          /* 失败回退到下面的单次整篇生成 */
        }
      }

      emit({ stage: 'generating' });
      const first = await chat(buildDeepReadMessages(source, figures), 16000);
      let content = first.content || '';

      // 自检自修：对照原文审校一遍（修正事实/术语/去 AI 味），并把文风体检问题一并整改
      if (config.qualityReview && content) {
        emit({ stage: 'review' });
        try {
          const styleHint = styleWarningsForPrompt(content, 'deepread');
          const review = await chat(buildDeepReviewMessages(source, content, styleHint), 16000);
          // 兜底：审校输出变成英文时丢弃，保留中文原稿
          if (review.content && review.content.trim() && isChineseText(review.content)) {
            content = review.content;
          }
        } catch {
          /* 审校失败，用原稿 */
        }
      }

      return {
        markdown: content || '（模型未返回内容，请稍后重试）',
        reasoning: first.reasoning || '',
        style: checkStyle(content || '', 'deepread'),
      };
    },
  };
}
