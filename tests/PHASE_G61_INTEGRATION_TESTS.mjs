// =============================================================================
//  GROUP 6.1 — Load More INTEGRATION tests
//
//  These exercise the real wiring: moreX() -> ApexPage.handleMore() -> loadX().
//  The previous suite tested ApexPage.loadPage() in isolation and therefore did
//  not catch that one click fetched two pages.
//
//  The whole point of this file is the REQUEST COUNTER. Displayed row counts
//  alone would not have caught the bug either — 50 rows after one click looks
//  plausible until you count the queries.
//
//  Run: node tests/PHASE_G61_INTEGRATION_TESTS.mjs
// =============================================================================
import { readFileSync } from "fs";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("PASS " + m)) : (fail++, console.log("FAIL " + m)); };

const SRC = readFileSync(new URL("../docs/pagination.js", import.meta.url), "utf8");

// ── Minimal DOM good enough for the Load More button lifecycle ──────────────
function makeWrap() {
  const btn = { tagName: "BUTTON", disabled: false, textContent: "Load older", focused: 0,
                focus() { this.focused++; dom.activeElement = this; } };
  const status = { textContent: "" };
  const wrap = {
    hasButton: true,
    querySelector(sel) {
      if (sel === ".apex-more") return wrap.hasButton ? btn : null;
      if (sel === ".apex-more-status") return status;
      return null;
    },
    _btn: btn, _status: status,
  };
  return wrap;
}
const dom = { activeElement: null };

function loadHelper() {
  const win = {};
  new Function("window", "document", SRC)(win, dom);
  return win.ApexPage;
}

// ── Fake DB that COUNTS page requests ───────────────────────────────────────
function makeSb(rows, counter, opts = {}) {
  return {
    from() {
      const st = { filters: [], or: null, lim: null, sortCol: "created_at" };
      const api = {
        select: () => api,
        eq(c, v) { st.filters.push(r => r[c] === v); return api; },
        neq(c, v) { st.filters.push(r => r[c] !== v); return api; },
        or(e) { st.or = e; return api; },
        order(c) { if (!st._o) { st.sortCol = c; st._o = 1; } return api; },
        limit(n) { st.lim = n; return api; },
        then(res, rej) { return run().then(res, rej); },
      };
      async function run() {
        counter.n++;                                   // <-- the metric
        if (opts.failNext) { opts.failNext = false; return { data: null, error: { message: "network" } }; }
        let out = rows.slice();
        for (const f of st.filters) out = out.filter(f);   // eq/neq before paging
        if (st.or) {
          const m = st.or.match(/^([a-z_]+)\.lt\."([^"]*)",and\([a-z_]+\.eq\."[^"]*",id\.lt\."([^"]*)"\)$/);
          if (!m) return { data: null, error: { message: "malformed or()" } };
          const [, col, v, cid] = m;
          out = out.filter(r => String(r[col]) < v || (String(r[col]) === v && String(r.id) < cid));
        }
        out.sort((a, b) => {
          const A = String(a[st.sortCol]), B = String(b[st.sortCol]);
          if (A !== B) return A < B ? 1 : -1;
          return String(a.id) < String(b.id) ? 1 : -1;
        });
        return { data: out.slice(0, st.lim ?? out.length), error: null };
      }
      return api;
    },
  };
}

const iso = n => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const mkRows = n => Array.from({ length: n }, (_, i) => ({
  id: `R-${String(9000 - i).padStart(4, "0")}`, created_at: iso(n - i), customer_id: "C1",
}));

/**
 * Reproduces the production shape of a loader: ONE loadPage call, then render.
 * `renderCalls` proves render ran; `counter.n` proves how many DB pages were
 * requested. This mirrors loadQuotes/loadInvoices/loadHistory/loadPayments.
 */
function makeLoader(P, sb, st, wrap, renderCalls, opts = {}) {
  return async function loadX(append) {
    const { error } = await P.loadPage(sb, st);
    if (error) return { error };
    if (opts.asyncRender) await new Promise(r => setTimeout(r, 5));
    renderCalls.push({ items: st.items.length, hasMore: st.hasMore });
    wrap.hasButton = st.hasMore;                      // render decides the button
    return { error: null };
  };
}

async function scenario(total, clicks, opts = {}) {
  const P = loadHelper();
  const counter = { n: 0 };
  const sb = makeSb(mkRows(total), counter, opts);
  const st = P.create({ table: "t" });
  const wrap = makeWrap();
  const renders = [];
  const loadX = makeLoader(P, sb, st, wrap, renders, opts);

  await loadX(false);                                  // initial load
  const afterInitial = { rows: st.items.length, requests: counter.n };

  const steps = [afterInitial];
  for (let i = 0; i < clicks; i++) {
    if (!st.hasMore) break;
    dom.activeElement = wrap._btn;
    wrap._btn.disabled = false;
    await P.handleMore(wrap, () => loadX(true));
    steps.push({ rows: st.items.length, requests: counter.n });
  }
  return { P, st, wrap, steps, counter, renders };
}

console.log("═══ THE BUG: ONE CLICK MUST BE ONE REQUEST ═══");
{
  const { steps } = await scenario(100, 3);
  ok(steps[0].rows === 25 && steps[0].requests === 1, `I1 initial: 25 rows, 1 request (${steps[0].rows}/${steps[0].requests})`);
  ok(steps[1].rows === 50 && steps[1].requests === 2, `I2 click 1: 50 rows, 2 requests (${steps[1].rows}/${steps[1].requests})`);
  ok(steps[2].rows === 75 && steps[2].requests === 3, `I3 click 2: 75 rows, 3 requests (${steps[2].rows}/${steps[2].requests})`);
  ok(steps[3].rows === 100 && steps[3].requests === 4, `I4 click 3: 100 rows, 4 requests (${steps[3].rows}/${steps[3].requests})`);
  // The old wiring produced 25 -> 75 on the first click.
  ok(steps[1].rows - steps[0].rows === 25, `I5 one click advances by exactly one page, never two`);
}

console.log("\n═══ 26 ROWS ═══");
{
  const { st, steps, wrap } = await scenario(26, 3);
  ok(steps[0].rows === 25, `J1 initial 25 (${steps[0].rows})`);
  ok(steps[1].rows === 26, `J2 after one click 26 (${steps[1].rows})`);
  ok(st.hasMore === false, "J3 hasMore false once exhausted");
  ok(steps.length === 2 && steps[1].requests === 2,
     `J4 exactly 2 page queries total — no third empty request (${steps[steps.length-1].requests})`);
  ok(wrap.hasButton === false, "J5 Load More withdrawn");
}

console.log("\n═══ 51 ROWS — the deterministic double-fetch detector ═══");
{
  const { steps, st } = await scenario(51, 5);
  ok(steps[0].rows === 25, `K1 initial 25 (${steps[0].rows})`);
  ok(steps[1].rows === 50, `K2 click 1 -> 50 (${steps[1].rows})`);
  ok(steps[2].rows === 51, `K3 click 2 -> 51 (${steps[2].rows})`);
  ok(steps[steps.length - 1].requests === 3, `K4 exactly 3 page queries (${steps[steps.length-1].requests})`);
  ok(st.hasMore === false, "K5 exhausted");
  ok(new Set(st.items.map(r => r.id)).size === 51, "K6 no duplicate ids");
}

console.log("\n═══ ASYNC RENDER ORDERING ═══");
{
  // Quotes render asynchronously because attachment URLs are signed. The helper
  // must await the render before it looks for the replacement button.
  const { wrap, renders, st } = await scenario(60, 1, { asyncRender: true });
  ok(renders.length === 2, `A1 render ran for both the initial load and the click (${renders.length})`);
  ok(renders[1].items === 50, `A2 the render saw the appended rows (${renders[1].items})`);
  ok(wrap._btn.focused >= 1, `A3 focus was restored to the Load More button after rendering`);
  ok(st.items.length === 50, "A4 exactly two pages loaded");
}
{
  // Focus must not be attempted before the DOM is replaced. With an async
  // render that resolves late, a non-awaited implementation would focus first.
  const P = loadHelper();
  const counter = { n: 0 };
  const sb = makeSb(mkRows(60), counter);
  const st = P.create({ table: "t" });
  const wrap = makeWrap();
  const order = [];
  dom.activeElement = wrap._btn;
  await P.handleMore(wrap, async () => {
    await P.loadPage(sb, st);
    await new Promise(r => setTimeout(r, 5));
    order.push("render");
    return { error: null };
  });
  order.push("after-handleMore");
  ok(order[0] === "render", `A5 render completes before handleMore returns (${order.join(" -> ")})`);
}

console.log("\n═══ FAILURE DURING LOAD MORE ═══");
{
  const P = loadHelper();
  const counter = { n: 0 };
  const opts = {};
  const sb = makeSb(mkRows(60), counter, opts);
  const st = P.create({ table: "t" });
  const wrap = makeWrap();
  const renders = [];
  const loadX = makeLoader(P, sb, st, wrap, renders);
  await loadX(false);
  const before = st.items.length;

  opts.failNext = true;
  dom.activeElement = wrap._btn;
  const out = await P.handleMore(wrap, () => loadX(true));
  ok(!!out.error, "E1 the failure is reported");
  ok(st.items.length === before, "E2 rows already on screen are preserved");
  ok(wrap._btn.disabled === false, "E3 the button is re-enabled for retry");
  ok(/try again/i.test(wrap._status.textContent), "E4 the failure is announced in the live region");

  const retry = await P.handleMore(wrap, () => loadX(true));
  ok(!retry.error && st.items.length === 50, `E5 retry succeeds and appends (${st.items.length})`);
  ok(new Set(st.items.map(r => r.id)).size === st.items.length, "E6 retry produced no duplicates");
}

console.log("\n═══ DOUBLE-CLICK GUARD ═══");
{
  const P = loadHelper();
  const counter = { n: 0 };
  const sb = makeSb(mkRows(100), counter);
  const st = P.create({ table: "t" });
  const wrap = makeWrap();
  const renders = [];
  const loadX = makeLoader(P, sb, st, wrap, renders);
  await loadX(false);
  const base = counter.n;
  dom.activeElement = wrap._btn;
  // Two clicks fired before the first resolves.
  const [a, b] = await Promise.all([
    P.handleMore(wrap, () => loadX(true)),
    P.handleMore(wrap, () => loadX(true)),
  ]);
  ok(counter.n === base + 1, `D1 a double click still fetches one page (${counter.n - base})`);
  ok(st.items.length === 50, `D2 rows advanced by exactly one page (${st.items.length})`);
}

console.log("\n═══ ATTACHMENT SIGNED-URL REUSE ═══");
{
  // Mirrors attHtmlCached(): markup is generated once per quote and reused
  // while inside the signing window, so loading page 2 does not re-sign page 1.
  const signCalls = [];
  const CACHE = {}, TTL = 8 * 60 * 1000;
  async function attHtmlCached(id) {
    const hit = CACHE[id];
    if (hit && Date.now() - hit.at < TTL) return hit.html;
    signCalls.push(id);
    const html = `<a href="signed-${id}">file</a>`;
    CACHE[id] = { html, at: Date.now() };
    return html;
  }
  const page1 = ["Q-1", "Q-2", "Q-3"], page2 = ["Q-4", "Q-5"];
  for (const q of page1) await attHtmlCached(q);
  ok(signCalls.length === 3, `T1 page 1 signs 3 attachments (${signCalls.length})`);
  for (const q of [...page1, ...page2]) await attHtmlCached(q);   // full re-render
  ok(signCalls.length === 5, `T2 re-rendering after Load More signs only the 2 NEW quotes (${signCalls.length})`);
  ok(!signCalls.slice(3).some(id => page1.includes(id)), "T3 page-1 attachments were not re-signed");
}

console.log("\n═══ handleMore NEVER FETCHES ═══");
{
  const P = loadHelper();
  const counter = { n: 0 };
  const sb = makeSb(mkRows(60), counter);
  const st = P.create({ table: "t" });
  const wrap = makeWrap();
  // A callback that does no fetching at all: the request count must stay 0.
  await P.handleMore(wrap, async () => ({ error: null }));
  ok(counter.n === 0, `H1 handleMore itself issues no query (${counter.n})`);
  ok(P.handleMore.length === 2, `H2 signature is (wrapEl, loadFn) — no sb/state to fetch with (${P.handleMore.length})`);
}


// =============================================================================
//  APPEND SEMANTICS AGAINST THE REAL LOADER SOURCE
//
//  The harness above recreates the loader shape. These assertions run against
//  the ACTUAL docs/portal-customer.js text and the real ApexPage, because the
//  bug being guarded here is in the loaders themselves, not the helper.
// =============================================================================
import { readFileSync as _rf } from "fs";
const LOADER_SRC = _rf(new URL("../docs/portal-customer.js", import.meta.url), "utf8");

console.log("\n═══ REAL LOADERS: APPEND MUST NOT WIPE THE LIST ═══");
{
  const guarded = (LOADER_SRC.match(/if \(!append\) wrap\.innerHTML = '<div class="loading-msg">/g) || []).length;
  ok(guarded === 4, `W1 all four loaders guard the loading state behind !append (${guarded}/4)`);
  const unguarded = (LOADER_SRC.match(/^\s*wrap\.innerHTML = '<div class="loading-msg">/gm) || []).length;
  ok(unguarded === 0, `W2 no loader clears the wrapper unconditionally (${unguarded} found)`);
}
{
  const early = (LOADER_SRC.match(/if \(append\) return \{ error \};/g) || []).length;
  ok(early === 3, `W3 quotes/invoices/history return early on an append failure (${early}/3)`);
  ok(/if \(!append && !PAYMENTS_PAGE\.items\.length\)/.test(LOADER_SRC),
     "W4 payments only paints its error card on an initial-load failure");
}
{
  // Order matters: the !append guard must come BEFORE the await, or the list is
  // already gone by the time the request is made.
  for (const fn of ["loadQuotes", "loadInvoices", "loadHistory", "loadPayments"]) {
    const body = LOADER_SRC.slice(LOADER_SRC.indexOf(`async function ${fn}(`));
    const iGuard = body.indexOf("if (!append) wrap.innerHTML");
    const iAwait = body.indexOf("await ApexPage.loadPage");
    ok(iGuard > -1 && iAwait > -1 && iGuard < iAwait,
       `W5 ${fn}: the loading state is decided before the request, and only for an initial load`);
  }
}

console.log("\n═══ HIDDEN INVOICES MUST NOT CONSUME PAGE SLOTS ═══");
{
  ok(/applyFilters: q => q\.eq\('customer_id', USER\.id\)\.neq\('status', 'hidden'\)/.test(LOADER_SRC),
     "V1 invoices exclude 'hidden' in the database query");
  // Worst case the auditor named: the newest 25 physical rows are all hidden.
  const P = loadHelper();
  const rows = [];
  for (let i = 0; i < 60; i++) {
    rows.push({ id: `I-${String(9000 - i).padStart(4, "0")}`, created_at: iso(60 - i),
                customer_id: "C1", status: i < 25 ? "hidden" : "unpaid" });
  }
  const visible = rows.filter(r => r.status !== "hidden");
  const counter = { n: 0 };
  // The mock honours .neq the way PostgREST does.
  const sb = makeSb(rows, counter);
  const st = P.create({ table: "invoices",
    applyFilters: q => q.eq("customer_id", "C1").neq("status", "hidden") });
  const wrap = makeWrap();
  const renders = [];
  const loadX = makeLoader(P, sb, st, wrap, renders);
  await loadX(false);
  ok(st.items.length === 25, `V2 first page holds 25 VISIBLE invoices even though the newest 25 rows are hidden (${st.items.length})`);
  ok(st.items.every(r => r.status !== "hidden"), "V3 no hidden invoice is loaded");
  ok(st.hasMore === true, "V4 hasMore reflects eligible rows, not physical rows");
  while (st.hasMore) await loadX(true);
  ok(st.items.length === visible.length, `V5 the full visible history stays reachable (${st.items.length}/${visible.length})`);
  ok(st.items.every(r => r.status !== "hidden"), "V6 still no hidden invoices after exhaustion");
}

console.log("\n═══ FINAL-PAGE ANNOUNCEMENT ═══");
{
  const P = loadHelper();
  const st = P.create({ table: "t" });
  st.hasMore = false;
  const html = P.moreButtonHtml(st, "moreX");
  ok(html !== "", "Z1 the exhausted state still renders something");
  ok(/class="apex-more-status"/.test(html) && /aria-live="polite"/.test(html),
     "Z2 it is a polite live region");
  ok(!/<button/.test(html), "Z3 but no button — the list really is exhausted");

  // End to end: last page renders, live region survives, announcement lands.
  const counter = { n: 0 };
  const sb = makeSb(mkRows(26), counter);
  const st2 = P.create({ table: "t" });
  const wrap = makeWrap();
  const renders = [];
  const loadX = makeLoader(P, sb, st2, wrap, renders);
  await loadX(false);
  dom.activeElement = wrap._btn;
  wrap._btn.disabled = false;
  await P.handleMore(wrap, () => loadX(true));
  ok(st2.hasMore === false, "Z4 exhausted after the final page");
  ok(wrap._status.textContent === "All records loaded.",
     `Z5 the exhaustion announcement actually happens (${JSON.stringify(wrap._status.textContent)})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
