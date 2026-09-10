// V25 — BEHAVIOURAL conversion tests against the shipped public-forms.js.
// ApexConsent.track is spied; fetch is mocked to 200 or 500. This exercises the
// real submit handler, not event-name strings.
import { JSDOM } from "jsdom";
import { readFileSync } from "fs";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("PASS " + m)) : (fail++, console.log("FAIL " + m)); };
const D = new URL("../docs/", import.meta.url).pathname;
const read = f => readFileSync(D + f, "utf8");
const tick = () => new Promise(r => setTimeout(r, 15));

async function run(page, formId, status) {
  const dom = new JSDOM(read(page), { runScripts: "outside-only", pretendToBeVisual: true, url: "https://apexliftsolutionsusa.com/" + page });
  const w = dom.window, events = [];
  w.ApexConsent = { track: (n, m) => events.push([n, m]) };          // consent granted
  w.fetch = async () => ({ ok: status === 200, status });
  w.alert = () => {};
  w.eval(read("public-forms.js"));
  await tick();
  const f = w.document.getElementById(formId);
  f.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await tick(); await tick();
  return events.map(e => e[0]);
}
const count = (ev, n) => ev.filter(x => x === n).length;

for (const [page, formId, kind] of [["index.html","contactForm","request"],["contact.html","contactForm","request"],["careers.html","applyForm","careers"]]) {
  console.log(`\n═══ ${page} ═══`);
  const success = kind === "request" ? "request_submit" : "job_application_submit";
  const attempt = kind === "request" ? "request_submit_attempt" : "job_application_submit_attempt";
  const okEv = await run(page, formId, 200);
  ok(count(okEv, success) === 1, `200 -> ${success} exactly once (${count(okEv, success)})`);
  ok(count(okEv, attempt) === 1, `200 -> ${attempt} exactly once (${count(okEv, attempt)})`);
  const badEv = await run(page, formId, 500);
  ok(count(badEv, success) === 0, `500 -> ${success} zero times (${count(badEv, success)})`);
  ok(count(badEv, attempt) === 1, `500 -> attempt still recorded once (${count(badEv, attempt)})`);
  if (kind === "careers") {
    ok(count(okEv, "request_submit") === 0 && count(badEv, "request_submit") === 0, "careers never emits request_submit");
    ok(count(okEv, "request_submit_attempt") === 0, "careers never emits request_submit_attempt");
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
