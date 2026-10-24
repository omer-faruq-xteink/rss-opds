// CommaFeed accounts. Account 1 is the original configuration (COMMAFEED_URL, COMMAFEED_API_KEY
// or COMMAFEED_USER + COMMAFEED_PASSWORD, optional COMMAFEED_LABEL). Further accounts use the same
// names with a numeric suffix: COMMAFEED_API_KEY_2, COMMAFEED_URL_2, COMMAFEED_LABEL_2, ... up to
// MAX_ACCOUNTS. An account exists when it has credentials; a deployment that sets no suffixed
// variable behaves exactly as before. Requests pick one with ?acct=N (default 1).

export const MAX_ACCOUNTS = 5;

function readAccount(env, n) {
  const sfx = n === 1 ? '' : `_${n}`;
  const apiKey = env[`COMMAFEED_API_KEY${sfx}`];
  const username = env[`COMMAFEED_USER${sfx}`];
  const password = env[`COMMAFEED_PASSWORD${sfx}`];
  if (n > 1 && !apiKey && !(username && password)) return null;
  return {
    n,
    label: (env[`COMMAFEED_LABEL${sfx}`] || '').trim() || `Account ${n}`,
    // a second account on the same server needs no URL of its own
    baseUrl: env[`COMMAFEED_URL${sfx}`] || env.COMMAFEED_URL,
    apiKey,
    username,
    password,
  };
}

export function accountsFromEnv(env) {
  const list = [readAccount(env, 1)];
  for (let n = 2; n <= MAX_ACCOUNTS; n++) {
    const a = readAccount(env, n);
    if (a) list.push(a);
  }
  return list;
}

/** The account a request asks for: ?acct=N, or account 1 without the parameter; null if unknown. */
export function pickAccount(accounts, param) {
  if (param === null || param === undefined || param === '') return accounts[0];
  return accounts.find((a) => String(a.n) === String(param).trim()) || null;
}
