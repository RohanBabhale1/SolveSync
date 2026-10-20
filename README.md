# SolveSync

Chrome extension that pushes your **accepted** solutions from LeetCode, Codeforces, AtCoder, CSES, CodeChef (experimental) and Repovive (experimental) to a GitHub repo.
Each problem gets its own folder with the solution file and a README (problem statement, topics, runtime/memory,
submission link). A solved-problems index is kept in the repo's root README.

## Install
1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick this folder.
2. Open **Options** and click **Sign in with GitHub**. Enter the shown code on GitHub and approve. No token is pasted.
3. On the GitHub page that opens (or via **Choose repository access**), install SolveSync on **only your solutions repo**.
4. Back in Options, click **Refresh repo list**, pick the repo, enter your **username for each platform**, then **Save settings**.

The extension uses the SolveSync GitHub App (client ID and slug in `lib/shared.js`; device flow on, Contents: read & write). It can only reach repos you install it on. It cannot create repos, so create yours on GitHub first.

## Backfill
Open LeetCode, Codeforces or AtCoder in the active tab, click the extension icon, then **Backfill this site**. It reads your full list of accepted
submissions (LeetCode: your signed-in account's history; Codeforces: the public API for your saved handle; AtCoder: the AtCoder Problems API at kenkoooo.com),
skips problems already in the repo, pushes the rest (one commit each, newest accepted solution per problem) and rebuilds the root README index once at the end.
Progress shows as a toast on the page. CSES, CodeChef and Repovive have no backfill.

## Activity log
The popup has an **Activity log** with the latest pushes, held solutions, skipped accounts and errors, including read failures on the pages.

## Repovive (experimental)
Repovive is client-rendered and its markup was not inspectable, so detection is heuristic: on a problem page (`/contests/<id>/problems/<X>` or `/problems/<id>`)
SolveSync notices a new "Accepted" label, reads the code from the editor (Monaco, Ace or CodeMirror) and pushes it. Contest URLs are held 3 hours unless an end time can
be found in the contest page. The signed-in username is read from the first profile link. If anything can't be read, a "SolveSync debug (Repovive)" dump is printed to the console.

## Contest solutions
Accepted solutions from a contest that is still running are not pushed immediately. They are kept in the browser (Options has a switch for this)
and pushed automatically by a background timer once the contest has ended; the popup lists what is waiting. If the contest end time
can't be read, the solution is held for 3 hours (4 on CodeChef). Codeforces uses `/api/contest.list` (gym contests are not held), AtCoder reads the
contest page, LeetCode reads `/contest/api/info/<slug>/`, CodeChef reads `/api/contests/<code>` for URLs like `/<CONTEST>/problems/<CODE>`.
Contest windows longer than 30 days (AtCoder practice contests) are never held. Chrome must be running at release time; if it was closed, the push happens when it starts.

## Username filter
Each platform has its own username field. A solution is pushed only when the account that submitted it matches the username
saved for that platform (case-insensitive). Other accounts are ignored with a short toast. If a platform is enabled but has no
username, or the extension cannot tell which account submitted, nothing is synced. Account detection: LeetCode (signed-in
user), Codeforces (handle on the submission row), AtCoder (User field of the submission), CSES and CodeChef (read from the
page; unverified, check the toast on your first submission).

Sign out in Options clears the stored token; to revoke fully, uninstall the app under GitHub > Settings > Applications.

## How syncing triggers
- **LeetCode:** automatic when a submission comes back Accepted.
- **Codeforces:** open your "My submissions" / status page; rows that turn Accepted while the page is open sync automatically. Older accepted rows get a "⇪ sync" link.
- **AtCoder (English UI):** automatic on your "My submissions" page and on a submission detail page once it shows AC. Older rows get "⇪ sync".

## Resulting layout (default template `{platform}/{group}/{id}-{slug}`)
```
README.md                      <- index between <!-- solvesync:start/end --> markers
LeetCode/array/0001-two-sum/solution.py
LeetCode/array/0001-two-sum/README.md
Codeforces/800/4A-watermelon/solution.cpp
CSES/introductory-problems/1068-weird-algorithm/solution.cpp
AtCoder/ABC/abc300_a-min-of-two/solution.py
```

## Adding a platform
Write `content/<platform>.js` that builds a payload `{platform, problemId, slug, title, url, difficulty, tags, language,
code, runtime, memory, submissionId, submissionUrl, submittedAt, descriptionMd}` and calls `SS.submit(payload)`.
Then register the script in `manifest.json` and the platform name in `SS.DEFAULTS.enabled` (`lib/shared.js`).
