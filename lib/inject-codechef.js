// Diagnostic only: logs CodeChef requests that look submission-related, so the right
// endpoint can be wired up. Look for "[SolveSync net]" lines in the console.
(() => {
  const RE = /submi|solution|verdict|status/i;
  const log = (kind, url, status, body) => {
    try { console.log('[SolveSync net]', kind, status, url, String(body).slice(0, 400)); } catch (_) {}
  };
  const realFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await realFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || String(args[0]);
      if (RE.test(url)) res.clone().text().then((t) => log('fetch', url, res.status, t));
    } catch (_) {}
    return res;
  };
  const realOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    const u = String(url);
    if (RE.test(u)) this.addEventListener('load', () => log('xhr', u, this.status, this.responseText));
    return realOpen.apply(this, arguments);
  };
})();
