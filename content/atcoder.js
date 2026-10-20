// Note: parsing relies on AtCoder's English UI (Task / Status / Language labels).
(() => {
  const clean = SS.clean;
  const myName = (document.documentElement.innerHTML.match(/userScreenName\s*=\s*"([^"]+)"/) || [])[1];

  const fetchDoc = async (url) => {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error(`AtCoder returned ${r.status}`);
    return new DOMParser().parseFromString(await r.text(), 'text/html');
  };

  const readCells = (doc) => {
    const cells = {};
    doc.querySelectorAll('table tr').forEach((tr) => {
      const th = tr.querySelector('th'), td = tr.querySelector('td');
      if (th && td) cells[clean(th.textContent)] = td;
    });
    return cells;
  };
  const isAC = (cells) => /^AC\b|Accepted/.test(clean(cells.Status?.textContent));

  // Contest window from the contest page: { start, end } in ms, or null.
  async function atWindow(contest) {
    try {
      const html = await (await fetch(`/contests/${contest}`, { credentials: 'include' })).text();
      const pick = (n) => SS.parseTime((html.match(new RegExp(n + '\\s*=\\s*moment\\("([^"]+)"')) || [])[1]);
      let start = pick('startTime'), end = pick('endTime');
      if (end == null) {
        const t = [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('.contest-duration time')];
        start = SS.parseTime(t[0]?.textContent); end = SS.parseTime(t[1]?.textContent);
      }
      return end == null ? null : { start, end };
    } catch (_) { return null; }
  }

  async function build(doc, pageUrl) {
    const cells = readCells(doc);
    if (!isAC(cells)) return null;
    if (myName && cells.User && !clean(cells.User.textContent).includes(myName)) return null;
    const a = cells.Task?.querySelector('a');
    const code = SS.codeText(doc.querySelector('#submission-code'));
    if (!a || !code) throw new Error('Could not read this AtCoder submission.');
    const taskId = a.getAttribute('href').split('/').pop();
    const title = clean(a.textContent).replace(/^\w+\s*-\s*/, '');
    const contest = a.getAttribute('href').split('/')[2];

    let descriptionMd = '';
    try {
      const td = await fetchDoc(a.getAttribute('href'));
      const st = td.querySelector('#task-statement .lang-en') || td.querySelector('#task-statement');
      if (st) descriptionMd = SS.htmlToMd(st.innerHTML, 'https://atcoder.jp');
    } catch (_) {}

    const win = await atWindow(contest);
    const subId = pageUrl.match(/submissions\/(\d+)/)[1];
    return {
      platform: 'AtCoder',
      holdUntil: SS.holdUntil(win?.end ?? null, 3 * 36e5, win?.start),
      accountUser: clean(cells.User?.querySelector('a[href^="/users/"]')?.textContent || cells.User?.textContent) || myName || '',
      problemId: taskId,
      slug: SS.slugify(title),
      title,
      url: `https://atcoder.jp${a.getAttribute('href')}`,
      difficulty: contest.replace(/\d+$/, '').toUpperCase(),
      group: contest.replace(/\d+$/, '').toUpperCase(),
      tags: [],
      language: clean(cells.Language?.textContent),
      code,
      runtime: clean(cells['Exec Time']?.textContent),
      memory: clean(cells.Memory?.textContent),
      submissionId: subId,
      submissionUrl: `https://atcoder.jp/contests/${contest}/submissions/${subId}`,
      submittedAt: Date.now(),
      descriptionMd,
    };
  }

  SS.onBackfill('AtCoder', {
    // Two sources, merged: the AtCoder Problems API (complete but delayed by days) and AtCoder itself
    // (contests from your rating history, plus the contest of the page you are on).
    list: async (user) => {
      const byProblem = new Map();
      const add = (x) => { const o = byProblem.get(x.problem_id); if (!o || x.id > o.id) byProblem.set(x.problem_id, x); };

      const r = await chrome.runtime.sendMessage({ type: 'FETCH_JSON', url: `https://kenkoooo.com/atcoder/atcoder-api/v3/user/submissions?user=${encodeURIComponent(user)}&from_second=0` });
      if (r?.ok) r.data.forEach(add);

      const contests = new Set();
      const here = location.pathname.match(/^\/contests\/([^/]+)/);
      if (here) contests.add(here[1]);
      try {
        const h = await fetchDoc(`/users/${encodeURIComponent(user)}/history`);
        h.querySelectorAll('#history tbody tr td:nth-child(2) a[href^="/contests/"]').forEach((a) => contests.add(a.getAttribute('href').split('/')[2]));
      } catch (_) {}

      for (const c of contests) {
        for (let page = 1; page <= 5; page++) {
          let doc;
          try { doc = await fetchDoc(`/contests/${c}/submissions?f.Status=AC&f.User=${encodeURIComponent(user)}&page=${page}`); } catch (_) { break; }
          const rows = [...doc.querySelectorAll('table tbody tr')].map((tr) => ({
            id: Number((tr.querySelector('a[href*="/submissions/"]:not([href*="?"])')?.getAttribute('href').match(/submissions\/(\d+)$/) || [])[1]),
            problem_id: (tr.querySelector('a[href*="/tasks/"]')?.getAttribute('href') || '').split('/').pop(),
          })).filter((x) => x.id && x.problem_id);
          rows.forEach((x) => add({ ...x, contest_id: c, epoch_second: 0 }));
          if (rows.length < 20) break;
          await SS.sleep(400);
        }
        await SS.sleep(400);
      }

      if (!byProblem.size) throw new Error(`No accepted AtCoder submissions found for “${user}”. Check the username in Options (and that you’re logged in).`);
      return [...byProblem.values()];
    },
    done: (x, st) => st.problems.has(`AtCoder:${x.problem_id}`),
    build: async (x) => {
      const p = await build(await fetchDoc(`/contests/${x.contest_id}/submissions/${x.id}`), `https://atcoder.jp/contests/${x.contest_id}/submissions/${x.id}`);
      if (p && x.epoch_second) p.submittedAt = x.epoch_second * 1000;
      return p;
    },
  });

  const run = async (doc, url) => {
    if (!(await SS.isEnabled('AtCoder'))) return;
    try {
      const p = await build(doc, url);
      if (p) await SS.submit(p);
    } catch (err) {
      SS.toast(`SolveSync: ${err.message}`, 'err', 8000);
    }
  };

  // 1) A single submission page: sync once the verdict is Accepted (poll while it is still judging).
  if (/\/submissions\/\d+\/?$/.test(location.pathname)) {
    let tries = 0;
    const tick = () => {
      const st = clean(readCells(document).Status?.textContent);
      if (isAC(readCells(document))) return run(document, location.href);
      if ((/^WJ$|^\d+\/\d+/.test(st) || !st) && tries++ < 40) setTimeout(tick, 3000);
    };
    tick();
  }

  // 2) "My submissions" table: sync rows that turn AC while the page is open.
  if (/\/submissions\/me\/?$/.test(location.pathname)) {
    const detailLink = (tr) => [...tr.querySelectorAll('a')].find((a) => /\/submissions\/\d+$/.test(a.getAttribute('href') || ''));
    const sync = async (tr) => {
      const href = detailLink(tr)?.getAttribute('href');
      if (!href) return;
      try { await run(await fetchDoc(href), `https://atcoder.jp${href}`); }
      catch (e) { SS.toast(`SolveSync: ${e.message}`, 'err', 8000); }
    };
    SS.watchAccepted({
      rows: () => [...document.querySelectorAll('table tbody tr')].filter(detailLink),
      id: (tr) => (detailLink(tr).getAttribute('href').match(/(\d+)$/) || [])[1],
      accepted: (tr) => [...tr.querySelectorAll('.label')].some((l) => clean(l.textContent) === 'AC'),
      sync,
      mount: SS.mountButton,
    });
  }
})();
