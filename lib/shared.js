// Pure helpers shared by the service worker, content scripts and extension pages.
(function (g) {
  const SS = (g.SS = g.SS || {});

  // Client ID of the SolveSync GitHub App (device flow enabled, Contents: read & write). Public by design.
  SS.GITHUB_CLIENT_ID = 'Iv23liWzf7BZZt3TPQnO';
  SS.GITHUB_APP_SLUG = 'solvesyncs'; // the last part of github.com/apps/<slug>
  SS.PLATFORMS = ['LeetCode', 'Codeforces', 'AtCoder', 'CSES', 'CodeChef', 'Repovive'];

  SS.DEFAULTS = {
    token: '',
    githubUser: '',
    usernames: { LeetCode: '', Codeforces: '', AtCoder: '', CSES: '', CodeChef: '', Repovive: '' },
    repo: '',
    branch: 'main',
    folderTemplate: '{platform}/{group}/{id}-{slug}',
    updateRootReadme: true,
    holdContests: true,
    enabled: { LeetCode: true, Codeforces: true, AtCoder: true, CSES: true, CodeChef: true, Repovive: true },
  };

  SS.getSettings = async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    return {
      ...SS.DEFAULTS,
      ...settings,
      branch: settings.branch || SS.DEFAULTS.branch,
      folderTemplate: !settings.folderTemplate || settings.folderTemplate === '{platform}/{id}-{slug}' ? SS.DEFAULTS.folderTemplate : settings.folderTemplate,
      enabled: { ...SS.DEFAULTS.enabled, ...(settings.enabled || {}) },
      usernames: { ...SS.DEFAULTS.usernames, ...(settings.usernames || {}) },
    };
  };
  SS.isEnabled = async (platform) => (await SS.getSettings()).enabled[platform];
  SS.parseTime = (t) => {
    let d = Date.parse(t);
    if (isNaN(d)) d = Date.parse(String(t).replace(' ', 'T').replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
    return isNaN(d) ? null : d;
  };

  SS.sameUser = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

  // Returns null when the submitting account matches the saved username, else a reason string.
  SS.accountProblem = (s, platform, account) => {
    const want = (s.usernames[platform] || '').trim();
    if (!want) return `add your ${platform} username in the SolveSync options first.`;
    if (!account) return `couldn’t tell which ${platform} account made this submission, so it was not synced.`;
    if (!SS.sameUser(want, account)) return `skipped — submitted as “${account}”, but SolveSync only syncs “${want}” on ${platform}.`;
    return null;
  };
  SS.isConfigured = (s) => !!s.token && /^[\w.-]+\/[\w.-]+$/.test(s.repo);

  // Language name -> file extension. Order matters (javascript before java, c++ before c).
  const EXT_RULES = [
    [/javascript|node\.?js|\bjs\b/i, 'js'],
    [/typescript/i, 'ts'],
    [/c\+\+|\bcpp\b|c_cpp/i, 'cpp'],
    [/c#|csharp|\.net|mono/i, 'cs'],
    [/pypy|python/i, 'py'],
    [/kotlin/i, 'kt'],
    [/java/i, 'java'],
    [/rust/i, 'rs'],
    [/golang|\bgo\b/i, 'go'],
    [/ruby/i, 'rb'],
    [/swift/i, 'swift'],
    [/scala/i, 'scala'],
    [/php/i, 'php'],
    [/dart/i, 'dart'],
    [/racket/i, 'rkt'],
    [/erlang/i, 'erl'],
    [/elixir/i, 'ex'],
    [/haskell/i, 'hs'],
    [/perl/i, 'pl'],
    [/ocaml/i, 'ml'],
    [/pascal|delphi/i, 'pas'],
    [/sql/i, 'sql'],
    [/bash|shell/i, 'sh'],
    [/\bc\b|gcc|gnu c\d|^c\d+/i, 'c'],
  ];
  SS.extForLang = (name = '') => (EXT_RULES.find(([re]) => re.test(name)) || [, 'txt'])[1];

  SS.slugify = (s = '') =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'problem';

  SS.cleanSegment = (s) => s.replace(/[\\/:*?"<>|#%]/g, '-').replace(/\s+/g, ' ').trim();

  // "{platform}/{difficulty}/{id}-{slug}" -> "LeetCode/Easy/0001-two-sum"
  SS.renderTemplate = (tpl, vars) =>
    tpl
      .replace(/\{(\w+)\}/g, (_, k) => SS.cleanSegment(String(vars[k] ?? '')))
      .split('/')
      .map((p) => p.trim())
      .filter(Boolean)
      .join('/');

  SS.b64enc = (str) => {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  SS.b64dec = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

  SS.gh = async (s, path, opts = {}) => {
    const r = await fetch('https://api.github.com' + path, {
      ...opts,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${s.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const err = new Error(j.message || `GitHub error ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return r.status === 204 ? null : r.json();
  };
})(globalThis);
