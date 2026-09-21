/**
 * 深度解读各阶段提示词（plan / section / repair / 整篇兜底 / 审校）
 *
 * 与旧版最大的差别：正文不再喂「前 6000 / 16000 字」，而是喂
 *   ① 研究地图（全文级结论与证据定位）
 *   ② 本节检索到的 evidence chunks（带 chunk id，按相关性从全文召回）
 *   ③ 少量全局上下文（摘要、图片索引）
 * 并要求机制级解释、最小例子、Before/After/Diff/Trade-off、公式变量含义、数字必须有证据。
 */

import { renderResearchMap } from './researchMap.js';
import { renderEvidence } from './retrieval.js';

/**
 * 人声规则（去 AI 味）。
 *
 * 整理自社区流传的「去 AI 味」提示词（把「AI 模式」拆成可逐条删的清单 + 注入真实人声），
 * 按本项目的场景改写：原文是论文解读，不是营销稿，所以「删模式」保留、「躲检测」的诉求去掉，
 * 另外明确保留本项目自己的版式选择（小标题可用 emoji、破折号有上限而不是禁用）。
 * 每条都必须可执行：要么删，要么换成具体事实/动作动词/主动句。
 */
export function humanVoiceRules() {
  return [
    '  【删掉这些 AI 模式】',
    '  · 夸大规模：里程碑意义 / 至关重要 / 反映更广泛趋势 / 在持续演变的格局中 → 换成具体事实、日期、数字。',
    '  · 动名词假深度：突出了 / 反映了 / 促进了 / 彰显了 / 体现了 → 换成可核实的事实或动作动词。',
    '  · 广告腔与模糊归因：植根于 / 充满活力 / 革命性 / 无与伦比 / 专家认为 / 多个来源指出 → 要么精确引用，要么删掉。',
    '    论文解读里「专家认为」这种写法尤其危险：要么写清是哪篇论文的哪个 claim，要么不写。',
    '  · 滥用系动词：是 / 充当 / 构成 / 代表 / 被视为 → 改用动作动词或「有 / 拥有」。',
    '  · 被动与幽灵主语：「需要被配置」→「你需要配置」；主语写明确，动词用主动式。',
    '  · 三段式与同义轮换：不写「第一…第二…第三…」，同一个概念不换着说法写（核心主题→关键焦点）。',
    '  · 抽象名词空转：堆「范式、闭环、维度、生态」这类大词而没有具体动作时，落回具体对象。',
    '  · 客服与聊天机器人套话：希望对你有帮助 / 很棒的问题 / 总而言之 / 为了总结 / 期待你的回复 / 未来充满希望，一律不写。',
    '  · 过度谨慎的「可能」：只在真有不确定性时用，不要每句都加。',
    '  【注入真实人声】',
    '  · 节奏错落：长短句穿插，连续两段不要同一结构。',
    '  · 给出反应：对事实做出判断（仍与论文事实分句），不只是复述。',
    '  · 允许不确定与矛盾：证据不足就说不足，不硬圆。',
    '  · 第一人称：该用「我们」就用，不写「有人认为」这类无主语转述。',
    '  · 保留一点不整齐：口语、转折、插入语都可以有，不追求工整对仗。',
  ].join('\n');
}

/** 逐节注入的写作规则。 */
export function deepReadSectionRules() {
  return [
    '## 写作规则（每节都遵守）',
    '- 本文是原创解读不是逐句翻译；论文事实与「我们的判断」分开陈述。',
    '- 归因句式（硬性）：论文的主张一律写成「论文称 / 作者报告 / 该研究声称」；实验结果写成「实验显示 / 在 X 设置下报告为」；',
    '  只有「我们觉得 / 这更像是 / 现有证据更适合支持」才是编辑部判断。三种句子不混写，也不把判断写成领域共识。',
    '- 段首即观点句，先结论后论证；一个自然段至多一个加粗点，禁止整段加粗。',
    '- 术语：Agent/Harness/Policy/RL/SFT/RLHF/RLVR/Skill/World Model/benchmark 等社区通用词保留英文不硬译；方法/模型/数据集/机构名一律原文；新概念首次出现定形（英文全称（缩写）或 中文（英文））后与已写部分保持一致，禁止同一概念一处英文一处译名。',
    '- 数字纪律（硬性）：只写证据里出现的数字，且数字必须绑定条件——模型规模 / 数据集 / 任务 / 设置 / 基线 / 单位 / 指标口径缺一不可；',
    '  口径精确（提升至 vs 提升了、百分比写基数），小数与原文一致；表外（证据外）的数字一个都不写，宁可不写也不编造。',
    '  严禁把 estimate 写成精确事实、把定性 case 写成定量证据、把不同 protocol 的数字直接横比、把「图中排序位置」写成 benchmark ranking。',
    '- 研究边界词（首次 / 最强 / SOTA / 碾压 / 下一代 / 已经解决 / 证明 / 排名）：能不用就不用；',
    '  确实要写时必须紧跟来源归属（谁的 claim、在什么范围、什么条件下），不得写成领域共识或我们自己的结论。',
    '- 图片：正文讲到该图内容时用（图N）引用，N 用图片列表里的全局编号，把图放在最相关的段落；不要文末图注清单式罗列。',
    '- 去 AI 味：不用「不是A而是B/本质上/更重要的是/我的结论是」、无「随着…的发展」空泛开头、无「首先/其次/最后」「总而言之」、不排比三连、不空泛升华收尾。',
    ...humanVoiceRules().split('\n'),
    '- 与已写前文衔接自然：不重复前文已讲过的小节标题与结论，术语形态与行文口吻保持一致。',
    '- 证据里出现的 chunk 编号（如 [c12]）只给你定位用，**不要写进正文**。',
  ].join('\n');
}

/** 机制级解释要求（方法 / 方法类小节强制）。 */
const MECHANISM_REQUIREMENTS = [
  '## 本节必须达到机制级（硬性）',
  '- 每个关键组件都写清「输入 → 做了什么变换 → 输出」，不要只报组件名；',
  '- 至少给出 1 个最小例子，从输入一路走到输出（可以用一个具体样本/一个 3 步的小场景）；',
  '- 至少给出 1 个 Before / After / Diff / Trade-off：和旧做法比，最小差分是什么、代价是什么；',
  '- 关键公式保留 LaTeX 原样（行内 $...$、块级 $$...$$），并在首次出现处解释每个符号的含义与作用；',
  '- 不为了凑字数重复扩写：同一判断只说一次，宁可多给机制细节与证据。',
].join('\n');

/** 证据驱动要求（结果 / 局限类小节强制）。 */
const EVIDENCE_REQUIREMENTS = [
  '## 本节必须证据驱动（硬性）',
  '- 每个关键数字都要能追溯到证据片段里的原文说法（数据集/设置/基线/单位齐全），不要四舍五入或改写口径；',
  '- 区分「论文声称」「实验显示」「我们的判断」；证据不足时明说不足，不脑补；',
  '- 论文有消融就写消融（去掉某个组件/设置后发生什么），有失效条件就写边界；',
  '- 不为了凑字数重复扩写。',
].join('\n');

/**
 * 归因要求（全节强制）——迁移自青稞「技术解读稿件」规范：
 * 「实验结果的下一句必须写清这个实验不能回答什么」。
 */
const ATTRIBUTION_REQUIREMENTS = [
  '## 归因与边界（硬性）',
  '- 每个实验结果后面紧跟一句「这个实验不能回答什么」：协议覆盖不到的场景、没有做的对照、样本/规模限制。',
  '- 论文主张写「论文称 / 作者报告」；实验结论写「实验显示」；编辑部判断写「我们觉得 / 现有证据更适合支持」——三类句子分开。',
  '- 数字必须绑定条件（模型 / 数据集 / 任务 / 设置 / 基线 / 指标 / 单位）；缺条件的数字宁可不写。',
  '- 不写「下一代 / 已经解决 / 必将取代 / 证明了未来一定」这类越界结论；不做 winner / loser / ranking 判断。',
].join('\n');

/**
 * 边界小节（「它还没有证明什么」）的专属要求：这一节不是写缺点清单，
 * 而是把「哪些结论已经被证据支持、哪些还没有」划清楚。
 */
const LIMITATION_SECTION_REQUIREMENTS = [
  '## 本节定位：它还没有证明什么（硬性）',
  '- 逐条回答：论文想主张的每句大话里，哪部分有实验支撑、哪部分只是合理推测；',
  '- 覆盖显式 limitations、failure cases、伦理与 broader impacts、future work 中真正的限制；',
  '- 不要只找「limitations」这个词：附录里的失败案例、数据集偏差、评测协议差异同样算边界；',
  '- 每条边界用「哪个实验/哪组数据能证伪它」收尾，方便读者判断可信度。',
].join('\n');

/** 收尾小结的专属要求。 */
const SUMMARY_SECTION_REQUIREMENTS = [
  '## 本节定位：技术小结（硬性）',
  '- 用 3~5 句回答：作者真正改变了哪一层、证据支持到哪、还差什么验证；',
  '- 不复述前面小节的结论清单，只给「读者合上文章后该记住的那一条判断」；',
  '- 落在具体判断上，不写「能力飞轮 / 时代分水岭」这类空泛比喻或升华。',
].join('\n');

/** 第一步：规划大纲（基于全文结构 + 研究地图，而不是正文前 6000 字）。 */
export function buildPlanMessages({ source, structure, researchMap, figures }) {
  const figList = (figures || [])
    .map((f, i) => `图${f.num ?? i + 1}：${(f.caption || '').slice(0, 80)}${f.sectionTitle ? `（位于 ${f.sectionTitle}）` : ''}`)
    .join('\n');
  const toc = (structure?.sections || [])
    .map((s, i) => `${i + 1}. ${s.title}（${s.chunkIds.length} chunks）`)
    .join('\n');

  const sys = [
    '你是论文解读的栏目策划。下面给出一篇论文的**完整章节结构**与「研究地图」（问题/主张/方法/结果/消融/局限 + 证据定位）。',
    '请据此规划这篇论文「深度解读」的分节大纲。',
    '要求：',
    '- 共 5~7 节，顺序覆盖：①导语（论文回答什么问题、为什么现在值得读）②旧做法卡在哪/动机 ③作者产物与机制（最厚，可按需拆 2~3 节）④关键实验证据（含消融）⑤核心公式（有则单独成节或并入机制）⑥失效边界与后续可追问题 ⑦收尾的社区视角判断。',
    '- **两节不许省**（可以换标题措辞，但主题必须保留、role 必须对应）：',
    '  ① 一节专门回答「它还没有证明什么」（role: limitation）——显式局限、失败案例、伦理与 broader impacts、附录里的限制；',
    '  ② 一节收尾的「技术小结」（role: discussion）——3~5 句给读者一条可带走的判断，不复述目录。',
    '- 大纲必须覆盖全文，不要只写前半篇：实验/消融/局限各节都要在大纲里有落点；',
    '- 每节标题用结论句或名词短语，自然口语（可带 emoji），不要「引言/相关工作/背景介绍」这类栏目名，不要编号模板；',
    '- 每节的写作要点写明「这节要讲哪些证据」（例如「用表 2 的 BLEU 41.8 + 消融结果说明」）；',
    '- 规划时把论文图片安排到最相关的小节（图片列表见下）。',
    '输出格式：一行一节，用「｜」分隔 5 个字段：',
    '## 小节标题｜这节要回答的问题（≤40 字）｜sections: 原文小节名｜terms: 必用术语｜role: 角色',
    '字段说明（务必遵守）：',
    '- sections：这节对应的**论文原文小节名**，必须从上面「全文结构」里照抄（保留原文语言，不要翻译、不要自创），多个用 ; 分隔；',
    '  例：sections: Experiments; Ablation Study。对不上原文的会被判为未匹配，只能靠 terms 兜底；',
    '- terms：这一节真正必须出现的论文术语（模型/组件/数据集/benchmark/指标/表号/图号/消融变量），多个用 ; 分隔；',
    '  例：terms: self-attention; Table 3; label smoothing；',
    '- role：只能取 method | results | ablation | limitation | discussion | formula | intro | general 之一。',
    '不要输出任何其它内容。',
  ].join('\n');

  const ctx = [
    `标题：${source.title || '（无）'}`,
    `作者：${source.byline || ''}　时间：${source.date || ''}`,
    `全文结构（${structure?.stats?.chunkCount || 0} 个切片 / ${structure?.stats?.chars || 0} 字）：\n${toc || '（无）'}`,
    `研究地图：\n${renderResearchMap(researchMap, { maxChars: 2400 }) || '（无）'}`,
    `论文图片：\n${figList || '（无）'}`,
  ].join('\n\n');

  return [
    { role: 'system', content: sys },
    { role: 'user', content: `请给出大纲：\n\n${ctx}` },
  ];
}

/** 计划里允许的角色值（英文 / 中文都接受，统一归一化）。 */
const PLAN_ROLES = new Set(['method', 'results', 'ablation', 'limitation', 'discussion', 'formula', 'intro', 'general']);
const ROLE_ALIAS = {
  方法: 'method',
  机制: 'method',
  结果: 'results',
  实验: 'results',
  消融: 'ablation',
  局限: 'limitation',
  边界: 'limitation',
  讨论: 'discussion',
  结论: 'discussion',
  公式: 'formula',
  导语: 'intro',
  背景: 'intro',
};

const RE_SECTIONS = /^(?:source\s*sections?|sections?|原文小节|原文章节|对应小节|小节|章节)\s*[:：]\s*(.*)$/i;
const RE_TERMS = /^(?:must[\s-]*use[\s-]*terms?|terms?|keywords?|必用术语|必现术语|术语|关键词)\s*[:：]\s*(.*)$/i;
const RE_ROLE = /^(?:role|角色|类型)\s*[:：]\s*(.*)$/i;

function splitPlanList(value) {
  return String(value || '')
    .split(/[;；,，、]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizePlanRole(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (PLAN_ROLES.has(raw)) return raw;
  for (const [zh, en] of Object.entries(ROLE_ALIAS)) if (raw.includes(zh)) return en;
  return '';
}

/**
 * 解析大纲：返回 [{ title, purpose, note, role, sourceSections, mustUseTerms }]。
 *
 * 兼容两种输入：
 *   v1（旧）：`## 标题｜要点`
 *   v2（新）：`## 标题｜要点｜sections: Model Architecture; Attention｜terms: self-attention; Table 3｜role: method`
 * 字段缺失时保持兼容（sourceSections/mustUseTerms 为空数组，role 由 sectionRole 兜底推断）。
 */
export function parseDeepReadPlan(content) {
  const out = [];
  for (const line of String(content || '').split('\n')) {
    const m = line.trim().match(/^#{2,3}\s+(.+)$/);
    if (!m) continue;
    const parts = String(m[1])
      .split(/｜|\|/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const title = parts.shift() || '';
    if (!title) continue;
    let note = '';
    let role = '';
    let sourceSections = [];
    let mustUseTerms = [];
    for (const part of parts) {
      let hit = part.match(RE_SECTIONS);
      if (hit) {
        sourceSections = splitPlanList(hit[1]);
        continue;
      }
      hit = part.match(RE_TERMS);
      if (hit) {
        mustUseTerms = splitPlanList(hit[1]);
        continue;
      }
      hit = part.match(RE_ROLE);
      if (hit) {
        role = normalizePlanRole(hit[1]);
        continue;
      }
      if (!note) note = part;
    }
    out.push({
      title,
      note: note || '',
      purpose: note || '',
      role: role || '',
      sourceSections,
      mustUseTerms,
    });
    if (out.length >= 7) break;
  }
  return out;
}

/** 兜底大纲：模型没给出可用大纲时按社区解读骨架走。 */
export function defaultDeepReadPlan() {
  return [
    { title: '为什么值得读这篇论文？', note: '导语：回答什么问题、为什么现在值得读、作者给出什么', role: 'intro', sourceSections: [], mustUseTerms: [] },
    { title: '旧方法卡在哪，作者换了个什么思路', note: '动机、旧做法局限、产物概览', role: 'intro', sourceSections: [], mustUseTerms: [] },
    { title: '核心机制：组件怎么从输入走到输出', note: '机制逐组件拆解 + 最小例子（全文最厚的一节）', role: 'method', sourceSections: [], mustUseTerms: [] },
    { title: '关键公式与实验证据有多硬', note: '公式（如有）+ 有坐标的数字、消融与它改变/推翻的判断', role: 'results', sourceSections: [], mustUseTerms: [] },
    { title: '它还没有证明什么', note: '显式局限 / 失败案例 / 伦理与 broader impacts / 每个实验不能回答什么（必写节）', role: 'limitation', sourceSections: [], mustUseTerms: [] },
    { title: '技术小结：它值不值得跟进', note: '3~5 句可带走的判断：改变了哪一层、证据支持到哪、还差什么验证（必写节）', role: 'discussion', sourceSections: [], mustUseTerms: [] },
  ];
}

/**
 * 写某一节：注入研究地图 + 本节检索到的证据 + 全局上下文 + 已写前文。
 */
export function buildDeepReadSectionMessages({
  source,
  figures,
  plan,
  index,
  prevMd,
  evidence = [],
  globalContext = '',
  researchMap = null,
  role = 'general',
  auditHints = [],
  facts = [],
}) {
  const total = plan.length;
  const sec = plan[index];
  const figList = (figures || [])
    .map((f, i) => `图${f.num ?? i + 1}：${(f.caption || '（无图注）').slice(0, 120)}`)
    .join('\n');
  const outline = plan.map((s, i) => `${i + 1}. ${s.title}`).join('\n');
  const needMechanism = role === 'method' || role === 'formula' || index === 2;
  const needEvidence = role === 'results' || role === 'limitation';
  // 必写小节（迁移自青稞解读规范）：边界小节与收尾小结。标题由计划决定，主题不许省。
  const needBoundary = role === 'limitation' || /还没有证明|未证明|失效|边界|局限/.test(sec.title || '');
  const needSummary = role === 'discussion' && index === total - 1;

  // Writer v3：把「必须写出来的事实 / 必须保留的数字 / 允许的推导 / 禁止的编造」结构化给模型，
  // 而不是让它从证据片段里自己猜哪些是重点。
  const factList = (facts || []).filter(Boolean);
  const mustNumbers = [];
  for (const f of factList) {
    for (const n of f.mustUseNumbers || []) {
      if (!n || n.value == null) continue;
      if (mustNumbers.some((x) => x.value === String(n.value) && x.factId === f.id)) continue;
      mustNumbers.push({ factId: f.id, value: String(n.value), term: n.term || '', chunkIds: n.chunkIds || [] });
    }
  }
  const mustCoverBlock = factList.length
    ? [
        '### MUST COVER（本节必须写出来的论文事实；写不出来就明说证据不足，不要用泛化句搪塞）',
        ...factList.map(
          (f) =>
            `- [${f.id}]（${f.category}${f.priority === 'high' ? '·high' : ''}，来源：${f.sourceSections?.join('、') || f.origin || 'source'}）${f.claim}`,
        ),
      ].join('\n')
    : '';
  const mustNumbersBlock = mustNumbers.length
    ? [
        '### MUST USE NUMBERS（这些数字必须出现在本节，且与原文一致）',
        ...mustNumbers.map((n) => `- ${n.term ? `${n.term}: ` : ''}${n.value}${n.chunkIds.length ? `（来源 chunk ${n.chunkIds.join(',')}）` : ''}`),
      ].join('\n')
    : '';

  const sys = [
    '你是「技术解释者」：既让零背景读者读得进去，也让懂行读者能复核机制、证据与边界。',
    '',
    deepReadSectionRules(),
    '',
    needMechanism ? MECHANISM_REQUIREMENTS : '',
    needMechanism ? '' : '',
    needEvidence ? EVIDENCE_REQUIREMENTS : '',
    needEvidence ? '' : '',
    ATTRIBUTION_REQUIREMENTS,
    '',
    needBoundary ? LIMITATION_SECTION_REQUIREMENTS : '',
    needBoundary ? '' : '',
    needSummary ? SUMMARY_SECTION_REQUIREMENTS : '',
    needSummary ? '' : '',
    '## 任务',
    `这是深度解读的第 ${index + 1}/${total} 节。`,
    `标题（必须原样使用，作为本节的 Markdown H2）：## ${sec.title}`,
    `本节写作要点：${sec.note || '（自由展开）'}`,
    // Retrieval v2：把「本节对应的原文小节 + 必用术语」显式交给写作者，
    // 让检索到的证据（source-local / mustUseTerms）真的在这节被用掉。
    (sec.sourceSections || []).length ? `本节对应的论文原文小节：${sec.sourceSections.join('、')}` : '',
    (sec.mustUseTerms || []).length
      ? `本节必须出现的论文术语（原文形态，不要翻译；至少覆盖大部分）：${sec.mustUseTerms.join('、')}`
      : '',
    index === 0
      ? '本节是全文开头：前 1~3 段内完成「论文回答什么问题 → 为什么现在值得读 → 作者给出什么」，允许口语化设问开场。'
      : index === total - 1
        ? '本节是全文收尾：给具体的社区视角判断（与既有工作的关系、可复现性、最该补的验证），落在一个可被讨论的具体判断上，不升华成金句。'
        : '本节是正文主体：机制/证据/公式相关时尽量写厚，逐组件、逐证据展开，不要一两段带过。',
    '正文目标：本节写 450–1000 字（机制、证据、公式相关节往 800 字以上写）；只输出这一节内容（从「## …」开始到本节结束），不要输出 # 文档大标题，不要复述或预告其它小节，不要写「第 x 节」。',
    '只依据给定的证据片段写作；证据没提到的机制细节、数字、结论不要编造。',
  ]
    .filter(Boolean)
    .join('\n');

  const ctx = [
    `论文：${source.title || '（无）'}　作者：${source.byline || ''}　时间：${source.date || ''}`,
    `全文大纲：\n${outline}`,
    researchMap ? `研究地图（全文级，供对齐口径）：\n${renderResearchMap(researchMap, { maxChars: 2000 })}` : '',
    globalContext ? `全局上下文（摘要与图片索引）：\n${globalContext}` : '',
    mustCoverBlock,
    `### SOURCE EVIDENCE（从全文检索得到，共 ${evidence.length} 条；chunk id 只给你定位，不要写进正文）：\n${
      renderEvidence(evidence) || '（无检索结果，请依据研究地图与全局上下文写作，不要编造细节）'
    }`,
    mustNumbersBlock,
    factList.length
      ? '### DERIVED ALLOWED\n- 可以基于上面的 source 数字做换算/差值（例如「20 分钟 × 2fps = 2400 帧」），但**必须写成「按论文数据计算」这类明确措辞**，不得让推导数字看起来像论文直接给出的数值。'
      : '',
    factList.length
      ? '### DO NOT INVENT\n- 不得补论文里没有的数字、benchmark、数据集或结论；证据不足时直接说证据不足；你自己的判断（interpretation）要与论文事实分开写。'
      : '',
    auditHints.length ? `上一轮证据审计提出的整改要求（本次必须解决）：\n${auditHints.map((h) => `- ${h}`).join('\n')}` : '',
    `论文图片（编号即（图N）的 N）：\n${figList || '（无）'}`,
    prevMd ? `已写前文（衔接与术语保持一致，不要重复其内容）：\n${prevMd}` : '（这是第一节，没有前文）',
  ]
    .filter(Boolean)
    .join('\n\n');

  return [
    { role: 'system', content: sys },
    { role: 'user', content: `请撰写第 ${index + 1} 节：\n\n${ctx}` },
  ];
}

/**
 * 定点修复 v2：只重写有问题的那一节（不整篇重生成）。
 * 除了审计提出的 missing number/entity/formula，还接收「Fact Coverage 判定没写出来的事实」。
 */
export function buildSectionRepairMessages({
  source,
  sectionTitle,
  currentBody,
  hints = [],
  evidence = [],
  researchMap = null,
  figures = [],
  missingFacts = [],
}) {
  const sys = [
    '你是论文解读的修订编辑。下面这一节在「证据审计」中出了问题，请按要求**只重写这一节**。',
    '硬性要求：',
    '1. 只输出这一节的 Markdown（从「## 标题」开始），标题保持不变；',
    '2. 只修审计指出的问题，其余内容与行文风格保持原样，不要顺手改写无关段落；',
    '3. 数字与结论必须来自给定证据片段；证据里没有的数字删掉，不要换成别的数字；',
    '4. **不得新增或删除小节、不得引入新事实**；',
    '5. 不得把「按论文数据计算」的推导数字写成论文直接给出的数值；',
    '6. 不要写 chunk id，不要解释你在做什么。',
  ].join('\n');

  const factsBlock = (missingFacts || []).length
    ? [
        '## 本节还缺的论文事实（必须补进正文；证据不足就明说证据不足，不要用泛化句搪塞）',
        ...missingFacts.map(
          (f) =>
            `- [${f.factId}]（${f.status}${f.priority === 'high' ? '·high' : ''}）${f.claim}` +
            (f.mustUseNumbers?.length ? `\n    必须出现的数字：${f.mustUseNumbers.map((n) => n.value).join('、')}` : '') +
            (f.chunkIds?.length ? `\n    依据 chunk：${f.chunkIds.join(',')}` : ''),
        ),
      ].join('\n')
    : '';
  const ctx = [
    `论文：${source.title || '（无）'}`,
    `本节标题：## ${sectionTitle}`,
    factsBlock,
    `审计问题与整改要求：\n${hints.map((h) => `- ${h}`).join('\n') || '-（未提供具体提示）'}`,
    researchMap ? `研究地图（口径对齐）：\n${renderResearchMap(researchMap, { maxChars: 1600 })}` : '',
    `可用证据片段：\n${renderEvidence(evidence) || '（无）'}`,
    `可用图片：\n${(figures || []).map((f) => `图${f.num}：${(f.caption || '').slice(0, 80)}`).join('\n') || '（无）'}`,
    `当前这一节内容：\n${currentBody}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  return [
    { role: 'system', content: sys },
    { role: 'user', content: ctx },
  ];
}

/** 深度解读自检自修：对照原文审校并输出修正后的完整 Markdown。 */
export function buildDeepReviewMessages(source, markdown, styleHint = '', { evidenceText = '' } = {}) {
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
    '   结构里必须有「它还没有证明什么」这一节（显式局限 / 失败案例 / 伦理与 broader impacts / 附录限制）与一节的「技术小结」；',
    '   缺了就补上，被合并进别节的要拆回来；这一节不是缺点清单，而是划清「哪部分有证据、哪部分还只是推测」；',
    '10. 去 AI 味与转述腔：无「不是A而是B/本质上/更重要的是/我的结论是」、无「随着…的发展」空泛开头、无「首先/其次/最后」「总而言之」、',
    '   无「我们提出/本文研究」式开场、无整段加粗；',
    '11. 结构完整、自然收尾，不套模板编号。',
    '12. 归因与边界：论文主张写成「论文称/作者报告」，实验结果写成「实验显示」，编辑部判断写成「我们觉得/现有证据更适合支持」，',
    '   三者不得混写；每个实验结果后要有一句「这个实验不能回答什么」；',
    '   边界词（首次/最强/SOTA/碾压/下一代/已经解决/证明/排名）能删则删，必须保留的补上来源归属，不得写成领域共识；',
    '13. 人声检查（逐条删模式）：',
    humanVoiceRules(),
    styleHint ? `14. 文风体检整改（只调整表达与分段，不得改动事实与结构）：\n${styleHint}` : '',
    '15. 交付前自检：先按上面 13 条静默通读一遍，挑出仍然机械的残留（模板句、空泛升华、成串被动、同义轮换），改掉之后再输出；',
    '   只输出最终 Markdown，不要输出自检过程、修改摘要或前言。',
  ].filter(Boolean).join('\n');
  const ctx = [
    `原文证据（用于核对数字、公式与结论）：\n${String(evidenceText || source.text || '').slice(0, 24000)}`,
    `待审校报告：\n${markdown}`,
  ].join('\n\n');
  return [
    { role: 'system', content: sys },
    { role: 'user', content: ctx },
  ];
}

/** 论文深度解读：六部分 Markdown 图文报告，图片以 CDN 形式嵌入。 */
export function buildDeepReadMessages(source, figures, { extraContext = '' } = {}) {
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
    '  5) **它还没有证明什么**（必写节，不许省）：显式局限、失败案例、伦理与 broader impacts、附录里的限制；',
    '     每个关键实验结果后面都要写清「这个实验不能回答什么」，不是罗列缺点清单；',
    '  6) 后续可追的问题：3~5 条追问，像给自己列阅读提纲（方法还没验证什么、最想看到的对照/消融实验、接下来该读哪类工作）；',
    '  7) **技术小结**（必写节）：3~5 句给读者一条可带走的判断——改变了哪一层、证据支持到哪、还差什么验证；',
    '     再补一句**具体的社区视角判断**（不是复述论文）：与既有/相邻工作的关系、可复现性（代码/硬件/数据是否齐全）、',
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
    '- 数字与条件绑定：表外（证据外）的数字一个都不写；严禁把 estimate 写成精确事实、把 qualitative case 写成定量证据、',
    '  把不同 protocol 的数字直接横比、把「图中排序位置」写成 benchmark ranking。',
    '- 口径精确：「提升至 X」是终值、「提升了 X」是增量；百分比变化写清基数；小数位与原文一致。',
    '- 关键数字所在句子可整句加粗单列（一段仍至多一个加粗点）。',
    '- 区分立场（硬性）：论文主张写成「论文称 / 作者报告」；实验结果显示写成「实验显示 / 在 X 设置下报告为」；',
    '  「我们的判断/解读/推测」明示（可用「我们觉得」「这更像是」），三类句子不混写，不把判断写成领域共识。',
    '- 研究边界词（首次/最强/SOTA/碾压/下一代/已经解决/证明/排名）：能删则删，必须保留的补上来源归属。',
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
    '## 去 AI 味：逐条删模式 + 注入人声',
    humanVoiceRules(),
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
    extraContext,
  ].filter(Boolean).join('\n\n');

  return [
    { role: 'system', content: sys.join('\n') },
    { role: 'user', content: `请解读这篇论文：\n\n${context}` },
  ];
}
