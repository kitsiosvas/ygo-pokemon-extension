/*
 * GitHub integration for Competitive packs. Credits come from:
 *   1. Merged PRs you authored — sized by additions+deletions
 *   2. Direct pushes to a repo's default branch (main/etc.) that are NOT
 *      part of any PR — same size tiers — so solo "commit to main" workflows
 *      earn packs without a fake PR. PR-linked landing commits are skipped
 *      so a merge never pays twice.
 *
 * Size → packs (additions + deletions):
 *   < 20 lines  → 1 (small)
 *   < 200 lines → 2 (medium)
 *   200+ lines  → 3 (large)
 * Zero-diff commits (empty / no-op) earn nothing.
 *
 * Talks to github.com or GitHub Enterprise Server via a personal access
 * token (VS Code's built-in GitHub auth only targets github.com).
 *
 * By default merged-PR search covers every repo the token can see (your
 * authored merges). Direct commits are scanned on recently-pushed repos
 * you own — no allowlist to configure.
 *
 * Pure data layer — never shows UI (besides the token input box).
 * extension.js owns toasts and when to poll.
 *
 * First check baselines: records a cutoff timestamp + WELCOME_BONUS instead
 * of dumping history. Only activity AFTER that timestamp earns credits.
 * Cutoff is a time (not "PRs seen at baseline") so a later wider-scope
 * token can't cash in years-old work.
 *
 * Exports (consumed by extension.js):
 *   promptForToken(context)   async — prompt + store a PAT in SecretStorage
 *   promptForServer(context)  async — pick/enter ygoDuel.github.apiBaseUrl
 *   hasToken(context)         async — is a token already stored?
 *   checkMerges(context)      async — poll PRs + direct commits, credit them,
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
const CREDITED_COMMITS_KEY = 'ygoDuel.competitive.creditedCommits';
const BASELINED_KEY = 'ygoDuel.competitive.baselined';
const BASELINE_AT_KEY = 'ygoDuel.competitive.baselineAt';

const PUBLIC_GITHUB_URL = 'https://api.github.com';

const PER_PAGE = 100;
const MAX_PAGES = 5; // enough for 500 newly-merged PRs in one poll before we'd need real pagination
const WELCOME_BONUS = 3; // flat one-time credit on the first-ever check, instead of your whole history
const MAX_COMMIT_REPOS = 50; // recently-pushed owned repos to scan for direct commits
const MAX_COMMITS_PER_REPO = 30; // per-poll cap so a busy repo can't blow the rate limit

/** Packs for a change sized by total lines touched (additions + deletions). */
function creditsForLines(additions, deletions) {
  const lines = (Number(additions) || 0) + (Number(deletions) || 0);
  if (lines <= 0) return 0;
  if (lines < 20) return 1;
  if (lines < 200) return 2;
  return 3;
}

function cfg() { return vscode.workspace.getConfiguration('ygoDuel'); }

function apiBaseUrl() {
  return (cfg().get('github.apiBaseUrl') || 'https://api.github.com').replace(/\/+$/, '');
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
    prompt: `Token for ${apiBaseUrl()} (needs "repo" scope to read your PRs and commits)`,
    password: true,
    ignoreFocusOut: true
  });
  if (!token) return false;
  await context.secrets.store(TOKEN_KEY, token.trim());
  await context.globalState.update(LOGIN_KEY, undefined); // force a fresh /user lookup on next check
  vscode.window.showInformationMessage('✅ GitHub token saved. Run "Cards: Check for Competitive Activity" to sync.');
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
function request(base, token, urlPath, accept) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(base + urlPath); } catch (err) { reject(err); return; }
    const req = https.request(url, {
      headers: {
        Authorization: 'token ' + token,
        'User-Agent': 'ygo-duel-vscode-extension',
        Accept: accept || 'application/vnd.github+json'
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

/** Full pull details — Search has no additions/deletions/merge SHA. */
async function fetchPullDetails(base, token, repo, number) {
  const pr = await request(base, token, `/repos/${repo}/pulls/${number}`);
  return {
    additions: pr.additions || 0,
    deletions: pr.deletions || 0,
    mergeCommitSha: pr.merge_commit_sha || ''
  };
}

/** Recently-pushed repos you own — used for direct default-branch commits. */
async function reposForDirectCommits(base, token) {
  const repos = await request(
    base,
    token,
    `/user/repos?affiliation=owner&sort=pushed&per_page=${MAX_COMMIT_REPOS}`
  );
  return (Array.isArray(repos) ? repos : [])
    .map(r => r.full_name)
    .filter(Boolean);
}

async function fetchDefaultBranch(base, token, repo) {
  const info = await request(base, token, `/repos/${repo}`);
  return info.default_branch || 'main';
}

/** Commits you authored on the default branch since `sinceIso` (inclusive-ish
 *  via GitHub's `since` filter). Newest first; capped per repo. */
async function fetchDirectCommits(base, token, repo, login, branch, sinceIso) {
  const since = encodeURIComponent(sinceIso);
  const author = encodeURIComponent(login);
  const sha = encodeURIComponent(branch);
  const path =
    `/repos/${repo}/commits?author=${author}&sha=${sha}&since=${since}` +
    `&per_page=${MAX_COMMITS_PER_REPO}`;
  const list = await request(base, token, path);
  return Array.isArray(list) ? list : [];
}

/** True when this commit is part of any PR (merged or open) — those are owned
 *  by the PR reward path so we must not also pay the commit path. */
async function commitHasPull(base, token, repo, commitSha) {
  const pulls = await request(
    base,
    token,
    `/repos/${repo}/commits/${commitSha}/pulls`,
    'application/vnd.github.groot-preview+json'
  );
  return Array.isArray(pulls) && pulls.length > 0;
}

/** Full commit payload includes stats.additions / stats.deletions. */
async function fetchCommitStats(base, token, repo, commitSha) {
  const commit = await request(base, token, `/repos/${repo}/commits/${commitSha}`);
  const stats = (commit && commit.stats) || {};
  return {
    additions: stats.additions || 0,
    deletions: stats.deletions || 0
  };
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

/**
 * Poll for newly-merged PRs and direct default-branch commits, crediting
 * packs by size. Idempotent via creditedPRs / creditedCommits. Never shows UI.
 *
 * First-ever call baselines: marks current PRs seen, stamps baselineAt, grants
 * WELCOME_BONUS — history does not dump into the balance.
 */
async function checkMerges(context) {
  const token = await getToken(context);
  if (!token) return { status: 'no-token', newCredits: 0, totalCredits: getCredits(context) };

  const base = apiBaseUrl();
  try {
    const login = await getLogin(context, token);
    const queries = [`is:pr is:merged author:${login}`];

    const credited = Object.assign({}, context.globalState.get(CREDITED_PRS_KEY, {}));
    const creditedCommits = Object.assign({}, context.globalState.get(CREDITED_COMMITS_KEY, {}));
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
    let creditedDirty = false;
    let commitsDirty = false;

    // --- Merged PRs (sized) -------------------------------------------------
    for (const q of queries) {
      const items = await fetchMergedPRs(base, token, q);
      for (const item of items) {
        const repo = repoFromUrl(item.repository_url);
        const key = repo + '#' + item.number;
        if (credited[key]) continue;
        credited[key] = true;
        creditedDirty = true;

        const mergedAt = (item.pull_request && item.pull_request.merged_at) || item.closed_at || '';
        if (!(baselined && mergedAt > baselineAt)) continue;

        try {
          const details = await fetchPullDetails(base, token, repo, item.number);
          const award = creditsForLines(details.additions, details.deletions);
          // A PR with a real merge but empty diff is still "work shipped" —
          // treat as small rather than zero so merge-only housekeeping pays 1.
          newCredits += award > 0 ? award : 1;
          // Same change will also appear as a commit on the default branch —
          // mark the merge SHA now so the commit path can't double-pay.
          if (details.mergeCommitSha) {
            const commitKey = repo + '@' + details.mergeCommitSha;
            if (!creditedCommits[commitKey]) {
              creditedCommits[commitKey] = true;
              commitsDirty = true;
            }
          }
        } catch (_) {
          // Stats fetch failed (deleted repo, auth blip) — still count as small
          // so a merge isn't silently dropped.
          newCredits += 1;
        }
      }
    }

    // --- Direct default-branch commits (skip anything tied to a PR) ---------
    // Only after baseline: `since=baselineAt` means history never needs marking.
    if (baselined && baselineAt) {
      const repos = await reposForDirectCommits(base, token);
      for (const repo of repos) {
        let branch;
        try {
          branch = await fetchDefaultBranch(base, token, repo);
        } catch (_) {
          continue; // missing/private/renamed — skip this repo this poll
        }

        let commits;
        try {
          commits = await fetchDirectCommits(base, token, repo, login, branch, baselineAt);
        } catch (_) {
          continue;
        }

        for (const entry of commits) {
          const sha = entry && entry.sha;
          if (!sha) continue;
          const key = repo + '@' + sha;
          if (creditedCommits[key]) continue;

          // Mark seen up front so a mid-loop failure doesn't re-hit the same SHA
          // forever; we only award when the checks below succeed.
          creditedCommits[key] = true;
          commitsDirty = true;

          const commitDate =
            (entry.commit && entry.commit.committer && entry.commit.committer.date) ||
            (entry.commit && entry.commit.author && entry.commit.author.date) ||
            '';
          if (!(commitDate > baselineAt)) continue;

          try {
            if (await commitHasPull(base, token, repo, sha)) continue; // PR owns the reward
            const stats = await fetchCommitStats(base, token, repo, sha);
            newCredits += creditsForLines(stats.additions, stats.deletions);
          } catch (_) {
            // Leave marked so we don't hammer a bad SHA; no award this time.
          }
        }
      }
    }

    const baseline = !baselined;
    if (baseline) {
      await context.globalState.update(BASELINED_KEY, true);
      await context.globalState.update(BASELINE_AT_KEY, new Date().toISOString());
      newCredits += WELCOME_BONUS;
    }

    if (creditedDirty) await context.globalState.update(CREDITED_PRS_KEY, credited);
    if (commitsDirty) await context.globalState.update(CREDITED_COMMITS_KEY, creditedCommits);
    if (newCredits > 0) {
      await context.globalState.update(CREDITS_KEY, getCredits(context) + newCredits);
    }
    return { status: 'ok', newCredits, totalCredits: getCredits(context), baseline };
  } catch (err) {
    return { status: 'error', newCredits: 0, totalCredits: getCredits(context), error: err.message };
  }
}

/** Wipe credits, credited PR/commit history, and the baseline (flag + cutoff)
 *  — lets someone start Competitive over from scratch. Next checkMerges
 *  re-baselines cleanly. */
async function resetProgress(context) {
  await context.globalState.update(CREDITS_KEY, 0);
  await context.globalState.update(CREDITED_PRS_KEY, {});
  await context.globalState.update(CREDITED_COMMITS_KEY, {});
  await context.globalState.update(BASELINED_KEY, false);
  await context.globalState.update(BASELINE_AT_KEY, undefined);
}

module.exports = {
  promptForToken, promptForServer, hasToken, checkMerges, getCredits, spendCredit, resetProgress,
  // exported for clarity/tests; not required by extension.js
  creditsForLines
};
