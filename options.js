const $ = (id) => document.getElementById(id);
const PLATFORMS = SS.PLATFORMS;
const LABEL = { AtCoder: 'AtCoder (English interface)', CodeChef: 'CodeChef (experimental)', Repovive: 'Repovive (experimental)' };
const LOGIN = 'https://github.com/login';

const say = (msg, cls = '') => { $('status').className = cls; $('status').textContent = msg; };

for (const p of PLATFORMS) {
  const row = document.createElement('div');
  row.className = 'row';
  row.style.alignItems = 'center';
  row.innerHTML = `<label class="check"><input id="p-${p}" type="checkbox"> ${LABEL[p] || p}</label>` +
    `<input id="u-${p}" type="text" autocomplete="off" spellcheck="false" placeholder="${p} username">`;
  $('plats').append(row);
}

const read = () => ({
  repo: $('repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, ''),
  branch: $('branch').value.trim() || 'main',
  folderTemplate: $('tpl').value.trim() || SS.DEFAULTS.folderTemplate,
  updateRootReadme: $('root').checked,
  holdContests: $('hold').checked,
  enabled: Object.fromEntries(PLATFORMS.map((p) => [p, $('p-' + p).checked])),
  usernames: Object.fromEntries(PLATFORMS.map((p) => [p, $('u-' + p).value.trim()])),
});

const showAuth = (s) => {
  $('who').textContent = s.token ? `Signed in as ${s.githubUser || 'GitHub user'}.` : 'Not signed in.';
  $('login').hidden = !!s.token;
  $('logout').hidden = !s.token;
  $('install').hidden = !s.token;
};

async function load() {
  const s = await SS.getSettings();
  $('repo').value = s.repo;
  $('branch').value = s.branch;
  $('tpl').value = s.folderTemplate;
  $('root').checked = s.updateRootReadme;
  $('hold').checked = s.holdContests;
  PLATFORMS.forEach((p) => { $('p-' + p).checked = s.enabled[p]; $('u-' + p).value = s.usernames[p]; });
  showAuth(s);
}

// Saves the form on top of the stored settings so the token is never lost.
async function save(quiet) {
  const s = { ...(await SS.getSettings()), ...read() };
  await chrome.storage.local.set({ settings: s });
  const missing = PLATFORMS.filter((p) => s.enabled[p] && !s.usernames[p]);
  if (!quiet) {
    if (missing.length) say(`Saved, but ${missing.join(', ')} won’t sync until you add a username.`, 'err');
    else say('Saved.', 'ok');
  }
  return s;
}

$('save').onclick = () => save();

/* ---------- Sign in with GitHub (OAuth device flow, no token to paste) ---------- */

let cancelled = false;
const ghPost = async (path, body) => {
  const r = await fetch(LOGIN + path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

$('login').onclick = async () => {
  cancelled = false;
  try {
    say('Contacting GitHub…');
    const d = await ghPost('/device/code', { client_id: SS.GITHUB_CLIENT_ID });
    if (d.error) throw new Error(d.error_description || d.error);
    $('code').textContent = d.user_code;
    $('verify').href = d.verification_uri;
    $('device').hidden = false;
    navigator.clipboard?.writeText(d.user_code).catch(() => {});
    chrome.tabs.create({ url: d.verification_uri });
    say('Waiting for you to approve on GitHub…');

    let wait = (d.interval || 5) * 1000;
    const until = Date.now() + d.expires_in * 1000;
    while (!cancelled && Date.now() < until) {
      await sleep(wait);
      const t = await ghPost('/oauth/access_token', {
        client_id: SS.GITHUB_CLIENT_ID,
        device_code: d.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      if (t.access_token) {
        const me = await SS.gh({ token: t.access_token }, '/user');
        const s = { ...(await SS.getSettings()), ...read(), token: t.access_token, githubUser: me.login };
        await chrome.storage.local.set({ settings: s });
        $('device').hidden = true;
        showAuth(s);
        const n = await loadRepos(s);
        if (!n) {
          chrome.tabs.create({ url: installUrl() });
          return say(`Signed in as ${me.login}. Now pick the repository SolveSync may access on the GitHub page that opened, then click Refresh repo list.`, 'ok');
        }
        return say(`Signed in as ${me.login}. Pick your repository and save.`, 'ok');
      }
      if (t.error === 'slow_down') wait += 5000;
      else if (t.error && t.error !== 'authorization_pending') throw new Error(t.error_description || t.error);
    }
    throw new Error(cancelled ? 'Sign-in cancelled.' : 'The code expired. Click Sign in again.');
  } catch (e) {
    $('device').hidden = true;
    say(e.message, 'err');
  }
};

$('cancel').onclick = () => { cancelled = true; };

$('logout').onclick = async () => {
  const s = { ...(await SS.getSettings()), token: '', githubUser: '' };
  await chrome.storage.local.set({ settings: s });
  showAuth(s);
  say('Signed out. (To fully revoke access, remove SolveSync under GitHub > Settings > Applications.)', 'ok');
};

/* ---------- Connection / repo ---------- */

$('test').onclick = async () => {
  const s = await save(true);
  try {
    if (!s.token) throw new Error('Sign in with GitHub first.');
    if (!SS.isConfigured(s)) throw new Error('Repository must look like owner/name.');
    const me = await SS.gh(s, '/user');
    const repo = await SS.gh(s, `/repos/${s.repo}`);
    if (repo.permissions && !repo.permissions.push) throw new Error(`Signed in as ${me.login}, but you can’t write to ${s.repo}.`);
    say(`Connected as ${me.login}. ${s.repo} is writable.`, 'ok');
  } catch (e) {
    say(e.status === 404 ? 'Repository not found, or SolveSync isn’t installed on it. Click “Choose repository access” and select it.' : e.status === 401 ? 'GitHub rejected the sign-in. Sign out and sign in again.' : e.message, 'err');
  }
};

/* ---------- Repositories the GitHub App is installed on ---------- */

const installUrl = () => `https://github.com/apps/${SS.GITHUB_APP_SLUG}/installations/new`;

// Lists "owner/name" for every repo the app can reach, fills the suggestions, auto-picks a lone repo.
async function loadRepos(s) {
  const names = [];
  try {
    const { installations = [] } = await SS.gh(s, '/user/installations?per_page=100');
    for (const i of installations) {
      const { repositories = [] } = await SS.gh(s, `/user/installations/${i.id}/repositories?per_page=100`);
      repositories.forEach((r) => names.push(r.full_name));
    }
  } catch (_) { return 0; }
  $('repos').replaceChildren(...names.map((n) => Object.assign(document.createElement('option'), { value: n })));
  if (names.length === 1 && !names.includes($('repo').value.trim())) $('repo').value = names[0];
  return names.length;
}

$('install').onclick = () => chrome.tabs.create({ url: installUrl() });

$('refresh').onclick = async () => {
  const s = await SS.getSettings();
  if (!s.token) return say('Sign in with GitHub first.', 'err');
  const n = await loadRepos(s);
  say(n ? `SolveSync can access ${n} repo${n > 1 ? 's' : ''}. Pick one and save.` : 'No repositories yet. Click “Choose repository access” and select your solutions repo.', n ? 'ok' : 'err');
};

// SolveSync remembers what it pushed. If a folder was deleted on GitHub, drop it from that memory so it can be pushed again.
$('forget').onclick = async () => {
  try {
    const s = await SS.getSettings();
    if (!s.token || !SS.isConfigured(s)) throw new Error('Sign in and set the repository first.');
    const { history = {}, synced = {} } = await chrome.storage.local.get(['history', 'synced']);
    const gone = [];
    for (const [key, e] of Object.entries(history)) {
      try { await SS.gh(s, `/repos/${s.repo}/contents/${encodeURI(e.folder)}?ref=${encodeURI(s.branch || 'main')}`); }
      catch (err) { if (err.status === 404) gone.push([key, e]); else throw err; }
    }
    if (gone.length > 2 && gone.length === Object.keys(history).length) throw new Error(`None of the ${gone.length} recorded problems were found in ${s.repo} on branch “${s.branch || 'main'}”. That usually means the repository or branch is wrong, so nothing was forgotten.`);
    for (const [key, e] of gone) {
      delete history[key];
      const urls = Object.values(e.files || {}).map((f) => f.submissionUrl || '');
      for (const k of Object.keys(synced)) {
        const [plat, ...rest] = k.split(':'), id = rest.join(':');
        if (plat === e.platform && (id.startsWith(`${e.id}-`) || id === String(e.id) || urls.some((u) => u.includes(id)))) delete synced[k];
      }
    }
    await chrome.storage.local.set({ history, synced });
    say(gone.length ? `Forgot ${gone.length} problem${gone.length > 1 ? 's' : ''} no longer in the repo: ${gone.map(([, e]) => `${e.platform} ${e.id}`).join(', ')}. Submit them again to re-sync.` : 'Every problem SolveSync knows about is still in the repo. Nothing to forget.', 'ok');
  } catch (e) { say(e.message, 'err'); }
};

load().then(async () => { const s = await SS.getSettings(); if (s.token) loadRepos(s); });
