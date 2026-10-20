(async () => {
  const $ = (id) => document.getElementById(id);
  const s = await SS.getSettings();
  const { history = {}, recent = [], pending = {} } = await chrome.storage.local.get(['history', 'recent', 'pending']);

  const held = Object.values(pending);
  $('heldBox').hidden = !held.length;
  for (const h of held) {
    const li = document.createElement('li');
    li.textContent = `${h.p.problemId} · ${h.p.title}`;
    const m = document.createElement('div');
    m.className = 'mut';
    m.textContent = h.failed ? `${h.p.platform} · failed: ${h.error}` : `${h.p.platform} · pushes after ${new Date(h.until).toLocaleString()}`;
    li.append(m);
    $('held').append(li);
  }

  const ok = SS.isConfigured(s);
  $('conn').textContent = ok ? `Pushing to ${s.repo} (${s.branch})` : 'Not connected — sign in with GitHub in Options.';
  $('repo').hidden = !ok;

  const counts = {};
  Object.values(history).forEach((e) => (counts[e.platform] = (counts[e.platform] || 0) + 1));
  for (const p of SS.PLATFORMS) {
    const d = document.createElement('div');
    d.className = 'stat';
    const b = document.createElement('b');
    b.textContent = counts[p] || 0;
    d.append(b, p);
    $('stats').append(d);
  }

  if (!recent.length) {
    const li = document.createElement('li');
    li.className = 'mut';
    li.textContent = 'Nothing synced yet. Submit a solution and get an Accepted verdict.';
    $('recent').append(li);
  }
  for (const r of recent.slice(0, 6)) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = r.url; a.target = '_blank'; a.textContent = `${r.id} · ${r.title}`;
    const m = document.createElement('div');
    m.className = 'mut';
    m.textContent = `${r.platform} · ${r.language} · ${new Date(r.at).toLocaleDateString()}`;
    li.append(a, m);
    $('recent').append(li);
  }

  const { log = [] } = await chrome.storage.local.get('log');
  if (!log.length) $('log').innerHTML = '<li class="mut">No activity yet.</li>';
  for (const e of log.slice(0, 15)) {
    const li = document.createElement('li');
    li.textContent = [e.platform || e.site, e.id, e.title].filter(Boolean).join(' · ') || 'Page';
    const m = document.createElement('div');
    m.className = e.level === 'err' ? 'err' : e.level === 'ok' ? 'ok' : 'mut';
    m.textContent = `${new Date(e.at).toLocaleString()} · ${e.text}`;
    li.append(m);
    $('log').append(li);
  }

  $('backfill').onclick = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'BACKFILL' });
      $('bfmsg').textContent = r?.started ? 'Started. Watch the progress toast on the page.' : 'This page can’t backfill.';
    } catch (_) {
      $('bfmsg').textContent = 'Open LeetCode, Codeforces or AtCoder in this tab (and reload it once), then try again.';
    }
  };

  $('opts').onclick = () => chrome.runtime.openOptionsPage();
  $('repo').onclick = () => chrome.tabs.create({ url: `https://github.com/${s.repo}` });
})();
