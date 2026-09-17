'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  PACK_SIZE,
  MAX_BULK_PACKS,
  resolvePackCount,
  chunkIntoPacks,
  applyDraw,
  previewPacks,
  summarizePacks,
  isPackSessionBusy
} = require('./packs');

describe('resolvePackCount', () => {
  it('clamps competitive opens to credits and the bulk cap', () => {
    assert.equal(resolvePackCount(1, 30, true), 1);
    assert.equal(resolvePackCount(10, 7, true), 7);
    assert.equal(resolvePackCount('all', 30, true), MAX_BULK_PACKS);
    assert.equal(resolvePackCount('all', 0, true), 0);
    assert.equal(resolvePackCount('all', 250, true), MAX_BULK_PACKS);
    assert.equal(resolvePackCount(0, 5, true), 0);
    assert.equal(resolvePackCount('nope', 5, true), 0);
  });

  it('treats sandbox as free, defaulting invalid counts to 1 (no "all")', () => {
    assert.equal(resolvePackCount(1, 0, false), 1);
    assert.equal(resolvePackCount(8, 0, false), 8);
    assert.equal(resolvePackCount(999, 0, false), MAX_BULK_PACKS);
    assert.equal(resolvePackCount('all', 0, false), 0);
    assert.equal(resolvePackCount(undefined, 0, false), 1);
  });
});

describe('isPackSessionBusy', () => {
  it('blocks only an uncommitted in-flight session', () => {
    assert.equal(isPackSessionBusy(null), false);
    assert.equal(isPackSessionBusy({ committed: false }), true);
    assert.equal(isPackSessionBusy({ committed: true }), false);
  });
});

describe('chunkIntoPacks', () => {
  it('keeps only complete packs and returns leftover cards', () => {
    const cards = Array.from({ length: 12 }, (_, i) => ({ id: i }));
    const { packs, leftover } = chunkIntoPacks(cards);
    assert.equal(packs.length, 2);
    assert.equal(packs[0].length, PACK_SIZE);
    assert.equal(packs[1].length, PACK_SIZE);
    assert.deepEqual(leftover.map(c => c.id), [10, 11]);
  });

  it('returns nothing when there are not enough cards for one pack', () => {
    const { packs, leftover } = chunkIntoPacks([{ id: 1 }, { id: 2 }]);
    assert.deepEqual(packs, []);
    assert.equal(leftover.length, 2);
  });
});

describe('applyDraw', () => {
  it('marks the first copy new and later copies as dupes', () => {
    const col = {};
    const stats = { total: 0 };
    const a = applyDraw(col, stats, { id: 'dm', name: 'Dark Magician' });
    assert.equal(a.isNew, true);
    assert.equal(a.count, 1);
    assert.equal(a.unique, 1);
    assert.equal(a.total, 1);
    const b = applyDraw(col, stats, { id: 'dm', name: 'Dark Magician' });
    assert.equal(b.isNew, false);
    assert.equal(b.count, 2);
    assert.equal(b.unique, 1);
    assert.equal(b.total, 2);
    assert.equal(col.dm.count, 2);
  });
});

const html = fs.readFileSync(path.join(__dirname, 'media', 'duel.html'), 'utf8');
const binder = fs.readFileSync(path.join(__dirname, 'media', 'binder.html'), 'utf8');
const manifest = fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8');
const host = fs.readFileSync(path.join(__dirname, 'extension.js'), 'utf8');

describe('Field / Binder pack UI hooks', () => {
  it('Field speaks the packSession protocol and has bulk-open controls', () => {
    assert.match(html, /type === 'packSession'/);
    assert.match(html, /compAllBtn/);
    assert.match(html, /packResults/);
    assert.match(html, /count: 'all'/);
    assert.match(html, /Open ' \+ burst/);
    assert.match(html, /MAX_BULK_PACKS/);
    assert.match(html, /id="bulkModal"/);
    assert.match(html, /openBulkModal/);
    assert.match(html, /r-price/);
    assert.match(html, /r-name/);
    assert.match(html, /data-idx/);
    assert.match(html, /cardPriceLabel/);
    assert.match(html, /#bulkModal \{[^}]*position: fixed/);
    assert.match(html, /#bulkModalCard \{[^}]*user-select: text/);
    assert.match(html, /\.mname, \.mtype, \.mdesc, \.mmeta, \.mprice, \.mstats/);
  });

  it('Binder can open one competitive pack or a bulk burst', () => {
    assert.match(binder, /packAllBtn/);
    assert.match(binder, /count: 'all'/);
    assert.match(binder, /Open ' \+ burst/);
  });

  it('Actions tree and command palette say bulk, not all', () => {
    assert.match(host, /Open Bulk Competitive Packs/);
    assert.match(host, /Open up to 20 earned Competitive packs at once/);
    assert.doesNotMatch(host, /Open All Competitive Packs/);
    assert.match(manifest, /Cards: Open Bulk Competitive Packs/);
    assert.doesNotMatch(manifest, /Cards: Open All Competitive Packs/);
  });

  it('single-pack wrapper waits for a tap by default', () => {
    const cfg = JSON.parse(manifest).contributes.configuration.properties['ygoDuel.packReveal'];
    assert.equal(cfg.default, 'tap');
    assert.deepEqual(cfg.enum, ['auto', 'tap']);
  });
});

describe('previewPacks', () => {
  it('previews sequentially so later dupes in the same burst are not new', () => {
    const raw = [
      { id: 'a', name: 'A', atk: 100 },
      { id: 'b', name: 'B', atk: 200 },
      { id: 'c', name: 'C', atk: 300 },
      { id: 'a', name: 'A', atk: 100 },
      { id: 'd', name: 'D', atk: 50 }
    ];
    const { packs, leftover } = previewPacks(raw, {}, { total: 10 }, c => c.atk);
    assert.equal(leftover.length, 0);
    assert.equal(packs.length, 1);
    // reveal order is weakest first (atk); equal-atk keeps apply order
    assert.deepEqual(packs[0].map(c => c.id), ['d', 'a', 'a', 'b', 'c']);
    const copies = packs[0].filter(c => c.id === 'a');
    assert.equal(copies[0].isNew, true);
    assert.equal(copies[0].count, 1);
    assert.equal(copies[1].isNew, false);
    assert.equal(copies[1].count, 2);
    assert.equal(packs[0].find(c => c.id === 'd').isNew, true);
    // final tallies are stamped on every card
    assert.ok(packs[0].every(c => c.unique === 4 && c.total === 15));
  });

  it('previews several packs independently then stamps the session totals', () => {
    const raw = Array.from({ length: 10 }, (_, i) => ({
      id: 'c' + i,
      name: 'C' + i,
      atk: i
    }));
    const { packs } = previewPacks(raw, {}, { total: 0 }, c => c.atk);
    assert.equal(packs.length, 2);
    assert.equal(summarizePacks(packs).newCount, 10);
    assert.equal(summarizePacks(packs).cardCount, 10);
    assert.ok(packs.flat().every(c => c.unique === 10 && c.total === 10));
  });

  it('preview tallies match committing the same cards against a copy of the collection', () => {
    const startCol = { x: { id: 'x', name: 'X', count: 2 } };
    const startStats = { total: 2 };
    const raw = [
      { id: 'x', name: 'X' },
      { id: 'y', name: 'Y' },
      { id: 'z', name: 'Z' },
      { id: 'y', name: 'Y' },
      { id: 'w', name: 'W' }
    ];
    const { packs } = previewPacks(
      raw,
      JSON.parse(JSON.stringify(startCol)),
      JSON.parse(JSON.stringify(startStats)),
      () => 0
    );
    const col = JSON.parse(JSON.stringify(startCol));
    const stats = JSON.parse(JSON.stringify(startStats));
    for (const c of raw) applyDraw(col, stats, c);
    const last = packs[0][packs[0].length - 1];
    assert.equal(last.unique, Object.keys(col).length);
    assert.equal(last.total, stats.total);
    assert.equal(col.x.count, 3);
    assert.equal(col.y.count, 2);
  });

  it('caps a large competitive pile at MAX_BULK_PACKS and returns leftover cards', () => {
    const n = resolvePackCount('all', 31, true);
    assert.equal(n, MAX_BULK_PACKS);
    const raw = Array.from({ length: n * PACK_SIZE + 2 }, (_, i) => ({ id: 'c' + i, name: 'C' + i, atk: i % 7 }));
    const { packs, leftover } = previewPacks(raw, {}, { total: 0 }, c => c.atk);
    const summary = summarizePacks(packs);
    assert.equal(summary.packCount, 20);
    assert.equal(summary.cardCount, 100);
    assert.equal(summary.newCount, 100);
    assert.equal(leftover.length, 2);
    assert.equal(packs.every(p => p.length === PACK_SIZE), true);
  });
});
