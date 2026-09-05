// sync.js — Google Drive appDataFolder sync (Phase 2, see ARCHITECTURE.md 5.2/5.3)
// Strategy: local cache is written first (instant, offline-safe); this module
// mirrors it to a single hidden file in Drive. Last-write-wins by `updatedAt`.
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

  // One-time reconcile on connect: newer copy wins.
  async function reconcile() {
    await findFile();
    const remote = await download();
    const local = LedgerCore.data;
    const rt = (remote && remote.updatedAt) || 0;
    const lt = local.updatedAt || 0;
    if (remote && rt > lt) {
      LedgerCore.replaceData(remote);
      return 'from Drive';
    }
    await upload(local);
    return 'to Drive';
  }

  async function push() {
    if (!signedIn) return;
    if (syncing) { pendingWhileSyncing = true; return; }
    syncing = true;
    try {
      setStatus('syncing…');
      if (fileId === null) await findFile();
      await upload(LedgerCore.data);
      setStatus('synced ' + nowTime());
    } catch (e) {
      console.error('[sync] push failed', e);
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
    pushTimer = setTimeout(push, PUSH_DEBOUNCE_MS);
  }

  async function connect(interactive) {
    try {
      setStatus('connecting…');
      if (interactive) await LedgerAuth.signIn();
      else await LedgerAuth.getToken();
      signedIn = true;
      updateBtn();
      const dir = await reconcile();
      setStatus('synced ' + dir + ' · ' + nowTime());
      window.addEventListener('online', push);
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
