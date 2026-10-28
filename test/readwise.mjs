// Offline test of the Readwise relay through the whole Worker, with no CommaFeed configured.
// Run: node test/readwise.mjs
import worker from '../src/index.js';

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};

const env = { OPDS_USER: 'me', OPDS_PASS: 'pw', OPDS_TOKEN: 'tok' };
const basic = 'Basic ' + btoa('me:pw');
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init = {}) => {
  sent.push({ url: String(u), method: init.method, auth: init.headers && init.headers.authorization, body: init.body });
  if (String(u).includes('/slow0000/')) return new Response('{"detail":"Request was throttled."}', { status: 429, headers: { 'retry-after': '12' } });
  return new Response('{"id":"01abc","url":"https://read.readwise.io/read/01abc"}', { status: 200, headers: { 'content-type': 'application/json' } });
};
const post = (path, body, headers = {}) => worker.fetch(new Request('https://w.example' + path, { method: 'POST', body, headers }), env, {});

let r = await post('/readwise/update/01abc123', '{"location":"archive"}', { authorization: basic, 'x-readwise-token': 'RT' });
check('relayed as PATCH', r.status === 200 && sent.length === 1 && sent[0].method === 'PATCH'
  && sent[0].url === 'https://readwise.io/api/v3/update/01abc123/' && sent[0].auth === 'Token RT' && sent[0].body === '{"location":"archive"}', JSON.stringify(sent));
check('answer passed back', (await r.json()).id === '01abc');
r = await post('/k/tok/readwise/update/01abc123', '{"tags":["a"]}', { 'x-readwise-token': 'RT' });
check('path token works too', r.status === 200 && sent.length === 2);
r = await post('/readwise/update/01abc123', '{}', { 'x-readwise-token': 'RT' });
check('no Worker credentials: 401, nothing relayed', r.status === 401 && sent.length === 2);
r = await post('/readwise/update/01abc123', '{}', { authorization: 'Basic ' + btoa('me:wrong'), 'x-readwise-token': 'RT' });
check('wrong password: 401', r.status === 401 && sent.length === 2);
r = await post('/readwise/update/01abc123', '{}', { authorization: basic });
check('no Reader token: 400', r.status === 400 && sent.length === 2);
r = await post('/readwise/update/01abc123', 'not json', { authorization: basic, 'x-readwise-token': 'RT' });
check('bad body: 400', r.status === 400 && sent.length === 2);
r = await post('/readwise/update/../../v2/auth', '{}', { authorization: basic, 'x-readwise-token': 'RT' });
check('only the update endpoint (.. is resolved away, nothing relayed)', r.status >= 400 && sent.length === 2, String(r.status));
r = await post('/readwise/update/01abc%2F..%2Fx', '{}', { authorization: basic, 'x-readwise-token': 'RT' });
check('encoded slashes in the id: 404', r.status === 404 && sent.length === 2, String(r.status));
r = await post('/readwise/list/01abc123', '{}', { authorization: basic, 'x-readwise-token': 'RT' });
check('other relay paths: 404', r.status === 404 && sent.length === 2);
r = await worker.fetch(new Request('https://w.example/readwise/update/01abc123', { headers: { authorization: basic } }), env, {});
check('GET: 405', r.status === 405);
r = await post('/readwise/update/slow0000', '{"seen":true}', { authorization: basic, 'x-readwise-token': 'RT' });
check('rate limit passed back with Retry-After', r.status === 429 && r.headers.get('retry-after') === '12');
r = await post('/api/list', '{}', { authorization: basic });
check('POST elsewhere still 405', r.status === 405);
globalThis.fetch = realFetch;

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log('\nreadwise relay: all passed');
