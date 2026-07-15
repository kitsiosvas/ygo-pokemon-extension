/*
 * Game definition for Pokémon (Pokémon TCG cards via pokemontcg.io).
 *
 * Same contract as games/yugioh.js — see that file for the field-by-field
 * description of the adapter + theme. This one pulls real Pokémon TCG cards.
 *
 * Data source: https://docs.pokemontcg.io/ — works without an API key at a
 * lower rate limit; drop a free key into the header below to raise it.
 */

const api = 'https://api.pokemontcg.io/v2/cards';
const MAX_PAGE = 15000; // stay safely under the ~19.5k total-card count
const TOTAL_CARDS = 19000; // approx catalog size, for picking a random page by page-size

async function fetchOne() {
  // pokemontcg.io has no "random" endpoint, so grab one card from a random page
  const page = 1 + Math.floor(Math.random() * MAX_PAGE);
  const res = await fetch(api + '?pageSize=1&page=' + page, {
    headers: { 'Accept': 'application/json' }
    // headers: { 'X-Api-Key': '<your-free-key>' }  // optional: higher rate limit
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  const c = json && Array.isArray(json.data) ? json.data[0] : null;
  if (!c || !c.name) throw new Error('unexpected API shape');
  return c;
}

/* Batch fetch used by the buffer: ONE request for a big page. Two things make
 * this the right call for pokemontcg.io's slow, keyless-rate-limited API:
 *   - At this page size the API's ordering spans dozens of different sets in a
 *     single response (~46 sets in a 50-card page), so the buffer is naturally
 *     varied — no need for multiple requests to mix sets.
 *   - It deliberately over-fills the buffer, so refills happen roughly once
 *     every several packs instead of every pack. Fewer total requests is what
 *     keeps the API from throttling us into multi-second stalls after a run of
 *     pulls. `count` is ignored on purpose — one big page is cheapest.
 * We still shuffle so buffer insertion order isn't the page's order. */
const BATCH_PAGE_SIZE = 55;
async function fetchBatch(/* count ignored — one big page is cheapest */) {
  const maxPage = Math.max(1, Math.floor(TOTAL_CARDS / BATCH_PAGE_SIZE));
  const page = 1 + Math.floor(Math.random() * maxPage);
  const res = await fetch(api + '?pageSize=' + BATCH_PAGE_SIZE + '&page=' + page, {
    headers: { 'Accept': 'application/json' }
    // headers: { 'X-Api-Key': '<your-free-key>' }  // optional: higher rate limit
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  const data = json && Array.isArray(json.data) ? json.data : [];
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
  return {
    id: c.id != null ? c.id : c.name,
    name: c.name,
    image: images.large || images.small || null,
    hp: c.hp ? Number(c.hp) : null,
    attr: (c.types && c.types[0]) || null,
    type: (c.subtypes && c.subtypes.join(' / ')) || null
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
  binderTitle: '�� Pokédex',
  // drawWord = the base-tier banner; revealNoun fills each rarer tier's
  // wordTemplate (e.g. "✨ SHINY {noun}! ✨" → "✨ SHINY DRAW! ✨").
  drawWord: 'DRAW!',
  revealNoun: 'DRAW',
  actionLabel: '⚡ Draw',
  itemPlural: 'Pokémon',
  imgHosts: 'https://images.pokemontcg.io',
  // Pokémon energy type → icon, used on the fallback (emoji) card
  attrIcons: {
    Fire: '��', Water: '��', Grass: '��', Lightning: '⚡', Psychic: '��',
    Fighting: '��', Darkness: '��', Metal: '⚙️', Fairy: '��', Dragon: '��', Colorless: '⭐'
  },
  attrKey: 'attr',
  stats: [ { key: 'hp', label: 'HP' } ],
  packTitle: 'BOOSTER',
  packSubtitle: 'PACK',
  // real pack image's width/height ratio (media/pack-pokemon.jpg is 311×592),
  // so the pack box matches its shape with no cropping
  packAspectRatio: '311 / 592'
};

module.exports = { api, fetchOne, fetchBatch, keep, normalize, power, theme };