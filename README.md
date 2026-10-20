# drowl@cp: competitive programming dashboard

A personal dashboard for Codeforces, CodeChef and AtCoder with a problem log
(metacognition notes, mistake tags), a re-solve queue, a to-do list, weekly
reviews and insights.

Platform stats refresh by themselves every 6 hours through a GitHub Action.
Nothing runs on a server you have to maintain, and no API keys are needed.

## Set up (about 5 minutes)

1. Create a new GitHub repository (public, or private on a plan with Pages)
   and upload everything in this folder, keeping the folder structure.
2. In the repo, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Go to **Settings → Actions → General → Workflow permissions** and choose
   **Read and write permissions**.
4. Go to the **Actions** tab, open **Update stats and deploy**, and click
   **Run workflow**. When it finishes, your page is live at
   `https://<your-username>.github.io/<repo-name>/`.

After that it runs every 6 hours. Click **Run workflow** any time you want
fresh numbers right after a contest.

To change handles or time zone, edit `config.json`.

## Where the data comes from

| Platform   | Source |
|------------|--------|
| Codeforces | Official API: `user.info`, `user.rating`, `user.status` |
| AtCoder    | Rating history JSON from atcoder.jp, accepted submissions from the AtCoder Problems API (kenkoooo) |
| CodeChef   | No public API exists, so the public profile page is parsed |

If one platform fails (site down, page layout changed, request blocked),
the dashboard keeps that platform's last good data and shows
"update failed" in the header. Hover it to see the error. The CodeChef
parser is the most likely to break when CodeChef redesigns its profile page;
the patterns are in `codechef()` in `scripts/fetch-stats.mjs`.

## Your notes

Problem notes, to-dos and reviews are saved in your browser (localStorage),
not in the repo, so they stay private even if the repo is public.
Use **review → Backup → Export notes** now and then, and **Import notes**
on another device.

## Files

- `index.html`: the dashboard (one file, no build step)
- `data/stats.json`: platform stats, rewritten by the Action
- `scripts/fetch-stats.mjs`: the fetcher (Node 20, no dependencies)
- `.github/workflows/update-stats.yml`: schedule, commit and Pages deploy
- `config.json`: your handles and time zone
