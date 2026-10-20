(() => {
  const Q_SUB = `query submissionDetails($submissionId: Int!) {
    submissionDetails(submissionId: $submissionId) {
      runtimeDisplay memoryDisplay code timestamp lang { name verboseName }
    }
  }`;
  const Q_QUESTION = `query questionData($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      questionFrontendId title titleSlug content difficulty topicTags { name }
    }
  }`;

  async function gql(query, variables) {
    const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
    const r = await fetch('/graphql/', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrftoken': csrf },
      body: JSON.stringify({ query, variables }),
    });
    const j = await r.json();
    if (j.errors) throw new Error(j.errors[0].message);
    return j.data;
  }

  // The submit/check requests only come from the signed-in tab, so the signed-in user is the submitter.
  async function currentUser() {
    try { return (await gql('query { userStatus { username } }', {})).userStatus?.username || ''; }
    catch (_) { return ''; }
  }

  async function build(id, slug) {
    if (!slug) throw new Error('Could not detect the problem slug.');
    let d;
    for (let i = 0; i < 3 && !d?.code; i++) {
      if (i) await new Promise((r) => setTimeout(r, 800));
      d = (await gql(Q_SUB, { submissionId: Number(id) })).submissionDetails;
    }
    if (!d?.code) throw new Error('Could not read the submission code.');
    let q;
    try { q = (await gql(Q_QUESTION, { titleSlug: slug })).question; } catch (_) {}
    // Contest problems can be hidden while the contest runs; fall back to the slug.
    q = q || { questionFrontendId: slug, title: slug, titleSlug: slug, difficulty: 'Unrated', topicTags: [] };
    const contest = (location.pathname.match(/^\/contest\/([^/]+)\//) || [])[1];
    let holdUntil = 0;
    if (contest) {
      const c = (await SS.getJson(`/contest/api/info/${contest}/`))?.contest;
      holdUntil = SS.holdUntil(c?.start_time ? (c.start_time + c.duration) * 1000 : null, 3 * 36e5);
    }
    const fid = String(q.questionFrontendId);
    const ts = Number(d.timestamp);
    return {
      platform: 'LeetCode',
      holdUntil,
      accountUser: await currentUser(),
      problemId: /^\d+$/.test(fid) ? fid.padStart(4, '0') : fid,
      slug: q.titleSlug,
      title: q.title,
      url: `https://leetcode.com/problems/${q.titleSlug}/`,
      difficulty: q.difficulty,
      tags: (q.topicTags || []).map((t) => t.name),
      group: SS.slugify((q.topicTags || [])[0]?.name || 'misc'),
      language: d.lang.verboseName,
      langKey: d.lang.name,
      code: d.code,
      runtime: d.runtimeDisplay,
      memory: d.memoryDisplay,
      submissionId: String(id),
      submissionUrl: `https://leetcode.com/submissions/detail/${id}/`,
      submittedAt: ts ? (ts < 1e12 ? ts * 1000 : ts) : Date.now(),
      descriptionMd: q.content ? SS.htmlToMd(q.content, 'https://leetcode.com') : '',
    };
  }

  // Backfill through GraphQL (the same channel the live sync uses): list solved problems, then find
  // the newest Accepted submission of each.
  const Q_SOLVED = `query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
    problemsetQuestionList: questionList(categorySlug: $categorySlug, limit: $limit, skip: $skip, filters: $filters) {
      total: totalNum
      questions: data { titleSlug }
    }
  }`;
  const Q_SUBS = [
    `query q($offset: Int!, $limit: Int!, $questionSlug: String!) {
      questionSubmissionList(offset: $offset, limit: $limit, questionSlug: $questionSlug) { submissions { id statusDisplay } }
    }`,
    `query q($offset: Int!, $limit: Int!, $questionSlug: String!) {
      submissionList(offset: $offset, limit: $limit, questionSlug: $questionSlug) { submissions { id statusDisplay } }
    }`,
  ];

  async function acceptedId(slug) {
    let lastErr;
    for (const q of Q_SUBS) {
      try {
        const d = await gql(q, { offset: 0, limit: 40, questionSlug: slug });
        const subs = (d.questionSubmissionList || d.submissionList)?.submissions || [];
        return subs.find((x) => x.statusDisplay === 'Accepted')?.id;
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  SS.onBackfill('LeetCode', {
    list: async (user) => {
      const me = await currentUser();
      if (!SS.sameUser(me, user)) throw new Error(`You are signed in to LeetCode as “${me || 'nobody'}”, but SolveSync is set to “${user}”.`);
      const out = [];
      for (let skip = 0, total = 1; skip < total; skip += 100) {
        const d = (await gql(Q_SOLVED, { categorySlug: '', skip, limit: 100, filters: { status: 'AC' } })).problemsetQuestionList;
        total = d.total;
        out.push(...d.questions.map((x) => ({ slug: x.titleSlug })));
        await SS.sleep(400);
      }
      return out;
    },
    done: (x, st) => st.slugs.has(`LeetCode:${x.slug}`),
    build: async (x) => {
      const id = await acceptedId(x.slug);
      if (!id) throw new Error(`No accepted submission found for ${x.slug}.`);
      return build(id, x.slug);
    },
  });

  const started = new Set();
  const run = async (id, slug) => {
    if (!(await SS.isEnabled('LeetCode'))) return;
    try {
      await SS.submit(await build(id, slug));
    } catch (err) {
      SS.toast(`SolveSync: ${err.message}`, 'err', 8000);
    }
  };

  // Poll the verdict ourselves after a submit; sync only if it is Accepted.
  async function pollAndRun(id, slug) {
    if (started.has(id)) return;
    started.add(id);
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const r = await fetch(`/submissions/detail/${id}/check/`, { credentials: 'include' });
        const j = await r.json();
        if (j.state === 'SUCCESS') {
          if (j.status_msg === 'Accepted') await run(id, slug);
          return;
        }
      } catch (_) { /* keep polling */ }
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (e.data?.source === 'solvesync-lc') { started.add(e.data.id); run(e.data.id, e.data.slug); }
    if (e.data?.source === 'solvesync-lc-submit') pollAndRun(e.data.id, e.data.slug);
  });
})();
