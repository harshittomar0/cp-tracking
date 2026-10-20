#!/usr/bin/env node
// Fetches public profile data for the dashboard and writes data/stats.json.
// Uses only public pages and APIs: no credentials are needed or stored.
//   Codeforces: official API (user.info, user.rating, user.status)
//   AtCoder:    rating history JSON from atcoder.jp + submissions from the AtCoder Problems API (kenkoooo)
//   CodeChef:   no public API, so the public profile page is parsed
// If one platform fails, its previous data is kept and the error is recorded.

import { readFile, writeFile, mkdir } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const OUT = new URL("data/stats.json", ROOT);
const config = JSON.parse(await readFile(new URL("config.json", ROOT), "utf8"));

const HANDLE_RE = /^[A-Za-z0-9_.\-]{1,40}$/;
for (const k of ["codeforces", "codechef", "atcoder"]) {
  if (!HANDLE_RE.test(config[k] || "")) throw new Error(`config.json: "${k}" must be a valid handle`);
}
const TZ = config.timezone || "UTC";
const DAYS_KEPT = 400;
const RECENT_KEPT = 40;
const UA = `cp-dashboard-stats/1.0 (personal stats page; ${process.env.GITHUB_REPOSITORY || "local"})`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const toDay = (sec) => dayFmt.format(new Date(sec * 1000));
const cutoff = toDay(Date.now() / 1000 - DAYS_KEPT * 86400);

async function get(url, { json = true, tries = 3 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 30000);
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: json ? "application/json" : "text/html", "Accept-Encoding": "gzip" },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}${new URL(url).pathname}`);
      return json ? await res.json() : await res.text();
    } catch (e) {
      last = e;
      if (i < tries - 1) await sleep(3000 * (i + 1));
    }
  }
  throw last;
}

function trimDaily(m) {
  const out = {};
  for (const [d, n] of Object.entries(m)) if (d >= cutoff) out[d] = n;
  return out;
}

/* ---------------- Codeforces ---------------- */
async function codeforces(handle) {
  const base = "https://codeforces.com/api/";
  const h = encodeURIComponent(handle);
  const call = async (path) => {
    const r = await get(base + path);
    if (r.status !== "OK") throw new Error(`Codeforces API: ${r.comment || "request failed"}`);
    return r.result;
  };
  const info = (await call(`user.info?handles=${h}`))[0];
  await sleep(2100); // API limit: one call per 2 seconds
  const rating = await call(`user.rating?handle=${h}`);
  await sleep(2100);
  const subs = await call(`user.status?handle=${h}`);

  const firstAc = new Map();
  for (const s of subs) {
    if (s.verdict !== "OK" || !s.problem) continue;
    const p = s.problem;
    const key = `${p.contestId ?? p.problemsetName ?? "x"}-${p.index}`;
    const prev = firstAc.get(key);
    if (!prev || s.creationTimeSeconds < prev.creationTimeSeconds) firstAc.set(key, s);
  }
  const daily = {}, tags = {}, ratings = {};
  for (const s of firstAc.values()) {
    const d = toDay(s.creationTimeSeconds);
    daily[d] = (daily[d] || 0) + 1;
    for (const t of s.problem.tags || []) tags[t] = (tags[t] || 0) + 1;
    if (s.problem.rating) ratings[s.problem.rating] = (ratings[s.problem.rating] || 0) + 1;
  }
  const recent = [...firstAc.values()]
    .sort((a, b) => b.creationTimeSeconds - a.creationTimeSeconds)
    .slice(0, RECENT_KEPT)
    .map((s) => {
      const p = s.problem;
      const cid = p.contestId;
      const url = cid
        ? `https://codeforces.com/${cid >= 100000 ? "gym" : "contest"}/${cid}/problem/${encodeURIComponent(p.index)}`
        : null;
      return { name: `${cid ?? ""}${p.index} ${p.name}`.trim(), url, rating: p.rating || null, tags: p.tags || [], date: toDay(s.creationTimeSeconds) };
    });

  return {
    handle,
    rating: info.rating ?? null,
    maxRating: info.maxRating ?? null,
    rank: info.rank || "unrated",
    maxRank: info.maxRank || "",
    solved: firstAc.size,
    history: rating.map((r) => [toDay(r.ratingUpdateTimeSeconds), r.contestName, r.newRating, r.newRating - r.oldRating, null]),
    daily: trimDaily(daily),
    tags,
    ratings,
    recent,
  };
}

/* ---------------- AtCoder ---------------- */
async function atcoder(handle, prev) {
  const h = encodeURIComponent(handle);
  const hist = await get(`https://atcoder.jp/users/${h}/history/json`);
  const rated = (Array.isArray(hist) ? hist : []).filter((r) => r.IsRated);
  const history = rated.map((r, i) => [
    toDay(Date.parse(r.EndTime) / 1000),
    String(r.ContestScreenName || r.ContestNameEn || "").split(".")[0].toUpperCase(),
    r.NewRating,
    i === 0 ? null : r.NewRating - r.OldRating,
    r.Performance ?? null,
  ]);
  const out = {
    handle,
    rating: history.length ? history[history.length - 1][2] : null,
    max: history.length ? Math.max(...history.map((r) => r[2])) : null,
    rank: prev?.rank ?? null,
    solved: prev?.solved ?? null,
    history,
    daily: prev?.daily || {},
    recent: prev?.recent || [],
  };

  // Rank from the profile page (optional).
  try {
    await sleep(1500);
    const html = await get(`https://atcoder.jp/users/${h}`, { json: false });
    const m = html.match(/<th[^>]*>\s*Rank\s*<\/th>\s*<td[^>]*>\s*(\d+)/i);
    if (m) out.rank = Number(m[1]);
  } catch (e) {
    console.warn("AtCoder rank skipped:", e.message);
  }

  // Accepted submissions from AtCoder Problems (optional; keeps previous data on failure).
  try {
    const subs = [];
    let from = 0;
    for (let page = 0; page < 40; page++) {
      await sleep(1100); // be polite: the API asks not to be hit often
      const batch = await get(`https://kenkoooo.com/atcoder/atcoder-api/v3/user/submissions?user=${h}&from_second=${from}`);
      if (!Array.isArray(batch) || !batch.length) break;
      subs.push(...batch);
      if (batch.length < 500) break;
      from = Math.max(...batch.map((s) => s.epoch_second)) + 1;
    }
    const firstAc = new Map();
    for (const s of subs) {
      if (s.result !== "AC") continue;
      const prevS = firstAc.get(s.problem_id);
      if (!prevS || s.epoch_second < prevS.epoch_second) firstAc.set(s.problem_id, s);
    }
    const daily = {};
    for (const s of firstAc.values()) {
      const d = toDay(s.epoch_second);
      daily[d] = (daily[d] || 0) + 1;
    }
    out.solved = firstAc.size;
    out.daily = trimDaily(daily);
    out.recent = [...firstAc.values()]
      .sort((a, b) => b.epoch_second - a.epoch_second)
      .slice(0, RECENT_KEPT)
      .map((s) => ({
        name: String(s.problem_id).toUpperCase(),
        url: `https://atcoder.jp/contests/${encodeURIComponent(s.contest_id)}/tasks/${encodeURIComponent(s.problem_id)}`,
        rating: null,
        tags: [],
        date: toDay(s.epoch_second),
      }));
  } catch (e) {
    console.warn("AtCoder submissions skipped:", e.message);
  }
  return out;
}

/* ---------------- CodeChef ---------------- */
async function codechef(handle) {
  const html = await get(`https://www.codechef.com/users/${encodeURIComponent(handle)}`, { json: false });
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/\s+/g, " ");
  const num = (re, src = text) => {
    const m = src.match(re);
    return m ? Number(m[1]) : null;
  };
  const rating = num(/class="rating-number"[^>]*>\s*(\d{3,4})/, html) ?? num(/DSA Rating\s+(\d{3,4})/);
  if (rating == null) throw new Error("CodeChef: rating not found on the profile page (the page layout may have changed)");

  let history = [];
  try {
    const m = html.match(/var\s+all_rating\s*=\s*(\[[\s\S]*?\]);/);
    if (m) {
      const pad = (x) => String(x).padStart(2, "0");
      const rows = JSON.parse(m[1]);
      history = rows
        .filter((r) => r && r.rating && r.getyear)
        .map((r) => [`${r.getyear}-${pad(r.getmonth)}-${pad(r.getday)}`, String(r.name || r.code || "Contest"), Number(r.rating), null, null])
        .sort((a, b) => a[0].localeCompare(b[0]));
      for (let i = 1; i < history.length; i++) history[i][3] = history[i][2] - history[i - 1][2];
    }
  } catch (e) {
    console.warn("CodeChef rating history skipped:", e.message);
  }

  const starsMatch = text.match(/(\d)\s*★/);
  return {
    handle,
    rating,
    max: num(/Highest Rating\s*(\d{3,4})/) ?? (history.length ? Math.max(...history.map((r) => r[2])) : null),
    stars: starsMatch ? Number(starsMatch[1]) : null,
    global: num(/(\d+)\s+Global Rank/),
    country: num(/(\d+)\s+Country Rank/),
    contests: num(/Contests Participated:\s*(\d+)/),
    solved: num(/Total Problems Solved:\s*(\d+)/),
    history,
  };
}

/* ---------------- run ---------------- */
let prev = {};
try {
  prev = JSON.parse(await readFile(OUT, "utf8"));
} catch {
  prev = {};
}

const out = { updated: new Date().toISOString(), timezone: TZ };
const jobs = [
  ["cf", () => codeforces(config.codeforces)],
  ["ac", () => atcoder(config.atcoder, prev.ac)],
  ["cc", () => codechef(config.codechef)],
];
let failures = 0;
for (const [key, run] of jobs) {
  try {
    const data = await run();
    out[key] = { ok: true, fetchedAt: new Date().toISOString(), ...data };
    console.log(`${key}: ok (rating ${data.rating})`);
  } catch (e) {
    failures++;
    const msg = String(e && e.message ? e.message : e).slice(0, 300);
    console.error(`${key}: FAILED - ${msg}`);
    out[key] = { ...(prev[key] || { handle: config[{ cf: "codeforces", ac: "atcoder", cc: "codechef" }[key]], history: [] }), ok: false, error: msg };
  }
}

await mkdir(new URL("data/", ROOT), { recursive: true });
await writeFile(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(`wrote data/stats.json (${failures} platform(s) failed)`);
if (failures === jobs.length) process.exit(1);
