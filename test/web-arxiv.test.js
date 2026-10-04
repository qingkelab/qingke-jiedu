// 浏览器版（web/）的 arXiv 检索链路：免代理优先，逐级回退，最后给出可操作的错误。
// 全部用假 fetch，不发真实网络请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectBackend,
  fetchArxivMeta,
  mapOpenAlexWork,
  parseArxivHtmlMeta,
  resetBackendProbe,
  searchArxiv,
  searchViaOpenAlex,
} from '../web/lib/arxiv.js';

const ATOM = `<?xml version="1.0"?><feed>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <title>Attention Is All You Need</title>
    <published>2017-06-12T00:00:00Z</published>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
  </entry>
</feed>`;

const ARXIV_HTML = `<html><head><title>Attention Is All You Need</title></head><body>
  <h1 class="ltx_title ltx_title_document">Attention Is All You Need</h1>
  <div class="ltx_authors">
    <span class="ltx_personname">Ashish Vaswani <a href="#fn1">1</a></span>
    <span class="ltx_personname">Noam Shazeer <a href="#fn1">1</a></span>
    <span class="ltx_personname">Niki Parmar</span>
  </div>
</body></html>`;

/** 安装假 fetch，记录请求；handler(url) 返回 Response 形状。 */
function installFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push(String(url));
    return handler(String(url), init);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const json = (data, status = 200) => ({
  ok: status < 400,
  status,
  async json() {
    return data;
  },
  async text() {
    return JSON.stringify(data);
  },
});

const text = (body, status = 200) => ({
  ok: status < 400,
  status,
  async text() {
    return body;
  },
  async json() {
    return JSON.parse(body);
  },
});

const silence = () => {
  throw new TypeError('Failed to fetch');
};

// 这些模块是给浏览器写的：Node 里没有 location，测试时补一个假的同源地址
test.beforeEach(() => {
  globalThis.location = { origin: 'http://127.0.0.1:4780' };
  resetBackendProbe();
});
test.afterEach(() => {
  resetBackendProbe();
  delete globalThis.location;
});

// ============ 纯函数 ============

test('mapOpenAlexWork：只保留能定位到 arXiv 的结果（DOI 或 locations）', () => {
  const byDoi = mapOpenAlexWork({
    doi: 'https://doi.org/10.48550/arXiv.2501.12948',
    display_name: 'DeepSeek-R1',
    publication_date: '2025-01-22',
    authorships: [{ author: { display_name: 'A' } }, { author: { display_name: 'B' } }],
  });
  assert.equal(byDoi.id, '2501.12948');
  assert.equal(byDoi.url, 'https://arxiv.org/abs/2501.12948');

  const byLocation = mapOpenAlexWork({
    display_name: 'OpenVLA',
    publication_date: '2024-06-14',
    locations: [{ landing_page_url: 'https://arxiv.org/abs/2406.09246v2' }],
  });
  assert.equal(byLocation.id, '2406.09246');

  assert.equal(mapOpenAlexWork({ doi: 'https://doi.org/10.5281/zenodo.1', display_name: 'x' }), null, '非 arXiv 结果丢掉');
});

test('parseArxivHtmlMeta：从 /html/ 页取标题与作者（去掉脚注编号，不猜日期）', () => {
  const meta = parseArxivHtmlMeta(ARXIV_HTML, '1706.03762');
  assert.equal(meta.title, 'Attention Is All You Need');
  assert.equal(meta.authors, 'Ashish Vaswani, Noam Shazeer, Niki Parmar');
  assert.equal(meta.published, '', 'HTML 里没有日期就留空，不编');
});

// ============ 搜索链路 ============

test('搜索：同源后端可用时优先走后端（浏览器没有跨域问题）', async () => {
  const fake = installFetch((url) => {
    if (url.includes('/api/arxiv/search')) {
      if (url.includes('max=1')) return json({ papers: [{ id: 'x', title: 'probe' }] });
      return json({ papers: [{ id: '1706.03762', title: 'Attention Is All You Need' }] });
    }
    return silence();
  });
  try {
    const papers = await searchArxiv({ days: 3, category: 'cs.CL' });
    assert.equal(papers.source, 'backend');
    assert.equal(papers[0].id, '1706.03762');
    assert.ok(fake.calls.some((u) => u.includes('/api/arxiv/search?days=3')));
  } finally {
    fake.restore();
  }
});

test('搜索：没有后端、没有代理、有关键词 → 走 OpenAlex（免代理）', async () => {
  const fake = installFetch((url) => {
    if (url.includes('/api/arxiv/search')) throw new TypeError('Failed to fetch'); // 没有后端
    if (url.startsWith('https://api.openalex.org/works')) {
      return json({
        results: [
          { display_name: 'Non-arXiv thing', doi: 'https://doi.org/10.5281/zenodo.9' },
          {
            display_name: 'Vision-Language-Action Models',
            doi: 'https://doi.org/10.48550/arXiv.2406.09246',
            publication_date: '2024-06-14',
            authorships: [{ author: { display_name: 'Moo Jin Kim' } }],
          },
        ],
      });
    }
    return silence();
  });
  try {
    const papers = await searchArxiv({ days: 3650, keyword: 'VLA', max: 20 });
    assert.equal(papers.source, 'openalex');
    assert.equal(papers.length, 1, '非 arXiv 结果应被过滤掉');
    assert.equal(papers[0].id, '2406.09246');
    assert.ok(!fake.calls.some((u) => u.includes('export.arxiv.org')), '不该去碰需要跨域的官方 API');
  } finally {
    fake.restore();
  }
});

test('搜索：配置了代理则走 arXiv 官方 API（最准）', async () => {
  const fake = installFetch((url) => {
    if (url.includes('/api/arxiv/search')) throw new TypeError('Failed to fetch');
    if (url.startsWith('https://proxy.test/?url=')) return text(ATOM);
    return silence();
  });
  try {
    const papers = await searchArxiv({ days: 3, category: 'cs.CL', keyword: 'attention', proxy: 'https://proxy.test/?url=' });
    assert.equal(papers.length, 1);
    assert.equal(papers[0].id, '1706.03762');
    assert.ok(fake.calls.some((u) => u.startsWith('https://proxy.test/?url=') && decodeURIComponent(u).includes('export.arxiv.org')));
  } finally {
    fake.restore();
  }
});

test('搜索：全都失败时报错要说清「怎么办」，不再只说去填代理', async () => {
  const fake = installFetch(() => silence());
  try {
    await assert.rejects(() => searchArxiv({ days: 3 }), (err) => {
      assert.match(err.message, /不支持跨域直连/);
      assert.match(err.message, /填一个关键词/, '要给免代理的出路');
      assert.match(err.message, /CORS 代理/, '也要给代理的出路');
      assert.match(err.message, /已尝试：/, '要列出试过哪些渠道');
      return true;
    });
  } finally {
    fake.restore();
  }
});

test('searchViaOpenAlex：没有关键词直接拒绝（OpenAlex 的「最新」几乎不是 arXiv）', async () => {
  await assert.rejects(() => searchViaOpenAlex({ keyword: '' }), /需要关键词/);
});

// ============ 元数据链路 ============

test('元数据：没有后端/代理时走 arXiv HTML 页（/html/ 带 CORS）', async () => {
  const fake = installFetch((url) => {
    if (url.includes('/api/arxiv/search')) throw new TypeError('Failed to fetch');
    if (url.startsWith('https://arxiv.org/html/')) return text(ARXIV_HTML);
    return silence();
  });
  try {
    const meta = await fetchArxivMeta('1706.03762');
    assert.equal(meta.source, 'arxiv-html');
    assert.equal(meta.title, 'Attention Is All You Need');
    assert.match(meta.authors, /Ashish Vaswani/);
  } finally {
    fake.restore();
  }
});

test('元数据：有代理时优先官方 API（带日期）', async () => {
  const fake = installFetch((url) => {
    if (url.includes('/api/arxiv/search')) throw new TypeError('Failed to fetch');
    if (url.startsWith('https://proxy.test/?url=')) return text(ATOM);
    return silence();
  });
  try {
    const meta = await fetchArxivMeta('1706.03762', 'https://proxy.test/?url=');
    assert.equal(meta.source, 'arxiv-api');
    assert.equal(meta.published, '2017-06-12');
  } finally {
    fake.restore();
  }
});

test('元数据：同源后端可用时用后端（本地跑 server.js 的场景）', async () => {
  const fake = installFetch((url) => {
    if (url.includes('/api/arxiv/search')) return json({ papers: [{ id: 'x' }] });
    if (url.includes('/api/arxiv/meta')) return json({ id: '1706.03762', title: 'Attention Is All You Need', authors: 'A', published: '2017-06-12' });
    return silence();
  });
  try {
    const meta = await fetchArxivMeta('1706.03762');
    assert.equal(meta.source, 'backend');
    assert.equal(meta.published, '2017-06-12');
  } finally {
    fake.restore();
  }
});

test('detectBackend：返回 HTML（GitHub Pages 上的 /api/... 会 404 到 index.html）时判定为无后端', async () => {
  const fake = installFetch(() => ({
    ok: true,
    status: 200,
    async json() {
      throw new SyntaxError('Unexpected token <');
    },
  }));
  try {
    assert.equal(await detectBackend(), false);
  } finally {
    fake.restore();
  }
});

test('detectBackend：探测结果会被缓存（同一次会话只探测一次）', async () => {
  let hits = 0;
  const fake = installFetch(() => {
    hits += 1;
    return json({ papers: [] });
  });
  try {
    await detectBackend();
    await detectBackend();
    assert.equal(hits, 1);
  } finally {
    fake.restore();
  }
});
