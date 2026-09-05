// auth.js — Google sign-in for Drive sync (Phase 2, see ARCHITECTURE.md 5.2/5.3)
// Uses Google Identity Services token flow: no backend, no client secret.
window.LedgerAuth = (function () {
  const CLIENT_ID = '836990755684-r9j0tjs3f8r4j3le728nutsn3ibqb8rj.apps.googleusercontent.com';
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const SIGNED_IN_KEY = 'ledgerSignedIn';

  let tokenClient = null;
  let accessToken = null;
  let expiry = 0;
  let pending = null;

  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });

  function init() {
    if (!(window.google && google.accounts && google.accounts.oauth2)) {
      return setTimeout(init, 100);
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: (resp) => {
        if (resp && resp.error) {
          if (pending) { pending.reject(resp); pending = null; }
          return;
        }
        accessToken = resp.access_token;
        expiry = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
        try { localStorage.setItem(SIGNED_IN_KEY, '1'); } catch (e) {}
        if (pending) { pending.resolve(accessToken); pending = null; }
      },
    });
    resolveReady();
  }

  function requestToken(interactive) {
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
      try {
        tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
      } catch (e) {
        pending = null;
        reject(e);
      }
    });
  }

  async function getToken() {
    await ready;
    if (accessToken && Date.now() < expiry) return accessToken;
    return requestToken(false);
  }

  async function signIn() {
    await ready;
    return requestToken(true);
  }

  function signOut() {
    if (accessToken && window.google && google.accounts && google.accounts.oauth2) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null;
    expiry = 0;
    try { localStorage.removeItem(SIGNED_IN_KEY); } catch (e) {}
  }

  function wasSignedIn() {
    try { return localStorage.getItem(SIGNED_IN_KEY) === '1'; } catch (e) { return false; }
  }

  init();
  return { ready, getToken, signIn, signOut, wasSignedIn };
})();
