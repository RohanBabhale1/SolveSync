importScripts('lib/shared.js');
const SS = globalThis.SS;

// Serialise syncs so two quick submissions never race on the same branch.
let queue = Promise.resolve();
const enqueue = (fn) => { queue = queue.then(fn).catch(() => {}); };
const errText = (e) => e?.message || String(e);

// Activity log shown in the popup (newest first).
let logQ = Promise.resolve();
const addLog = (entry) => {
  logQ = logQ.then(async () => {
    const { log = [] } = await chrome.storage.local.get('log');
    log.unshift({ at: Date.now(), ...entry });
    await chrome.storage.local.set({ log: log.slice(0, 40) });
  }).catch(() => {});
};

async function tracked(p) {
  const who = { platform: p.platform, id: p.problemId, title: p.title };
  try {
    const r = await handle(p);
    if (r.skipped === 'held') addLog({ ...who, level: 'info', text: 'held until the contest ends' });
    else if (r.skipped === 'account') addLog({ ...who, level: 'warn', text: r.reason });
    else if (!r.skipped) addLog({ ...who, level: 'ok', text: 'pushed to GitHub' });
    return r;
  } catch (e) {
    addLog({ ...who, level: 'err', text: errText(e) });
    throw e;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  switch (msg?.type) {
    case 'SUBMISSION': {
      const job = queue.then(() => tracked(msg.payload));
      queue = job.catch(() => {});
      job.catch((e) => ({ ok: false, error: errText(e) })).then(send);
      return true;
    }
    case 'STATE':
      chrome.storage.local.get(['history', 'synced']).then(({ history = {} }) => send({
        problems: Object.keys(history),
        slugs: Object.values(history).filter((e) => e.slug).map((e) => `${e.platform}:${e.slug}`),
      }));
      return true;
    case 'REINDEX': {
      const job = queue.then(reindex);
      queue = job.catch(() => {});
      job.then(() => ({ ok: true }), (e) => ({ ok: false, error: errText(e) })).then(send);
      return true;
    }
    case 'LOG':
      addLog(msg.entry);
      return false;
    case 'FETCH_JSON': {
      if (!/^https:\/\/kenkoooo\.com\/atcoder\/atcoder-api\//.test(msg.url)) { send({ ok: false, error: 'URL not allowed' }); return false; }
      fetch(msg.url)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => send({ ok: true, data: d.filter((x) => x.result === 'AC').map((x) => ({ id: x.id, contest_id: x.contest_id, problem_id: x.problem_id, epoch_second: x.epoch_second })).sort((a, b) => b.epoch_second - a.epoch_second).filter((x, i, arr) => arr.findIndex((y) => y.problem_id === x.problem_id) === i) }),
          (e) => send({ ok: false, error: errText(e) }));
      return true;
    }
  }
});

/* ---------- Held contest solutions ---------- */

const ALARM = 'solvesync-release';
chrome.alarms.get(ALARM, (a) => { if (!a) chrome.alarms.create(ALARM, { periodInMinutes: 1 }); });
chrome.alarms.onAlarm.addListener((a) => a.name === ALARM && enqueue(release));
chrome.runtime.onStartup.addListener(() => enqueue(release));

async function release() {
  const { pending = {} } = await chrome.storage.local.get('pending');
  const due = Object.keys(pending).filter((k) => pending[k].until <= Date.now() && !pending[k].failed);
  for (const k of due) {
    try {
      await tracked({ ...pending[k].p, holdUntil: 0 });
      delete pending[k];
    } catch (e) {
      const t = pending[k];
      t.attempts += 1;
      t.error = e.message || String(e);
      if (t.attempts >= 30) t.failed = true;
    }
  }
  await chrome.storage.local.set({ pending });
}

async function reindex() {
  const s = await SS.getSettings();
  if (!s.updateRootReadme || !SS.isConfigured(s)) return;
  const { history = {} } = await chrome.storage.local.get('history');
  const existing = await readFile(s, 'README.md');
  await commitFiles(s, [{ path: 'README.md', content: mergeRoot(existing, rootIndex(history, s.repo.split('/')[0])) }], 'Update solved-problems index');
}

async function sha1(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function handle(p) {
  const s = await SS.getSettings();
  if (!s.enabled[p.platform]) return { ok: true, skipped: 'disabled' };
  if (!SS.isConfigured(s)) throw new Error('GitHub is not configured — open the SolveSync options page.');
  const why = SS.accountProblem(s, p.platform, p.accountUser);
  if (why) return { ok: true, skipped: 'account', reason: why };

  const store = await chrome.storage.local.get(['history', 'synced', 'recent']);
  const history = store.history || {};
  const synced = store.synced || {};
  const recent = store.recent || [];

  const subKey = `${p.platform}:${p.submissionId}`;
  if (synced[subKey]) return { ok: true, skipped: 'duplicate' };

  // Contest still running: keep the solution in the browser; release() pushes it after the end.
  if (p.holdUntil && p.holdUntil > Date.now()) {
    const { pending = {} } = await chrome.storage.local.get('pending');
    if (pending[subKey]) return { ok: true, skipped: 'duplicate' };
    pending[subKey] = { p, until: p.holdUntil, attempts: 0 };
    await chrome.storage.local.set({ pending });
    return { ok: true, skipped: 'held', until: p.holdUntil };
  }

  const key = `${p.platform}:${p.problemId}`;
  const fileName = `solution.${SS.extForLang(p.langKey || p.language)}`;
  const folder = SS.renderTemplate(s.folderTemplate, {
    platform: p.platform,
    difficulty: p.difficulty || 'Unrated',
    group: p.group || p.difficulty || 'General',
    id: p.problemId,
    slug: p.slug || SS.slugify(p.title),
  });
  const code = p.code.replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
  const hash = await sha1(code);

  const prev = history[key];
  const sameFolder = prev && prev.folder === folder;
  if (sameFolder && prev.files[fileName]?.hash === hash) {
    synced[subKey] = Date.now();
    await chrome.storage.local.set({ synced });
    return { ok: true, skipped: 'duplicate' };
  }

  const entry = {
    platform: p.platform,
    id: p.problemId,
    slug: p.slug,
    title: p.title,
    url: p.url,
    difficulty: p.difficulty || 'Unrated',
    group: p.group || p.difficulty || 'General',
    tags: p.tags || [],
    folder,
    files: {
      ...(sameFolder ? prev.files : {}),
      [fileName]: {
        lang: p.language,
        runtime: p.runtime,
        memory: p.memory,
        submittedAt: p.submittedAt || Date.now(),
        submissionUrl: p.submissionUrl,
        hash,
      },
    },
  };

  const files = [
    { path: `${folder}/${fileName}`, content: code },
    { path: `${folder}/README.md`, content: problemReadme(entry, p.descriptionMd) },
  ];
  const nextHistory = { ...history, [key]: entry };
  if (s.updateRootReadme && !p.skipRoot) {
    const existing = await readFile(s, 'README.md');
    files.push({ path: 'README.md', content: mergeRoot(existing, rootIndex(nextHistory, s.repo.split('/')[0])) });
  }

  await commitFiles(s, files, `${prev ? 'Update' : 'Add'} ${p.platform} ${p.problemId} ${p.title} (${p.language})`);

  synced[subKey] = Date.now();
  recent.unshift({
    platform: p.platform,
    id: p.problemId,
    title: p.title,
    language: p.language,
    at: Date.now(),
    url: `https://github.com/${s.repo}/tree/${s.branch}/${encodeURI(folder)}`,
  });
  await chrome.storage.local.set({ history: nextHistory, synced, recent: recent.slice(0, 25) });
  return { ok: true };
}

/* ---------- GitHub ---------- */

async function readFile(s, path) {
  try {
    const j = await SS.gh(s, `/repos/${s.repo}/contents/${encodeURI(path)}?ref=${encodeURI(s.branch)}`);
    return SS.b64dec(j.content);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// One commit for all files, via the Git Data API.
async function commitFiles(s, files, message) {
  const base = `/repos/${s.repo}`;
  let branch = s.branch;
  const getRef = async (b) => {
    try { return await SS.gh(s, `${base}/git/ref/heads/${encodeURI(b)}`); }
    catch (e) { if (e.status === 404 || e.status === 409) return null; throw e; }
  };

  let ref = await getRef(branch);
  if (!ref) {
    const info = await SS.gh(s, base);
    if (await getRef(info.default_branch)) throw new Error(`Branch “${branch}” doesn’t exist in ${s.repo}.`);
    // Empty repository: the contents API can create the first commit.
    const [first, ...rest] = files;
    await SS.gh(s, `${base}/contents/${encodeURI(first.path)}`, {
      method: 'PUT',
      body: JSON.stringify({ message, content: SS.b64enc(first.content) }),
    });
    if (!rest.length) return;
    files = rest;
    branch = info.default_branch;
    ref = await getRef(branch);
  }

  const parent = await SS.gh(s, `${base}/git/commits/${ref.object.sha}`);
  const tree = await SS.gh(s, `${base}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: parent.tree.sha,
      tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
    }),
  });
  const commit = await SS.gh(s, `${base}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: tree.sha, parents: [ref.object.sha] }),
  });
  await SS.gh(s, `${base}/git/refs/heads/${encodeURI(branch)}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha }),
  });
}

/* ---------- Markdown ---------- */

const esc = (t) => String(t).replace(/\|/g, '\\|');
const FIELD = { Codeforces: 'Rating', CSES: 'Section', AtCoder: 'Contest type', Repovive: 'Points' };

function problemReadme(e, desc) {
  const rows = Object.entries(e.files).map(([f, m]) =>
    `| [${esc(m.lang)}](./${f}) | ${m.runtime || '—'} | ${m.memory || '—'} | ${new Date(m.submittedAt).toISOString().slice(0, 10)} | ${m.submissionUrl ? `[link](${m.submissionUrl})` : '—'} |`);
  return [
    `# ${e.id} · ${e.title}`,
    '',
    `**Platform:** ${e.platform} &nbsp;|&nbsp; **${FIELD[e.platform] || 'Difficulty'}:** ${e.difficulty} &nbsp;|&nbsp; [Problem link](${e.url})`,
    '',
    ...(e.tags.length ? [`**Topics:** ${e.tags.map((t) => `\`${t}\``).join(' ')}`, ''] : []),
    '## Accepted solutions',
    '',
    '| Language | Runtime | Memory | Date | Submission |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    ...(desc ? ['## Problem', '', desc, ''] : []),
  ].join('\n');
}

const ORDER = ['Codeforces', 'LeetCode', 'CSES', 'CodeChef', 'AtCoder', 'Repovive'];
const GROUP_LABEL = { Codeforces: 'Difficulty', LeetCode: 'Topic', CSES: 'Section', CodeChef: 'Difficulty', AtCoder: 'Contest type', Repovive: 'Contest' };
const BLURB = {
  Codeforces: (o) => `Solutions by ${o}, organized by difficulty rating.`,
  LeetCode: () => 'Solutions organized by primary topic folder.',
  CSES: () => 'Solutions from the CSES Problem Set, organized by section.',
  CodeChef: () => 'Solutions organized by difficulty rating.',
  AtCoder: () => 'Solutions organized by contest type.',
  Repovive: () => 'Solutions from Repovive contests and practice.',
};
const groupOf = (e) => e.group || (e.platform === 'LeetCode' ? SS.slugify((e.tags || [])[0] || 'misc') : e.difficulty || 'Unrated');
const cmpGroup = (a, b) => (a === 'Unrated' ? 1 : b === 'Unrated' ? -1 : a.localeCompare(b, undefined, { numeric: true }));

function rootIndex(history, owner) {
  const list = Object.values(history);
  const lines = [
    '# Competitive Programming Solutions',
    '',
    'Synced automatically by SolveSync.',
    '',
    `**Total solved:** ${list.length}`,
  ];
  const extra = [...new Set(list.map((e) => e.platform))].filter((p) => !ORDER.includes(p));
  for (const p of [...ORDER, ...extra]) {
    const mine = list.filter((e) => e.platform === p);
    const groups = {};
    mine.forEach((e) => { const g = groupOf(e); groups[g] = (groups[g] || 0) + 1; });
    const names = Object.keys(groups).sort(cmpGroup);
    lines.push(
      '', `## ${p}`, '',
      (BLURB[p] || (() => 'Solutions synced by SolveSync.'))(owner), '',
      `**Solved:** ${mine.length}`, '',
      `| ${GROUP_LABEL[p] || 'Group'} | Solved |`, '| --- | --- |',
      ...(names.length ? names.map((n) => `| ${esc(n)} | ${groups[n]} |`) : ['| — | 0 |']),
    );
  }
  lines.push('', `*Last updated: ${new Date().toISOString().slice(0, 10)}*`);
  return lines.join('\n');
}

const START = '<!-- solvesync:start -->';
const END = '<!-- solvesync:end -->';
function mergeRoot(existing, block) {
  const wrapped = `${START}\n${block}\n${END}`;
  if (existing == null) return wrapped + '\n';
  existing = existing.replace(/^# Coding solutions\s*/, ''); // header from earlier SolveSync versions
  const i = existing.indexOf(START);
  const j = existing.indexOf(END);
  if (i !== -1 && j > i) return existing.slice(0, i) + wrapped + existing.slice(j + END.length);
  return existing.replace(/\s*$/, '') + '\n\n' + wrapped + '\n';
}
