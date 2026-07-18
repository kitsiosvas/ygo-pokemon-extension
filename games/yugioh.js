/*
 * Game definition for Yu-Gi-Oh.
 *
 * Everything game-specific lives here: where cards come from (the data
 * adapter) and how they're presented (the theme). To make a differently
 * themed version (e.g. Pokémon), copy this file, rewrite the adapter for the
 * new API, tweak the theme, and point extension.js at it — nothing else in the
 * codebase hardcodes Yu-Gi-Oh.
 *
 * Adapter contract (consumed by extension.js):
 *   api                  string   — endpoint hit by fetchOne
 *   fetchOne()           async    — returns one raw card object from the API
 *   keep(raw)            bool     — should this raw card be kept? (filter)
 *   normalize(raw)       object   — map a raw card to our internal shape:
 *                                   { id, name, image, ...displayFields, }
 *   power(card)          number   — base rarity score (bigger = rarer/last)
 *   theme                object   — display config, forwarded to the webviews
 */

const { getJson } = require('../http');

const api = 'https://db.ygoprodeck.com/api/v7/randomcard.php';
const CARDINFO_API = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';

async function fetchOne() {
  const json = await getJson(api);
  const c = json && Array.isArray(json.data) ? json.data[0] : json;
  if (!c || !c.name) throw new Error('unexpected API shape');
  return c;
}

/** Look up one exact, already-known card by its YGOPRODeck id — used to
 *  backfill rarity/price onto cards caught before that data existed. */
async function fetchById(id) {
  const json = await getJson(CARDINFO_API + '?id=' + encodeURIComponent(id));
  const c = json && Array.isArray(json.data) ? json.data[0] : null;
  if (!c || !c.name) throw new Error('card not found: ' + id);
  return c;
}

/* randomcard.php can't filter, so we pull random cards and keep only Monsters
 * (their `type` always contains "Monster"). */
function keep(c) {
  return typeof c.type === 'string' && c.type.includes('Monster');
}

function normalize(c) {
  // A card can have several real-world printings at different rarities (e.g.
  // reprinted as both Ultra Rare and Starlight Rare) — pick one at random.
  // Picking uniformly over card_sets (rather than an explicit rarity-rank
  // table) already leans common: a card reprinted at Common in several
  // structure decks has several array entries, while a one-off chase rarity
  // has just one — no 20-years-of-rarity-names table to maintain.
  const sets = Array.isArray(c.card_sets) ? c.card_sets : [];
  const printing = sets.length ? sets[Math.floor(Math.random() * sets.length)] : null;
  // Real-world price: any single market blanks out per card (e.g. a new set has
  // no TCGplayer listing yet), so take the first market that lists a price.
  const p = (c.card_prices && c.card_prices[0]) || {};
  const price = ['cardmarket_price', 'tcgplayer_price', 'ebay_price', 'amazon_price', 'coolstuffinc_price']
    .map(k => Number(p[k])).find(v => v > 0) || null;
  const rarity = (printing && printing.set_rarity) || null;
  const baseId = c.id != null ? c.id : c.name;

  return {
    // Different rarities of the same card are different binder entries (a
    // Common and a Secret Rare "Dark Magician" both fill their own slot) —
    // falls back to the plain id when a card has no listed printings.
    id: rarity ? baseId + ' · ' + rarity : baseId,
    name: c.name,
    image: c.card_images && c.card_images[0] && c.card_images[0].image_url,
    atk: typeof c.atk === 'number' ? c.atk : null,
    def: typeof c.def === 'number' ? c.def : null,
    level: c.level || c.linkval || null,
    attr: c.attribute || null,
    type: c.type || null,
    desc: c.desc || '',
    rarity,
    price
  };
}

/** Base rarity: stronger monsters reveal later. */
function power(c) {
  return c.atk || 0;
}

const theme = {
  ns: 'ygoDuel',
  toggleLabel: '�� YGO',
  fieldTitle: '�� Duel Field',
  binderTitle: '�� Card Binder',
  // action words shown in banners / buttons / empty states.
  // drawWord = the base-tier banner; revealNoun fills each rarer tier's
  // wordTemplate (e.g. "✨ SHINY {noun}! ✨" → "✨ SHINY DRAW! ✨").
  drawWord: 'DRAW!',
  revealNoun: 'DRAW',
  actionLabel: '⚔️ Draw',
  itemPlural: 'monsters',
  // CSP img-src hosts the webviews are allowed to load art from
  imgHosts: 'https://images.ygoprodeck.com https://storage.googleapis.com',
  // attribute → icon, used on the fallback (emoji) card
  attrIcons: { DARK: '��', LIGHT: '☀️', EARTH: '⛰️', WATER: '��', FIRE: '��', WIND: '��️', DIVINE: '✴️' },
  attrKey: 'attr',
  // stat rows rendered under a card (order matters); each reads card[key]
  stats: [ { key: 'atk', label: 'ATK' }, { key: 'def', label: 'DEF' } ],
  // fallback SVG pack wordmark (only shown when no media/pack.* image exists)
  packTitle: 'DUEL',
  packSubtitle: 'PACK',
  // real pack image's width/height ratio (media/pack-yugioh.jpg is 657×1181),
  // so the pack box matches its shape with no cropping
  packAspectRatio: '657 / 1181'
};

module.exports = { api, fetchOne, fetchById, keep, normalize, power, theme };
