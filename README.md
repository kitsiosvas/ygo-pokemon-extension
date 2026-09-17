# ⚔️ YGO Duel Mode

*It's time to d-d-d-duel!* A personal, for-fun VS Code extension that plays a
**card draw animation** in a side panel — card rises from below, spins in
3D, holo-shimmers, and bursts into a shower of stars with a banner.

Ships with two games you switch between from the Command Palette:
- **Yu-Gi-Oh** — cards from the free [YGOPRODeck API](https://ygoprodeck.com/api-guide/)
- **Pokémon** — TCG cards from [pokemontcg.io](https://docs.pokemontcg.io/)

Real cards are fetched at runtime; no card art is stored in this repo. If a
fetch fails (offline, or the source API is down/rate-limited), you'll get a
heads-up notification instead of a card — nothing is recorded and no
Competitive credit is spent.

Each game splits into two collections/tracks:
- **Sandbox** — the original, always-free draw/pack flow. Unlimited, no setup.
- **Competitive 🏆** — packs earned by merging your own PRs **or** pushing
  straight to a repo's default branch on GitHub. Size (additions + deletions)
  awards **1 / 2 / 3** packs for **&lt;20 / 20–199 / 200+** lines. Commits that
  landed via a PR are skipped so a merge never pays twice. Separate collection
  from Sandbox.

> Personal project — not published, not distributed. Yu-Gi-Oh art is property of
> Konami; Pokémon art is property of Nintendo / The Pokémon Company. This tool
> only *displays* cards fetched live from public fan APIs for personal use.

## Install (from a `.vsix`)

Handed a `ygo-duel-X.Y.Z.vsix`? Install it — no build, no source checkout:

- **VS Code UI:** Extensions view → `⋯` menu → **Install from VSIX…** → pick the file.
- **CLI:** `code --install-extension ygo-duel-0.1.1.vsix`

Then run **Developer: Reload Window**, open a Field from the Command Palette, and
you're playing.

**Upgrading and you already have a collection?** Run **Cards: Backfill Rarity &
Prices for Existing Cards** once so your older cards pick up rarity/price (both
games, both tracks). New draws already include them. See "Real card rarity &
prices" below.

## Run it from source (no build needed)

1. Open this folder in VS Code: `code C:\Users\vakitsi\Desktop\ygo-duel`
2. Press **F5** (Run → Start Debugging). A second VS Code window
   ("Extension Development Host") launches with the extension loaded.
3. In that window, open the Command Palette (**Ctrl+Shift+P**) and run:
   - **Cards: Open Yu-Gi-Oh Field** — play with Yu-Gi-Oh cards
   - **Cards: Open Pokémon Field** — switch to Pokémon (TCG cards)
   - **Cards: Draw a Card!** — draw a random card in the active game (Sandbox)
  - **Cards: Open a Pack** — rip a free 5-card Sandbox booster (wrapper auto-rips, then tap each card)
  - **Cards: Open Binder** — open the collection grid for the active game/track
  - **Cards: Open Competitive Pack 🏆** — spend one earned credit on a
    5-card Competitive booster (disabled/no-ops at 0 credits). Same auto-rip, tap-each-card flow as Sandbox.
  - **Cards: Open Bulk Competitive Packs 🏆** — open up to 20 earned Competitive
    packs at once and show the cards in a results grid. Confirms first; leftover
    credits stay on the balance.
  - **Cards: Open Multiple Packs…** — pick Sandbox or Competitive and a count;
    2+ packs use the same results grid. Competitive is clamped to your credit balance (max 20 per burst).
   - **Cards: Set GitHub Server (Competitive Packs)** — switch between
     github.com and an on-site GitHub Enterprise Server, see below
   - **Cards: Set GitHub Token (Competitive Packs)** — one-time setup, see below
   - **Cards: Check for Competitive Activity** — manually sync PRs + direct
     commits now instead of waiting for the background poll
   - **Cards: Reset Collection (active game + track)** — wipe the shown
     collection for the active game; the other track/game is untouched

The two "Open … Field" commands pick the **active game**; everything else
(Draw, Open a Pack, Binder, Reset) operates on whichever game is active.
Each game keeps its own collection, so they never mix.

### Opening packs (single + bulk)

Two separate flows, both from the Field, the Binder, and the Command Palette:

1. **One pack.** Click **Pack** or **Competitive** — the wrapper rips itself,
   then tap each card to reveal the next. Credits still spend only when the
   wrapper actually tears, so closing the panel mid-fetch costs nothing. Set
   `ygoDuel.packReveal` to `tap` if you also want to tap to rip the wrapper.
2. **Bulk / open many.** With 2+ Competitive credits, **Open N**
   (N is `min(credits, 20)`) confirms, spends that many credits, fetches every card, and shows them in
   a scrollable grid (new cards highlighted, grouped by pack). Sandbox has
   no credit cap, so use **Cards: Open Multiple Packs…** and pick a count
   (max 20 per burst). A partial fetch still commits the packs that landed
   and leaves the rest of your credits.

### Real card rarity & prices

Every caught card also carries its **real-world rarity and market price**,
pulled from the same APIs and shown on the card's popup in the Binder. For
Yu-Gi-Oh, a card printed at several rarities is tracked as a *separate* binder
entry per rarity (a Common and a Secret Rare "Dark Magician" each get their own
slot); Pokémon cards are already per-printing at the source. The price also
shows on the draw caption as a card is revealed, and the Binder header totals
your whole collection's worth (price × copies owned, for the shown track).

Cards caught *before* this feature existed have no rarity/price yet. Run
**Cards: Backfill Rarity & Prices for Existing Cards** once to fetch it for your
whole collection (both games, both tracks). Safe to re-run: if the Pokémon API
rate-limits and some cards come back "skipped", just run it again — it only
retries what's left, until it reports "Nothing to backfill".

### Faster Pokémon draws

Pokémon card art always loads the smaller/faster image for the draw animation
and Binder grid; the Binder's zoomed popup still loads the full hi-res scan,
since detail is actually visible there. Cards caught before this change keep
whatever image they were caught with — nothing is backfilled retroactively.

## Architecture (high level)

| File | Role |
|------|------|
| `package.json` | Extension manifest — commands + `ygoDuel.drawOnSave` setting (static; VS Code reads this at load) |
| `extension.js` | **Host logic.** Holds the `GAMES` registry + active-game switching, manages the two webview panels, runs the prefetch buffer, persists per-game collections (Sandbox + Competitive tracks), and owns pack *sessions* (1-pack play vs N-pack bulk). Game-agnostic. |
| `packs.js` | **Pack-session domain.** Pack size, count clamping, collection fold (`applyDraw`), preview/sort of N packs. Pure — no vscode, no I/O. |
| `github.js` | **Competitive packs' data layer.** PAT storage (SecretStorage), polls GitHub for merged PRs you authored and direct default-branch commits (skipping PR-linked SHAs so merges aren't double-counted), awards 1–3 credits by lines changed, tracks the pack-credit balance (`spendCredit` / `spendCredits`). Never shows UI — `extension.js` owns all toasts. |
| `http.js` | Tiny shared HTTPS JSON fetch helper used by both game adapters; forces https so card fetches work behind a TLS-inspecting proxy. |
| `games/yugioh.js`, `games/pokemon.js` | **The game definitions** — the *only* places a game is hardcoded. Each exports a data adapter (`fetchOne`/`keep`/`normalize`/`power`) + a `theme` object (titles, words, stat rows, attr icons, image hosts, pack wordmark). |
| `media/duel.html` | The Field — draw/pack CSS+JS animation, sandboxed in a webview. Theme-driven. |
| `media/binder.html` | The Binder/Pokédex — collection grid view, sandboxed in a webview. Theme-driven. |
| `media/pack-<game>.*` | Optional real booster-pack image per game (e.g. `pack-yugioh.jpg`). If absent, the webview draws an SVG pack instead. |

**How the pieces talk:**

- **Host ↔ game:** `extension.js` keeps a `GAMES` registry and an `activeGame`;
  `setActiveGame(id)` swaps the module, resets the buffer, reloads open panels,
  and refreshes the binder. All card data goes through `game.*`; display strings
  come from `game.theme`. The host contains no game-specific field names.
- **Per-game state:** collection/stats keys (`collectionKey()`/`statsKey()`) and
  the buffer cache file are namespaced by game id, so the two games never mix.
  Yu-Gi-Oh keeps the original un-suffixed keys. The active game is remembered in
  globalState across reloads.
- **Host ↔ webview:** the host injects `{{THEME}}` (theme as JSON),
  `{{IMG_HOSTS}}`, `{{CSP_SOURCE}}`, and `{{PACK_IMG}}` into the HTML when a
  panel opens or the game switches (`renderHtml`), then communicates over
  `postMessage` (`draw` / `packSession` / `prefetch` → webview;
  `requestDraw` / `openPacks` / `openBinder` / `ready` → host).
  A pack session has phases `opening` → (`progress`) → `ready` (or `failed`).
  Mode `play` is one pack (wrapper auto-rips by default, then tap each card);
  mode `bulk` is 2+ packs (results grid, commit as soon as the fetch lands).
  Set `ygoDuel.packReveal` to `tap` if you also want to tap to rip the wrapper.
- **Data flow:** a background **buffer** of pre-fetched cards (persisted to
  globalStorage so reloads start warm) → `recordCollection` stores the whole
  normalized card in globalState → payload posted to the webview. The webview
  **pre-warms** upcoming image URLs so each reveal is instant.

The extension host (Node) does the network fetch; the webview (a locked-down
mini browser) only loads card art from hosts allowlisted in the theme
(`theme.imgHosts`), enforced by a strict Content-Security-Policy.

## Adding another game

The game-specific bits are centralized, so a new game is mostly one new file:

1. Copy an existing `games/*.js`; rewrite the data adapter for the new API and
   adjust the `theme` (words, `stats` rows, `attrIcons`, `imgHosts`, pack wordmark).
2. Register it in the `GAMES` map in `extension.js` and add an
   `ygoDuel.open<Name>` command (register it in `activate` **and** list it in
   `package.json`'s `contributes.commands` — the manifest is static).
3. Optionally drop a `media/pack-<id>.*` image (or let the SVG fallback stand in).

Storage keys auto-namespace by game id, so collections stay separate with no
extra work.

## Applying changes (important!)

VS Code runs the **installed copy** of this extension at
`~/.vscode/extensions/ygo-duel/`, which is a *separate* folder from this source
checkout. Editing the files here does **not** affect the running extension until
that installed copy is updated — so after any change you must sync it and then
run **Developer: Reload Window**.

**Option A — PowerShell sync (Windows, recommended).** From this repo root:

```powershell
.\sync-to-vscode.ps1                 # VS Code + Cursor (default)
.\sync-to-vscode.ps1 -Target vscode  # VS Code only
.\sync-to-vscode.ps1 -Target cursor  # Cursor only
# preview only:  .\sync-to-vscode.ps1 -WhatIf
```

Copies `extension.js`, `github.js`, `http.js`, `packs.js`, `package.json`, `games\*.js`,
`media\duel.html`, `media\binder.html`, `media\icon.svg`, and any
`media\pack-*` art into `%USERPROFILE%\.vscode\extensions\ygo-duel\` and/or
`%USERPROFILE%\.cursor\extensions\ygo-duel\`. First Cursor sync also registers
the extension in Cursor’s `extensions.json`. Then run **Developer: Reload
Window**.

**Option A2 — manual sync (bash).** Same file set, hand-copied:

```bash
SRC=~/Desktop/ygo-duel
DST=~/.vscode/extensions/ygo-duel
mkdir -p "$DST/games" "$DST/media"
cp "$SRC/extension.js"      "$DST/extension.js"
cp "$SRC/github.js"         "$DST/github.js"
cp "$SRC/http.js"           "$DST/http.js"
cp "$SRC/packs.js"          "$DST/packs.js"
cp "$SRC/games/"*.js        "$DST/games/"
cp "$SRC/package.json"      "$DST/package.json"
cp "$SRC/media/duel.html"   "$DST/media/duel.html"
cp "$SRC/media/binder.html" "$DST/media/binder.html"
cp "$SRC/media/icon.svg"    "$DST/media/icon.svg"
cp "$SRC/media/pack-"*      "$DST/media/" 2>/dev/null   # if you changed a pack image
# then: Command Palette → "Developer: Reload Window"
```

**Option B — symlink once (no copying afterwards).** Replace the installed
folder with a directory junction pointing at this source, so edits are picked up
directly and you only ever reload the window:

```bash
rm -rf ~/.vscode/extensions/ygo-duel
cmd //c mklink //J "%USERPROFILE%\.vscode\extensions\ygo-duel" "%USERPROFILE%\Desktop\ygo-duel"
```

(Developing via **F5** / the Extension Development Host also loads this source
directly and sidesteps the whole issue.)

## Performance: if the Binder ever feels slow (future work)

Not needed today — draws are already instant (a background prefetch buffer keeps
cards ready; the network is never on the draw path). This is a note for later, in
case the Binder gets sluggish once a collection grows to **thousands** of unique
cards.

**The weak spot.** Everything is O(collection size) per draw *while the Binder is
open*, even though only one card changed:

1. `recordCollection` re-serializes the **entire** collection to globalState every
   draw (`extension.js` → `globalState.update(collectionKey, col)`).
2. `sendCollection` posts `Object.values(col)` — the **whole** collection, full
   card objects — over `postMessage` every draw (`extension.js`).
3. Binder `render()` rebuilds **all** of `grid.innerHTML` (recreating every
   `<img>`) on every `collection` message *and* every search keystroke
   (`media/binder.html`).

At hundreds of cards this is a few ms (invisible). At thousands, steps 2–3 become
per-draw jank.

**Measure before touching it.** Wrap the Binder's `render()` in
`console.time('render')` / `console.timeEnd('render')` and draw a card. If it's
< ~10 ms, the slowness is the **network** (blocked/slow card art — see the Cisco
Umbrella note), not the code — leave the architecture alone.

**The fix, if genuinely needed (a targeted change, not a rewrite).**

- **Delta updates.** On a single draw, post `{ type: 'cardDelta', card, stats,
  credits }` instead of the whole collection. The Binder patches its local
  `allCards` and re-renders just that **one** cell + the stat chips. Keep the full
  `collection` message only for initial load and track/game switches. This removes
  the per-draw O(N) `postMessage` and the O(N) DOM rebuild. ~30–40 lines across
  `extension.js` + `media/binder.html`.
- Leave `globalState.update` as-is — VS Code batches those writes; not the
  bottleneck.
- Optional: debounce the search `render()` (currently O(N) per keystroke).

## Ideas to extend

- Binder is not currently shared between Cursor and VSCODE. 
  The binder uses context.GlobalState, and Cursor and VS Code maintain separate global state.
  The safest shared design is storing binder data in a common file such as: C:\Users\User\.ygo-duel\binder.json
- "Attack points" combo meter that climbs as you type
- Pokémon's `fetchBatch` usually only ends up sampling ONE random page (55
  cards) per refill, since that's almost always enough to hit `BUFFER_TARGET`
  — packs can feel same-set-y as a result. Fix: have `fetchBatch` pull a few
  smaller pages at independently-random page numbers instead of one big page.
