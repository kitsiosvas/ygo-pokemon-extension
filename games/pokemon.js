/*
 * Game definition for Pokémon (Pokémon TCG cards via pokemontcg.io).
 *
 * Same contract as games/yugioh.js — see that file for the field-by-field
 * description of the adapter + theme. This one pulls real Pokémon TCG cards.
 *
 * Data source: https://docs.pokemontcg.io/ — works without an API key at a
 * lower rate limit; drop a free key into the header below to raise it.
 */

const { getJson } = require('../http');

const api = 'https://api.pokemontcg.io/v2/cards';
const MAX_PAGE = 15000; // stay safely under the ~19.5k total-card count

// Optional: a free pokemontcg.io API key raises the rate limit. Drop it here
// and it's forwarded on every request:  const KEY_HEADER = { 'X-Api-Key': '<key>' };
const KEY_HEADER = {};

// EUR→USD rate for cardmarket fallback prices. Fetched once at module load from
// the ECB via frankfurter.app; falls back to 1.10 if the request fails.
let eurUsd = 1.10;
getJson('https://api.frankfurter.app/latest?from=EUR&to=USD', {})
  .then(json => { const r = json && json.rates && json.rates.USD; if (r > 0) eurUsd = r; })
  .catch(() => {});

async function fetchOne() {
  // pokemontcg.io has no "random" endpoint, so grab one card from a random page
  const page = 1 + Math.floor(Math.random() * MAX_PAGE);
  const json = await getJson(api + '?pageSize=1&page=' + page, KEY_HEADER);
  const c = json && Array.isArray(json.data) ? json.data[0] : null;
  if (!c || !c.name) throw new Error('unexpected API shape');
  return c;
}

/** Look up one exact, already-known card by its pokemontcg.io id — used to
 *  backfill rarity/price onto cards caught before that data existed. The
 *  by-id endpoint returns a single object under "data", not an array. */
async function fetchById(id) {
  const json = await getJson(api + '/' + encodeURIComponent(id), KEY_HEADER);
  const c = json && json.data;
  if (!c || !c.name) throw new Error('card not found: ' + id);
  return c;
}

/* Batch fetch used by the buffer: 3 parallel requests, each from a different
 * random page, so the buffer spans multiple eras of the catalog instead of one
 * narrow set-ordered slice. The API orders cards by set ID (release timeline),
 * so a single page clusters cards from the same era with similar rarities —
 * spreading across 3 independent pages fixes that at the cost of 3x requests,
 * which run concurrently so wall-clock latency stays similar. */
const BATCH_PAGE_SIZE = 15;
const BATCH_REQUESTS = 3;
async function fetchBatch() {
  const maxPage = Math.max(1, Math.floor(MAX_PAGE / BATCH_PAGE_SIZE));
  const pages = Array.from({ length: BATCH_REQUESTS }, () => 1 + Math.floor(Math.random() * maxPage));
  const results = await Promise.all(
    pages.map(page => getJson(api + '?pageSize=' + BATCH_PAGE_SIZE + '&page=' + page, KEY_HEADER))
  );
  const data = results.flatMap(json => (json && Array.isArray(json.data) ? json.data : []));
  for (let i = data.length - 1; i > 0; i--) {   // Fisher–Yates shuffle
    const j = Math.floor(Math.random() * (i + 1));
    [data[i], data[j]] = [data[j], data[i]];
  }
  return data;
}

/** Keep actual Pokémon, skip Trainer/Energy cards (≈ "monsters only"). */
function keep(c) {
  return c.supertype === 'Pokémon';
}

function normalize(c) {
  const images = c.images || {};

  // Display currency is USD. TCGplayer variants are already USD; cardmarket
  // fallback is EUR and converted via the cached rate.
  // Randomly pick a TCGplayer variant that has a real market price.
  const tcgEntries = c.tcgplayer && c.tcgplayer.prices
    ? Object.entries(c.tcgplayer.prices).filter(([, v]) => v.market > 0)
    : [];
  const tcgPick = tcgEntries.length
    ? tcgEntries[Math.floor(Math.random() * tcgEntries.length)]
    : null;
  const tcgPrice = tcgPick ? tcgPick[1].market : null;

  // Cardmarket fallback (EUR → USD). trendPrice is the most stable signal;
  // averageSellPrice is the next best.
  const cm = c.cardmarket && c.cardmarket.prices;
  const cmEur = cm && (cm.trendPrice > 0 ? cm.trendPrice : cm.averageSellPrice > 0 ? cm.averageSellPrice : null);
  const cmPrice = cmEur ? Math.round(cmEur * eurUsd * 100) / 100 : null;

  const price = tcgPrice || cmPrice || null;

  return {
    id: c.id != null ? c.id : c.name,
    name: c.name,
    // "small" (~160KB) keeps the draw/pack reveal and Binder grid thumbnails
    // fast — preload() blocks the reveal animation on a full download+decode,
    // and "large" (~850KB hi-res scan) made that a multi-second stall.
    // imageFull keeps the hi-res scan around for the Binder's zoomed popup,
    // where the extra detail is actually visible and load time isn't in the
    // way of an animation.
    image: images.small || images.large || null,
    imageFull: images.large || images.small || null,
    hp: c.hp ? Number(c.hp) : null,
    attr: (c.types && c.types[0]) || null,
    type: (c.subtypes && c.subtypes.join(' / ')) || null,
    rarity: c.rarity || null,
    price
  };
}

/** Base rarity: higher-HP Pokémon reveal later. */
function power(c) {
  return c.hp || 0;
}

const theme = {
  ns: 'ygoDuel',
  toggleLabel: '⚡ Poké',
  fieldTitle: '⚡ Poké Field',
  binderTitle: '📖 Pokédex',
  // drawWord = the reveal banner shown on every draw/pack card.
  drawWord: 'DRAW!',
  actionLabel: '⚡ Draw',
  itemPlural: 'Pokémon',
  imgHosts: 'https://images.pokemontcg.io',
  // Pokémon energy type → icon, used on the fallback (emoji) card
  attrIcons: {
    Fire: '🔥', Water: '💧', Grass: '🌿', Lightning: '⚡', Psychic: '🔮',
    Fighting: '👊', Darkness: '🌑', Metal: '⚙️', Fairy: '🧚', Dragon: '🐉', Colorless: '⭐'
  },
  attrKey: 'attr',
  stats: [ { key: 'hp', label: 'HP' } ],
  packTitle: 'BOOSTER',
  packSubtitle: 'PACK',
  // real pack image's width/height ratio (media/pack-pokemon.jpg is 311×592),
  // so the pack box matches its shape with no cropping
  packAspectRatio: '311 / 592'
};

module.exports = { api, fetchOne, fetchById, fetchBatch, keep, normalize, power, theme };
