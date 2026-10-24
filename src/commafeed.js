// CommaFeed API client.
// - REST API (/rest/...) accepts the user's API key as ?apiKey= on GET requests.
// - The Google Reader compatible API (/rest/googlereader/...) accepts the same
//   key as "Authorization: GoogleLogin auth=<key>" for GET and POST, which is
//   what lets us fetch one entry by id and mark it as read.

export class CommaFeedError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// CommaFeed (commafeed.com in particular) now and then answers 502 / 503 / 504 or drops the
// connection; one more try a moment later almost always goes through.
const RETRY_DELAY_MS = 400;
async function fetchRetry(url, init) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status < 500 || attempt > 0) return res;
      console.log(`CommaFeed HTTP ${res.status}, retrying: ${String(url).replace(/apiKey=[^&]+/, 'apiKey=…')}`);
    } catch (err) {
      if (attempt > 0) throw err;
      console.log(`CommaFeed fetch failed (${err && err.message}), retrying`);
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
}

export class CommaFeed {
  /**
   * Either an API key (recommended) or the account's username + password.
   * CommaFeed accepts HTTP Basic on every endpoint (it is what the KOReader
   * plugin uses); the API key only works on GET for the REST API, so the
   * Google Reader API is used for the write (mark as read) in that mode.
   */
  constructor({ baseUrl, apiKey, username, password }) {
    this.baseUrl = String(baseUrl || 'https://www.commafeed.com').replace(/\/+$/, '');
    this.apiKey = apiKey || '';
    this.basic = username && password ? 'Basic ' + btoa(unescape(encodeURIComponent(`${username}:${password}`))) : '';
    if (!this.apiKey && !this.basic) {
      throw new CommaFeedError('Set COMMAFEED_API_KEY (or COMMAFEED_USER + COMMAFEED_PASSWORD)', 500);
    }
  }

  async rest(path, { method = 'GET', params = {}, json } = {}) {
    const url = new URL(this.baseUrl + '/rest' + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const headers = { accept: 'application/json' };
    if (this.basic) headers.authorization = this.basic;
    else url.searchParams.set('apiKey', this.apiKey);
    let body;
    if (json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await fetchRetry(url, { method, headers, body });
    if (!res.ok) {
      throw new CommaFeedError(`CommaFeed ${path} failed: HTTP ${res.status}`, res.status);
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('json') ? res.json() : res.text();
  }

  async reader(path, { method = 'GET', params = {}, form } = {}) {
    const url = new URL(this.baseUrl + '/rest/googlereader/reader/api/0' + path);
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
      else if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const headers = { Authorization: this.basic || `GoogleLogin auth=${this.apiKey}` };
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const res = await fetchRetry(url, { method, headers, body });
    if (!res.ok) {
      throw new CommaFeedError(`CommaFeed reader ${path} failed: HTTP ${res.status}`, res.status);
    }
    return res;
  }

  /** Root category with nested children and subscriptions. */
  getRoot() {
    return this.rest('/category/get');
  }

  /**
   * List entries of a category ('all', 'starred' or a category id) or a subscription.
   * @returns {Promise<{name:string, entries:object[], hasMore:boolean}>}
   */
  entries({ kind = 'category', id = 'all', readType = 'unread', offset = 0, limit = 30, keywords, order = 'desc' }) {
    return this.rest(`/${kind}/entries`, { params: { id, readType, offset, limit, keywords, order } });
  }

  /** Fetch one entry by numeric id via the Google Reader API. */
  async getEntry(id) {
    const res = await this.reader('/stream/items/contents', { params: { i: id, output: 'json' } });
    const data = await res.json();
    const item = (data.items || [])[0];
    if (!item) return null;
    const link = (item.canonical || [])[0]?.href || (item.alternate || [])[0]?.href || '';
    return {
      id: String(id),
      title: item.title || '',
      author: item.author || '',
      content: item.summary?.content || '',
      url: link,
      feedName: item.origin?.title || '',
      date: item.published ? new Date(item.published * 1000) : null,
    };
  }

  /** Fallback: scan recent entries of 'all' for the id (works on servers without the Reader API). */
  async findEntryByScan(id, maxPages = 5, pageSize = 200) {
    for (let page = 0; page < maxPages; page++) {
      const data = await this.entries({ id: 'all', readType: 'all', offset: page * pageSize, limit: pageSize });
      const e = (data.entries || []).find((x) => String(x.id) === String(id));
      if (e) return normalizeRestEntry(e);
      if (!data.hasMore) break;
    }
    return null;
  }

  async markRead(id, read = true) {
    if (this.basic) {
      await this.rest('/entry/mark', { method: 'POST', json: { id: String(id), read } });
      return;
    }
    const tokenRes = await this.reader('/token');
    const token = (await tokenRes.text()).trim();
    const tag = 'user/-/state/com.google/read';
    await this.reader('/edit-tag', {
      method: 'POST',
      form: { i: String(id), [read ? 'a' : 'r']: tag, T: token },
    });
  }
}

export function normalizeRestEntry(e) {
  return {
    id: String(e.id),
    title: e.title || '',
    author: e.author || '',
    content: e.content || '',
    url: e.url || '',
    feedName: e.feedName || '',
    feedId: e.feedId ? String(e.feedId) : '',
    date: e.date ? new Date(e.date) : null,
    read: !!e.read,
    starred: !!e.starred,
    enclosureUrl: e.enclosureUrl || '',
    enclosureType: e.enclosureType || '',
  };
}
