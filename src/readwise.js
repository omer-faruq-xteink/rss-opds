// Relay for the Readwise Reader mini app. The Xteink reader sends only GET and POST (PATCH,
// PUT and DELETE never get an answer on XTOS Licorice), and Reader changes a document only by
// PATCH, so the app reads Reader directly and posts its changes here:
//
//   POST /readwise/update/<document id>   body: the JSON Reader's update endpoint takes
//        header X-Readwise-Token: <the user's Reader access token>
//   -> PATCH https://readwise.io/api/v3/update/<document id>/ with "Authorization: Token ...",
//      Reader's status and answer passed back (Retry-After too, for its rate limit).
//
// The route sits behind the Worker's own authentication like everything else, needs no
// CommaFeed account, and relays nothing but that one Reader endpoint.

const READER_UPDATE = 'https://readwise.io/api/v3/update/';
const MAX_BODY = 16 * 1024;

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

/** path: the route after authentication. Returns a Response, or null when it is not a /readwise route. */
export async function handleReadwise(request, path) {
  if (!path.startsWith('/readwise/')) return null;
  const m = /^\/readwise\/update\/([0-9A-Za-z]{6,64})\/?$/.exec(path);
  if (!m) return json({ error: 'not found' }, 404);
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
  const token = (request.headers.get('x-readwise-token') || '').trim();
  if (!token) return json({ error: 'X-Readwise-Token header missing' }, 400);
  const body = await request.text();
  if (body.length > MAX_BODY) return json({ error: 'body too large' }, 413);
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
  } catch {
    return json({ error: 'body must be a JSON object' }, 400);
  }
  const res = await fetch(READER_UPDATE + m[1] + '/', {
    method: 'PATCH',
    headers: { authorization: `Token ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body,
  });
  const headers = { 'content-type': res.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' };
  const retry = res.headers.get('retry-after');
  if (retry) headers['retry-after'] = retry;
  return new Response(await res.text(), { status: res.status, headers });
}
