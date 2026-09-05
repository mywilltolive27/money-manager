# Ledger — Money manager App
Architecture & build plan

## 1. Goal

Replace the multi-tab Excel expense tracker with a single lightweight app that:
- Runs on Android (installed, not a browser tab) and Windows desktop
- Requires no app store, no packaging/build toolchain, no native mobile dev
- Syncs the same data between phone and laptop using the user's own Google Drive
- Keeps the existing category list and pie-chart-by-category view

## 2. High-level architecture

```
 Phone (Android)                          Laptop (Windows)
 ┌───────────────────────┐                ┌───────────────────────┐
 │ Installed PWA          │                │ Installed PWA          │
 │  - same HTML/JS/CSS    │                │  - same HTML/JS/CSS    │
 │  - IndexedDB/localStore│                │  - IndexedDB/localStore│
 │    (offline cache)     │                │    (offline cache)     │
 └───────────┬────────────┘                └───────────┬────────────┘
             │  read/write                              │ read/write
             ▼                                           ▼
                    ┌─────────────────────────┐
                    │  Google Drive            │
                    │  expenses.json           │
                    │  (user's own account,    │
                    │   app-private folder)    │
                    └─────────────────────────┘
```

**Key idea:** there is only one codebase and no custom backend server. The
"backend" is a single JSON file living in the user's own Google Drive. Each
device caches data locally (works offline) and syncs that file up/down over
the Google Drive API when online.

### Why a PWA instead of native apps

| Option | Installable on Android w/o Play Store | Installable on Windows | Mobile dev expertise needed | Verdict |
|---|---|---|---|---|
| PWA (this plan) | Yes — "Add to Home screen" | Yes — Chrome/Edge "Install app" | No | ✅ chosen |
| Flutter / React Native | Needs APK build + sideload or Play Store | Needs separate build | Yes | ❌ overkill |
| Electron (desktop) + separate mobile app | N/A | Yes | Yes, for mobile half | ❌ two codebases |

A PWA is just a website with a manifest file, opened once and then
"installed" by the browser — no signing, no store review, no build step.

## 3. Data model

Stored as one JSON object (currently in `localStorage`, later mirrored to
Google Drive):

```jsonc
{
  "categories": [
    { "name": "Utilities", "color": "#6B8CAE", "type": "expense" },
    { "name": "Food", "color": "#C1704A", "type": "expense" },
    { "name": "Groceries", "color": "#7A9B76", "type": "expense" },
    { "name": "Personal", "color": "#A9739A", "type": "expense" },
    { "name": "Transportation", "color": "#B8873B", "type": "expense" },
    { "name": "Travel", "color": "#5B8C88", "type": "expense" },
    { "name": "Home", "color": "#9A6B6B", "type": "expense" },
    { "name": "EMI", "color": "#7A7AA9", "type": "expense" },
    { "name": "Entertainment", "color": "#8A9A5B", "type": "expense" },
    { "name": "Savings-Mandatory", "color": "#AA8866", "type": "expense" },
    { "name": "Savings-Optional", "color": "#5B8CA0", "type": "expense" },
    { "name": "Paycheck", "color": "#A05B7A", "type": "income" }
  ],
  "transactions": [
    {
      "id": "tx_1737200000_ab12c",
      "date": "2026-07-15",
      "amount": 4500,
      "description": "Electricity bill",
      "category": "Utilities",
      "type": "expense"
    }
  ],
  "budgets": {
    "2026-07": 60000
  }
}
```

Notes:
- `transactions[].id` is a locally generated string (timestamp + random
  suffix) — good enough for a single-user file; no server-assigned IDs
  needed.
- `budgets` is keyed by `YYYY-MM` so each month can have its own target.
- Categories carry their own color so the transaction list and the pie
  chart always match.

## 4. Current prototype (phase 1 — done)

File: `index.html` (single file, no build step, no dependencies beyond one
CDN script).

- Chart.js (via cdnjs) renders the doughnut/pie chart
- Google Fonts: Fraunces (headers), Inter (UI), IBM Plex Mono (all money
  figures, for a ledger feel)
- All state lives in `localStorage` under the key `ledgerAppData`
- Features implemented: month switcher, add/edit/delete transactions,
  category manager (add/rename/recolor/delete), monthly budget with
  progress bar, category pie chart, JSON export/import (manual backup —
  this is also the exact shape phase 2 will sync automatically)

This phase intentionally has **no login, no network calls, no backend** —
it was built to validate the UI/UX quickly.

## 5. Phase 2 — hosting + Google Drive sync

### 5.1 One-time setup (done once by the user, not per device)

1. **GitHub Pages** — create a public (or private) repo, add `index.html`
   and `manifest.json`, enable Pages in repo settings. Result: a permanent
   URL such as `https://<username>.github.io/ledger-app/`.
   - Needed because Google OAuth requires a fixed, registered URL — it
     will not work from an ephemeral preview link.
2. **Google Cloud Console** (free tier):
   - Create a project
   - Enable the **Google Drive API**
   - Configure the OAuth consent screen (External, Testing mode is fine
     for personal use — add your own Google account as a test user)
   - Create an **OAuth Client ID** (type: Web application)
   - Add the GitHub Pages URL as an Authorized JavaScript origin
   - Copy the generated **Client ID** into the app's config (a single
     constant near the top of the JS)
3. Visit the GitHub Pages URL on the phone (Chrome → "Add to Home
   screen") and on the laptop (Edge/Chrome → install icon in the address
   bar).

### 5.2 Runtime sync design

- Use **Google Identity Services** (`accounts.google.com/gsi/client`) for
  sign-in — no backend token exchange needed for this personal-use case;
  the app requests an access token client-side with the
  `drive.appdata` (or `drive.file`) scope.
- Store the JSON blob as a single file inside Drive's **appDataFolder** —
  a hidden folder scoped to this app, invisible in the user's normal Drive
  UI, no risk of the user accidentally deleting/moving it.
- Sync strategy (simple, appropriate for a single user on 2 devices):
  1. On load: fetch `expenses.json` from Drive, compare against local
     cache using a `lastModified` timestamp stored in both places.
  2. Whichever copy is newer wins (last-write-wins); load it into the UI
     and local cache.
  3. On every change (add/edit/delete transaction, category, or budget):
     save to local cache immediately (instant UI, offline-safe), then
     push to Drive in the background.
  4. If offline: queue the change, flag "not yet synced" in the UI, retry
     on reconnect.
- This avoids needing any custom server, database, or hosting cost beyond
  free-tier GitHub Pages + the user's existing Google account.

### 5.3 What changes in the code

- Add a small `auth.js` module: sign-in button, token handling, silent
  token refresh.
- Add a `sync.js` module: `pullFromDrive()`, `pushToDrive()`, conflict
  check by timestamp, "last synced at" indicator in the UI.
- No changes to the data model — Drive just stores the same JSON shape
  already used by `localStorage`/export-import today.

## 6. Phase 3 — nice-to-haves (optional, after phase 2 is stable)

- **Import from Excel**: one-time button using a small CSV/XLSX parser
  (e.g. SheetJS) to read the existing `04-26`…`07-26` tabs and convert
  rows into `transactions[]`.
- **Multiple budget lines**: separate "living expense" budget that
  excludes Savings-Mandatory/Optional, mirroring the Excel sheet's
  surplus calculation.
- **Recurring transactions**: e.g. EMI, mandatory savings, auto-added
  each month.
- **Multi-currency / multi-account**: only if actually needed.
- **True offline queue + retry-with-backoff** for Drive sync, if flaky
  connections become a problem in practice.

## 7. Build phase summary

| Phase | What | Status |
|---|---|---|
| 1 | Local-only prototype (this repo's `index.html`) | ✅ done |
| 2 | Host on GitHub Pages, add Google sign-in + Drive sync | 🚧 in progress |
| 3 | Excel import, refined budget logic, recurring transactions | Not started |

## 8. Files in this handoff

- `index.html` — the working phase-1 prototype
- `manifest.json` — PWA manifest (already linked from `index.html`);
  needs real icon files added before phase 2 install testing
- `ARCHITECTURE.md` — this document
