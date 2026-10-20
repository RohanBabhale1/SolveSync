// DOM helpers used by content scripts only.
(function (g) {
  const SS = g.SS;

  // HTML -> Markdown (good enough for problem statements).
  SS.htmlToMd = (html, baseHref) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (baseHref) {
      const b = doc.createElement('base');
      b.href = baseHref;
      doc.head.appendChild(b);
    }
    const walk = (n) => {
      if (n.nodeType === 3) return n.textContent.replace(/\u00a0/g, ' ');
      if (n.nodeType !== 1) return '';
      if (n.classList.contains('section-title')) return `\n\n### ${n.textContent.trim()}\n\n`;
      const inner = () => [...n.childNodes].map(walk).join('');
      switch (n.tagName.toLowerCase()) {
        case 'p': case 'div': return `\n\n${inner().trim()}\n\n`;
        case 'br': return '\n';
        case 'strong': case 'b': return `**${inner()}**`;
        case 'em': case 'i': return `*${inner()}*`;
        case 'code': return n.closest('pre') ? n.textContent : `\`${inner()}\``;
        case 'pre': return `\n\n\`\`\`\n${n.textContent.trim()}\n\`\`\`\n\n`;
        case 'ul': case 'ol': return `\n${inner()}\n`;
        case 'li': return `- ${inner().trim()}\n`;
        case 'sup': return `^${inner()}`;
        case 'sub': return `_${inner()}`;
        case 'a': return `[${inner()}](${n.href})`;
        case 'img': return `![](${n.src})`;
        case 'script': case 'style': return '';
        default: return inner();
      }
    };
    return walk(doc.body).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  };

  SS.toast = (text, kind = 'info', ms = 4000) => {
    let el = document.getElementById('solvesync-toast');
    if (kind === 'hide') return el && el.remove();
    if (!el) {
      el = document.createElement('div');
      el.id = 'solvesync-toast';
      document.documentElement.appendChild(el);
    }
    const bg = { info: '#26323d', ok: '#177a5b', err: '#b3392c' }[kind];
    el.style.cssText =
      'position:fixed;right:20px;bottom:20px;z-index:2147483647;max-width:360px;padding:10px 14px;' +
      'border-radius:8px;color:#fff;font:13px/1.4 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);background:' + bg;
    el.textContent = text;
    if (kind === 'err') chrome.runtime.sendMessage({ type: 'LOG', entry: { level: 'err', text, site: location.hostname } }).catch(() => {});
    clearTimeout(el._t);
    el._t = setTimeout(() => el.remove(), ms);
  };

  // Send a normalised submission to the background worker and report the outcome.
  SS.submit = async (payload) => {
    const s = await SS.getSettings();
    if (!s.enabled[payload.platform]) return;
    if (!SS.isConfigured(s)) return SS.toast('SolveSync: connect GitHub in the extension options first.', 'err', 7000);
    const why = SS.accountProblem(s, payload.platform, payload.accountUser);
    if (why) return SS.toast(`SolveSync: ${why}`, 'info', 7000);
    if (!s.holdContests) payload.holdUntil = 0;
    SS.toast(`SolveSync: syncing “${payload.title}”…`, 'info', 60000);
    try {
      const res = await chrome.runtime.sendMessage({ type: 'SUBMISSION', payload });
      if (!res) throw new Error('No response from the extension.');
      if (res.skipped === 'account') return SS.toast(`SolveSync: ${res.reason}`, 'info', 7000);
      if (res.skipped === 'held') return SS.toast(`SolveSync: contest solution saved. It will be pushed to GitHub after the contest ends (${new Date(res.until).toLocaleString()}).`, 'ok', 9000);
      if (res.skipped === 'duplicate') return SS.toast('Already synced — nothing new to push.', 'info');
      if (!res.ok) throw new Error(res.error);
      SS.toast(`Synced “${payload.title}” to GitHub ✓`, 'ok');
    } catch (e) {
      SS.toast(`SolveSync: ${e.message}`, 'err', 8000);
    }
  };

  // Watches a status table. Rows that are already accepted when the page loads only get
  // a manual sync button; rows that turn accepted afterwards sync automatically.
  SS.watchAccepted = ({ rows, id, accepted, sync, mount }) => {
    const baseline = new Set();
    const done = new Set();
    let first = true;
    const scan = () => {
      const list = [...rows()];
      for (const r of list) {
        const i = id(r);
        if (!i) continue;
        const ok = accepted(r);
        if (first) {
          if (ok) { baseline.add(i); mount && mount(r, () => sync(r)); }
        } else if (ok && !baseline.has(i) && !done.has(i)) {
          done.add(i);
          sync(r);
        }
      }
      if (list.length) first = false;
    };
    scan();
    setInterval(scan, 2000);
  };

  SS.mountButton = (tr, onClick) => {
    if (tr.querySelector('.ss-btn')) return;
    const a = document.createElement('a');
    a.className = 'ss-btn';
    a.href = '#';
    a.textContent = '⇪ sync';
    a.title = 'Push this solution to GitHub with SolveSync';
    a.style.cssText = 'margin-left:8px;font-size:11px;white-space:nowrap';
    a.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
    (tr.lastElementChild || tr).appendChild(a);
  };

  // Text of a code block with line breaks intact. Syntax highlighters (prettify) rewrite the
  // block into one <li> per line, and plain textContent would glue those lines together.
  SS.codeText = (el) => {
    if (!el) return '';
    const items = el.querySelectorAll('li');
    let out;
    if (items.length) out = [...items].map((li) => li.textContent.replace(/\u00a0/g, ' ').replace(/\n$/, '')).join('\n');
    else {
      const c = el.cloneNode(true);
      c.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
      out = c.textContent.replace(/\u00a0/g, ' ');
    }
    out = out.replace(/\r\n?|\u2028|\u2029/g, '\n');
    // Lines held in separate elements (<div>/<span> per line) glue together under textContent. Recover them.
    if (!out.includes('\n') && out.length > 120) {
      if (el.isConnected && el.innerText && el.innerText.includes('\n')) out = el.innerText.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
      else {
        let box = el; // deepest element whose children look like one-per-line
        while (box.children.length === 1) box = box.children[0];
        if (box.children.length > 1) out = [...box.children].map((c) => c.textContent.replace(/\u00a0/g, ' ')).join('\n');
      }
    } // lone CR / unicode separators would otherwise show as one line on GitHub
    if (!out.includes('\n') && out.length > 200) {
      try { console.log('SolveSync debug: code block has no line breaks', { items: items.length, htmlHead: el.innerHTML.slice(0, 300), rawLen: el.textContent.length, hasCR: /\r/.test(el.textContent) }); } catch (_) {}
    }
    return out;
  };

  SS.getJson = async (url) => {
    try { const r = await fetch(url, { credentials: 'include' }); return r.ok ? await r.json() : null; }
    catch (_) { return null; }
  };

  // Timestamp to hold a contest submission until, or 0 to push now.
  //  endsAt  : contest end in ms, or null when it could not be determined (hold `fallbackMs` to be safe)
  //  startsAt: optional; a window over 30 days is an always-open practice contest, never held
  SS.holdUntil = (endsAt, fallbackMs, startsAt) => {
    const now = Date.now();
    if (endsAt == null) return now + fallbackMs;
    if (startsAt && endsAt - startsAt > 30 * 864e5) return 0;
    return endsAt > now ? endsAt : 0;
  };

  // Full text of the page's code editor, read through the MAIN-world bridge (lib/inject-editor.js).
  SS.readEditor = () => new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const done = (v) => { window.removeEventListener('message', on); resolve(v); };
    const on = (e) => { if (e.source === window && e.data?.source === 'solvesync-rv-res' && e.data.id === id) done(e.data); };
    window.addEventListener('message', on);
    window.postMessage({ source: 'solvesync-rv-req', id }, '*');
    setTimeout(() => done(null), 1500);
  });
  SS.domCode = () => {
    const c = document.querySelector('.cm-content');
    if (c) return [...c.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\n');
    const t = [...document.querySelectorAll('textarea')].sort((a, b) => b.value.length - a.value.length)[0];
    return t?.value || '';
  };
  SS.guessLang = (code) =>
    /#include\s*</.test(code) ? 'C++' : /^\s*(def |import \w+|from \w+ import|print\()/m.test(code) ? 'Python'
    : /public\s+(static\s+)?class|System\.out/.test(code) ? 'Java' : /fn main\(/.test(code) ? 'Rust'
    : /package main|func main\(/.test(code) ? 'Go' : 'Text';

  SS.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  SS.send = (payload) => chrome.runtime.sendMessage({ type: 'SUBMISSION', payload });

  // Backfill: { list(user) -> items, done(item, state) -> bool, build(item, user) -> payload|null }.
  // Triggered from the popup. Pushes every solved problem not yet in the repo, one commit each,
  // then rebuilds the root README index once.
  SS.onBackfill = (platform, impl) =>
    chrome.runtime.onMessage.addListener((m, _s, send) => {
      if (m?.type !== 'BACKFILL') return;
      send({ started: true });
      SS.backfill(platform, impl);
    });

  SS.backfill = async (platform, impl) => {
    const note = (t, k = 'info', ms = 60000) => SS.toast(`SolveSync backfill: ${t}`, k, ms);
    try {
      const s = await SS.getSettings();
      const user = (s.usernames[platform] || '').trim();
      if (!s.enabled[platform]) return note(`${platform} is switched off in Options.`, 'err', 8000);
      if (!SS.isConfigured(s)) return note('connect GitHub and pick a repository in Options first.', 'err', 8000);
      if (!user) return note(`add your ${platform} username in Options first.`, 'err', 8000);
      const st = await chrome.runtime.sendMessage({ type: 'STATE' });
      const state = { problems: new Set(st.problems), slugs: new Set(st.slugs) };
      note('reading your submission list…');
      const items = await impl.list(user);
      const todo = items.filter((i) => !impl.done(i, state));
      if (!todo.length) return note(`found ${items.length} solved problem${items.length === 1 ? '' : 's'} for “${user}”, and all are already in the repo.`, 'ok', 10000);
      note(`found ${items.length} solved, ${items.length - todo.length} already in the repo, pushing ${todo.length}…`);
      await SS.sleep(1500);
      let n = 0, fail = 0, last = '', streak = 0;
      for (const it of todo) {
        try {
          const p = await impl.build(it, user);
          if (p) {
            p.accountUser = user;
            p.skipRoot = true;
            const r = await SS.send(p);
            if (!r?.ok) throw new Error(r?.error || 'no response');
          }
          streak = 0;
        } catch (e) {
          fail++; streak++; last = e.message;
          chrome.runtime.sendMessage({ type: 'LOG', entry: { level: 'err', text: `backfill: ${e.message}`, site: platform } });
        }
        note(`${++n}/${todo.length}${fail ? ` (${fail} failed)` : ''}`);
        if (streak >= 3) { note(`stopped after ${streak} failures in a row (last: ${last}). Try again in a few minutes.`, 'err', 20000); return; }
        await SS.sleep(impl.delay || 800);
      }
      await chrome.runtime.sendMessage({ type: 'REINDEX' });
      note(`finished. ${n - fail} pushed${fail ? `, ${fail} failed (last: ${last})` : ''}.`, fail ? 'err' : 'ok', 20000);
    } catch (e) {
      note(e.message, 'err', 12000);
    }
  };

  SS.clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
})(globalThis);
