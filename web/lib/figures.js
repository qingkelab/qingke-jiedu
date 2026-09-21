/**
 * 「（图N）」引用处插图：与 server.js 中 injectFigures 同一套逻辑（浏览器版复刻）。
 * 模型没引用够 3 张时按图注关键词匹配到最相关段落，保证图文不分离。
 */
const FIG_STOPWORDS = new Set(
  'the and for with from that this our are were was using between of in on to a an is as by vs versus left right top bottom figure fig show shows showing shown result results overview comparison table example examples also not but or than we they it its each all both two one illustration diagram schematic'.split(' '),
);

function captionKeywords(caption) {
  return (String(caption || '').toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []).filter(
    (w) => !FIG_STOPWORDS.has(w),
  );
}

function blockScore(block, keywords) {
  const low = block.toLowerCase();
  let s = 0;
  for (const kw of keywords) if (low.includes(kw)) s += 1;
  return s;
}

function figImageLines(figure, n) {
  const alt = String(figure.caption || `图 ${n}`).replace(/[[\]]/g, '');
  const lines = [`![${alt}](${figure.url})`];
  if (String(figure.caption || '').trim()) lines.push(`> 图 ${n}：${alt}`);
  return lines;
}

export function injectFigures(markdown, figures) {
  if (!figures || !figures.length) return markdown;
  const blocks = String(markdown || '').split(/\n\n+/);
  const images = blocks.map(() => []);
  const used = new Set();

  figures.forEach((f, i) => {
    const n = i + 1;
    const re = new RegExp(`图\\s*${n}(?![0-9])`);
    const bi = blocks.findIndex((b) => re.test(b));
    if (bi >= 0) {
      images[bi].push(...figImageLines(f, n));
      used.add(i);
    }
  });

  const MIN = 3;
  if (used.size < MIN) {
    const need = MIN - used.size;
    const missing = figures.map((_, i) => i).filter((i) => !used.has(i)).slice(0, need);
    missing.forEach((fi, k) => {
      const n = fi + 1;
      const kws = captionKeywords(figures[fi].caption);
      let pos = -1;
      let bestScore = 0;
      if (kws.length) {
        for (let b = 0; b < blocks.length; b++) {
          const s = blockScore(blocks[b], kws);
          if (s > bestScore) {
            bestScore = s;
            pos = b;
          }
        }
      }
      if (pos < 0 || bestScore < 2) {
        const denom = missing.length + 1;
        pos = Math.min(blocks.length - 1, Math.floor((blocks.length * (k + 1)) / denom));
      }
      while (pos > 0 && !blocks[pos].trim()) pos--;
      images[pos].push(...figImageLines(figures[fi], n));
    });
  }

  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    out.push(blocks[i].trimEnd());
    for (const img of images[i]) out.push(img);
  }
  return out.join('\n\n');
}
