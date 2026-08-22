const $ = (sel) => document.querySelector(sel);

const form = $('#form');
const urlInput = $('#url');
const submitBtn = $('#submit');
const statusEl = $('#status');
const statusText = $('#status-text');
const errorEl = $('#error');
const resultEl = $('#result');
const deepResultEl = $('#deepresult');
let currentId = null;
let currentCopy = '';
let selectedFiles = new Set();
let currentMode = 'pic'; // pic | deep

function setStatus(msg, show = true) {
  statusEl.hidden = !show;
  statusText.textContent = msg;
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
  resultEl.hidden = true;
  deepResultEl.hidden = true;
}

function copyText(text) {
  return navigator.clipboard
    ? navigator.clipboard.writeText(text)
    : Promise.reject(new Error('clipboard 不可用'));
}

function toast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  Object.assign(t.style, {
    position: 'fixed', bottom: '28px', left: '50%', transform: 'translateX(-50%)',
    background: '#1f2329', color: '#fff', padding: '9px 18px', borderRadius: '999px',
    fontSize: '13px', zIndex: 99, boxShadow: '0 8px 24px rgba(0,0,0,.2)',
  });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

function triggerDownload(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function updateSelCount() {
  const el = $('#sel-count');
  const n = selectedFiles.size;
  el.hidden = n === 0;
  el.textContent = `已选 ${n} 张`;
}

function setAllSelected(selected) {
  document.querySelectorAll('#gallery .tile-check').forEach((c) => {
    if (c.checked !== selected) c.click();
  });
}

// 示例 chip
document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    urlInput.value = chip.dataset.url;
  });
});

// 模式切换
function setMode(mode) {
  currentMode = mode;
  $('#mode-pic').classList.toggle('active', mode === 'pic');
  $('#mode-deep').classList.toggle('active', mode === 'deep');
  $('#submit').textContent = mode === 'deep' ? '生成深度解读' : '生成图文';
  urlInput.placeholder =
    mode === 'deep'
      ? 'https:// 输入 arXiv 论文链接（abs/pdf/html）'
      : 'https:// 输入论文 PDF 链接或网页链接';
}
$('#mode-pic').addEventListener('click', () => setMode('pic'));
$('#mode-deep').addEventListener('click', () => setMode('deep'));
setMode('pic');

// 公众号账号列表（单选按钮，渲染到多个容器）
let wechatAccounts = [];
function renderAccountRadios() {
  ['#wechat-account', '#deep-wechat-account'].forEach((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.innerHTML = '';
    if (!wechatAccounts.length) {
      el.innerHTML = '<span class="muted">未配置公众号凭证</span>';
      return;
    }
    wechatAccounts.forEach((a, i) => {
      const label = document.createElement('label');
      label.className = 'radio-option';
      label.innerHTML =
        `<input type="radio" name="${sel.slice(1)}" value="${a.index}" ${i === 0 ? 'checked' : ''} /> <span>${escapeHtml(a.name)}</span>`;
      el.appendChild(label);
    });
  });
}
function getSelectedAccount(sel) {
  const el = document.querySelector(`${sel} input[type="radio"]:checked`);
  return el ? Number(el.value) : 0;
}
async function loadWechatAccounts() {
  try {
    const res = await fetch('/api/wechat/accounts');
    const data = await res.json();
    wechatAccounts = data.accounts || [];
  } catch {
    wechatAccounts = [];
  }
  renderAccountRadios();
}
loadWechatAccounts();

// 主流程
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  errorEl.hidden = true;
  resultEl.hidden = true;
  deepResultEl.hidden = true;
  submitBtn.disabled = true;
  setStatus('正在抓取内容…');

  const isDeep = currentMode === 'deep';
  const start = Date.now();
  const stages = isDeep
    ? [
        [2000, '正在抽取论文图片…'],
        [5000, '正在生成深度解读报告…'],
      ]
    : [
        [1500, '正在渲染图片…'],
        [4000, '正在生成解读文案与标题…'],
      ];
  const timer = setInterval(() => {
    const elapsed = Date.now() - start;
    let msg = stages[stages.length - 1][1];
    for (const [t, m] of stages) {
      if (elapsed < t) { msg = m; break; }
    }
    setStatus(msg);
  }, 250);

  try {
    const res = await fetch(isDeep ? '/api/deepread' : '/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (isDeep) renderDeep(data);
    else render(data);
  } catch (err) {
    showError('处理失败：' + (err.message || err));
  } finally {
    clearInterval(timer);
    submitBtn.disabled = false;
    setStatus('', false);
  }
});

function renderDeep(d) {
  errorEl.hidden = true;
  resultEl.hidden = true;
  deepResultEl.hidden = false;
  currentId = d.id;

  $('#deep-title').textContent = d.title || d.source?.title || '';
  $('#deep-origin').textContent = [d.institution, d.date].filter(Boolean).join(' · ');
  $('#deep-fig-count').textContent = `${(d.figures || []).length} 张图（CDN 嵌入）`;
  $('#deep-render').innerHTML = renderMarkdown(d.markdown);
  $('#deep-copy').onclick = () =>
    copyText(d.markdown).then(() => toast('Markdown 已复制')).catch(() => toast('复制失败'));
  $('#deep-md-btn').href = d.markdownUrl;

  // 深度解读同步为公众号文章
  const deepNote = $('#deep-sync-note');
  deepNote.textContent = '';
  $('#deep-sync-wechat').onclick = async () => {
    deepNote.textContent = '正在同步为公众号文章…';
    try {
      const res = await fetch('/api/sync/wechat-article', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: d.title,
          markdown: d.markdown,
          figures: d.figures || [],
          sourceUrl: d.arxivUrl || '',
          accountIndex: getSelectedAccount('#deep-wechat-account'),
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        deepNote.textContent = `已同步到「${data.account}」的文章草稿（media_id: ${data.draft.media_id}），到公众号后台「草稿箱」查看。`;
        toast(`已同步文章到${data.account}`);
      } else if (data.needCreds) {
        deepNote.textContent = '未配置公众号凭证：请到公众号后台手动发布。';
      } else {
        throw new Error(data.error || data.message || '同步失败');
      }
    } catch (err) {
      deepNote.textContent = '同步失败：' + (err.message || err);
    }
  };

  deepResultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function render(d) {
  errorEl.hidden = true;
  resultEl.hidden = false;
  currentId = d.id;

  $('#meta-type').textContent = d.type === 'pdf' ? '📄 论文 PDF' : '🌐 网页';
  $('#meta-provider').textContent = '文案引擎：' + d.provider;
  $('#meta-title').textContent = d.source.title || d.source.url;
  const origin = [d.source.institution, d.source.date].filter(Boolean).join(' · ');
  $('#meta-origin').textContent = origin;

  // 图片
  selectedFiles = new Set();
  $('#img-count').textContent = `${d.images.length} 张`;
  $('#zip-btn').href = d.zipUrl;
  updateSelCount();
  const gallery = $('#gallery');
  gallery.innerHTML = '';
  d.images.forEach((img) => {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.innerHTML = `
      <input type="checkbox" class="tile-check" data-filename="${img.filename}" title="选择上传" />
      <img src="${img.url}" alt="${img.label}" loading="lazy" />
      <div class="tile-foot">
        <span>${img.label} · ${img.width}×${img.height}</span>
        <a class="tile-dl" href="/download/${d.id}/${img.filename}" download>下载</a>
      </div>`;
    const check = tile.querySelector('.tile-check');
    check.addEventListener('change', () => {
      if (check.checked) selectedFiles.add(img.filename);
      else selectedFiles.delete(img.filename);
      tile.classList.toggle('selected', check.checked);
      updateSelCount();
    });
    tile.querySelector('img').addEventListener('click', () => openLightbox(img));
    gallery.appendChild(tile);
  });

  // 文案
  currentCopy = d.copy.text;
  $('#copy-count').textContent = `${d.copy.charCount} 字 / ≤1000`;
  $('#copy-render').innerHTML = renderMarkdown(currentCopy);
  $('#copy-src').textContent = currentCopy;
  $('#copy-copy').onclick = () =>
    copyText(stripMarkdown(currentCopy)).then(() => toast('文案已复制')).catch(() => toast('复制失败'));
  $('#md-btn').href = d.markdownUrl;
  setCopyView('preview');

  // 标题
  $('#title-count').textContent = `每条约 ≤20 字`;
  const titlesEl = $('#titles');
  titlesEl.innerHTML = '';
  d.titles.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'title-row' + (i === 0 ? ' main' : '');
    row.innerHTML = `
      <span class="num">${i + 1}</span>
      <span class="txt">${escapeHtml(t.text)}</span>
      <span class="cnt">${t.charCount} 字</span>
      <button class="copy">复制</button>`;
    row.querySelector('.copy').onclick = () =>
      copyText(t.text).then(() => toast('标题已复制')).catch(() => toast('复制失败'));
    titlesEl.appendChild(row);
  });

  // 同步发布
  const syncNote = $('#sync-note');
  $('#sync-hint').textContent =
    '选公众号账号后，把勾选的图片同步为「贴图」；需认证服务号凭证，否则打包下载图片。X：打开发帖框预填标题。';
  syncNote.textContent = '';

  $('#sync-x').onclick = () => {
    const text = d.title.text;
    window.open('https://twitter.com/intent/tweet?text=' + encodeURIComponent(text), '_blank', 'noopener');
    copyText(text).then(() => toast('已打开 X 发帖框，标题已复制')).catch(() => toast('已打开 X 发帖框'));
  };

  $('#sync-wechat').onclick = async () => {
    if (selectedFiles.size === 0) {
      toast('请先在图片上勾选要上传的图片');
      return;
    }
    syncNote.textContent = '正在生成公众号「贴图」草稿…';
    try {
      const res = await fetch('/api/sync/wechat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: d.id,
          filenames: [...selectedFiles],
          accountIndex: getSelectedAccount('#wechat-account'),
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        syncNote.textContent = `已同步到「${data.account}」的贴图草稿（media_id: ${data.draft.media_id}），到公众号后台「草稿箱」查看。`;
        toast(`已同步贴图到${data.account}`);
      } else if (data.needCreds) {
        triggerDownload(d.zipUrl);
        window.open('https://mp.weixin.qq.com/', '_blank', 'noopener');
        syncNote.textContent = '未配置公众号凭证：已打包下载图片，请到公众号后台手动上传。';
        toast('已打包图片，请手动上传');
      } else {
        throw new Error(data.error || data.message || '同步失败');
      }
    } catch (err) {
      syncNote.textContent = '同步失败：' + (err.message || err);
    }
  };

  resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 极简 Markdown → HTML（标题/加粗/列表/引用/代码/表格/围栏代码，先转义防 XSS）。 */
function renderMarkdown(md) {
  const inline = (s) => {
    let t = escapeHtml(s);
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy" />');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    return t;
  };
  const splitRow = (line) => {
    let t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|')) t = t.slice(0, -1);
    return t.split('|').map((c) => c.trim());
  };
  const isTableSep = (line) => {
    const cells = splitRow(line);
    return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
  };

  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let listType = null;
  let para = [];
  const closeList = () => {
    if (listType) { html += `</${listType}>`; listType = null; }
  };
  const flushPara = () => {
    if (para.length) { html += `<p>${inline(para.join(' '))}</p>`; para = []; }
  };

  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trimEnd().trim();
    if (!t) { flushPara(); closeList(); i++; continue; }

    // 围栏代码块 ```...```
    if (/^```/.test(t)) {
      flushPara(); closeList();
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { code.push(lines[i]); i++; }
      i++; // 跳过结束 ```
      html += `<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`;
      continue;
    }

    // 表格
    if (t.startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara(); closeList();
      const header = splitRow(t);
      const body = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim().startsWith('|')) { body.push(splitRow(lines[j])); j++; }
      let tbl = '<table><thead><tr>';
      header.forEach((h) => { tbl += `<th>${inline(h)}</th>`; });
      tbl += '</tr></thead><tbody>';
      body.forEach((row) => {
        tbl += '<tr>';
        row.forEach((c) => { tbl += `<td>${inline(c)}</td>`; });
        tbl += '</tr>';
      });
      tbl += '</tbody></table>';
      html += tbl;
      i = j;
      continue;
    }

    const h = t.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      flushPara(); closeList();
      const level = Math.min(h[1].length + 2, 6);
      html += `<h${level}>${inline(h[2])}</h${level}>`;
      i++; continue;
    }
    const ul = t.match(/^[-*]\s+(.+)$/);
    if (ul) {
      flushPara();
      if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
      html += `<li>${inline(ul[1])}</li>`;
      i++; continue;
    }
    const ol = t.match(/^\d+[.)]\s+(.+)$/);
    if (ol) {
      flushPara();
      if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
      html += `<li>${inline(ol[1])}</li>`;
      i++; continue;
    }
    const bq = t.match(/^>\s?(.+)$/);
    if (bq) {
      flushPara(); closeList();
      html += `<blockquote>${inline(bq[1])}</blockquote>`;
      i++; continue;
    }
    para.push(t);
    i++;
  }
  flushPara();
  closeList();
  return html;
}

/** 去掉 Markdown 符号，得到可粘贴的纯文本。 */
function stripMarkdown(md) {
  return String(md || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) =>
      l
        .replace(/^\s*#{1,4}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^\s*[-*]\s+/, '• ')
        .replace(/^\s*\d+[.)]\s+/, ''),
    )
    .join('\n')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

/** 切换文案「预览 / Markdown 源码」视图。 */
function setCopyView(view) {
  $('#copy-render').hidden = view !== 'preview';
  $('#copy-src').hidden = view !== 'src';
  $('#view-preview').classList.toggle('active', view === 'preview');
  $('#view-src').classList.toggle('active', view === 'src');
}

// Lightbox
const lightbox = $('#lightbox');
const lightboxImg = $('#lightbox-img');
const lightboxDl = $('#lightbox-dl');

// 文案视图切换
$('#view-preview').addEventListener('click', () => setCopyView('preview'));
$('#view-src').addEventListener('click', () => setCopyView('src'));

// 图片选择
$('#sel-all').addEventListener('click', () => setAllSelected(true));
$('#sel-clear').addEventListener('click', () => setAllSelected(false));

function openLightbox(img) {
  lightboxImg.src = img.url;
  lightboxDl.href = `/download/${currentId}/${img.filename}`;
  lightbox.hidden = false;
}

$('#lightbox-close').addEventListener('click', () => (lightbox.hidden = true));
lightbox.addEventListener('click', (e) => {
  if (e.target === lightbox) lightbox.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') lightbox.hidden = true;
});
