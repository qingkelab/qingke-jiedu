/**
 * 从 arXiv 链接里解析 ID，并调 arXiv API 拿精确标题/作者/发表时间。
 * 仅用于 arXiv 论文；非 arXiv 链接返回 null。
 */
export async function fetchArxivMeta(url) {
  let id;
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(v\d+)?/i);
    if (!m) return null;
    id = m[1];
  } catch {
    return null;
  }

  try {
    const res = await fetch(
      `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}&max_results=1`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) return null;
    const xml = await res.text();
    const entry = xml.match(/<entry>[\s\S]*?<\/entry>/);
    if (!entry) return null;
    const title = (entry[0].match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const authors = [...entry[0].matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => m[1]);
    const published = (entry[0].match(/<published>([\s\S]*?)<\/published>/) || [])[1] || '';
    return {
      title: title.replace(/\s+/g, ' ').trim(),
      authors: authors.join(', '),
      published,
    };
  } catch {
    return null;
  }
}
