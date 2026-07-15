# �� YGO Duel Mode

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
- **Competitive ��** — packs earned only by merging your own PRs on GitHub (see
  "Competitive packs" below). Its own separate collection, so grinding it never1
  touches your Sandbox binder.

> Personal project — not published, not distributed. Yu-Gi-Oh art is property of
> Konami; Pokémon art is property of Nintendo / The Pokémon Company. This tool
> only *displays* cards fetched live from public fan APIs for personal use.

## Run it (no build needed)

1. Open this folder in VS Code: `code C:\Users\vakitsi\ygo-duel`
2. Press **F5** (Run → Start Debugging). A second VS Code window
   ("Extension Development Host") launches with the extension loaded.
3. In that window, open the Command Palette (**Ctrl+Shift+P**) and run:
   - **Cards: Open Yu-Gi-Oh Field** — play with Yu-Gi-Oh cards
   - **Cards: Open Pokémon Field** — switch to Pokémon (TCG cards)
   - **Cards: Draw a Card!** — draw a random card in the active game (Sandbox)
   - **Cards: Open a Pack** — rip a free 5-card Sandbox booster
   - **Cards: Toggle Draw-on-Save** — draw on every file save ��
   - **Cards: Open Competitive Pack ��** — spend one merge-earned credit on a
     5-card Competitive booster (disabled/no-ops at 0 credits)
   - **Cards: Set GitHub Server (Competitive Packs)** — switch between
     github.com and an on-site GitHub Enterprise Server, see below
   - **Cards: Set GitHub Token (Competitive Packs)** — one-time setup, see below
   - **Cards: Check for Merged PRs** — manually sync now instead of waiting for
     the background poll

The two "Open … Field" commands pick the **active game**; everything else
(Draw, Open a Pack, Binder, Reset) operates on whichever game is active.
Each game keeps its own collection, so they never mix.



### Competitive packs (optional)

Every merged PR you authored, on a repo this checks, earns one Competitive
pack. Sandbox is untouched and always free — this is a separate, opt-in track:

1. Defaults to plain github.com. If you're on an on-site GitHub Enterprise
   Server instead, run **Cards: Set GitHub Server (Competitive Packs)** first
   and enter its URL via "Custom URL…" — this updates `ygoDuel.github.apiBaseUrl`.
   No on-site URL is hardcoded anywhere in this extension.
2. Generate a personal access token with `repo` scope, at
   `https://github.com/settings/tokens` for github.com or your on-site
   server's `/settings/tokens` otherwise, then run **Cards: Set GitHub Token
   (Competitive Packs)** and paste it.
3. By default it counts every merged PR you authored on any repo the token
   can see (GitHub's search `author:` qualifier does this in one query — no
   repo list needed). Set `ygoDuel.trackedRepos` to a list of `"owner/repo"`
   strings only if you want to scope it down to specific repos.
4. It polls in the background (`ygoDuel.pollIntervalMinutes`, default 15, plus
   on window focus) and shows a �� credit count in the status bar — click it,
   or run **Cards: Check for Merged PRs**, to sync on demand.
5. The *first* check for each person is a baseline, not a payout: your
   existing merged PRs are marked seen but earn nothing, and you get a flat
   3-pack welcome bonus instead — so nobody's whole PR history dumps into
   their balance on day one. Only merges from that point on earn packs.
   (**Cards: Reset Competitive Progress** wipes credits, merge history, the
   baseline, AND every Competitive card collection, then re-baselines from
   scratch — a clean slate for the whole Competitive side. Sandbox is
   untouched.)

## Architecture (high level)

| File | Role |
|------|------|
| `package.json` | Extension manifest — commands + `ygoDuel.drawOnSave` setting (static; VS Code reads this at load) |
| `extension.js` | **Host logic.** Holds the `GAMES` registry + active-game switching, manages the two webview panels, runs the prefetch buffer, persists per-game collections (Sandbox + Competitive tracks). Game-agnostic. |
| `github.js` | **Competitive packs' data layer.** PAT storage (SecretStorage), polls the GitHub Search API for merged PRs you authored (globally by default, or scoped to `ygoDuel.trackedRepos`), tracks the pack-credit balance. Never shows UI — `extension.js` owns all toasts. |
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
  `postMessage` (`draw` / `packOpening` / `packCards` / `prefetch` → webview;
  `requestDraw` / `openPack` / `openBinder` / `ready` → host).
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

**Option A — manual sync (current setup).** Copy the changed files into the
installed copy, then reload the window:

```bash
SRC=~/Desktop/ygo-duel
DST=~/.vscode/extensions/ygo-duel
mkdir -p "$DST/games"
cp "$SRC/extension.js"      "$DST/extension.js"
cp "$SRC/github.js"         "$DST/github.js"
cp "$SRC/games/"*.js        "$DST/games/"
cp "$SRC/package.json"      "$DST/package.json"
cp "$SRC/media/duel.html"   "$DST/media/duel.html"
cp "$SRC/media/binder.html" "$DST/media/binder.html"
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

## Ideas to extend

- Pick the monster by file type (`.py` → a Spellcaster, `.js` → a Machine…)
- "Attack points" combo meter that climbs as you type
- Trap-card flip on a failing test, Spell-card flash on a passing one
- Sound effects (bundle your own audio into `media/`)
