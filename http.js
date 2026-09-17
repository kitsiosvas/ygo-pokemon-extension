/*
 * Tiny GET-JSON helper over Node's built-in https — deliberately NOT the global
 * fetch().
 *
 * Why not fetch(): inside VS Code's extension host the classic https module
 * picks up the OS / corporate certificate store (VS Code injects it), while
 * undici — which backs the global fetch() — does not. So behind a TLS-inspecting
 * corporate proxy, fetch() throws SELF_SIGNED_CERT_IN_CHAIN on any host the
 * proxy re-signs, while https keeps working. github.js already uses https for
 * exactly this reason; the card adapters route through here so draws work in
 * those environments too.
 *
 * Every request carries a socket-inactivity timeout (REQUEST_TIMEOUT_MS, per
 * redirect hop) so a hung connection rejects instead of stalling callers forever.
 */
const https = require('https');

const MAX_REDIRECTS = 3;
/** Socket-inactivity timeout per request (per redirect hop). Without one, a
 *  hung socket never settles: the caller awaits forever, and anything gated
 *  on that promise (the buffer's single refill loop, the pack lock) is stuck
 *  until reload. */
const REQUEST_TIMEOUT_MS = 15000;

/** GET a URL and parse JSON. Follows up to MAX_REDIRECTS 3xx redirects (fetch
 *  did this for us; https doesn't). Rejects on non-2xx, non-JSON, transport
 *  error, or `timeoutMs` of socket inactivity — the .cause on a TLS failure
 *  carries the real code (e.g. SELF_SIGNED_CERT_IN_CHAIN). */
function getJson(url, headers = {}, redirectsLeft = MAX_REDIRECTS, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (err) { reject(err); return; }
    const req = https.request(u, {
      headers: { 'User-Agent': 'ygo-duel-vscode-extension', Accept: 'application/json', ...headers }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // drain so the socket frees
        if (redirectsLeft <= 0) { reject(new Error('too many redirects')); return; }
        resolve(getJson(new URL(res.headers.location, u).toString(), headers, redirectsLeft - 1, timeoutMs));
        return;
      }
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error('HTTP ' + res.statusCode)); return; }
        try { resolve(JSON.parse(body)); }
        catch (err) { reject(new Error('non-JSON response: ' + err.message)); }
      });
    });
    req.on('error', reject);
    // destroy(err) surfaces as the 'error' event above, so the same reject path
    // handles it whether the socket hung before or during the response body
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout after ' + timeoutMs + 'ms')));
    req.end();
  });
}

module.exports = { getJson };
