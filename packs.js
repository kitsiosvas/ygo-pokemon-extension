/*
 * Pack-opening domain logic — how many packs to open, how a fetched pile of
 * cards is split/sorted/previewed, and the collection fold used both to
 * preview a still-sealed pack and to commit it for real.
 *
 * Pure: no vscode, no I/O. extension.js owns credits, the buffer, and when
 * a session is committed; the Field webview owns how a session is shown.
 */

const PACK_SIZE = 5;
/** Hard cap on one bulk open. 20 packs = 100 cards — enough to feel like a
 *  real rip without a long fetch that often dies mid-burst. A bulk open of a
 *  bigger pile takes this many and leaves the rest on the balance. */
const MAX_BULK_PACKS = 20;

/** Turn a requested count ('all' | number) into an actual pack count.
 *  Competitive is clamped to the credit balance; sandbox has no "all"
 *  (unlimited) so a missing/invalid count means 1. Both tracks cap at
 *  MAX_BULK_PACKS. */
function resolvePackCount(requested, credits, competitive) {
  const cap = MAX_BULK_PACKS;
  if (competitive) {
    const available = Math.max(0, Math.floor(Number(credits) || 0));
    if (available <= 0) return 0;
    if (requested === 'all' || requested === '*') return Math.min(available, cap);
    const n = Math.floor(Number(requested));
    if (!Number.isFinite(n) || n < 1) return 0;
    return Math.min(n, available, cap);
  }
  if (requested === 'all' || requested === '*') return 0;
  const n = Math.floor(Number(requested));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, cap);
}

/** Split a flat card list into complete packs; leftover cards (< PACK_SIZE)
 *  are not a pack and should be returned to the buffer. */
function chunkIntoPacks(cards, size = PACK_SIZE) {
  const list = Array.isArray(cards) ? cards : [];
  const n = Math.floor(list.length / size) * size;
  const packs = [];
  for (let i = 0; i < n; i += size) packs.push(list.slice(i, i + size));
  return { packs, leftover: list.slice(n) };
}

/** Pure state transition: fold one draw into the given col/stats objects and
 *  return progress info. Doesn't touch storage — recordCollection uses it
 *  against the live collection, previewPacks uses it against a throwaway
 *  clone so a sealed pack can be shown without actually being recorded. */
function applyDraw(col, stats, card) {
  const id = String(card.id || card.name);
  const existing = col[id];
  const isNew = !existing;
  // store the whole normalized card (whatever fields the game produced) plus
  // our bookkeeping, so the collection isn't tied to any one game's schema.
  const entry = existing || {
    ...card,
    id,
    count: 0,
    firstSeen: Date.now()
  };
  entry.count += 1;
  entry.lastSeen = Date.now();
  col[id] = entry;

  stats.total += 1;

  return { isNew, count: entry.count, unique: Object.keys(col).length, total: stats.total };
}

/** Preview N packs against a throwaway clone of the collection: each card
 *  gets isNew/count as if the packs were committed in order, each pack is
 *  then sorted weakest→strongest for reveal, and every card carries the
 *  FINAL unique/total so the tally stays steady through the session.
 *  `rarityScore(card)` is injected so this file doesn't import a game. */
function previewPacks(rawCards, col, stats, rarityScore) {
  const { packs, leftover } = chunkIntoPacks(rawCards);
  let lastRec;
  const previewed = packs.map(pack => {
    const cards = pack.map(card => {
      lastRec = applyDraw(col, stats, card);
      return { ...card, isNew: lastRec.isNew, count: lastRec.count };
    });
    if (typeof rarityScore === 'function') {
      cards.sort((a, b) => rarityScore(a) - rarityScore(b));
    }
    return cards;
  });
  const unique = lastRec ? lastRec.unique : Object.keys(col).length;
  const total = lastRec ? lastRec.total : stats.total;
  for (const pack of previewed) {
    for (const c of pack) { c.unique = unique; c.total = total; }
  }
  return { packs: previewed, leftover };
}

function summarizePacks(packs) {
  const cards = (packs || []).flat();
  return {
    packCount: (packs || []).length,
    cardCount: cards.length,
    newCount: cards.filter(c => c.isNew).length
  };
}

/** True while a session is still fetching, waiting to be ripped, or writing
 *  (spend + record). A committed play pack that has finished writing may
 *  still be on screen, but the host is done with it and the next open is
 *  allowed. `writing` stays set across the spend await so the lock is not
 *  dropped before credits actually move. */
function isPackSessionBusy(session) {
  return !!(session && (!session.committed || session.writing));
}

/** Host-wide busy flag: an explicit lock (held from the start of openPacks,
 *  including the confirm modal) OR an in-flight session. */
function isPackOpenBusy(session, lockHeld) {
  return !!lockHeld || isPackSessionBusy(session);
}

function canStartPackOpen(session, lockHeld) {
  return !isPackOpenBusy(session, lockHeld);
}

/** Split a burst into packs we actually paid for vs packs to put back.
 *  `spent` is what spendCredits returned; unpaid packs must not be recorded. */
function splitPaidPacks(packs, spent) {
  const list = Array.isArray(packs) ? packs : [];
  const n = Math.max(0, Math.min(list.length, Math.floor(Number(spent) || 0)));
  return { paid: list.slice(0, n), unpaid: list.slice(n) };
}

/** Cards to persist after a spend attempt. Sandbox records the whole burst;
 *  Competitive records only as many complete packs as credits actually moved. */
function settlePackSpend(packs, spent, competitive) {
  const list = Array.isArray(packs) ? packs : [];
  if (!competitive) return { paid: list.slice(), unpaid: [] };
  return splitPaidPacks(list, spent);
}

/** How many cards a refill should aim for. A bulk fetch passes remaining
 *  cards needed so we don't top up to the 1-pack BUFFER_TARGET mid-burst. */
function refillTarget(remaining, bufferTarget) {
  const need = Math.max(0, Math.floor(Number(remaining) || 0));
  const steady = Math.max(0, Math.floor(Number(bufferTarget) || 0));
  return Math.max(steady, need);
}

/** If a refill is already running, a larger bulk goal must win — never keep
 *  the smaller in-flight target and ignore the burst. */
function coalesceRefillGoal(inFlightGoal, requested, bufferTarget) {
  return Math.max(
    refillTarget(inFlightGoal, bufferTarget),
    refillTarget(requested, bufferTarget)
  );
}

/** The goal a refill request may actually use, given what the active fetch
 *  still needs right now (`liveNeed`, 0 when no fetch is running). A bulk
 *  goal is only honoured while a fetch still needs that many cards: it shrinks
 *  to the live need as the fetch progresses and to `bufferTarget` once the
 *  fetch is done — so a request captured mid-fetch (or a callback queued
 *  behind an in-flight refill) can never start a fresh 90-card loop after the
 *  fetch has returned. Never raises a goal above what was asked for. */
function liveRefillGoal(requestedGoal, liveNeed, bufferTarget) {
  const goal = Math.max(0, Math.floor(Number(requestedGoal) || 0));
  const need = Math.max(0, Math.floor(Number(liveNeed) || 0));
  return refillTarget(Math.min(goal, need), bufferTarget);
}

module.exports = {
  PACK_SIZE,
  MAX_BULK_PACKS,
  resolvePackCount,
  chunkIntoPacks,
  applyDraw,
  previewPacks,
  summarizePacks,
  isPackSessionBusy,
  isPackOpenBusy,
  canStartPackOpen,
  splitPaidPacks,
  settlePackSpend,
  refillTarget,
  coalesceRefillGoal,
  liveRefillGoal
};
