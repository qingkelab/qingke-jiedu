import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { config } from './config.js';

function buildMarkdown(meta) {
  const lines = [];
  lines.push(`# ${meta.title}`);
  lines.push('');
  lines.push(`> 来源：${meta.url}`);
  lines.push(`> 类型：${meta.type === 'pdf' ? '论文 PDF' : '网页'}`);
  if (meta.sourceTitle) lines.push(`> 原文标题：${meta.sourceTitle}`);
  if (meta.institution) lines.push(`> 机构：${meta.institution}`);
  if (meta.date) lines.push(`> 时间：${meta.date}`);
  lines.push('');
  lines.push('## 解读文案');
  lines.push('');
  lines.push(meta.copy);
  lines.push('');
  lines.push('## 备选标题');
  lines.push('');
  for (const t of meta.titles || []) lines.push(`- ${t}`);
  lines.push('');
  lines.push('## 图片清单');
  lines.push('');
  for (const img of meta.images || []) {
    lines.push(`- ${img.filename} — ${img.label}（${img.width}×${img.height}）`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 将渲染结果写入 output/{id}/，并打包 images.zip + summary.md。
 */
export async function saveResult(id, images, meta) {
  const dir = path.join(config.outputDir, id);
  await fs.mkdir(dir, { recursive: true });

  const saved = [];
  for (const img of images) {
    const filename = `${String(img.pageNumber).padStart(3, '0')}.png`;
    await fs.writeFile(path.join(dir, filename), img.buffer);
    saved.push({
      filename,
      pageNumber: img.pageNumber,
      width: img.width,
      height: img.height,
      label: img.label,
    });
  }

  const md = buildMarkdown({ ...meta, images: saved });
  await fs.writeFile(path.join(dir, 'summary.md'), md, 'utf-8');

  // 持久化结果元数据，供「同步到公众号」等后续操作读取
  await fs.writeFile(
    path.join(dir, 'result.json'),
    JSON.stringify({
      title: meta.title,
      titles: meta.titles || [],
      copy: meta.copy,
      type: meta.type,
      sourceTitle: meta.sourceTitle || '',
      institution: meta.institution || '',
      date: meta.date || '',
      url: meta.url || '',
      images: saved,
    }),
    'utf-8',
  );

  const zip = new AdmZip();
  for (const img of saved) zip.addFile(img.filename, await fs.readFile(path.join(dir, img.filename)));
  zip.addFile('summary.md', Buffer.from(md, 'utf-8'));
  zip.writeZip(path.join(dir, 'images.zip'));

  return { id, images: saved };
}
