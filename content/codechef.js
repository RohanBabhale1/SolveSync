// CodeChef (experimental): runs on /viewsolution/<id> pages and, for live submits, on problem pages. CodeChef's pages are rendered by
// JavaScript and I could not verify their markup, so this reads the page heuristically and
// prints a "SolveSync debug" report to the console when it cannot.
(() => {
  const m = location.pathname.match(/^\/viewsolution\/(\d+)/);
  const subId = m ? m[1] : null;
  const clean = SS.clean;

  const readCode = (doc = document) => {
    const tries = [
      () =>
        [...doc.querySelectorAll(".ace_line")]
          .map((l) => l.textContent)
          .join("\n"),
      () =>
        [...doc.querySelectorAll(".view-line")]
          .map((l) => l.textContent.replace(/\u00a0/g, " "))
          .join("\n"),
      () => doc.querySelector("pre code")?.textContent,
      () =>
        doc.querySelector("#solutiondiv pre, .solution pre, pre")?.textContent,
      () => doc.querySelector("textarea")?.value,
    ];
    for (const t of tries) {
      const c = t();
      if (c && c.trim().length > 10) return c;
    }
    return "";
  };

  // Profile name from an <a>. CodeChef's current UI uses absolute hrefs (https://www.codechef.com/users/<name>),
  // so resolve via a.pathname instead of matching the raw attribute against "/users/".
  const userOf = (a) => {
    let p = "";
    try {
      p = new URL(a.getAttribute("href") || "", location.href).pathname;
    } catch (_) {
      return "";
    }
    const n = (p.match(/^\/users\/([^/]+)/) || [])[1];
    return n ? decodeURIComponent(n) : "";
  };
  const userLinks = () =>
    [...document.querySelectorAll('a[href*="/users/"]')]
      .map((a) => ({ a, name: userOf(a) }))
      .filter((x) => x.name);

  // Logged-in user, read from the header / profile menu. Falls back to the username saved in the options
  // when it can be seen in the page chrome (header links, menu text) or the page's embedded state.
  const loggedInUser = async () => {
    const links = userLinks();
    const chrome_ = links.find((x) =>
      x.a.closest(
        'header, nav, [class*="header" i], [class*="navbar" i], [class*="menu" i], [class*="dropdown" i], [class*="avatar" i], [class*="profile" i]',
      ),
    );
    if (chrome_) return chrome_.name;
    const want = ((await SS.getSettings()).usernames.CodeChef || "").trim();
    if (!want) return "";
    const w = want.toLowerCase();
    if (links.some((x) => x.name.toLowerCase() === w)) return want;
    const chromeText = [
      ...document.querySelectorAll(
        'header, nav, [class*="header" i], [class*="navbar" i], [class*="menu" i], [class*="dropdown" i], [class*="avatar" i], [class*="profile" i]',
      ),
    ]
      .map((e) => e.textContent)
      .join("\n")
      .toLowerCase();
    if (chromeText.includes(w)) return want;
    const state = (
      document.getElementById("__NEXT_DATA__")?.textContent || ""
    ).toLowerCase();
    if (
      new RegExp(
        '"(?:user_?name|handle|user)"\\s*:\\s*"' +
          w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
          '"',
      ).test(state)
    )
      return want;
    // Last resort: you're signed in (no Login link) and your saved username appears somewhere in the page's data.
    const loggedOut = [
      ...document.querySelectorAll(
        'a[href*="/login"], a[href*="/signup"], button',
      ),
    ].some((e) =>
      /^\s*(log\s*in|sign\s*in|sign\s*up|register)\s*$/i.test(e.textContent),
    );
    if (!loggedOut) {
      const html = document.documentElement.innerHTML.toLowerCase();
      const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (
        new RegExp("(?:^|[^a-z0-9_.])" + esc + "(?:$|[^a-z0-9_.])").test(html)
      )
        return want;
    }
    return "";
  };

  // /viewsolution/<id>: the solution's author is the profile link in the page body, not the header's own link.
  const author = async () => {
    const body = userLinks().find((x) => !x.a.closest("header, nav"));
    return body ? body.name : await loggedInUser();
  };

  // CodeChef's editor reports Ace mode names ("c_cpp", "python", ...). Turn them into real language names.
  const ACE = {
    python: "Python",
    java: "Java",
    javascript: "JavaScript",
    typescript: "TypeScript",
    golang: "Go",
    rust: "Rust",
    kotlin: "Kotlin",
    ruby: "Ruby",
    php: "PHP",
    csharp: "C#",
    swift: "Swift",
    scala: "Scala",
    haskell: "Haskell",
    perl: "Perl",
    pascal: "Pascal",
    sh: "Bash",
  };
  const normLang = (raw, code) => {
    const r = String(raw || "").trim();
    if (!r) return SS.guessLang(code);
    if (/^c_?cpp$|^c\+\+|^cpp/i.test(r)) {
      const isC =
        /#include\s*<stdio\.h>/.test(code) &&
        !/iostream|bits\/stdc|using\s+namespace|std::|\bclass\b|template\s*</.test(
          code,
        );
      return isC ? "C" : "C++";
    }
    return ACE[r.toLowerCase()] || r;
  };

  // Problem statement as Markdown: CodeChef's API first, then whatever statement is on the page.
  const getDescription = async (contest, pcode) => {
    for (const c of [...new Set([contest, "PRACTICE"].filter(Boolean))]) {
      const j = await SS.getJson(`/api/contests/${c}/problems/${pcode}`);
      const body = j && (j.body || j.problem_body || j.problemStatement);
      if (body && String(body).trim().length > 30) {
        const b = String(body);
        let md = /<\/?(p|div|pre|ul|ol|li|br|strong|em|code|h\d)\b/i.test(b)
          ? SS.htmlToMd(b, "https://www.codechef.com")
          : b;
        const extra = [];
        if (j.constraints && !md.includes(String(j.constraints).slice(0, 20)))
          extra.push(`### Constraints\n\n${j.constraints}`);
        if (j.max_timelimit) extra.push(`**Time limit:** ${j.max_timelimit} s`);
        return [md.trim(), ...extra].join("\n\n");
      }
    }
    const el = document.querySelector(
      '#problem-statement, [class*="problem-statement" i], [class*="problemStatement" i], [class*="_problem__body" i], [class*="problem_body" i]',
    );
    return el
      ? SS.htmlToMd(el.innerHTML, "https://www.codechef.com").trim()
      : "";
  };

  const debug = () => {
    const names = new Set();
    document.querySelectorAll("[class]").forEach((e) =>
      String(e.className)
        .split(/\s+/)
        .forEach(
          (c) =>
            /code|editor|ace|monaco|verdict|status|result|lang|solution/i.test(
              c,
            ) && names.add(c),
        ),
    );
    console.log("SolveSync debug (CodeChef)", {
      url: location.href,
      header: (document.querySelector("header, nav")?.innerText || "").slice(
        0,
        300,
      ),
      hasLoginBtn: /log\s*in/i.test(document.body.innerText.slice(0, 400)),
      userLinks: userLinks().map((x) => [
        x.name,
        x.a.getAttribute("href"),
        x.a.parentElement?.className,
      ]),
      classNames: [...names].slice(0, 80),
      text: document.body.innerText.slice(0, 1500),
    });
  };

  async function run() {
    const text = document.body.innerText;
    const accepted =
      /\b(accepted|correct answer)\b/i.test(text) &&
      !/wrong answer/i.test(text.slice(0, 600));
    if (!accepted) return false;
    const code = readCode();
    const prob = document.querySelector('a[href*="/problems/"]');
    if (!code || !prob) {
      debug();
      SS.toast(
        "SolveSync: couldn’t read this CodeChef page — see console (“SolveSync debug”).",
        "err",
        9000,
      );
      return true;
    }
    const contest = (prob
      .getAttribute("href")
      .match(/^(?:https?:\/\/www\.codechef\.com)?\/([^/]+)\/problems\//) ||
      [])[1];
    let holdUntil = 0;
    if (contest) {
      const j = await SS.getJson(`/api/contests/${contest}`);
      const iso = (k) => (j && j[k] ? SS.parseTime(j[k]) : null);
      holdUntil = SS.holdUntil(
        iso("contest_end_date_iso") ?? iso("end_date_iso"),
        4 * 36e5,
        iso("contest_start_date_iso") ?? iso("start_date_iso"),
      );
    }
    const pcode = (prob.getAttribute("href").match(/problems\/([^/?#]+)/) ||
      [])[1];
    const title = clean(prob.textContent) || pcode;
    const lang = (text.match(/Language[:\s]+([^\n]+)/i) || [])[1] || "";
    const descriptionMd = await getDescription(contest, pcode);
    await SS.submit({
      platform: "CodeChef",
      holdUntil,
      accountUser: await author(),
      problemId: pcode,
      slug: SS.slugify(title),
      title,
      url: `https://www.codechef.com/problems/${pcode}`,
      difficulty: "Unrated",
      group: "Unrated",
      tags: [],
      language: normLang(clean(lang), code),
      code,
      runtime: "",
      memory: "",
      submissionId: subId,
      submissionUrl: location.href,
      submittedAt: Date.now(),
      descriptionMd,
    });
    return true;
  }

  /* ---- problem page: /problems/<CODE> or /<CONTEST>/problems/<CODE> ---- */
  // After you press Submit, CodeChef shows a result panel under the editor ("Total Score = 100%" or an
  // Accepted / Correct Answer verdict). When that count goes up, the code is read from the editor.
  function watchProblemPage() {
    const pm = () =>
      location.pathname.match(/^\/(?:([^/]+)\/)?problems\/([^/?#]+)/);
    const solved = () =>
      (
        document.body.innerText.match(
          /Total\s*Score\s*=\s*100\s*%|\bAccepted\b|\bCorrect Answer\b/gi,
        ) || []
      ).length;
    async function push() {
      const [, contest, pcode] = [0, ...pm().slice(1)];
      const ed = await SS.readEditor();
      const code = (ed?.code || SS.domCode()).trim();
      if (code.length < 10)
        return (
          debug(),
          SS.toast(
            "SolveSync: couldn’t read the code editor on this CodeChef page (see console “SolveSync debug”).",
            "err",
            9000,
          )
        );
      const title =
        clean(document.querySelector("h1")?.textContent) ||
        clean(document.title.replace(/\s*[|–-].*$/, "")) ||
        pcode;
      const diff =
        (document.body.innerText.match(/Difficulty:\s*(\d+)/i) || [])[1] ||
        "Unrated";
      let holdUntil = 0;
      if (contest) {
        const j = await SS.getJson(`/api/contests/${contest}`);
        const iso = (k) => (j && j[k] ? SS.parseTime(j[k]) : null);
        holdUntil = SS.holdUntil(
          iso("contest_end_date_iso") ?? iso("end_date_iso"),
          4 * 36e5,
          iso("contest_start_date_iso") ?? iso("start_date_iso"),
        );
      }
      const acct = await loggedInUser();
      if (!acct) debug();
      await SS.submit({
        platform: "CodeChef",
        accountUser: acct,
        holdUntil,
        problemId: pcode,
        slug: SS.slugify(title),
        title,
        url: `https://www.codechef.com/problems/${pcode}`,
        difficulty: diff,
        group: diff,
        tags: [],
        language: normLang(ed?.lang, code),
        code,
        runtime: "",
        memory: "",
        submissionId: `${pcode}-${Date.now()}`,
        submissionUrl: location.href,
        submittedAt: Date.now(),
        descriptionMd: await getDescription(contest, pcode),
      });
    }

    let url = location.href,
      base = null,
      ticks = 0;
    const timer = setInterval(async () => {
      if (!chrome.runtime?.id) return clearInterval(timer); // extension was reloaded; this stale script should stop
      try {
        if (location.href !== url) {
          url = location.href;
          base = null;
          ticks = 0;
        }
        if (!pm() || !(await SS.isEnabled("CodeChef"))) return;
        const n = solved();
        if (base === null) {
          if (++ticks >= 3) base = n;
          return;
        } // let the page settle first
        if (n > base) {
          base = n;
          try {
            await push();
          } catch (e) {
            SS.toast(`SolveSync: ${e.message}`, "err", 8000);
          }
        } else if (n < base) base = n;
      } catch (e) {
        if (/context invalidated/i.test(e.message)) clearInterval(timer);
      }
    }, 1500);
  }

  const signedIn = () =>
    (userLinks().find((x) => x.a.closest("header, nav")) || {}).name || "";

  /* ---- backfill (best effort: CodeChef has no documented API, so this reads the same endpoints its own pages use) ---- */
  const htmlDoc = (h) =>
    new DOMParser().parseFromString(String(h || ""), "text/html");
  // CodeChef rate-limits (429). Space requests out and, when refused, wait (honouring Retry-After) before retrying.
  let lastReq = 0;
  const GAP = 2500;
  const getText = async (url, tries = [0, 8000, 20000, 45000, 90000]) => {
    let st = 0;
    for (const w of tries) {
      let wait = w;
      if (wait) {
        SS.toast(
          `SolveSync backfill: CodeChef is rate-limiting, waiting ${Math.round(wait / 1000)}s…`,
          "info",
          wait + 1500,
        );
        await SS.sleep(wait);
      }
      const gap = lastReq + GAP - Date.now();
      if (gap > 0) await SS.sleep(gap);
      lastReq = Date.now();
      const r = await fetch(url, { credentials: "include" });
      st = r.status;
      if (r.ok) return r.text();
      if (![403, 429, 503].includes(st)) break;
      const ra = Number(r.headers.get("Retry-After"));
      if (ra > 0 && ra <= 180)
        tries = tries.map((t, i) =>
          t && t < ra * 1000 && i < tries.length ? Math.max(t, ra * 1000) : t,
        );
    }
    throw new Error(`CodeChef returned ${st} for ${url}`);
  };

  // Rows (viewsolution link + problem link + verdict) out of an HTML fragment or page.
  const parseRows = (html) => {
    const out = [];
    htmlDoc(html)
      .querySelectorAll('a[href*="/viewsolution/"]')
      .forEach((a) => {
        const id = (a.getAttribute("href").match(/viewsolution\/(\d+)/) ||
          [])[1];
        const row =
          a.closest("tr, li") ||
          a.parentElement?.parentElement ||
          a.parentElement;
        if (!id || !row) return;
        const pa = row.querySelector('a[href*="/problems/"]');
        const pcode = ((pa?.getAttribute("href") || "").match(
          /problems\/([^/?#]+)/,
        ) || [])[1];
        if (!pcode) return;
        const hints =
          row.textContent +
          " " +
          [...row.querySelectorAll("[title],[alt],img,span,i")]
            .map(
              (e) =>
                `${e.getAttribute("title") || ""} ${e.getAttribute("alt") || ""} ${e.getAttribute("src") || ""} ${e.className || ""}`,
            )
            .join(" ");
        const ok =
          /\b(accepted|correct answer)\b|tick|\b100\s*(%|pts?)?\b/i.test(
            hints,
          ) && !/wrong|time limit|runtime|compil|partial|\bfail/i.test(hints);
        const cells = [...row.querySelectorAll("td")].map((td) =>
          clean(td.textContent),
        );
        out.push({
          id,
          pcode,
          title: clean(pa.textContent) || pcode,
          ok,
          lang:
            cells.find((c) =>
              /^(c\+\+|c|python|pypy|java|kotlin|rust|go|javascript|node|c#|ruby|php|swift|scala|haskell|perl|pascal|bash|ocaml|d|nim|lua|r|dart)\b/i.test(
                c,
              ),
            ) || "",
        });
      });
    return out;
  };

  // Accepted submissions for the user, newest first, newest per problem.
  const listAccepted = async (user) => {
    const rows = [];
    const errs = [];
    // 1) the paged "recent activity" feed used by profile pages
    try {
      for (let page = 0, max = 1; page < max && page < 200; page++) {
        const j = JSON.parse(
          await getText(
            `/recent/user?page=${page}&user_handle=${encodeURIComponent(user)}&_=${Date.now()}`,
          ),
        );
        max = Number(j.max_page) + 1 || 1;
        rows.push(...parseRows(j.content));
      }
    } catch (e) {
      errs.push(e.message);
    }
    // 2) the submissions page, filtered to accepted
    if (!rows.some((r) => r.ok)) {
      try {
        rows.push(
          ...parseRows(
            await getText(
              `/submissions?handle=${encodeURIComponent(user)}&result=AC`,
            ),
          ).map((r) => ({ ...r, ok: true })),
        );
      } catch (e) {
        errs.push(e.message);
      }
    }
    const byProblem = new Map();
    for (const r of rows)
      if (r.ok) {
        const g = byProblem.get(r.pcode);
        if (g) g.alts.push(r.id);
        else byProblem.set(r.pcode, { ...r, alts: [] });
      }
    const ok = [...byProblem.values()];
    if (!ok.length)
      throw new Error(
        `Found no accepted CodeChef submissions for “${user}”${errs.length ? ` (${errs.join("; ")})` : ""}. CodeChef may have changed its pages; see the Console for “SolveSync debug”.`,
      );
    return ok;
  };

  /* ---- skipped problems: queued here, then opened one by one so the normal "viewsolution" sync handles them ---- */
  const Q = "cc_walk";
  const getQ = async () =>
    (await chrome.storage.local.get(Q))[Q] || { ids: [], on: false };
  const setQ = (v) => chrome.storage.local.set({ [Q]: v });
  const queueSkipped = async (id) => {
    const q = await getQ();
    if (!q.ids.includes(id)) {
      q.ids.push(id);
      await setQ(q);
    }
  };

  // Code of one submission. CodeChef renders /viewsolution in JavaScript, so try, in order:
  // the plain-text view, data embedded in the page's HTML, and finally the rendered page in a hidden frame.
  let dbg = 0;
  const fetchCode = async (id) => {
    const why = [];
    try {
      const raw = await getText(`/viewplaintext/${id}`);
      if (/^\s*<(!doctype|html|pre|body)/i.test(raw)) {
        const pre = htmlDoc(raw).querySelector("pre")?.textContent;
        if (pre && pre.trim().length > 10) return pre.replace(/\r\n/g, "\n");
        why.push("plaintext returned a web page without code");
        if (dbg++ < 2)
          console.log(
            "SolveSync debug (CodeChef backfill) plaintext",
            id,
            raw.slice(0, 400),
          );
      } else if (raw.trim().length > 10) return raw.replace(/\r\n/g, "\n");
      else why.push("plaintext was empty");
    } catch (e) {
      why.push(e.message);
    }

    try {
      const html = await getText(`/viewsolution/${id}`, [0]);
      const js = (html.match(
        /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
      ) || [])[1];
      if (js) {
        let best = "";
        const walk = (v, k) => {
          if (typeof v === "string") {
            if (
              /^(code|source|source_code|solution|plain_?text|submission_code|answer)$/i.test(
                k || "",
              ) &&
              v.length > best.length &&
              v.trim().length > 10
            )
              best = v;
          } else if (v && typeof v === "object")
            for (const [kk, vv] of Object.entries(v)) walk(vv, kk);
        };
        walk(JSON.parse(js), "");
        if (best) return best.replace(/\r\n/g, "\n");
      }
      why.push("no code in page data");
    } catch (e) {
      why.push(e.message);
    }

    try {
      const code = await new Promise((resolve, reject) => {
        const f = document.createElement("iframe");
        f.style.cssText =
          "position:fixed;left:-9999px;top:0;width:1200px;height:900px;border:0;opacity:0";
        f.src = `/viewsolution/${id}`;
        document.documentElement.appendChild(f);
        const t0 = Date.now();
        const tick = setInterval(() => {
          try {
            if (!f.contentDocument)
              throw new Error("CodeChef does not allow its pages in a frame");
            const c = readCode(f.contentDocument);
            if (c) {
              clearInterval(tick);
              f.remove();
              return resolve(c);
            }
          } catch (e) {
            clearInterval(tick);
            f.remove();
            return reject(new Error(`frame blocked (${e.message})`));
          }
          if (Date.now() - t0 > 25000) {
            clearInterval(tick);
            f.remove();
            reject(new Error("timed out waiting for the page to render"));
          }
        }, 800);
      });
      return code.replace(/\r\n/g, "\n");
    } catch (e) {
      why.push(e.message);
    }
    const err = new Error(
      `Could not read the code of CodeChef submission ${id}: ${why.join("; ")}`,
    );
    err.hardFail = why.some((w) => /^CodeChef returned/.test(w)); // rate limit / server error, not just "no code there"
    throw err;
  };

  SS.onBackfill("CodeChef", {
    delay: 1500,
    list: async (user) => {
      await setQ({ ids: [], on: false });
      const me = signedIn();
      if (me && !SS.sameUser(me, user))
        throw new Error(
          `You are signed in to CodeChef as “${me}”, but SolveSync is set to “${user}”.`,
        );
      try {
        return await listAccepted(user);
      } catch (e) {
        debug();
        throw e;
      }
    },
    done: (x, st) => st.problems.has(`CodeChef:${x.pcode}`),
    build: async (x, user) => {
      let code = null,
        lastErr = null,
        usedId = x.id;
      for (const id of [x.id, ...(x.alts || []).slice(0, 3)]) {
        try {
          code = await fetchCode(id);
          usedId = id;
          break;
        } catch (e) {
          lastErr = e;
          if (e.hardFail) throw e;
        }
      }
      if (!code) {
        // CodeChef shows no code for these submissions (not a rate limit): skip the problem instead of failing the run
        console.warn(
          `SolveSync: skipped CodeChef ${x.pcode} – no readable code (queued to open page by page)`,
          lastErr?.message,
        );
        await queueSkipped(x.id);
        return null;
      }
      let info = null;
      try {
        info = JSON.parse(
          await getText(`/api/contests/PRACTICE/problems/${x.pcode}`, [0]),
        );
      } catch (_) {}
      const title = clean(info?.problem_name) || x.title;
      const diff =
        String(info?.difficulty_rating || info?.rating || "").match(
          /\d+/,
        )?.[0] || "Unrated";
      return {
        platform: "CodeChef",
        holdUntil: 0,
        accountUser: user,
        problemId: x.pcode,
        slug: SS.slugify(title),
        title,
        url: `https://www.codechef.com/problems/${x.pcode}`,
        difficulty: diff,
        group: diff,
        tags: [],
        language: normLang(x.lang, code),
        code,
        runtime: "",
        memory: "",
        submissionId: usedId,
        submissionUrl: `https://www.codechef.com/viewsolution/${usedId}`,
        submittedAt: Date.now(),
        descriptionMd: await getDescription("", x.pcode),
      };
    },
  });

  // After a backfill finishes with skipped problems, walk through their pages (one tab, one page at a time).
  function watchForWalk() {
    setInterval(async () => {
      try {
        const t = document.getElementById("solvesync-toast")?.textContent || "";
        if (!/SolveSync backfill: finished/i.test(t)) return;
        const q = await getQ();
        if (q.on || !q.ids.length) return;
        await setQ({ ...q, on: true, total: q.ids.length });
        SS.toast(
          `SolveSync: opening ${q.ids.length} skipped CodeChef submissions one by one. Keep this tab open.`,
          "info",
          6000,
        );
        setTimeout(() => {
          location.href = `/viewsolution/${q.ids[0]}`;
        }, 3000);
      } catch (_) {}
    }, 2000);
  }

  async function advance() {
    const q = await getQ();
    if (!q.on || !q.ids.includes(subId)) return; // only continue when this page is part of the walk
    q.ids = q.ids.filter((x) => x !== subId);
    if (q.ids.length) {
      await setQ(q);
      SS.toast(
        `SolveSync: ${q.ids.length} skipped submission${q.ids.length === 1 ? "" : "s"} left…`,
        "info",
        4000,
      );
      await SS.sleep(3000);
      location.href = `/viewsolution/${q.ids[0]}`;
    } else {
      await setQ({ ids: [], on: false });
      SS.toast(
        "SolveSync: finished the skipped CodeChef submissions.",
        "ok",
        15000,
      );
    }
  }

  if (!m) {
    watchForWalk();
    return watchProblemPage();
  }

  (async () => {
    if (!(await SS.isEnabled("CodeChef"))) return;
    let done = false;
    for (let i = 0; i < 20 && !done; i++) {
      // wait for the SPA to render
      await new Promise((r) => setTimeout(r, 1500));
      try {
        done = await run();
      } catch (e) {
        SS.toast(`SolveSync: ${e.message}`, "err", 8000);
        break;
      }
    }
    if (!done) {
      debug();
      SS.toast(
        "SolveSync: no “Accepted” verdict found on this CodeChef page — see console (“SolveSync debug”).",
        "err",
        9000,
      );
    }
    await advance();
  })();
})();
