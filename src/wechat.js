import { markdownToHtml, plainFromMarkdown } from './markdown.js';

const MAX_PIC = 20; // 公众号贴图（图片消息）最多 20 张
const tokenCache = new Map(); // appId -> { token, expiresAt }

/** 获取某公众号 access_token（按账号缓存，提前 5 分钟过期）。 */
async function getAccessToken(account) {
  const key = account.appId;
  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const url =
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential` +
    `&appid=${encodeURIComponent(account.appId)}&secret=${encodeURIComponent(account.appSecret)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`获取公众号 access_token 失败：${data.errmsg || JSON.stringify(data)}`);
  }
  tokenCache.set(key, {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 300) * 1000,
  });
  return data.access_token;
}

/** 上传永久图片素材，返回 { media_id, url }。 */
async function uploadImage(token, buffer, filename) {
  const form = new FormData();
  form.append('media', new Blob([buffer], { type: 'image/png' }), filename);
  const res = await fetch(
    `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${token}&type=image`,
    { method: 'POST', body: form, signal: AbortSignal.timeout(30000) },
  );
  const data = await res.json();
  if (!data.media_id) {
    throw new Error(`上传图片素材失败：${data.errmsg || JSON.stringify(data)}`);
  }
  return data;
}

/** 新建草稿，返回 { media_id }。 */
async function createDraft(token, article) {
  const res = await fetch(
    `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${token}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articles: [article] }),
      signal: AbortSignal.timeout(30000),
    },
  );
  const data = await res.json();
  if (data.errcode && data.errcode !== 0) {
    throw new Error(`新建草稿失败：${data.errmsg || JSON.stringify(data)}`);
  }
  if (!data.media_id) {
    throw new Error(`新建草稿失败（无 media_id）：${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * 同步到公众号「贴图」（图片消息，article_type=newspic）：首图为封面，最多 20 张。
 */
export async function syncWechatPic({ account, title, content = '', images = [] }) {
  if (!images.length) throw new Error('没有可上传的图片');
  if (images.length > MAX_PIC) {
    throw new Error(`公众号贴图最多支持 ${MAX_PIC} 张图片，当前选择了 ${images.length} 张`);
  }

  const token = await getAccessToken(account);
  const image_list = [];
  for (const img of images) {
    const up = await uploadImage(token, img.buffer, img.filename);
    image_list.push({ image_media_id: up.media_id });
  }

  const article = {
    article_type: 'newspic',
    title: title || '贴图',
    content: content || '',
    image_info: { image_list },
  };

  return createDraft(token, article);
}

/**
 * 同步到公众号「文章」（图文消息，article_type=news）：第一张图作封面，正文 Markdown 渲染为 HTML。
 */
export async function syncWechatArticle({ account, title, copy, images = [], sourceUrl = '' }) {
  if (!images.length) throw new Error('没有可用的图片作为封面图');

  const token = await getAccessToken(account);
  const thumb = await uploadImage(token, images[0].buffer, images[0].filename);

  const bodyHtml = markdownToHtml(copy, account.theme);
  const galleryHtml = [];
  for (const img of images) {
    const up = await uploadImage(token, img.buffer, img.filename);
    if (up.url) galleryHtml.push(`<p><img src="${up.url}" alt="${img.label}"/></p>`);
  }

  const article = {
    article_type: 'news',
    title,
    author: '',
    digest: plainFromMarkdown(copy).slice(0, 120),
    content: `${bodyHtml}${galleryHtml.join('')}`,
    content_source_url: sourceUrl || '',
    thumb_media_id: thumb.media_id,
  };

  return createDraft(token, article);
}

/** 下载远程图片（带超时）。 */
async function downloadImage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`下载图片失败 HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 同步「深度解读」为公众号文章：下载正文里实际用到的 CDN 图 → 上传素材库 → 替换链接 → 建文章草稿。
 */
export async function syncArticleFromMarkdown({
  account,
  title,
  markdown,
  figures = [],
  sourceUrl = '',
}) {
  const token = await getAccessToken(account);

  // 只处理正文里真正用到的图；若一张都没用，取第一张做封面
  const used = figures.filter((f) => markdown.includes(f.url));
  const toUpload = used.length ? used : figures.slice(0, 1);

  const urlMap = new Map();
  let thumbMediaId = '';
  for (const f of toUpload) {
    try {
      const buf = await downloadImage(f.url);
      const filename = f.url.split('/').pop() || 'img.png';
      const up = await uploadImage(token, buf, filename);
      if (up.url) urlMap.set(f.url, up.url);
      if (!thumbMediaId && up.media_id) thumbMediaId = up.media_id;
    } catch {
      /* 单张失败跳过 */
    }
  }

  let md = markdown;
  for (const [cdn, wx] of urlMap) md = md.split(cdn).join(wx);

  if (!thumbMediaId) throw new Error('没有可用的图片作为封面图');

  const article = {
    article_type: 'news',
    title,
    author: '',
    digest: plainFromMarkdown(markdown).slice(0, 120),
    content: markdownToHtml(md, account.theme),
    content_source_url: sourceUrl || '',
    thumb_media_id: thumbMediaId,
  };

  return createDraft(token, article);
}
