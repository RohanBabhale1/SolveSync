// CSES result page: https://cses.fi/problemset/result/<id>/
(() => {
  const m = location.pathname.match(/^\/problemset\/result\/(\d+)/);
  if (!m) return;
  const subId = m[1];
  const clean = SS.clean;

  const fetchDoc = async (url) => {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error(`CSES returned ${r.status}`);
    return new DOMParser().parseFromString(await r.text(), 'text/html');
  };

  // The summary is a table of "Label: value" rows.
  const readCells = (doc) => {
    const cells = {};
    doc.querySelectorAll('tr').forEach((tr) => {
      if (tr.children.length >= 2) cells[clean(tr.children[0].textContent).replace(/:$/, '')] = tr.children[1];
    });
    return cells;
  };

  async function build(doc) {
    const cells = readCells(doc);
    const task = cells.Task?.querySelector('a') || doc.querySelector('a[href*="/problemset/task/"]');
    const code = SS.codeText(doc.querySelector('pre.linenums'));
    if (!task || !code) throw new Error('Could not read this CSES submission.');
    const taskId = (task.getAttribute('href').match(/task\/(\d+)/) || [])[1];
    const title = clean(task.textContent);

    let section = 'General';
    let descriptionMd = '';
    try {
      const list = await fetchDoc('/problemset/');
      const a = list.querySelector(`a[href^="/problemset/task/${taskId}"]`);
      const h = a?.closest('ul')?.previousElementSibling;
      if (h && /^H\d$/.test(h.tagName)) section = clean(h.textContent);
    } catch (_) {}
    try {
      const td = await fetchDoc(`/problemset/task/${taskId}`);
      const st = td.querySelector('.md') || td.querySelector('.content');
      if (st) descriptionMd = SS.htmlToMd(st.innerHTML, 'https://cses.fi');
    } catch (_) {}

    return {
      platform: 'CSES',
      accountUser: clean(cells.User?.textContent) || clean(doc.querySelector('.account, a[href^="/user/"]')?.textContent),
      problemId: taskId,
      slug: SS.slugify(title),
      title,
      url: `https://cses.fi/problemset/task/${taskId}`,
      difficulty: section,
      group: SS.slugify(section),
      tags: [],
      language: clean(cells.Language?.textContent) || 'C++',
      code,
      runtime: '',
      memory: '',
      submissionId: subId,
      submissionUrl: `https://cses.fi/problemset/result/${subId}/`,
      submittedAt: Date.now(),
      descriptionMd,
    };
  }

  const verdict = (doc) => clean(readCells(doc).Result?.textContent);
  const status = (doc) => clean(readCells(doc).Status?.textContent);

  (async () => {
    if (!(await SS.isEnabled('CSES'))) return;
    // The result is filled in after judging; poll until it is final.
    for (let i = 0; i < 60; i++) {
      try {
        const doc = i === 0 ? document : await fetchDoc(location.pathname);
        if (/^ACCEPTED/i.test(verdict(doc))) return SS.submit(await build(doc));
        if (/^READY/i.test(status(doc)) && verdict(doc)) return; // finished, not accepted
      } catch (err) {
        return SS.toast(`SolveSync: ${err.message}`, 'err', 8000);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  })();
})();
