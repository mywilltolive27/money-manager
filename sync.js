// sync.js — Google Drive appDataFolder sync (Phase 2, see ARCHITECTURE.md 5.2/5.3)
// Strategy: local cache is written first (instant, offline-safe); this module
// merges it with the single hidden file in Drive on every sync (not just on
// connect) — per record, by `updatedAt`, not by comparing one whole-file
// timestamp. Whole-file last-write-wins would silently drop an entire edit
// made on device A if device B pushed anything at all afterwards, even to a
// different transaction; per-record merge means only a genuine edit to the
// exact same record within the same debounce window can collide.
window.LedgerSync = (function () {
  const FILE_NAME = 'ledger.json';
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const PUSH_DEBOUNCE_MS = 1500;

  let fileId = null;
  let signedIn = false;
  let syncing = false;
  let pushTimer = null;
  let pendingWhileSyncing = false;

  const tagEl = () => document.getElementById('syncTag');
  const btnEl = () => document.getElementById('syncBtn');
  const setStatus = (t) => { const el = tagEl(); if (el) el.textContent = t; };
  const nowTime = () =>
    new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

  function updateBtn() {
    const b = btnEl();
    if (b) b.textContent = signedIn ? 'Sign out' : 'Sign in to sync';
  }

  async function authFetch(url, opts) {
    const token = await LedgerAuth.getToken();
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + token });
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error('Drive ' + res.status + ': ' + (await res.text()));
    return res;
  }

  async function findFile() {
    const q = encodeURIComponent("name='" + FILE_NAME + "' and trashed=false");
    const res = await authFetch(
      API + '/files?spaces=appDataFolder&fields=files(id)&q=' + q
    );
    const json = await res.json();
    fileId = json.files && json.files.length ? json.files[0].id : null;
    return fileId;
  }

  async function download() {
    if (!fileId) return null;
    const res = await authFetch(API + '/files/' + fileId + '?alt=media');
    return res.json();
  }

  async function upload(payload) {
    const body = JSON.stringify(payload);
    if (fileId) {
      await authFetch(UPLOAD + '/files/' + fileId + '?uploadType=media', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      return;
    }
    const boundary = 'ledger_' + Date.now();
    const metadata = { name: FILE_NAME, parents: ['appDataFolder'] };
    const multipart =
      '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) +
      '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' +
      body +
      '\r\n--' + boundary + '--';
    const res = await authFetch(UPLOAD + '/files?uploadType=multipart&fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
      body: multipart,
    });
    fileId = (await res.json()).id;
  }

  // Merge two arrays of records that each carry a stable `id` and an
  // `updatedAt`: for every id, keep whichever side's record is newer (ties
  // go to local). A record present on only one side is kept as-is — that's
  // what makes a genuinely new entry on either device survive the merge,
  // and (combined with delete-as-tombstone in index.html) what makes a
  // delete on one device stick instead of being resurrected by the other.
  function mergeById(localList, remoteList) {
    const byId = new Map();
    (remoteList || []).forEach((r) => byId.set(r.id, r));
    (localList || []).forEach((l) => {
      const r = byId.get(l.id);
      if (!r || (l.updatedAt || 0) >= (r.updatedAt || 0)) byId.set(l.id, l);
    });
    return Array.from(byId.values());
  }

  // Same idea for budgets, keyed by month instead of id.
  function mergeBudgets(localB, remoteB) {
    const out = Object.assign({}, remoteB);
    Object.keys(localB || {}).forEach((k) => {
      const l = localB[k], r = out[k];
      if (!r || (l.updatedAt || 0) >= (r.updatedAt || 0)) out[k] = l;
    });
    return out;
  }

  function mergeData(local, remote) {
    if (!remote) return local;
    return {
      categories: mergeById(local.categories, remote.categories),
      transactions: mergeById(local.transactions, remote.transactions),
      budgets: mergeBudgets(local.budgets, remote.budgets),
      updatedAt: Date.now(),
    };
  }

  // Pull whatever's on Drive, merge it into the local copy record-by-record,
  // apply the merged result locally, then push the merged result back so
  // both sides converge. Used both for the initial connect and for every
  // debounced push after a local change — so a stale local copy (e.g. this
  // device was offline while the other device made edits) gets reconciled
  // before it overwrites anything.
  async function syncNow() {
    if (!signedIn) return;
    if (syncing) { pendingWhileSyncing = true; return; }
    syncing = true;
    try {
      setStatus('syncing…');
      if (fileId === null) await findFile();
      let remote = fileId ? await download() : null;
      if (remote) LedgerCore.migrate(remote);
      const merged = mergeData(LedgerCore.data, remote);
      LedgerCore.replaceData(merged);
      await upload(merged);
      setStatus('synced ' + nowTime());
    } catch (e) {
      console.error('[sync] failed', e);
      setStatus('offline — will retry');
    } finally {
      syncing = false;
      if (pendingWhileSyncing) {
        pendingWhileSyncing = false;
        onLocalChange();
      }
    }
  }

  function onLocalChange() {
    if (!signedIn) return;
    setStatus('changes pending…');
    clearTimeout(pushTimer);
    pushTimer = setTimeout(syncNow, PUSH_DEBOUNCE_MS);
  }

  async function connect(interactive) {
    try {
      setStatus('connecting…');
      if (interactive) await LedgerAuth.signIn();
      else await LedgerAuth.getToken();
      signedIn = true;
      updateBtn();
      await syncNow();
      window.addEventListener('online', syncNow);
    } catch (e) {
      console.error('[sync] connect failed', e);
      signedIn = false;
      updateBtn();
      setStatus('local · not signed in');
    }
  }

  function wire() {
    const b = btnEl();
    if (!b) return;
    b.onclick = () => {
      if (signedIn) {
        LedgerAuth.signOut();
        signedIn = false;
        fileId = null;
        updateBtn();
        setStatus('local · this device only');
      } else {
        connect(true);
      }
    };
    if (LedgerAuth.wasSignedIn()) connect(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  return { onLocalChange };
})();
