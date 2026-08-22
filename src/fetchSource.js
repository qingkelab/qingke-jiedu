import { config } from './config.js';

const PDF_MAGIC = '%PDF-';

function looksLikePdfUrl(url) {
  try {
    const u = new URL(url);
    const p = u.pathname.toLowerCase();
    return p.endsWith('.pdf') || p.includes('.pdf?');
  } catch {
    return false;
  }
}

async function httpGet(url, { binary = false } = {}) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(config.fetchTimeoutMs),
    headers: {
      'User-Agent': config.userAgent,
      Accept:
        'text/html,application/xhtml+xml,application/pdf,application/x-pdf,*/*;q=0.8',
    },
  });
  if (!res.ok) {
    throw new Error(`抓取失败 HTTP ${res.status} ${res.statusText}`);
  }
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const body = binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
  return { body, contentType, finalUrl: res.url || url };
}

/**
 * 下载并识别来源类型：PDF 论文 或 网页。
 * @returns {{type:'pdf', buffer:Buffer, finalUrl:string} | {type:'webpage', html:string, finalUrl:string}}
 */
export async function fetchSource(url) {
  const raw = await httpGet(url, { binary: true });

  const isPdf =
    looksLikePdfUrl(url) ||
    raw.contentType.includes('pdf') ||
    raw.body.subarray(0, 5).toString() === PDF_MAGIC;

  if (isPdf) {
    return { type: 'pdf', buffer: raw.body, finalUrl: raw.finalUrl };
  }

  // 网页：重新以文本方式取回（避免 buffer 转码问题），兼容 gbk 等常见编码兜底
  let html;
  try {
    const text = await httpGet(url);
    html = text.body;
  } catch {
    html = raw.body.toString('utf-8');
  }
  return { type: 'webpage', html, finalUrl: raw.finalUrl };
}
