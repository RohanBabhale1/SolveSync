// Runs in the page's own JS world. Two detection paths for an Accepted submission:
//  1) LeetCode's own polling request  /submissions/detail/<id>/check/
//  2) The submit request  /problems/<slug>/submit/  (we then poll the result ourselves)
(() => {
  const CHECK = /\/submissions\/detail\/(\d+)\/check\/?/;
  const SUBMIT = /\/problems\/([^/]+)\/submit\/?(\?|$)/;
  const slugNow = () => (location.pathname.match(/problems\/([^/]+)/) || [])[1];

  const onCheck = (url, text) => {
    try {
      const m = CHECK.exec(url);
      if (!m) return;
      const j = JSON.parse(text);
      if (j.state === 'SUCCESS' && j.status_msg === 'Accepted') {
        window.postMessage({ source: 'solvesync-lc', id: m[1], slug: slugNow() }, '*');
      }
    } catch (_) {}
  };

  const onSubmit = (url, text) => {
    try {
      const m = SUBMIT.exec(url);
      if (!m) return;
      const j = JSON.parse(text);
      if (j.submission_id) {
        window.postMessage({ source: 'solvesync-lc-submit', id: String(j.submission_id), slug: m[1] }, '*');
      }
    } catch (_) {}
  };

  const handle = (url, text) => { onCheck(url, text); onSubmit(url, text); };

  const realFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await realFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || String(args[0]);
      if (CHECK.test(url) || SUBMIT.test(url)) res.clone().text().then((t) => handle(url, t));
    } catch (_) {}
    return res;
  };

  const realOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    const u = String(url);
    if (CHECK.test(u) || SUBMIT.test(u)) this.addEventListener('load', () => handle(u, this.responseText));
    return realOpen.apply(this, arguments);
  };
})();
