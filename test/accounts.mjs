// Offline test of several CommaFeed accounts: runs the whole Worker against a fake fetch that
// plays two CommaFeed servers, and checks routing by ?acct=N, the OPDS account folders, the
// JSON account list, and that a single-account deployment is unchanged.
// Run: node test/accounts.mjs
import worker from '../src/index.js';
import { accountsFromEnv, pickAccount } from '../src/accounts.js';

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};

// ---- fake CommaFeed servers and Cloudflare cache
const calls = [];
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(input instanceof Request ? input.url : String(input));
  const auth = (init.headers && (init.headers.authorization || init.headers.Authorization)) || '';
  calls.push({ host: u.host, path: u.pathname, key: u.searchParams.get('apiKey'), auth });
  const who = u.host.startsWith('work') ? 'work' : 'home';
  if (u.pathname === '/rest/category/get') {
    return Response.json({ children: [{ id: 1, name: `${who} news`, feeds: [{ id: 7, name: `${who} feed`, unread: 2 }], children: [] }], feeds: [] });
  }
  if (u.pathname.endsWith('/entries')) {
    return Response.json({ name: 'All', hasMore: false, entries: [{ id: '42', title: `${who} article`, content: '<p>x</p>', feedName: `${who} feed`, date: 0 }] });
  }
  return new Response('not found', { status: 404 });
};
const ctx = { waitUntil: (p) => p && p.catch && p.catch(() => {}) };

const base = { OPDS_TOKEN: 'tok', COMMAFEED_URL: 'https://home.example', COMMAFEED_API_KEY: 'k1' };
const two = { ...base, COMMAFEED_LABEL: 'Personal', COMMAFEED_URL_2: 'https://work.example', COMMAFEED_API_KEY_2: 'k2', COMMAFEED_LABEL_2: 'Work' };
const get = async (env, path) => {
  const res = await worker.fetch(new Request('https://w.example/k/tok' + path), env, ctx);
  return { status: res.status, body: await res.text() };
};

// ---- account list from the environment
const accs = accountsFromEnv(two);
check('two accounts read', accs.length === 2 && accs[0].label === 'Personal' && accs[1].label === 'Work' && accs[1].baseUrl === 'https://work.example');
check('single account by default', accountsFromEnv(base).length === 1 && accountsFromEnv(base)[0].label === 'Account 1');
check('second account on the same server', accountsFromEnv({ ...base, COMMAFEED_USER_2: 'u', COMMAFEED_PASSWORD_2: 'p' })[1].baseUrl === 'https://home.example');
check('half-configured account ignored', accountsFromEnv({ ...base, COMMAFEED_USER_2: 'u' }).length === 1);
check('pickAccount', pickAccount(accs, null).n === 1 && pickAccount(accs, '2').n === 2 && pickAccount(accs, '9') === null);

// ---- single account: nothing changes
let r = await get(base, '/opds');
check('single: root is the usual menu', r.body.includes('<title>Unread</title>') && !r.body.includes('acct='), r.body.slice(0, 300));
r = await get(base, '/api');
check('single: api lists one account', JSON.parse(r.body).accounts.length === 1);

// ---- two accounts: OPDS root lists them, each folder opens the usual menu
r = await get(two, '/opds');
check('two: root lists the accounts', r.body.includes('<title>Personal</title>') && r.body.includes('<title>Work</title>') && !r.body.includes('<title>Unread</title>'), r.body.slice(0, 400));
check('two: account links carry acct', r.body.includes('acct=1') && r.body.includes('acct=2'));
r = await get(two, '/opds?acct=2');
check('two: account menu', r.body.includes('<title>Unread</title>') && r.body.includes('CommaFeed: Work'), r.body.slice(0, 400));
check('two: menu links keep acct', /\/opds\/unread\?acct=2/.test(r.body), r.body.slice(0, 600));

calls.length = 0;
r = await get(two, '/opds/unread?acct=2');
check('two: listing goes to the work server with its key', calls.length > 0 && calls.every((c) => c.host === 'work.example' && c.key === 'k2') && r.body.includes('work article'), JSON.stringify(calls));
check('two: book links keep acct', /\/book\/42\/[^"]*\.epub\?acct=2/.test(r.body), r.body.slice(0, 900));
calls.length = 0;
r = await get(two, '/opds/unread');
check('two: no acct = first account', calls.every((c) => c.host === 'home.example' && c.key === 'k1') && r.body.includes('home article'));

calls.length = 0;
const epub = await worker.fetch(new Request('https://w.example/k/tok/book/42/x.epub?acct=2'), two, ctx);
check('two: EPUB of account 2 built from the work server', epub.status === 200 && calls.length > 0 && calls.every((c) => c.host === 'work.example'), JSON.stringify(calls));

// ---- JSON API
r = await get(two, '/api');
const root = JSON.parse(r.body);
check('api: accounts with labels', JSON.stringify(root.accounts) === JSON.stringify([{ id: '1', label: 'Personal' }, { id: '2', label: 'Work' }]) && root.account === '1', r.body);
calls.length = 0;
r = await get(two, '/api/list?kind=unread&acct=2');
check('api: list from account 2', JSON.parse(r.body).items[0].title === 'work article' && calls.every((c) => c.host === 'work.example'));
r = await get(two, '/api/feeds?acct=2');
check('api: feeds from account 2', JSON.parse(r.body).items[0].name === 'work feed');
check('api: feeds carry the accounts', JSON.stringify(JSON.parse(r.body).accounts) === JSON.stringify(root.accounts), r.body);
r = await get(two, '/api/list?kind=unread&acct=2');
check('api: lists carry the accounts', JSON.stringify(JSON.parse(r.body).accounts) === JSON.stringify(root.accounts), r.body);
r = await get(two, '/api/list?kind=unread&acct=9');
check('api: unknown account is 404', r.status === 404);

// ---- CommaFeed hiccups: one 503 is retried, two are reported
let flaky = 1;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = new URL(input instanceof Request ? input.url : String(input));
  if (u.pathname === '/rest/category/get' && flaky > 0) { flaky--; return new Response('busy', { status: 503 }); }
  return realFetch(input, init);
};
r = await get(two, '/api/feeds?acct=2');
check('a single 503 from CommaFeed is retried', r.status === 200 && JSON.parse(r.body).items[0].name === 'work feed', r.body);
flaky = 2;
r = await get(two, '/api/feeds?acct=2');
check('two 503s in a row are reported', r.status === 502 && /HTTP 503/.test(r.body), `${r.status} ${r.body}`);
globalThis.fetch = realFetch;

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
