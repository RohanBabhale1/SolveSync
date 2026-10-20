(() => {
  const path = location.pathname;
  const clean = SS.clean;
  // Codeforces answers 403/429 when pages are requested too quickly. Wait and retry before giving up.
  const parseDoc = async (url, waits = [0, 4000, 12000, 30000]) => {
    let status = 0;
    for (const wait of waits) {
      if (wait) await SS.sleep(wait);
      const r = await fetch(url, { credentials: 'include' });
      status = r.status;
      if (r.ok) return new DOMParser().parseFromString(await r.text(), 'text/html');
      if (status !== 403 && status !== 429 && status !== 503) break;
    }
    throw new Error(`Codeforces returned ${status} for ${url}`);
  };

  const csrf = () =>
    document.querySelector('meta[name="X-Csrf-Token"]')?.content ||
    document.querySelector('input[name="csrf_token"]')?.value || '';
  const unescapeHtml = (t) => (/&(lt|gt|amp|quot|#39);/.test(t) && !/[<>]/.test(t) ? new DOMParser().parseFromString(t, 'text/html').documentElement.textContent : t);

  // Source code of a submission. The submission page is the one Codeforces tends to refuse (403), so first use the
  // same AJAX endpoint the "view source" popup on the status page uses, then fall back to the page itself.
  const sourceOf = async (id, subPath) => {
    const errs = [];
    try {
      const token = csrf();
      const r = await fetch('/data/submitSource', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', 'X-Csrf-Token': token },
        body: `submissionId=${encodeURIComponent(id)}&csrf_token=${encodeURIComponent(token)}`,
      });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j && typeof j.source === 'string' && j.source.trim()) return unescapeHtml(j.source).replace(/\r\n/g, '\n');
        errs.push('submitSource returned no code');
      } else errs.push(`submitSource ${r.status}`);
    } catch (e) { errs.push(`submitSource ${e.message}`); }
    try {
      const code = (await parseDoc(subPath, [0, 5000])).querySelector('#program-source-text')?.textContent;
      if (code) return code;
      errs.push('page had no code (are you logged in?)');
    } catch (e) { errs.push(e.message); }
    throw new Error(`Could not read submission ${id}: ${errs.join('; ')}`);
  };

  let cfList;
  const cfEnd = async (cid) => {
    cfList = cfList || (await SS.getJson('/api/contest.list'))?.result;
    if (!cfList) return null;
    const c = cfList.find((x) => String(x.id) === String(cid));
    return c && c.startTimeSeconds ? (c.startTimeSeconds + c.durationSeconds) * 1000 : 0;
  };

  // info: { kind, cid, idx, id, title, subPath, language, runtime, memory, handle, at? }
  async function build(info) {
    const { kind, cid, idx, id, title, subPath } = info;
    const problemUrl = `https://codeforces.com/${kind}/${cid}/problem/${idx}`;
    const code = await sourceOf(id, subPath);

    let tags = info.tags || [], rating = info.rating ? String(info.rating) : '', descriptionMd = '';
    try {
      const pd = await parseDoc(problemUrl, [0]);
      const boxes = [...pd.querySelectorAll('.tag-box')].map((b) => clean(b.textContent));
      rating = rating || (boxes.find((t) => t.startsWith('*')) || '').replace('*', '');
      if (!tags.length) tags = boxes.filter((t) => !t.startsWith('*'));
      const st = pd.querySelector('.problem-statement');
      if (st) {
        const body = [...st.children].filter((c) => !c.classList.contains('header')).map((c) => c.outerHTML).join('');
        descriptionMd = SS.htmlToMd(body, 'https://codeforces.com');
      }
    } catch (_) { /* README still gets written without the statement */ }

    return {
      platform: 'Codeforces',
      accountUser: info.handle || '',
      holdUntil: kind === 'gym' ? 0 : SS.holdUntil(await cfEnd(cid), 3 * 36e5),
      problemId: `${cid}${idx}`,
      slug: SS.slugify(title),
      title,
      url: problemUrl,
      difficulty: rating || 'Unrated',
      group: rating || 'Unrated',
      tags,
      language: info.language,
      code,
      runtime: info.runtime || '',
      memory: info.memory || '',
      submissionId: id,
      submissionUrl: `https://codeforces.com${subPath}`,
      submittedAt: info.at || Date.now(),
      descriptionMd,
    };
  }

  /* ---- backfill from the public API ---- */
  SS.onBackfill('Codeforces', {
    delay: 2000,
    list: async (user) => {
      const r = await SS.getJson(`/api/user.status?handle=${encodeURIComponent(user)}`);
      if (!r || r.status !== 'OK') throw new Error(`Codeforces didn’t return submissions for “${user}”.`);
      const seen = new Set();
      return r.result.filter((x) => x.verdict === 'OK' && x.problem.contestId && !seen.has(x.problem.contestId + x.problem.index) && seen.add(x.problem.contestId + x.problem.index));
    },
    done: (x, st) => st.problems.has(`Codeforces:${x.problem.contestId}${x.problem.index}`),
    build: (x, user) => {
      const kind = x.problem.contestId >= 100000 ? 'gym' : 'contest';
      return build({
        kind, cid: x.problem.contestId, idx: x.problem.index, id: String(x.id), title: x.problem.name,
        subPath: `/${kind}/${x.problem.contestId}/submission/${x.id}`,
        tags: x.problem.tags, rating: x.problem.rating, language: x.programmingLanguage, runtime: `${x.timeConsumedMillis} ms`,
        memory: `${Math.round(x.memoryConsumedBytes / 1024)} KB`, handle: user, at: x.creationTimeSeconds * 1000,
      });
    },
  });

  /* ---- live syncing on "My submissions" pages ---- */
  const mine = /\/my\/?$/.test(path) || /^\/submissions\//.test(path) || /[?&]my=on/.test(location.search);
  if (!mine) return;
  const me = document.querySelector('#header a[href^="/profile/"]')?.textContent.trim();
  if (/^\/submissions\//.test(path) && me && path.split('/')[2].toLowerCase() !== me.toLowerCase()) return;

  async function sync(tr) {
    if (!(await SS.isEnabled('Codeforces'))) return;
    try {
      const id = tr.dataset.submissionId;
      const a = tr.querySelector('td[data-problemid] a') || tr.querySelector('a[href*="/problem/"]');
      const m = a.getAttribute('href').match(/\/(contest|gym)\/(\d+)\/problem\/(\w+)|\/problemset\/problem\/(\d+)\/(\w+)/);
      const kind = m[1] || 'contest';
      const cid = m[2] || m[4];
      const idx = m[3] || m[5];
      await SS.submit(await build({
        kind, cid, idx, id,
        title: clean(a.textContent).replace(/^\w+\s*-\s*/, ''),
        subPath: tr.querySelector('a.view-source')?.getAttribute('href') || `/${kind}/${cid}/submission/${id}`,
        language: clean(tr.children[4]?.textContent),
        runtime: clean(tr.querySelector('.time-consumed-cell')?.textContent),
        memory: clean(tr.querySelector('.memory-consumed-cell')?.textContent),
        handle: tr.querySelector('a[href^="/profile/"]')?.textContent.trim() || me || '',
      }));
    } catch (err) {
      SS.toast(`SolveSync: ${err.message}`, 'err', 8000);
    }
  }

  SS.watchAccepted({
    rows: () => document.querySelectorAll('table.status-frame-datatable tr[data-submission-id]'),
    id: (tr) => tr.dataset.submissionId,
    accepted: (tr) => !!tr.querySelector('.status-cell .verdict-accepted, .status-cell [submissionverdict="OK"]'),
    sync,
    mount: SS.mountButton,
  });
})();
