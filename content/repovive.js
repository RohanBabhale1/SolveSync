// Repovive (experimental). Repovive's pages are client-rendered and I could not inspect their markup
// while signed in, so this works from what is visible. When you click Submit, the code is snapshotted from the
// Monaco editor. The solution is then saved once the verdict shows Accepted, either inline on the problem page or
// as a new top row on the Submissions page that Repovive opens after a submit. A passing sample "Run" is ignored.
// Contest end times are learned from the contests list page (start time + duration), so submissions to a contest
// that has already ended are pushed right away. Anything it cannot read is reported with a "SolveSync debug" dump.
(() => {
  const clean = SS.clean;
  const where = () => {
    const c = location.pathname.match(
      /^\/contests?\/(\d+)\/(?:problems?\/)?([^/?#]+)/,
    );
    if (
      c &&
      !/^(results|leaderboard|standings|ranking|submissions|announcements)$/i.test(
        c[2],
      )
    )
      return { contest: c[1], label: decodeURIComponent(c[2]) };
    const p = location.pathname.match(/\/problems?\/([^/?#]+)/);
    return p ? { contest: "", label: decodeURIComponent(p[1]) } : null;
  };
  console.log("SolveSync: Repovive watcher active");

  const countAccepted = () =>
    (
      document.body.innerText.match(
        /\b(accepted|passed all|all (?:test ?)?cases? passed|all tests passed|correct answer|verdict:?\s*ac)\b/gi,
      ) || []
    ).length;

  // Profile name from a link. Handles absolute hrefs and /users/, /profile/, /u/ and /@name styles.
  const profileLinks = () => {
    const out = [];
    document.querySelectorAll("a[href]").forEach((a) => {
      let path = "";
      try {
        path = new URL(a.getAttribute("href"), location.href).pathname;
      } catch (_) {
        return;
      }
      const m =
        path.match(/^\/(?:users?|profile|profiles|u)\/([^/]+)/) ||
        path.match(/^\/@([^/]+)/);
      if (m) out.push({ a, name: decodeURIComponent(m[1]) });
    });
    return out;
  };
  const NAV =
    'header, nav, [class*="header" i], [class*="navbar" i], [class*="menu" i], [class*="dropdown" i], [class*="avatar" i], [class*="profile" i]';
  const account = async () => {
    const links = profileLinks();
    const inNav = links.find((x) => x.a.closest(NAV));
    if (inNav) return inNav.name;
    const ds = document.querySelector("[data-username]")?.dataset.username;
    if (ds) return ds;
    // Fall back to the username saved in the options when the page shows it (profile link, header/menu text, page data).
    const want = ((await SS.getSettings()).usernames.Repovive || "").trim();
    if (!want) return links[0]?.name || "";
    const w = want.toLowerCase();
    if (links.some((x) => x.name.toLowerCase() === w)) return want;
    const chrome_ = [...document.querySelectorAll(NAV)]
      .map((e) => e.textContent)
      .join("\n")
      .toLowerCase();
    if (chrome_.includes(w)) return want;
    const loggedOut = [...document.querySelectorAll("a, button")].some((e) =>
      /^\s*(log\s*in|sign\s*in|sign\s*up|register|get started)\s*$/i.test(
        e.textContent,
      ),
    );
    if (!loggedOut) {
      const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (
        new RegExp("(?:^|[^a-z0-9_.])" + esc + "(?:$|[^a-z0-9_.])").test(
          document.documentElement.innerHTML.toLowerCase(),
        )
      )
        return want;
    }
    return links[0]?.name || "";
  };

  // Learn contest end times from the contests list: cards show "Tue, Oct 13, 8:05 PM UTC+5:30" and a duration "2:30".
  const DATE_RE =
    /[A-Z][a-z]{2}, ([A-Z][a-z]{2}) (\d{1,2}), (\d{1,2}):(\d{2}) ([AP]M) UTC([+-])(\d{1,2})(?::?(\d{2}))?/;
  let learned = "";
  const learnContests = async () => {
    const ends = {};
    document.querySelectorAll('a[href*="/contests"]').forEach((a) => {
      const id = (a.getAttribute("href").match(/\/contests?\/(\d+)/) || [])[1];
      if (!id || ends[id]) return;
      for (let el = a, i = 0; el && i < 6; el = el.parentElement, i++) {
        const t = el.innerText || "";
        const m = t.match(DATE_RE);
        if (!m) continue;
        const d = t.replace(m[0], "").match(/(\d{1,2}):(\d{2})/);
        if (!d) break;
        const y0 = new Date().getFullYear();
        const off = `${m[6]}${m[7].padStart(2, "0")}${m[8] || "00"}`;
        const start = [y0, y0 - 1, y0 + 1]
          .map((y) =>
            Date.parse(
              `${m[1]} ${m[2]}, ${y} ${m[3]}:${m[4]} ${m[5]} GMT${off}`,
            ),
          )
          .filter((x) => !isNaN(x))
          .sort(
            (x, y) => Math.abs(x - Date.now()) - Math.abs(y - Date.now()),
          )[0];
        if (start) ends[id] = start + (+d[1] * 60 + +d[2]) * 60000;
        break;
      }
    });
    const s = JSON.stringify(ends);
    if (s === "{}" || s === learned) return;
    learned = s;
    try {
      const { repoviveEnds = {} } =
        await chrome.storage.local.get("repoviveEnds");
      await chrome.storage.local.set({
        repoviveEnds: { ...repoviveEnds, ...ends },
      });
      console.log("SolveSync: Repovive learned contest end times", ends);
    } catch (_) {}
  };

  // Hold a contest solution until the contest ends. A contest that already ended is pushed right away.
  async function holdFor(contest) {
    if (!contest) return 0;
    try {
      const { repoviveEnds = {} } =
        await chrome.storage.local.get("repoviveEnds");
      const e = repoviveEnds[contest];
      if (e) return e > Date.now() ? e : 0;
    } catch (_) {}
    let end = null;
    try {
      const html = await (
        await fetch(`/contests/${contest}`, { credentials: "include" })
      ).text();
      const m = html.match(
        /"(?:end(?:s)?_?(?:time|at|date)|endsAt|endTime)"\s*:\s*("?)([^",}]+)\1/i,
      );
      if (m)
        end = /^\d+$/.test(m[2])
          ? m[2].length < 12
            ? m[2] * 1000
            : +m[2]
          : SS.parseTime(m[2]);
    } catch (_) {}
    return SS.holdUntil(end, 3 * 36e5);
  }

  const debug = (why) => {
    const names = new Set();
    document.querySelectorAll("[class]").forEach((e) =>
      String(e.className)
        .split(/\s+/)
        .forEach(
          (c) =>
            /code|editor|monaco|ace|cm-|verdict|status|result|submission/i.test(
              c,
            ) && names.add(c),
        ),
    );
    console.log("SolveSync debug (Repovive)", {
      why,
      url: location.href,
      profileLinks: profileLinks().map((x) => [
        x.name,
        x.a.getAttribute("href"),
      ]),
      classNames: [...names].slice(0, 80),
      text: document.body.innerText.slice(0, 1500),
    });
    SS.toast(
      `SolveSync: Repovive — ${why} (see console, “SolveSync debug”).`,
      "err",
      9000,
    );
  };

  const titleNow = () => {
    const h1 = clean(document.querySelector("h1")?.textContent);
    const m = h1.match(/^(\w+)\.\s*(.+)$/);
    return m ? m[2] : h1;
  };

  // Monaco only renders visible lines, so very long solutions may be cut off.
  let lastCode = "",
    lastLang = "",
    armedAt = 0,
    snap = null;
  const grab = async () => {
    const v = document.querySelector(".monaco-editor .view-lines");
    const c = v
      ? [...v.querySelectorAll(".view-line")]
          .sort((x, y) => parseFloat(x.style.top) - parseFloat(y.style.top))
          .map((l) => l.textContent.replace(/\u00a0/g, " "))
          .join("\n")
          .trim()
      : "";
    if (c.length >= 10) {
      lastCode = c;
      return;
    }
    if (armedAt) return; // after a Submit click, never overwrite the snapshot with text from another page
    try {
      const ed = await SS.readEditor();
      const d = (ed?.code || SS.domCode() || "").trim();
      if (d.length >= 10) {
        lastCode = d;
        lastLang = ed?.lang || lastLang;
      }
    } catch (_) {}
  };

  // Newest row of a submissions table: "Oct 20, 2026 · 17:43:14 ... C++ 17 ... Accepted ... 12 ms 1.5 MB".
  const TIME_RE =
    /([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})\s*[·•]\s*(\d{1,2}:\d{2}:\d{2})/;
  const latestRow = () => {
    let best = null;
    document.querySelectorAll('tr, [role="row"]').forEach((r) => {
      const text = r.innerText || "";
      const m = text.match(TIME_RE);
      const t = m ? Date.parse(`${m[1]} ${m[2]}`) : NaN;
      if (t && (!best || t > best.t)) best = { r, t, text };
    });
    return best;
  };

  async function sync(row) {
    if (!(await SS.isEnabled("Repovive"))) return;
    const w = snap?.w;
    const code = lastCode;
    if (!w) return;
    if (code.length < 10) return debug("couldn’t read the code editor");
    const title = snap.title || w.label;
    const pid = w.contest ? `${w.contest}${w.label}` : w.label;
    const cells = row
      ? [...row.r.querySelectorAll('td, [role="cell"]')].map((c) =>
          clean(c.textContent),
        )
      : [];
    const rt = row?.text.match(/(\d+)\s*ms/i);
    const mem = row?.text.match(/([\d.]+)\s*(?:KB|MB|GB)/i);
    const lang = cells[3] && !/accepted/i.test(cells[3]) ? cells[3] : lastLang;
    await SS.submit({
      platform: "Repovive",
      accountUser: await account(),
      holdUntil: await holdFor(w.contest),
      problemId: pid,
      slug: SS.slugify(title),
      title,
      url: `https://repovive.com${snap.path}`,
      difficulty: snap.pts || "Unrated",
      group: w.contest ? `contest-${w.contest}` : "practice",
      tags: [],
      language: lang ? String(lang) : SS.guessLang(code),
      code,
      runtime: rt ? `${rt[1]} ms` : "",
      memory: mem ? mem[0].replace(/\s+/g, " ") : "",
      submissionId: `${pid}-${row?.t || Date.now()}`,
      submissionUrl: w.contest
        ? `https://repovive.com/contests/${w.contest}/results`
        : location.href,
      submittedAt: row?.t || Date.now(),
      descriptionMd: "",
    });
  }

  // State is kept per problem, so Repovive moving from the problem page to its Submissions page does not reset it.
  let key = "",
    base = null,
    ticks = 0;
  document.addEventListener(
    "click",
    (e) => {
      const b = e.target.closest && e.target.closest('button, [role="button"]');
      const w = where();
      if (!b || !w || !/\bsubmit/i.test(b.textContent)) return;
      grab(); // snapshot the code before the page navigates away
      armedAt = Date.now();
      base = countAccepted();
      snap = {
        w,
        title: titleNow(),
        pts: (document.body.innerText.match(/(\d+)\s*pts/i) || [])[1],
        path: location.pathname,
      };
      console.log(
        "SolveSync: Repovive submit click detected, waiting for Accepted",
      );
    },
    true,
  );

  const timer = setInterval(async () => {
    if (!chrome.runtime?.id) return clearInterval(timer); // extension was reloaded: this old copy stops itself
    const w = where();
    if (!w) {
      learnContests();
      return;
    }
    const k = `${w.contest}/${w.label}`;
    if (k !== key) {
      key = k;
      base = null;
      ticks = 0;
      armedAt = 0;
      snap = null;
      lastCode = "";
      lastLang = "";
    }
    if (!(await SS.isEnabled("Repovive"))) return;
    await grab();
    const live = armedAt && Date.now() - armedAt < 180000;
    if (!live) armedAt = 0;

    const row = latestRow();
    if (live && row) {
      // Submissions page: wait for a new Accepted row at the top
      if (row.t >= armedAt - 60000 && /accepted/i.test(row.text)) {
        armedAt = 0;
        console.log("SolveSync: Repovive Accepted row found, saving");
        try {
          await sync(row);
        } catch (e) {
          SS.toast(`SolveSync: ${e.message}`, "err", 8000);
        }
      }
      return;
    }

    const n = countAccepted();
    if (base === null) {
      if (++ticks >= 3) base = n;
      return;
    } // let the page settle before taking a baseline
    if (n > base) {
      base = n;
      if (!live) return; // a passing sample Run, not a Submit
      armedAt = 0;
      console.log("SolveSync: Repovive Accepted after submit, saving");
      try {
        await sync(null);
      } catch (e) {
        SS.toast(`SolveSync: ${e.message}`, "err", 8000);
      }
    } else if (n < base) base = n;
  }, 1500);
})();
