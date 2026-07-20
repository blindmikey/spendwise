# Development

Everything a developer needs to be productive here: the money model the
whole app is built around, how the code is laid out, and how to run it.

- [The model](#the-model)
- [Storage](#storage)
- [Concurrent edits](#concurrent-edits)
- [Running it](#running-it)
- [Architecture](#architecture)
- [Environment variables](#environment-variables)

## The model

Each **month** is a self-contained document of user-configurable **groups**:

| kind       | sign | behavior |
|------------|------|----------|
| `income`   | +    | plain amounts |
| `expense`  | −    | plain amounts; can be **linked to an envelope** so they draw from its balance instead of counting twice |
| `envelope` | −    | mini savings account: monthly allotment (`value`), accumulated balance (`avail`). Spending is **derived** - the sum of expense rows assigned to the envelope, each row's draw rounded **up** to whole dollars (`linkedDraw`), so balances stay integral. Overspend counts against the month it happens, once. |
| `goal`     | −    | a **capped budget**: identical to an envelope (spending via linked expense rows) but the monthly amount only fills up to `target`. At the cap it contributes $0 and sits; spending opens headroom and contributions resume automatically. |

Envelope and goal fields can be **auto-funded** (the `％` button): the monthly
amount derives live from a percentage of selected groups' net - e.g. SE tax
savings = 33% × (Self-Employment Income − Self-Employment Expenses). The rule
carries forward on rollover and the derived value is materialized at save.
One deliberate exception: an expense **drawn from the auto-funded envelope
itself** is excluded from the rule's net - it's a distribution of money the
rule already set aside, so paying quarterly estimated taxes out of the
tax-savings envelope doesn't zero the very set-aside that pays them. Expenses
drawn from *other* envelopes still count in full.

- **Cents** are allowed in income and expense amounts (budget allotments stay
  whole dollars). A **group total never shows cents and always rounds against
  the month**: income **down**, spending **up** - so the books are never
  flattered. Sums accumulate in integer cents before rounding; summing floats
  and rounding after lets `10.00 + 20.00` reach `30.000000000000004` and ceil
  to 31.
- **Pin (📌)** an income or expense field to carry it into future months; **✓**
  marks paid/received. Budgets have no pin - they're standing accounts and
  always carry forward. Retiring one is a delete (Empty it first to return the
  balance). Rollover ignores `pinned` on envelope/goal fields, so legacy imports
  that arrive unpinned still survive.
- **Close Out** finalizes a month: envelope balances roll over
  (`avail = value + remain`), pinned fields copy forward, a savings snapshot is
  recorded, and the next month is created. Income/expense rows holding a value
  never marked ✓ prompt first: mark them all, **carry them into the new month**
  (zeroed in the closing month's history, re-created with their value - one
  atomic write, see `carryOverExtract`/`carryOverRestore`), or cancel.
- **Strict overspend** (per group, Settings): legacy behavior where overspending
  also reduces next month's balance by the shortfall. Off by default - the
  overspend already hit the ledger.
- **Past months** are view-only. Unlock to edit; saving recomputes every later
  month's derived values (starting savings, envelope chains, history) after
  taking a backup, and shows a change summary.
- **Empty** returns an envelope's remaining balance to Income as a labeled line
  item before removing it.
- **Tags** on any field feed the **Insights** view (spend by tag, trends,
  averages, savings trajectory). A budget's tags are enforced on the expenses
  that draw from it at chart time - merged with (never overriding) the expense's
  own tags; nothing is written back to the data.
- **Keyboard**: `Ctrl+S` saves (month or settings), `Ctrl+Z` / `Ctrl+Y` (or
  `Ctrl+Shift+Z`) undo/redo edits to the open month. Undo history is per month,
  groups rapid keystrokes, and resets on close-out/recompute. `Ctrl+K` opens
  search across every month (labels + tags); picking a hit jumps to the month
  and spotlights the row.

## Storage

One JSON file via lowdb, default `%APPDATA%/Spend Wise/db.json`.
Settings → "Move / share database…" relocates it.

Upgrading from the app's former name, "Finances"? On first launch it adopts that
folder's database, settings and backups automatically, leaving the originals
untouched as a safety net.

Automatic backups (last 20) are taken before close-out, recompute, restore and
import; Settings → Backups… restores.

**Per-device state lives in localStorage, never the db** - the same db.json is
shared between the desktop app, the web server and other machines, so device
preferences must not follow the data: `spendwise-theme` (Appearance),
`spendwise-last-screen` (view + month restored on reload),
`finances.collapsedGroups`. The screen also mirrors into the URL hash
(`#month/2026-05`), which is what makes browser back/forward walk the history.

**Remote mode** (desktop): Settings can point the app at a hosted
spendwise-server instead of the local file. The connection lives in the
Electron `userData` config (`remote: { host, tokenEnc }` - the session token is
OS-encrypted via `safeStorage` where available; the password is never stored),
and `ipc.js` routes the shared db methods to `remote-core.js` while refusing
the local-file-only operations.

## Concurrent edits

Saves carry a revision counter. When another session has saved first, an open
month is **merged field-by-field** (three-way, against the snapshot you loaded)
rather than rejected: both people's edits survive, tags union, and if you both
changed the same value yours wins and the toast says so.

History rewrites - editing a closed month, closing out, changing settings -
still require a fresh revision and stop rather than merge.

## Running it

```bash
npm install
npm run css          # build Tailwind (src/renderer/css/app.css)
npm start            # launch the desktop app
npm run serve        # launch the headless server
npm test             # engine, merge, api-core, web server, remote client (vitest)
npm run dist         # Windows installer + portable (dist/)
node dev-server.mjs  # renderer in a plain browser, no auth, localhost only
```

`npm run serve -- --password test` serves with a session-only login - held in
memory, never written to the db - so the real web login flow is testable
locally without touching a stored password. The dev server takes
`[db-path] [port]` positional args (or `PORT`).

`npm run css:watch` rebuilds Tailwind on change. `npm run dist` currently only
targets Windows (NSIS + portable); macOS and Linux run from source.

**Node 18 is the supported floor** (`engines` in package.json), verified by
running the suite and a full server round trip on 18.20.7 as well as 22. One
wrinkle worth knowing: Node 18 has no global `crypto` - it became a global in
19 - and `engine.js` is UMD, so it reads `uuid()` off the global and would
otherwise fall back to `Math.random`. `src/server/cli.mjs` installs
`node:crypto`'s `webcrypto` onto the global before anything loads. Electron and
Node 20+ already have it, so the shim is a no-op there.

> Careful when probing this: `node -e` / `--input-type=module` exposes a global
> `crypto` that a real `.mjs` file on Node 18 does **not** have. Test version
> assumptions in a file, or you'll get a false pass.

## Architecture

- **`src/shared/engine.js`** - pure calculation core (totals, rollover,
  recompute, three-way merge). All money math lives here; UMD so the renderer,
  main process, server and tests share one implementation.
- **`src/main/api-core.js`** - transport-agnostic handlers sitting behind
  Electron IPC, the web server and the dev server. `db-open.js` (open + lazy
  migrations) and `auth.js` (scrypt) are Electron-free too.
- **`src/main/webserver.js`** - login, sessions, rate limiting, static serving.
  Runs inside the desktop app (Web access) or standalone via
  `src/server/cli.mjs`.
- **`src/main/remote-core.js`** - the desktop app's remote-database client:
  the same surface as `api-core`, but every method is an HTTP call to a hosted
  server. Electron-free; `tests/remote-core.test.js` exercises it against a
  real `createWebServer` instance.
- **`src/main/update-check.js`** - the app's only outbound request: an
  unauthenticated GET of the GitHub releases API, compared against
  `package.json`'s version. Runs in the main/server process (one check per
  install, not per browser tab, and the renderer's CSP needn't allow an
  external origin), caches for 24h, times out at 5s, and treats every failure
  as a non-event. `settings.updateCheck === false` disables it. `fetchImpl` and
  `now` are injectable, so the tests never touch the network.
- **`src/main/`** - Electron main: storage config, IPC (`ipc.js`), backups,
  legacy importer.
- **`src/renderer/`** - Alpine 3 UI. Components are single-source
  `<template x-component>` custom elements; vendored libs in `vendor/` (fully
  offline).
- **`tests/e2e-flow.js`** - in-app end-to-end driver:
  `FINANCES_E2E=tests/e2e-flow.js FINANCES_DB_PATH=<scratch> npm start`.

## Environment variables

Development:

| Variable | Notes |
| --- | --- |
| `FINANCES_DEVTOOLS=1` | open devtools on launch |
| `FINANCES_LOG_CONSOLE=1` | pipe the renderer console to stdout |
| `FINANCES_DB_PATH` | override the database location |
| `FINANCES_E2E` | run an in-app end-to-end driver script |
| `FINANCES_E2E_SCREENSHOT` | capture screenshots during an e2e run |
| `FINANCES_PROFILE` | write a CPU profile of an e2e run |
| `FINANCES_USER_DATA` | point userData (config.json, default db) at a scratch folder so e2e runs never touch the real profile |

Server variables are documented in [hosting.md](hosting.md#configuration).
