// Full-text "sanitizers": external article extractors tried in order before
// the EPUB is built, mirroring the KOReader rssreader plugin. Each returns the
// article body HTML or null; the chain falls back to the feed content.
// Network waits do not count toward the Workers CPU limit, so slow services
// (Diffbot renders pages server-side) are fine on the free plan.

const MIN_MEANINGFUL = 150; // chars, after trimming (same threshold as the plugin)
const FETCH_TIMEOUT_MS = 45_000;

function meaningful(html) {
  return typeof html === 'string' && html.trim().length >= MIN_MEANINGFUL;
}

function textToParagraphs(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ps = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => `<p>${esc(l)}</p>`);
  return ps.length ? ps.join('') : null;
}

async function call(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs || FETCH_TIMEOUT_MS) });
  return res;
}

async function readJson(res) {
  try { return await res.json(); } catch { return null; }
}

// ---- Instaparser: POST {url, output:"html"} with a Bearer token.
async function instaparser(env, { url }) {
  const endpoint = env.INSTAPARSER_ENDPOINT || 'https://www.instaparser.com/api/1/article';
  const res = await call(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.INSTAPARSER_TOKEN}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ url, output: 'html' }),
  });
  if (!res.ok) throw new Error(`instaparser HTTP ${res.status}`);
  const data = await readJson(res);
  if (!data || data.error) throw new Error(`instaparser error: ${data?.error || 'bad json'}`);
  if (meaningful(data.html)) return data.html;
  const fb = data.text ? textToParagraphs(data.text) : null;
  return meaningful(fb) ? fb : null;
}

// ---- Diffbot: GET /v3/analyze?token&url&timeout, one retry on 429.
async function diffbot(env, { url }) {
  const endpoint = env.DIFFBOT_ENDPOINT || 'https://api.diffbot.com/v3/analyze';
  const timeoutMs = parseInt(env.DIFFBOT_TIMEOUT_MS || '20000', 10) || 20000;
  const u = new URL(endpoint);
  u.searchParams.set('token', env.DIFFBOT_TOKEN);
  u.searchParams.set('url', url);
  u.searchParams.set('timeout', String(timeoutMs));
  if (env.DIFFBOT_MODE) u.searchParams.set('mode', env.DIFFBOT_MODE);
  let res = await call(u, { headers: { accept: 'application/json' }, timeoutMs: timeoutMs + 15_000 });
  if (res.status === 429) {
    const ra = parseInt(res.headers.get('retry-after') || '5', 10);
    const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 10) : 5;
    await new Promise((r) => setTimeout(r, wait * 1000));
    res = await call(u, { headers: { accept: 'application/json' }, timeoutMs: timeoutMs + 15_000 });
  }
  if (!res.ok) throw new Error(`diffbot HTTP ${res.status}`);
  const data = await readJson(res);
  if (!data || data.error || data.errorCode) throw new Error(`diffbot error: ${data?.error || data?.errorCode || 'bad json'}`);
  let fallbackText = null;
  for (const obj of data.objects || []) {
    if (!obj || typeof obj !== 'object') continue;
    if (typeof obj.html === 'string' && obj.html.trim() && (obj.type !== 'other' || meaningful(obj.html))) return obj.html;
    if (!fallbackText) {
      const t = typeof obj.text === 'string' && obj.text.trim() ? obj.text : obj.content;
      if (typeof t === 'string' && t.trim()) fallbackText = t;
    }
  }
  const fb = fallbackText ? textToParagraphs(fallbackText) : null;
  return meaningful(fb) ? fb : null;
}

// ---- Instapaper API v2 with a personal access token: save bookmark, parse, delete.
// Best-effort pause (per isolate) after 401/402/403 so every article does not
// spend a save+delete to learn the token is refused or the credit is gone.
let instapaperPausedUntil = 0;
const INSTAPAPER_PAUSE_MS = 3600_000;
const FRESH_BOOKMARK_SECONDS = 120;

async function instapaper(env, { url, title }) {
  if (Date.now() < instapaperPausedUntil) throw new Error('instapaper paused');
  const base = (env.INSTAPAPER_API_BASE || 'https://www.instapaper.com/api/2').replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${env.INSTAPAPER_TOKEN}`, accept: 'application/json' };
  const req = async (method, path, body) => {
    const init = { method, headers: { ...headers } };
    if (body) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    const res = await call(base + path, init);
    return { res, data: await readJson(res) };
  };
  const pauseOn = (status) => { if (status === 401 || status === 402 || status === 403) instapaperPausedUntil = Date.now() + INSTAPAPER_PAUSE_MS; };

  const save = await req('POST', '/bookmarks', title ? { url, title } : { url });
  if (!save.res.ok || !save.data || typeof save.data.id !== 'number') {
    pauseOn(save.res.status);
    throw new Error(`instapaper save HTTP ${save.res.status}`);
  }
  const id = save.data.id;
  const serverNow = Date.parse(save.res.headers.get('date') || '') / 1000;
  const preexisting = typeof save.data.time === 'number' && Number.isFinite(serverNow) && serverNow - save.data.time > FRESH_BOOKMARK_SECONDS;

  const parse = await req('GET', `/bookmarks/${id}/parse`);
  if (!preexisting) {
    try { await req('DELETE', `/bookmarks/${id}`); } catch { /* best effort */ }
  }
  if (!parse.res.ok) {
    pauseOn(parse.res.status);
    throw new Error(`instapaper parse HTTP ${parse.res.status}`);
  }
  const content = parse.data && parse.data.content;
  let body = content && typeof content.body === 'string' ? content.body : null;
  if (!body || !body.trim()) return null;
  if (content.direction === 'rtl') body = `<div dir="rtl">${body}</div>`;
  return meaningful(body) ? body : null;
}

export const SANITIZERS = {
  instaparser: { secret: 'INSTAPARSER_TOKEN', run: instaparser },
  diffbot: { secret: 'DIFFBOT_TOKEN', run: diffbot },
  instapaper: { secret: 'INSTAPAPER_TOKEN', run: instapaper },
};

/** Names of the sanitizers that are both listed (SANITIZERS var) and have a token. */
export function configuredChain(env) {
  const order = String(env.SANITIZERS || 'instaparser,diffbot,instapaper')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return order.filter((name) => SANITIZERS[name] && env[SANITIZERS[name].secret]);
}

/**
 * Try the chain in order. Resolves to {html, source} or null.
 * Results are cached (Cache API) for 24h per article URL + chain.
 */
export async function extractFullText(env, chain, { url, title }, { cache, waitUntil } = {}) {
  if (!url || !chain.length) return null;
  const cacheKey = cache
    ? new Request(`https://cache.commafeed-opds.invalid/fulltext/${chain.join('-')}/${encodeURIComponent(url)}`)
    : null;
  if (cacheKey) {
    const hit = await cache.match(cacheKey);
    if (hit) { try { return await hit.json(); } catch { /* fall through */ } }
  }
  for (const name of chain) {
    try {
      const html = await SANITIZERS[name].run(env, { url, title });
      if (meaningful(html)) {
        const result = { html, source: name };
        if (cacheKey) {
          const stored = new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=86400' } });
          const p = cache.put(cacheKey, stored);
          if (waitUntil) waitUntil(p); else await p;
        }
        return result;
      }
      console.log(`sanitizer ${name}: no meaningful content for ${url}`);
    } catch (err) {
      console.log(`sanitizer ${name} failed for ${url}: ${err && err.message}`);
    }
  }
  return null;
}
