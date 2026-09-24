/**
 * 手写字体：霞鹜文楷 Lite（LXGW WenKai Lite，SIL OFL 1.1）。
 *
 * 为什么不能直接引用字体文件：Chrome 在离屏页面里**不允许**加载 `file://` 字体
 * （实测 file:// 与不存在的字体渲染结果的 PNG 哈希完全相同），所以字体必须以
 * `data:` 形式内联进 SVG。
 *
 * 为什么要按需内联：字体包是按 unicode-range 切成 190+ 个小 woff2（每个约 50KB），
 * 一张海报通常只用 300~500 个汉字 → 只挑覆盖这些码点的分片，内联体积约 1~2MB，
 * 而不是把 4MB 全塞进去。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.resolve(HERE, '../../assets/fonts/lxgw-wenkai-lite');
export const HAND_FONT_FAMILY = 'LXGW WenKai Lite';

let faceCachePromise = null;

/** 解析 CSS 里的 @font-face（font-family / src / unicode-range）。 */
function parseFaces(css, dir) {
  const faces = [];
  for (const block of css.split('@font-face').slice(1)) {
    const file = (block.match(/url\('([^']+)'\)/) || [])[1];
    // 注意：unicode-range 常是块内最后一条声明，结尾没有分号 → 用 [^;}]+ 兜住
    const ranges = (block.match(/unicode-range:\s*([^;}]+)/) || [])[1];
    if (!file || !ranges) continue;
    const parsed = [];
    for (const part of ranges.split(',')) {
      const m = part.trim().match(/^U\+([0-9a-fA-F]+)(?:-([0-9a-fA-F]+))?$/);
      if (!m) continue;
      parsed.push([parseInt(m[1], 16), m[2] ? parseInt(m[2], 16) : parseInt(m[1], 16)]);
    }
    faces.push({ file: path.resolve(dir, file.replace(/^\.\//, '')), ranges: parsed });
  }
  return faces;
}

/** 读取并解析字体包（只读一次，进程内缓存）。 */
export async function loadHandFont() {
  if (!faceCachePromise) {
    faceCachePromise = (async () => {
      try {
        const css = await fs.readFile(path.join(FONT_DIR, 'lxgwwenkailite-regular.css'), 'utf-8');
        const faces = parseFaces(css, FONT_DIR);
        return { dir: FONT_DIR, faces, available: faces.length > 0 };
      } catch {
        return { dir: FONT_DIR, faces: [], available: false };
      }
    })();
  }
  return faceCachePromise;
}

const codePointsOf = (text) => [...new Set([...String(text || '')].map((c) => c.codePointAt(0)))];
const covers = (face, codes) => codes.some((cp) => face.ranges.some(([lo, hi]) => cp >= lo && cp <= hi));

/**
 * 生成只覆盖给定文本的 @font-face 规则（字体以 base64 内联）。
 * @returns {Promise<string>} CSS 文本；字体缺失时返回空串（调用方退化成系统字体栈）
 */
export async function buildHandFontCss(text, { maxFaces = 80 } = {}) {
  const font = await loadHandFont();
  if (!font.available) return '';
  const codes = codePointsOf(text);
  const picked = [];
  for (const face of font.faces) {
    if (!covers(face, codes)) continue;
    picked.push(face);
    if (picked.length >= maxFaces) break;
  }
  if (!picked.length) return '';
  const rules = [];
  for (const face of picked) {
    const buf = await fs.readFile(face.file).catch(() => null);
    if (!buf) continue;
    rules.push(
      `@font-face{font-family:'${HAND_FONT_FAMILY}';font-style:normal;font-weight:400;font-display:block;` +
        `src:url(data:font/woff2;base64,${buf.toString('base64')}) format('woff2');}`,
    );
  }
  return rules.join('');
}

/** 海报里会被手写字体覆盖的文字（标题/副标题/正文标签等）。 */
export function posterTextOf(content = {}, structure = {}) {
  return [
    content.title,
    content.subtitle,
    ...(content.steps || []),
    ...(content.claims || []),
    ...(content.tags || []),
    ...(content.numbers || []).flatMap((n) => [n.value, n.label, n.condition]),
    content.formula?.caption,
    structure.reason,
    '青稞解读论文深度解读视觉结构核心公式取舍与边界术语与来源方案保留去掉数值结论数字长度按数值等比红色为最大项从论文到推论黑色原文事实蓝色本文推演红色边界取舍',
  ]
    .filter(Boolean)
    .join('');
}
