/*
 * Pack-opening domain logic — how many packs to open, how a fetched pile of
 * cards is split/sorted/previewed, and the collection fold used both to
 * preview a still-sealed pack and to commit it for real.
 *
 * Pure: no vscode, no I/O. extension.js owns credits, the buffer, and when
 * a session is committed; the Field webview owns how a session is shown.
 */

const PACK_SIZE = 5;
/** Hard cap on one bulk open, so a huge credit balance can't stall the host
 *  on a 500-card fetch. Open All of a bigger pile just takes this many and
 *  leaves the rest on the balance. */
const MAX_BULK_PACKS = 100;

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

module.exports = {
  PACK_SIZE,
  MAX_BULK_PACKS,
  resolvePackCount,
  chunkIntoPacks,
  applyDraw,
  previewPacks,
  summarizePacks
};
