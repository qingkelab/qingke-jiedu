import { createCanvas } from '@napi-rs/canvas';
import { getPdfDocument } from './pdfjs.js';
import { config } from './config.js';

/**
 * 将 PDF 逐页渲染为 PNG。
 * @param {Buffer|Uint8Array} buffer
 * @returns {Promise<Array<{pageNumber:number, width:number, height:number, buffer:Buffer, label:string}>>}
 */
export async function pdfToImages(buffer) {
  const doc = await getPdfDocument(buffer);
  const total = Math.min(doc.numPages, config.maxPdfPages);
  const pages = [];

  for (let i = 1; i <= total; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: config.pdfScale });
    const width = Math.floor(viewport.width);
    const height = Math.floor(viewport.height);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    // 白底，避免透明 PDF 导出黑底
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    await page.render({ canvasContext: ctx, viewport }).promise;

    pages.push({
      pageNumber: i,
      width,
      height,
      buffer: canvas.toBuffer('image/png'),
      label: `第 ${i} 页`,
    });
    page.cleanup();
  }

  await doc.cleanup();
  return pages;
}

/**
 * 从 PDF 提取正文文本 + 元数据标题/作者（供 AI 文案使用）。
 */
export async function extractPdfInfo(buffer, maxChars = 9000) {
  const doc = await getPdfDocument(buffer);

  let metaTitle = '';
  let author = '';
  let creationDate = '';
  try {
    const md = await doc.getMetadata();
    metaTitle = (md && md.info && md.info.Title) || '';
    author = (md && md.info && md.info.Author) || '';
    creationDate = (md && md.info && md.info.CreationDate) || '';
  } catch {
    /* 元数据缺失时忽略 */
  }

  let text = '';
  const pages = Math.min(doc.numPages, 12);
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    text += tc.items.map((it) => (it && it.str ? it.str : '')).join(' ') + '\n';
    page.cleanup();
    if (text.length > maxChars) break;
  }
  await doc.cleanup();

  return {
    text: text
      .replace(/\s+/g, ' ')
      .replace(/provided proper attribution is provided[^.]*\.\s*/i, '')
      .trim()
      .slice(0, maxChars),
    title: metaTitle,
    author,
    creationDate,
  };
}
