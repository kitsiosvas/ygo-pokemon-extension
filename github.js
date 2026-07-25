/*
 * GitHub integration for Competitive packs: a merged PR you authored earns
 * one pack credit. Talks to either github.com or a GitHub Enterprise Server
 * instance via a personal access token (VS Code's built-in
 * `vscode.authentication` GitHub provider only targets github.com, so on-prem
 * GHES needs a PAT instead).
 *
 * By default this checks every repo the token can see — GitHub's Search API
 * qualifier `author:` already means "authored by", so a global
 * `is:pr is:merged author:<you>` query finds all of your merged PRs in one
 * shot with no need to enumerate repos. `ygoDuel.trackedRepos` is only an
 * optional allowlist for narrowing that down; empty (the default) means "all
 * of them".
 *
 * This module is a pure data layer — it never shows UI (besides the token
 * input box, which IS the action) — so extension.js owns all toasts and can
 * decide when a poll result is worth interrupting the user about.
 *
 * The very first check for a person baselines instead of paying out: it
 * records a cutoff timestamp and grants a flat WELCOME_BONUS, so nobody's
 * whole PR history dumps into their balance on day one. From then on only PRs
 * merged AFTER that timestamp earn a credit. The cutoff is a time, not the set
 * of PRs seen at baseline, on purpose: a later token with wider scope (or new
 * repo access) can suddenly reveal years-old PRs, and those must stay free.
 *
 * Exports (consumed by extension.js):
 *   promptForToken(context)   async — prompt + store a PAT in SecretStorage
 *   promptForServer(context)  async — pick/enter ygoDuel.github.apiBaseUrl
 *   hasToken(context)         async — is a token already stored?
 *   checkMerges(context)      async — poll for newly-merged PRs, credit them,
 *                              return { status: 'ok'|'no-token'|'error',
 *                                newCredits, totalCredits, baseline?, error? }
 *   getCredits(context)       — current pack-credit balance (sync, globalState)
 *   spendCredit(context)      async — decrement by 1 if available; returns bool
 *   resetProgress(context)    async — wipe credits/history/baseline (support/testing)
 */

const vscode = require('vscode');
const https = require('https');

const TOKEN_KEY = 'ygoDuel.github.token';
const LOGIN_KEY = 'ygoDuel.competitive.login';
const CREDITS_KEY = 'ygoDuel.competitive.packCredits';
const CREDITED_PRS_KEY = 'ygoDuel.competitive.creditedPRs';
const BASELINED_KEY = 'ygoDuel.competitive.baselined';
const BASELINE_AT_KEY = 'ygoDuel.competitive.baselineAt';

const PUBLIC_GITHUB_URL = 'https://api.github.com';

const PER_PAGE = 100;
const MAX_PAGES = 5; // enough for 500 newly-merged PRs in one poll before we'd need real pagination
const WELCOME_BONUS = 3; // flat one-time credit on the first-ever check, instead of your whole PR history

function cfg() { return vscode.workspace.getConfiguration('ygoDuel'); }

function apiBaseUrl() {
  return (cfg().get('github.apiBaseUrl') || 'https://api.github.com').replace(/\/+$/, '');
}

/** Optional "owner/repo" allowlist to scope the merge check to. Empty
 *  (default) means: search every repo the token can see. */
function trackedRepos() {
  return cfg().get('trackedRepos') || [];
}

async function hasToken(context) {
  return !!(await context.secrets.get(TOKEN_KEY));
}

async function getToken(context) {
  return context.secrets.get(TOKEN_KEY);
}

async function promptForToken(context) {
  const token = await vscode.window.showInputBox({
    title: 'GitHub Personal Access Token',
    prompt: `Token for ${apiBaseUrl()} (needs "repo" scope to read your merged PRs)`,
    password: true,
    ignoreFocusOut: true
  });
  if (!token) return false;
  await context.secrets.store(TOKEN_KEY, token.trim());
  await context.globalState.update(LOGIN_KEY, undefined); // force a fresh /user lookup on next check
  vscode.window.showInformationMessage('✅ GitHub token saved. Run "Cards: Check for Merged PRs" to sync.');
  return true;
}

/** Lets someone switch which GitHub server Competitive packs talks to,
 *  instead of hand-editing ygoDuel.github.apiBaseUrl in settings.json. No
 *  on-site/GHES URL is hardcoded here — anyone on such a server types their
 *  own in via "Custom URL…". Clears the cached login — it's server-specific
 *  — since a PAT (and username) for one server won't authenticate against
 *  the other. */
async function promptForServer(context) {
  const current = apiBaseUrl();
  const picks = [
    { label: 'github.com (public, default)', url: PUBLIC_GITHUB_URL },
    { label: 'Custom URL… (e.g. an on-site GitHub Enterprise Server)', url: null }
  ];
  for (const pick of picks) {
    if (pick.url === current) pick.description = 'current';
  }

  const pick = await vscode.window.showQuickPick(picks, {
    title: 'GitHub server for Competitive packs',
    placeHolder: `Current: ${current}`
  });
  if (!pick) return false;

  let url = pick.url;
  if (url === null) {
    url = await vscode.window.showInputBox({
      title: 'GitHub REST API base URL',
      prompt: 'e.g. https://api.github.com or https://<host>/api/v3',
      value: current,
      ignoreFocusOut: true
    });
    if (!url) return false;
  }
  url = url.replace(/\/+$/, '');
  if (url === current) return false;

  await cfg().update('github.apiBaseUrl', url, vscode.ConfigurationTarget.Global);
  await context.globalState.update(LOGIN_KEY, undefined);
  vscode.window.showInformationMessage(
    `✅ GitHub server set to ${url}. If your saved token is for the other server, run "Cards: Set GitHub Token" to update it.`
  );
  return true;
}

/** Minimal GitHub REST/Search client — no npm dependency, this project ships
 *  with no build step, so we use Node's built-in https instead of node-fetch. */
function request(base, token, urlPath) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(base + urlPath); } catch (err) { reject(err); return; }
    const req = https.request(url, {
      headers: {
        Authorization: 'token ' + token,
        'User-Agent': 'ygo-duel-vscode-extension',
        Accept: 'application/vnd.github+json'
      }
    }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GitHub API ${res.statusCode} on ${urlPath}: ${body.slice(0, 300)}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (err) { reject(new Error('GitHub API returned non-JSON: ' + err.message)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getLogin(context, token) {
  const cached = context.globalState.get(LOGIN_KEY);
  if (cached) return cached;
  const user = await request(apiBaseUrl(), token, '/user');
  if (!user || !user.login) throw new Error('GitHub /user response had no login');
  await context.globalState.update(LOGIN_KEY, user.login);
  return user.login;
}

/** Pull "owner/repo" out of a search result's repository_url
 *  (e.g. ".../repos/owner/repo"), so credited-PR keys are correct whether the
 *  search was scoped to one repo or run globally. */
function repoFromUrl(url) {
  const m = typeof url === 'string' && url.match(/\/repos\/([^/]+\/[^/]+)$/);
  return m ? m[1] : 'unknown';
}

async function fetchMergedPRs(base, token, query) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const q = encodeURIComponent(query);
    const res = await request(base, token, `/search/issues?q=${q}&per_page=${PER_PAGE}&page=${page}`);
    const batch = (res && res.items) || [];
    items.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return items;
}

function getCredits(context) {
  return context.globalState.get(CREDITS_KEY, 0);
}

async function spendCredit(context) {
  const current = getCredits(context);
  if (current <= 0) return false;
  await context.globalState.update(CREDITS_KEY, current - 1);
  return true;
}

/** Poll for merged PRs of yours not seen before, crediting one pack per
 *  newly-seen PR. Idempotent across restarts/polls via the persisted
 *  creditedPRs set. Never shows UI — see module doc.
 *
 *  The first-ever call baselines: every currently-merged PR is marked seen
 *  but pays 0, and a flat WELCOME_BONUS is granted instead — so nobody's
 *  career-spanning PR history dumps into their balance on day one. */
async function checkMerges(context) {
  const token = await getToken(context);
  if (!token) return { status: 'no-token', newCredits: 0, totalCredits: getCredits(context) };

  const base = apiBaseUrl();
  try {
    const login = await getLogin(context, token);
    const scoped = trackedRepos();
    const queries = scoped.length
      ? scoped.map(r => `repo:${r} is:pr is:merged author:${login}`)
      : [`is:pr is:merged author:${login}`];

    const credited = context.globalState.get(CREDITED_PRS_KEY, {});
    const baselined = context.globalState.get(BASELINED_KEY, false);
    let baselineAt = context.globalState.get(BASELINE_AT_KEY, '');
    // Migrate installs baselined before baselineAt existed: without a cutoff
    // timestamp, a newly-visible old PR (broader token scope, new repo access)
    // looks freshly earned. Stamp "now" so everything already merged stays free.
    if (baselined && !baselineAt) {
      baselineAt = new Date().toISOString();
      await context.globalState.update(BASELINE_AT_KEY, baselineAt);
    }

    let newCredits = 0;
    for (const q of queries) {
      const items = await fetchMergedPRs(base, token, q);
      for (const item of items) {
        const key = repoFromUrl(item.repository_url) + '#' + item.number;
        if (credited[key]) continue;
        credited[key] = true;
        // Pay only for PRs merged AFTER the baseline moment. Marking a PR seen
        // is idempotency (don't double-pay across polls); the timestamp is what
        // stops a token with wider visibility from cashing in your whole history.
        // ISO-8601 UTC strings compare lexicographically == chronologically.
        const mergedAt = (item.pull_request && item.pull_request.merged_at) || item.closed_at || '';
        if (baselined && mergedAt > baselineAt) newCredits++;
      }
    }

    const baseline = !baselined;
    if (baseline) {
      await context.globalState.update(BASELINED_KEY, true);
      await context.globalState.update(BASELINE_AT_KEY, new Date().toISOString());
      newCredits += WELCOME_BONUS;
    }

    if (newCredits > 0) {
      await context.globalState.update(CREDITED_PRS_KEY, credited);
      await context.globalState.update(CREDITS_KEY, getCredits(context) + newCredits);
    }
    return { status: 'ok', newCredits, totalCredits: getCredits(context), baseline };
  } catch (err) {
    return { status: 'error', newCredits: 0, totalCredits: getCredits(context), error: err.message };
  }
}

/** Wipe credits, credited-PR history, and the baseline (both the flag and its
 *  cutoff timestamp) — lets someone (or a mis-set-up test run) start
 *  Competitive over from scratch. The next checkMerges re-baselines cleanly. */
async function resetProgress(context) {
  await context.globalState.update(CREDITS_KEY, 0);
  await context.globalState.update(CREDITED_PRS_KEY, {});
  await context.globalState.update(BASELINED_KEY, false);
  await context.globalState.update(BASELINE_AT_KEY, undefined);
}

module.exports = {
  promptForToken, promptForServer, hasToken, checkMerges, getCredits, spendCredit, resetProgress
};
