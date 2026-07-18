const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const util = require('util');
const github = require('./github');

// Available game definitions (data adapter + theme). Add a game by dropping a
// module in ./games/ and registering it here; a command switches between them.
const GAMES = {
  yugioh: require('./games/yugioh'),
  pokemon: require('./games/pokemon')
};
const DEFAULT_GAME = 'yugioh';

let gameId = DEFAULT_GAME;   // which game is active right now
let game = GAMES[gameId];    // its definition (kept in sync with gameId)

let panel = null;
let binderPanel = null;
let binderTrack = 'sandbox';  // which collection the open Binder is showing: 'sandbox' | 'competitive'
let extCtx = null;
let persistTimer = null;
let statusBarItem = null;
let pollTimer = null;
let lastPollAt = 0;
const FOCUS_POLL_MIN_GAP_MS = 5 * 60 * 1000; // don't re-poll on every window-focus flip; the interval covers the rest

const ACTIVE_GAME_KEY = 'ygoDuel.activeGame';

/*
 * Rarity tiers — the SINGLE source of truth for both odds AND look. Every pull
 * gets exactly one tier. To add a rarity: add ONE entry here (rarest first) —
 * nothing else changes. The webviews generate the per-tier CSS from this list
 * and build the banner word from `wordTemplate` + the game's `theme.revealNoun`,
 * so no per-game or per-webview edits are needed.
 *
 *   id            internal key; also the CSS class the webview toggles on a card
 *   chance        roll probability; tiers are tried rarest-first, so keep this
 *                 list sorted rarest→common. Last tier is the catch-all (chance 0).
 *   bump          rarityScore boost → how late in a pack it reveals (rarer = later)
 *   label/tag     binder display: chip label + emoji marker (base tier: empty)
 *   wordTemplate  banner text; `{noun}` is replaced with theme.revealNoun. Omit
 *                 for the base tier (it uses theme.drawWord verbatim).
 *   chars/particles/flash/flashMs/bannerColor  reveal-animation knobs (webview)
 *   style         per-tier visual identity the webviews turn into CSS:
 *                   accent      border color (binder cell + modal)
 *                   glow        colored glow for binder borders
 *                   cardGlow    glow around the risen field card
 *                   holo        holographic-sweep gradient
 *                   holoOpacity / holoBlend / holoSpeed  sweep tuning
 */
const TIERS = [
  { id: 'prismatic', chance: 0.005, bump: 1000000, label: 'Prismatic', tag: '��',
    wordTemplate: '�� PRISMATIC {noun}! ��',
    chars: ['��','✨','��','��','⭐','��'], particles: 90, flash: 1, flashMs: 850, bannerColor: '#ffffff',
    style: { accent: '#c199ff', glow: 'rgba(160,120,255,.6)', cardGlow: 'rgba(255,255,255,.75)',
      holo: 'linear-gradient(115deg, #ff3b6b, #ffb03b, #f6ff3b, #4bff8a, #3bd4ff, #a03bff, #ff3b6b)',
      holoOpacity: 0.9, holoBlend: 'color-dodge', holoSpeed: '1.4s' } },
  { id: 'shiny', chance: 0.06, bump: 100000, label: 'Shiny', tag: '✨',
    wordTemplate: '✨ SHINY {noun}! ✨',
    chars: ['⭐','✨','��','��','��','��'], particles: 60, flash: 1, flashMs: 620, bannerColor: '#fff2b0',
    style: { accent: '#d9a800', glow: 'rgba(255,200,60,.55)', cardGlow: 'rgba(255,215,80,.85)',
      holo: 'linear-gradient(115deg, transparent 25%, rgba(255,225,120,.6) 42%, rgba(255,255,255,.75) 50%, rgba(255,205,80,.6) 58%, transparent 75%)',
      holoOpacity: 0.8, holoBlend: 'screen', holoSpeed: '1.8s' } },
  { id: 'normal', chance: 0, bump: 0, label: '', tag: '', base: true,
    chars: ['⭐','✨','��','��','��'], particles: 40, flash: 0.85, flashMs: 420, bannerColor: '#ffe680' }
];
const TIER_BY_ID = Object.fromEntries(TIERS.map(t => [t.id, t]));

/** The one "is this a special (non-base) tier?" test — the single predicate for
 *  specialness, shared by the host and (mirrored) by both webviews. Keying off
 *  the explicit `base` flag keeps host + webviews from ever disagreeing. */
function isSpecialTier(id) {
  const t = TIER_BY_ID[id];
  return !!t && !t.base;
}

/** Roll a pull's tier: try each tier rarest-first, else fall to the catch-all. */
function rollTier() {
  const r = Math.random();
  let acc = 0;
  for (const t of TIERS) {
    acc += t.chance;
    if (r < acc) return t.id;
  }
  return TIERS[TIERS.length - 1].id;
}

/** A fresh, tier-agnostic stats record (per-tier counts live in tierCounts). */
function emptyStats() { return { total: 0, tierCounts: {} }; }

// Collection/stats are namespaced per game so they never mix. Yu-Gi-Oh keeps
// the original un-suffixed keys so existing collections aren't orphaned.
// Each game additionally splits into two tracks: 'sandbox' (the original,
// always-free draw/pack flow — untouched, unsuffixed) and 'competitive' (fed
// only by credit-gated Competitive packs, its own suffixed keys).
function nsKey(kind, track, gid = gameId) {
  const base = 'ygoDuel.' + kind + (gid === 'yugioh' ? '' : ':' + gid);
  return track === 'competitive' ? base + ':competitive' : base;
}
function collectionKey(track, gid = gameId) { return nsKey('collection', track, gid); }
function statsKey(track, gid = gameId)      { return nsKey('stats', track, gid); }
function cachePath()     { return path.join(extCtx.globalStorageUri.fsPath, 'buffer-' + gameId + '.json'); }

// In-memory only (not globalState) — a fresh VS Code session/PC restart should
// start on an empty field, while collections/stats/credits stay durable. Keyed
// by the game the card was actually shown for (reported by the webview itself,
// not read off this module's mutable `gameId`) so a 'shown' message still in
// flight from the old game's page when you switch can't get filed under the
// new game's key.
const lastCardByGame = {};

/** Show the active game's last-pulled card again (no animation) after a panel
 *  (re)load, so switching games doesn't drop you on an empty field. */
function sendRestore() {
  if (!panel) return;
  const c = lastCardByGame[gameId];
  if (c) panel.webview.postMessage({ type: 'restore', card: c });
}

/** Switch the active game: reset the buffer, reload any open panels with the
 *  new theme, warm the new game's buffer, and refresh the binder. */
function setActiveGame(id) {
  if (!GAMES[id] || id === gameId) return;
  // Persist the OUTGOING game's buffer to ITS own file right now (and cancel any
  // pending debounced write) BEFORE swapping. The debounced writer binds its
  // target filename when scheduled but the buffer contents only when it fires
  // (~400ms later); a switch inside that window would otherwise flush the
  // incoming game's cards into the outgoing game's file. See persistBufferSoon.
  flushBufferNow();
  discardPendingPack(); // an unopened pack is abandoned on game switch (costs nothing — no credit spent)
  gameId = id;
  game = GAMES[id];
  extCtx.globalState.update(ACTIVE_GAME_KEY, id);

  BUFFER.length = 0;   // drop the previous game's cards
  loadBufferCache();   // warm-start this game's buffer from its own cache
  if (panel) panel.webview.html = renderHtml(panel.webview, 'duel.html');
  if (binderPanel) binderPanel.webview.html = renderHtml(binderPanel.webview, 'binder.html');
  ensureRefill();
  sendCollection(binderTrack);
}

function activate(context) {
  extCtx = context;
  const savedGame = context.globalState.get(ACTIVE_GAME_KEY);
  gameId = GAMES[savedGame] ? savedGame : DEFAULT_GAME;
  game = GAMES[gameId];
  sanitizeCollections(); // repair any collections a past cross-game race corrupted
  loadBufferCache(); // warm-start from last session so a reload doesn't hit the network cold

  context.subscriptions.push(
    vscode.commands.registerCommand('ygoDuel.open', () => ensurePanel(context)),

    vscode.commands.registerCommand('ygoDuel.openYugioh', () => { setActiveGame('yugioh'); ensurePanel(context); }),
    vscode.commands.registerCommand('ygoDuel.openPokemon', () => { setActiveGame('pokemon'); ensurePanel(context); }),

    vscode.commands.registerCommand('ygoDuel.draw', async () => {
      ensurePanel(context);
      await doDraw();
    }),

    vscode.commands.registerCommand('ygoDuel.openPack', async () => {
      ensurePanel(context);
      await doPack('sandbox');
    }),

    vscode.commands.registerCommand('ygoDuel.openCompetitivePack', async () => {
      ensurePanel(context);
      await doPack('competitive');
    }),

    vscode.commands.registerCommand('ygoDuel.setGithubToken', async () => {
      await github.promptForToken(context);
      await checkMergesAndToast();
    }),

    vscode.commands.registerCommand('ygoDuel.setGithubServer', async () => {
      const changed = await github.promptForServer(context);
      if (changed) await checkMergesAndToast();
    }),

    vscode.commands.registerCommand('ygoDuel.checkMerges', () => checkMergesAndToast()),

    vscode.commands.registerCommand('ygoDuel.resetCompetitiveProgress', async () => {
      const choice = await vscode.window.showWarningMessage(
        'Reset ALL Competitive progress? This wipes your pack-credit balance, merge ' +
        'history, and every Competitive card collection (all games), then re-baselines ' +
        '(existing merges won\'t count) and grants a fresh welcome bonus. ' +
        'Your Sandbox collections are untouched. This cannot be undone.',
        { modal: true },
        'Reset'
      );
      if (choice !== 'Reset') return;
      // the sequence below does at least one (often two) live network round
      // trips to GitHub — settling any in-flight poll, then re-checking merges
      // — so show a spinner instead of leaving the command looking hung.
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '�� Resetting Competitive progress…' },
        async () => {
          // let any in-flight poll (e.g. the one activation fires) fully settle
          // first — it captured baselined/credited from before this reset, so
          // piggybacking checkMergesAndToast on it would report its stale,
          // pre-reset result instead of running a fresh check against the wiped state.
          if (pollInFlight) await pollInFlight.catch(() => {});
          await github.resetProgress(extCtx);
          await clearAllCompetitiveCollections();
          await checkMergesAndToast(); // re-baseline + grant the welcome bonus right away
        }
      );
    }),

    vscode.commands.registerCommand('ygoDuel.migrateCardData', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '�� Backfilling rarity & prices…' },
        async progress => {
          const { migrated, skipped } = await migrateCardData((m, s) => {
            progress.report({ message: m + ' done' + (s ? ' · ' + s + ' skipped' : '') });
          });
          vscode.window.showInformationMessage(
            migrated || skipped
              ? `�� Backfilled ${migrated} card${migrated === 1 ? '' : 's'}` + (skipped ? ` · ${skipped} skipped` : '') + '.'
              : '�� Nothing to backfill — already up to date.'
          );
          if (binderPanel) sendCollection(binderTrack);
        }
      );
    }),

    vscode.commands.registerCommand('ygoDuel.openBinder', () => openBinder(context)),

    vscode.commands.registerCommand('ygoDuel.resetCollection', () => resetCollection(binderTrack)),

    vscode.commands.registerCommand('ygoDuel.toggleOnSave', async () => {
      const cfg = vscode.workspace.getConfiguration('ygoDuel');
      const next = !cfg.get('drawOnSave');
      await cfg.update('drawOnSave', next, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        next ? "�� Draw-on-Save: ON — it's time to d-d-d-duel!" : 'Draw-on-Save: OFF'
      );
    }),

    vscode.workspace.onDidSaveTextDocument(async () => {
      if (!vscode.workspace.getConfiguration('ygoDuel').get('drawOnSave')) return;
      ensurePanel(context);
      await doDraw();
    }),

    vscode.window.onDidChangeWindowState(state => {
      // the real-world trigger is "merged a PR on GitHub, tabbed back into VS Code"
      if (!state.focused || Date.now() - lastPollAt < FOCUS_POLL_MIN_GAP_MS) return;
      backgroundCheckMerges();
    })
  );

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'ygoDuel.checkMerges';
  context.subscriptions.push(statusBarItem);
  updateStatusBar();
  statusBarItem.show();

  const pollMinutes = Math.max(1, Number(vscode.workspace.getConfiguration('ygoDuel').get('pollIntervalMinutes')) || 15);
  pollTimer = setInterval(backgroundCheckMerges, pollMinutes * 60 * 1000);
  github.hasToken(context).then(has => { if (has) backgroundCheckMerges(); });

  // warm up the card buffer so the first draw is instant
  ensureRefill();
}

function ensurePanel(context) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside, true);
    return;
  }
  panel = vscode.window.createWebviewPanel(
    'ygoDuel',
    game.theme.fieldTitle,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = renderHtml(panel.webview, 'duel.html');
  panel.webview.onDidReceiveMessage(msg => {
    if (!msg) return;
    if (msg.type === 'requestDraw') doDraw();
    else if (msg.type === 'openPack') doPack('sandbox');
    else if (msg.type === 'openCompetitivePack') doPack('competitive');
    else if (msg.type === 'packRipped') onPackRipped();
    else if (msg.type === 'openBinder') openBinder(context);
    else if (msg.type === 'setGame') setActiveGame(msg.id);
    else if (msg.type === 'shown') lastCardByGame[msg.gameId] = msg.card;
    else if (msg.type === 'ready') { sendPrefetch(); sendRestore(); sendCredits(); }
  });
  panel.onDidDispose(() => { panel = null; discardPendingPack(); });
}

/** Read a webview HTML file and fill in the templated placeholders: the CSP
 *  source + allowed image hosts, the game theme + rarity tiers (as JSON), and
 *  the pack image. */
function renderHtml(webview, file) {
  const raw = fs.readFileSync(path.join(extCtx.extensionPath, 'media', file), 'utf8');
  const games = Object.keys(GAMES).map(id => ({ id, label: GAMES[id].theme.toggleLabel || id }));
  return raw
    .replace(/{{CSP_SOURCE}}/g, webview.cspSource)
    .replace(/{{IMG_HOSTS}}/g, game.theme.imgHosts)
    .replace(/{{THEME}}/g, JSON.stringify(game.theme))
    .replace(/{{GAMES}}/g, JSON.stringify(games))
    .replace(/{{TIERS}}/g, JSON.stringify(TIERS))
    .replace(/{{ACTIVE_GAME}}/g, gameId)
    .replace(/{{PACK_IMG}}/g, packImageUri(webview));
}

/** If a real booster-pack image for the active game is bundled in media/
 *  (pack-<game>.png/jpg/…), return a webview URI for it; otherwise return ''
 *  and the webview falls back to its built-in SVG pack. */
const PACK_IMG_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
function packImageUri(webview) {
  for (const ext of PACK_IMG_EXTS) {
    const p = path.join(extCtx.extensionPath, 'media', 'pack-' + gameId + '.' + ext);
    if (fs.existsSync(p)) return webview.asWebviewUri(vscode.Uri.file(p)).toString();
  }
  return '';
}

async function doDraw() {
  let card;
  try {
    card = await fetchRandomCard();
  } catch {
    if (panel) panel.webview.postMessage({ type: 'fetchFailed' });
    vscode.window.showWarningMessage("⚠️ Couldn't fetch a card right now — check your connection and try again.");
    return;
  }
  const tier = rollTier();
  const rec = recordCollection(card, tier);
  const payload = {
    ...card,
    tier,
    isNew: rec.isNew,
    count: rec.count,
    unique: rec.unique,
    total: rec.total
  };
  if (panel) panel.webview.postMessage({ type: 'draw', card: payload });
  sendPrefetch();                     // warm the next card's art in the webview
  if (binderPanel && binderTrack === 'sandbox') sendCollection('sandbox'); // live-update the binder if it's open
}

/** Push the current Competitive pack-credit balance to the Field panel. */
function sendCredits() {
  if (!panel) return;
  panel.webview.postMessage({ type: 'credits', credits: github.getCredits(extCtx) });
}

function updateStatusBar() {
  if (!statusBarItem) return;
  const n = github.getCredits(extCtx);
  statusBarItem.text = '�� ' + n;
  statusBarItem.tooltip = (n > 0
    ? n + ' Competitive pack' + (n > 1 ? 's' : '') + ' available'
    : 'No Competitive packs yet') + ' — click to check for new merges';
}

/** The one place that talks to GitHub, tags on where credits landed, and
 *  refreshes the status bar. Toasting is left to the two callers below, since
 *  a silent background poll and an explicit "check now" click want different
 *  levels of chattiness for the same result.
 *
 *  Coalesces concurrent calls into a single in-flight request — activation,
 *  the interval timer, and window-focus can all fire within the same instant
 *  (e.g. a burst of focus events while the dev host window is still settling),
 *  and without this, each one independently re-reads "not baselined yet" and
 *  grants its own welcome bonus on top of the others'. `primary` tells the
 *  caller whether they actually drove this request or just piggybacked on one
 *  already in flight, so background callers can avoid duplicate toasts. */
let pollInFlight = null;
async function pollMerges() {
  if (pollInFlight) return { result: await pollInFlight, primary: false };
  pollInFlight = (async () => {
    lastPollAt = Date.now(); // stamped now, not after, so a focus-event burst is throttled too
    const result = await github.checkMerges(extCtx);
    updateStatusBar();
    sendCredits();
    return result;
  })();
  try {
    return { result: await pollInFlight, primary: true };
  } finally {
    pollInFlight = null;
  }
}

/** Celebrate a poll result that found something — a first-ever baseline
 *  (welcome bonus, historical merges don't count) reads differently from an
 *  ordinary "you merged something new" credit. Shared by both callers below. */
function toastMergeResult(result) {
  if (result.baseline) {
    vscode.window.showInformationMessage(
      `�� Welcome to Competitive! ${result.newCredits} starter pack${result.newCredits > 1 ? 's' : ''} on the house — ` +
      `your existing merged PRs are now the baseline, so only new merges earn packs from here. (${result.totalCredits} available)`
    );
  } else {
    vscode.window.showInformationMessage(
      `�� +${result.newCredits} Competitive pack${result.newCredits > 1 ? 's' : ''} earned! (${result.totalCredits} available)`
    );
  }
}

/** Manual "Cards: Check for Merged PRs" — always says something, even if it
 *  ends up piggybacking on an already-in-flight background poll, since the
 *  user explicitly asked for feedback right now. */
async function checkMergesAndToast() {
  const { result } = await pollMerges();
  if (result.status === 'no-token') {
    const pick = await vscode.window.showInformationMessage(
      'No GitHub token set yet — set one to start earning Competitive packs.', 'Set Token'
    );
    if (pick === 'Set Token') await vscode.commands.executeCommand('ygoDuel.setGithubToken');
  } else if (result.status === 'error') {
    vscode.window.showErrorMessage('�� Merge check failed: ' + result.error);
  } else if (result.newCredits > 0) {
    toastMergeResult(result);
  } else {
    vscode.window.showInformationMessage(`No new merges yet. (${result.totalCredits} available)`);
  }
}

/** Background poll (activate, interval, window-focus) — quiet unless there's
 *  actually something to celebrate; a token/repo that's still unset shouldn't
 *  nag every few minutes. Skips toasting entirely if it piggybacked on
 *  another in-flight check, so a burst of triggers shows the celebration once. */
async function backgroundCheckMerges() {
  const { result, primary } = await pollMerges();
  if (primary && result.status === 'ok' && result.newCredits > 0) toastMergeResult(result);
}

/** Tell the webview which card images are on deck so it can warm the browser
 *  cache in the background — this keeps each draw's reveal instant even though
 *  we no longer ship image bytes inline. Pass extra URLs (e.g. a just-drawn
 *  pack's own cards, which have already been shifted out of the buffer) to
 *  warm those too. */
function sendPrefetch(extraUrls = []) {
  if (!panel) return;
  const urls = [...extraUrls, ...BUFFER.map(c => c.image)].filter(Boolean);
  if (urls.length) panel.webview.postMessage({ type: 'prefetch', urls });
}

const PACK_SIZE = 5;

/** A pack that's been fetched and rolled but not yet opened — the player is
 *  still looking at the sealed wrapper. It's a pure PREVIEW: nothing is
 *  recorded and (for Competitive) no credit is spent until the player rips it
 *  open (commitPendingPack). If they walk away first — switch games, close the
 *  panel, reload — it's simply discarded (discardPendingPack) at no cost. At
 *  most one at a time (the UI only allows one pack in flight). */
let pendingPack = null;
let ripBeforeReady = false; // player tore the wrapper open before the fetch finished drawing the pack

/** Draw a pack of monsters and send them for a one-by-one reveal, without
 *  touching the collection OR spending a credit yet — both happen only when
 *  the pack is actually ripped open. `track` is 'sandbox' (default, always
 *  free) or 'competitive' (needs a merge-earned credit available; the credit
 *  is verified here but not consumed until the rip). */
async function doPack(track = 'sandbox') {
  const competitive = track === 'competitive';
  if (competitive && github.getCredits(extCtx) <= 0) {
    vscode.window.showInformationMessage('�� No Competitive packs available yet — merge a PR to earn one!');
    return;
  }
  pendingPack = null;     // abandon any prior unopened pack (UI guards against this, but be safe)
  ripBeforeReady = false; // fresh pack: forget any stale early-rip from a prior one

  // show the wrapper immediately; fetch the cards while the player reads it
  if (panel) panel.webview.postMessage({ type: 'packOpening', competitive });

  let draws;
  try {
    draws = await Promise.all(
      Array.from({ length: PACK_SIZE }, () => fetchRandomCard())
    );
  } catch {
    // a rip that landed while this fetch was failing must not auto-commit
    // against whatever pack comes next — there's no pending pack to honor it.
    ripBeforeReady = false;
    if (panel) panel.webview.postMessage({ type: 'fetchFailed' });
    vscode.window.showWarningMessage("⚠️ Couldn't fetch cards right now — check your connection and try again.");
    return;
  }
  const cards = previewPack(draws, track);
  // reveal weakest first so the best card lands last (prismatic trumps shiny)
  cards.sort((a, b) => rarityScore(a) - rarityScore(b));
  pendingPack = { cards, track, competitive };

  // 'competitive' isn't sent here — the webview already captured it from the
  // earlier 'packOpening' message (beginPack), so re-sending it is dead weight.
  if (panel) panel.webview.postMessage({ type: 'packCards', cards });
  // warm THIS pack's images right now — they've been shifted out of the buffer,
  // so they download during the wrapper+rip animation and each reveal's
  // preload() resolves from cache instead of blocking on a cold fetch.
  sendPrefetch(cards.map(c => c.image));
  ensureRefill(); // top the buffer back up immediately so the next pack stays warm too

  // if the player already tore the wrapper open while we were fetching, the
  // packRipped message arrived before this pack existed — honor it now.
  if (ripBeforeReady) { ripBeforeReady = false; commitPendingPack(); }
}

/** Player ripped the wrapper. Commit now if the pack is ready; otherwise
 *  remember it so doPack commits as soon as the fetch lands (a fast rip can
 *  beat the fetch, and without this the cards/credit would never be recorded). */
function onPackRipped() {
  if (pendingPack) commitPendingPack();
  else ripBeforeReady = true;
}

/** Open the pending pack for real — called when the player rips the wrapper.
 *  This is the ONLY place a Competitive credit is spent and the ONLY place a
 *  pack's cards are recorded, so an unopened pack never costs anything. */
async function commitPendingPack() {
  if (!pendingPack) return;
  const { cards, track, competitive } = pendingPack;
  pendingPack = null;
  if (competitive) {
    await github.spendCredit(extCtx);
    updateStatusBar();
    sendCredits();
  }
  for (const c of cards) recordCollection(c, c.tier, track);
  if (binderPanel && binderTrack === track) sendCollection(track);
}

/** Throw away an unopened pack — switching games, closing the panel, or
 *  reloading. Costs nothing (no credit was spent, no cards recorded), so the
 *  credit stays on the balance and the player can open another later. */
function discardPendingPack() {
  pendingPack = null;
  ripBeforeReady = false; // a remembered early-rip is moot once the pack is abandoned
}

/** Higher = revealed later. The tier's bump dominates (rarer reveals last),
 *  new cards get a smaller bump, then the game's base power (e.g. ATK). */
function rarityScore(c) {
  let s = game.power(c) || 0;
  if (c.isNew) s += 3000;
  s += (TIER_BY_ID[c.tier] || {}).bump || 0;
  return s;
}

/** Pure state transition: fold one draw into the given col/stats objects and
 *  return progress info. Doesn't touch globalState — recordCollection uses it
 *  against the live collection, previewPack uses it against a throwaway
 *  clone so a sealed pack can be shown without actually being recorded. */
function applyDraw(col, stats, card, tier) {
  const id = String(card.id || card.name);
  const existing = col[id];
  const isNew = !existing;
  // store the whole normalized card (whatever fields the game produced) plus
  // our bookkeeping, so the collection isn't tied to any one game's schema.
  const entry = existing || {
    ...card,
    id,
    count: 0,
    tierCounts: {},
    firstSeen: Date.now()
  };
  entry.count += 1;
  if (isSpecialTier(tier)) entry.tierCounts[tier] = (entry.tierCounts[tier] || 0) + 1;
  entry.lastSeen = Date.now();
  col[id] = entry;

  stats.total += 1;
  if (isSpecialTier(tier)) stats.tierCounts[tier] = (stats.tierCounts[tier] || 0) + 1;

  return { isNew, count: entry.count, unique: Object.keys(col).length, total: stats.total };
}

/** Record a draw into the persistent collection; returns progress info.
 *  `track` is 'sandbox' (default) or 'competitive' — see collectionKey(). */
function recordCollection(card, tier, track) {
  const col = extCtx.globalState.get(collectionKey(track), {});
  const stats = extCtx.globalState.get(statsKey(track), emptyStats());
  const rec = applyDraw(col, stats, card, tier);
  extCtx.globalState.update(collectionKey(track), col);
  extCtx.globalState.update(statsKey(track), stats);
  return rec;
}

/** One-time repair for collections corrupted by the old cross-game buffer race
 *  (fixed in setActiveGame/persistBufferSoon): a card from one game could get
 *  filed into another game's collection, where it renders as a broken image
 *  under the wrong CSP. Drop any such foreign-host entries from every
 *  game/track collection and rebuild that track's stats from what survives
 *  (stats.total is the sum of per-card counts; stats.tierCounts the sum of
 *  per-card tierCounts — so this reconciles exactly). No-op once clean, so it's
 *  cheap to run on every activation. */
function sanitizeCollections() {
  let removed = 0;
  for (const gid of Object.keys(GAMES)) {
    const g = GAMES[gid];
    for (const track of ['sandbox', 'competitive']) {
      const key = collectionKey(track, gid);
      const col = extCtx.globalState.get(key, {});
      let changed = false;
      for (const id of Object.keys(col)) {
        if (!cardBelongsToGame(col[id], g)) { delete col[id]; removed++; changed = true; }
      }
      if (!changed) continue;
      const stats = emptyStats();
      for (const id of Object.keys(col)) {
        stats.total += col[id].count || 0;
        for (const t of Object.keys(col[id].tierCounts || {})) {
          stats.tierCounts[t] = (stats.tierCounts[t] || 0) + col[id].tierCounts[t];
        }
      }
      extCtx.globalState.update(key, col);
      extCtx.globalState.update(statsKey(track, gid), stats);
    }
  }
  if (removed) console.log('[ygo-duel] sanitized ' + removed + ' cross-game card(s) from collections');
}

/** One-time (idempotent), network-backed backfill: cards caught before
 *  rarity/price existed have neither field. For each such entry, re-fetch
 *  that exact card by id and re-run it through the game's own normalize() —
 *  for Yu-Gi-Oh, where normalize() now bakes the picked rarity into the id,
 *  this moves the entry onto its new key, merging into a same-rarity entry
 *  already there (count/tierCounts/firstSeen/lastSeen combined) rather than
 *  overwriting it. Pokémon's id is already per-printing, so it never moves —
 *  this just fills in rarity/price in place. Fetches sequentially (not in
 *  parallel) to stay easy on both APIs, and skips past any single card's
 *  fetch failure (deleted card, network blip) rather than aborting the run.
 *  Safe to re-run: a second pass finds nothing left with no `rarity` key.
 *
 *  Paced with a delay between requests, plus one retry after a longer
 *  backoff on failure: pokemontcg.io's keyless tier throttles hard under
 *  back-to-back hits (measured: response times balloon to 10-60s and some
 *  requests fail outright once a run of migrations hits it request after
 *  request with no gap — the exact card is fine, it's just rate-limited). */
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function migrateCardData(onProgress) {
  let migrated = 0, skipped = 0;
  for (const gid of Object.keys(GAMES)) {
    const g = GAMES[gid];
    if (!g.fetchById) continue;
    for (const track of ['sandbox', 'competitive']) {
      const key = collectionKey(track, gid);
      const snapshot = extCtx.globalState.get(key, {});
      const pending = Object.keys(snapshot).filter(id => !('rarity' in snapshot[id]));
      if (!pending.length) continue;
      for (const id of pending) {
        await sleep(300);
        let fresh;
        try {
          fresh = g.normalize(await g.fetchById(id));
        } catch (err) {
          await sleep(1500); // longer backoff, then one retry before giving up
          try {
            fresh = g.normalize(await g.fetchById(id));
          } catch (err2) {
            console.error('[ygo-duel] migrate failed for ' + id + ': ' + util.inspect(err2, { depth: 10 }));
            skipped++;
            if (onProgress) onProgress(migrated, skipped);
            continue;
          }
        }
        // Re-read right before mutating (not the snapshot above) — the fetch
        // just awaited is a real network round trip, during which a draw, a
        // pack, a reset, or another run of this same command could have
        // changed this exact collection. Reading fresh here, doing the whole
        // mutation synchronously, and writing back immediately keeps the
        // race window to ~zero, instead of the whole migration's duration.
        const col = extCtx.globalState.get(key, {});
        const entry = col[id];
        if (!entry || 'rarity' in entry) {
          if (onProgress) onProgress(migrated, skipped); // already handled (concurrent run) or drawn/reset away
          continue;
        }
        delete col[id];
        const target = col[fresh.id];
        if (target) {
          target.count += entry.count || 0;
          for (const t of Object.keys(entry.tierCounts || {})) {
            target.tierCounts[t] = (target.tierCounts[t] || 0) + entry.tierCounts[t];
          }
          target.firstSeen = Math.min(target.firstSeen || Infinity, entry.firstSeen || Infinity);
          target.lastSeen = Math.max(target.lastSeen || 0, entry.lastSeen || 0);
        } else {
          col[fresh.id] = { ...entry, ...fresh }; // fresh display/rarity/price/id win; entry's bookkeeping survives
        }
        extCtx.globalState.update(key, col);
        migrated++;
        if (onProgress) onProgress(migrated, skipped);
      }
    }
  }
  return { migrated, skipped };
}

/** Roll tiers for a freshly-fetched batch of cards and compute what recording
 *  them WOULD look like, against a throwaway clone of the real collection —
 *  so a still-sealed pack can preview isNew/count/unique/total for the reveal
 *  without writing anything real yet. Actual persistence happens later, in
 *  commitPendingPack(), once the player has ripped the pack open. */
function previewPack(rawCards, track) {
  const col = JSON.parse(JSON.stringify(extCtx.globalState.get(collectionKey(track), {})));
  const stats = JSON.parse(JSON.stringify(extCtx.globalState.get(statsKey(track), emptyStats())));
  let lastRec;
  const cards = rawCards.map(card => {
    const tier = rollTier();
    lastRec = applyDraw(col, stats, card, tier);
    return { ...card, tier, isNew: lastRec.isNew, count: lastRec.count };
  });
  // show the final tallies steadily through the reveal
  cards.forEach(c => { c.unique = lastRec.unique; c.total = lastRec.total; });
  return cards;
}

/** Open (or reveal) the Binder panel showing the whole collection. Always
 *  opens back on the Sandbox track; the webview's toggle switches from there. */
function openBinder(context) {
  if (binderPanel) {
    binderPanel.reveal(vscode.ViewColumn.Active);
    sendCollection(binderTrack);
    return;
  }
  binderTrack = 'sandbox';
  binderPanel = vscode.window.createWebviewPanel(
    'ygoBinder',
    game.theme.binderTitle,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  binderPanel.webview.html = renderHtml(binderPanel.webview, 'binder.html');
  binderPanel.webview.onDidReceiveMessage(msg => {
    if (!msg) return;
    if (msg.type === 'ready') sendCollection(binderTrack);
    else if (msg.type === 'setTrack') { binderTrack = msg.track === 'competitive' ? 'competitive' : 'sandbox'; sendCollection(binderTrack); }
    else if (msg.type === 'setGame') setActiveGame(msg.id);
    else if (msg.type === 'reset') resetCollection(binderTrack);
    else if (msg.type === 'requestDraw') { ensurePanel(context); doDraw(); }
    else if (msg.type === 'openPack') { ensurePanel(context); doPack('sandbox'); }
    else if (msg.type === 'openCompetitivePack') { ensurePanel(context); doPack('competitive'); }
  });
  binderPanel.onDidDispose(() => { binderPanel = null; });
}

/** Push the current collection + stats (for the given track) to the open
 *  Binder panel, along with the live Competitive credit balance. */
function sendCollection(track) {
  if (!binderPanel) return;
  const col = extCtx.globalState.get(collectionKey(track), {});
  const stats = extCtx.globalState.get(statsKey(track), emptyStats());
  binderPanel.webview.postMessage({
    type: 'collection', track, cards: Object.values(col), stats,
    credits: github.getCredits(extCtx)
  });
}

/** Wipe the collection (for the given track) after a confirm. */
async function resetCollection(track) {
  const label = track === 'competitive' ? 'Competitive' : 'Sandbox';
  const choice = await vscode.window.showWarningMessage(
    `Reset your entire ${label} card collection? This cannot be undone.`,
    { modal: true },
    'Reset'
  );
  if (choice !== 'Reset') return;
  await extCtx.globalState.update(collectionKey(track), {});
  await extCtx.globalState.update(statsKey(track), emptyStats());
  sendCollection(track);
  vscode.window.showInformationMessage(`��️ ${label} collection reset.`);
}

/** Wipe the Competitive collection + stats for EVERY game — used by the
 *  "Reset Competitive Progress" command, since a credit reset that left the
 *  cards behind would be inconsistent. Sandbox is never touched. Refreshes an
 *  open Binder if it's currently showing a Competitive track. */
async function clearAllCompetitiveCollections() {
  for (const gid of Object.keys(GAMES)) {
    await extCtx.globalState.update(collectionKey('competitive', gid), {});
    await extCtx.globalState.update(statsKey('competitive', gid), emptyStats());
  }
  if (binderPanel && binderTrack === 'competitive') sendCollection('competitive');
}

/*
 * Card drawing with a small prefetch buffer so draws are instant.
 * The game adapter's fetchOne() returns one random raw card; keep() filters
 * the ones we want, we stash extras, and top up in the background. If the
 * network/API is down, fetchRandomCard() throws and the caller tells the
 * player rather than handing them a fake card.
 */
const BUFFER = [];
const BUFFER_TARGET = 18;  // cards to keep ready (a few full packs of headroom)
const REFILL_AT = 12;      // background top-up once we dip to this (still >= a full pack)
let refilling = null;

/** True if a card's art is served from a host this game's CSP allows — i.e. the
 *  card actually belongs to `g` (default: the active game). A card can only ever
 *  be shown or recorded when its host is allowlisted, so a foreign host means a
 *  past cross-game race mis-filed the card. Cards with no art (e.g. old data)
 *  are harmless and kept. */
function cardBelongsToGame(card, g = game) {
  const url = card && card.image;
  if (!url) return true;
  return String(g.theme.imgHosts || '').split(/\s+/).some(h => h && url.startsWith(h));
}

/** Load whatever was left in the active game's buffer at the end of last session.
 *  Drops any wrong-game cards a past switch-race may have left in this file, plus
 *  any old-schema cards from a pre-rarity/price build (no `rarity` key — a fresh
 *  card legitimately with no rarity still has the key set to null, so it's kept).
 *  Both self-heal on reload: dropped cards are just re-fetched with the current
 *  normalize() instead of being served/recorded stale. */
function loadBufferCache() {
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    if (Array.isArray(cached)) {
      BUFFER.push(...cached.filter(c => c && c.name && ('rarity' in c) && cardBelongsToGame(c)).slice(0, BUFFER_TARGET));
    }
  } catch {
    // no cache yet, or it's corrupt — ensureRefill() will populate it from the network
  }
}

/** Persist the buffer to the CURRENT game's file immediately and cancel any
 *  pending debounced write. Called on game switch so the outgoing game's cards
 *  land in its own file and no stale timer can later fire against the incoming
 *  game — see persistBufferSoon for why the debounced path alone isn't enough. */
function flushBufferNow() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  if (!extCtx) return;
  const file = cachePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(BUFFER));
  } catch {
    // best-effort; a missed flush just means this game warms from the network next time
  }
}

/** Debounced, best-effort snapshot so the next reload starts warm instead of empty. */
function persistBufferSoon() {
  if (!extCtx || persistTimer) return;
  const file = cachePath();
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const snapshot = JSON.stringify(BUFFER);
    fs.mkdir(path.dirname(file), { recursive: true }, () => {
      fs.writeFile(file, snapshot, () => {});
    });
  }, 400);
}

/** Fetch a batch of raw cards; add any kept ones (deduped by name) to the
 *  buffer. Prefers the adapter's `fetchBatch(count)` (ONE request for many
 *  cards) when it has one — this matters for rate-limited APIs like
 *  pokemontcg.io, where firing `count` parallel single-card requests triggers
 *  429s and starves the buffer. Falls back to a parallel `fetchOne` burst for
 *  adapters with a fast random endpoint (e.g. Yu-Gi-Oh's randomcard.php).
 *
 *  We deliberately do NOT download the art here. The webview loads each image
 *  URL directly from the CDN (allowed by the CSP) and its own preload() waits
 *  for decode before painting — so harvest moves only tiny JSON metadata. */
async function harvest(count) {
  // util.inspect renders the full error as a plain string (message, stack,
  // .cause chain, any AggregateError.errors) BEFORE logging — a bare Error
  // object loses those custom properties when the Extension Host forwards
  // console output to the main window's console, leaving only the generic
  // "TypeError: fetch failed" wrapper undici throws with no way to see why.
  const onFail = err => { console.error('[ygo-duel] card fetch failed:\n' + util.inspect(err, { depth: 10 })); };
  const burst = game.fetchBatch
    ? await game.fetchBatch(count).catch(err => { onFail(err); return []; })
    : await Promise.all(Array.from({ length: count }, () => game.fetchOne().catch(err => { onFail(err); return null; })));
  for (const c of burst) {
    if (c && game.keep(c) && !BUFFER.some(b => b.name === c.name)) {
      BUFFER.push(game.normalize(c));
    }
  }
  persistBufferSoon();
  sendPrefetch();  // newly harvested art can start warming right away
}

/** Background top-up to BUFFER_TARGET; only one runs at a time. */
function ensureRefill() {
  if (refilling) return refilling;
  refilling = (async () => {
    let rounds = 0;
    while (BUFFER.length < BUFFER_TARGET && rounds < 5) {
      rounds++;
      await harvest(BUFFER_TARGET - BUFFER.length + 2);
    }
  })().catch(() => {}).finally(() => { refilling = null; });
  return refilling;
}

/** Return a monster: instant from the buffer, else block on a refill burst.
 *  ensureRefill already coalesces concurrent callers (via `refilling`) and
 *  retries a few rounds, so a cold 5-card pack fires one shared harvest.
 *  Draws a RANDOM buffer slot rather than the front, so the 5 cards of a pack
 *  are a varied mix of whatever's buffered instead of a contiguous (and thus
 *  same-set / same-rarity-looking) run. Throws if the buffer is still empty
 *  after a refill attempt (network down, API rate-limited, etc.) — callers
 *  are responsible for telling the player the fetch failed rather than
 *  handing them a fake card. */
async function fetchRandomCard() {
  if (BUFFER.length === 0) await ensureRefill();
  if (BUFFER.length === 0) throw new Error('no card available — fetch failed');
  const card = BUFFER.splice(Math.floor(Math.random() * BUFFER.length), 1)[0];
  if (BUFFER.length <= REFILL_AT) ensureRefill();
  persistBufferSoon();
  return card;
}

function deactivate() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  discardPendingPack(); // a reload mid-rip just abandons the unopened pack — no credit was spent
  if (!extCtx) return;
  try {
    const file = cachePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(BUFFER));
  } catch {
    // best-effort; a missed flush just means next activation warms up from the network
  }
}

module.exports = { activate, deactivate };
