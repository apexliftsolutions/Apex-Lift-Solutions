// =============================================================================
//  GROUP 3 — modal accessibility tests (real DOM via jsdom)
//  Exercises docs/a11y.js against the actual portal markup.
//  Run: node tests/PHASE_G3_A11Y_TESTS.mjs
// =============================================================================
import { JSDOM } from "jsdom";
import { readFileSync } from "fs";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("PASS " + m)) : (fail++, console.log("FAIL " + m)); };
const HELPER = readFileSync(new URL("../docs/a11y.js", import.meta.url), "utf8");
const tick = () => new Promise(r => setTimeout(r, 0));

function boot(bodyHtml) {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`,
    { runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  // jsdom leaves offsetParent undefined; the helper treats that as visible.
  w.eval(HELPER);
  return w;
}
const MODAL = (id, extra = "") => `
  <button id="opener">Manage</button>
  <div class="sp-modal" id="${id}" hidden>
    <div class="sp-modal-card">
      <h3 id="${id}-title">Refund a monthly payment</h3>
      <input id="amt" aria-label="Refund amount">
      <textarea id="reason" aria-label="Reason"></textarea>
      ${extra}
      <button data-a11y-close id="cancel">Cancel</button>
      <button id="go">Process refund</button>
    </div>
  </div>`;

const key = (w, k, shift = false) => {
  const e = new w.KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true, cancelable: true });
  w.document.dispatchEvent(e); return e;
};

console.log("═══ DIALOG SEMANTICS ═══");
{
  const w = boot(MODAL("rs-refund"));
  await tick();                       // let the helper's DOMContentLoaded init run
  const m = w.document.getElementById("rs-refund");
  ok(m.getAttribute("role") === "dialog", "A1 role=dialog applied");
  ok(m.getAttribute("aria-modal") === "true", "A2 aria-modal=true applied");
  ok(m.getAttribute("aria-labelledby") === "rs-refund-title", "A3 aria-labelledby points at the visible heading");
}

console.log("\n═══ FOCUS ON OPEN / RETURN ON CLOSE ═══");
{
  const w = boot(MODAL("rs-refund"));
  const d = w.document, m = d.getElementById("rs-refund"), opener = d.getElementById("opener");
  opener.focus();
  ok(d.activeElement === opener, "B1 focus starts on the launcher");
  m.hidden = false;
  await tick();
  ok(m.contains(d.activeElement), "B2 focus moves into the dialog on open");
  ok(d.activeElement.id === "rs-refund-title", "B3 focus lands on the dialog heading");
  m.hidden = true;
  await tick();
  ok(d.activeElement === opener, "B4 focus returns to the launcher on close");
}
{ // launcher removed while the dialog was open (the list re-renders after save)
  const w = boot('<main id="main-content"></main>' + MODAL("sp-equip-modal"));
  await tick();
  const d = w.document, m = d.getElementById("sp-equip-modal");
  d.getElementById("opener").focus();
  m.hidden = false; await tick();
  d.getElementById("opener").remove();          // launcher destroyed by re-render
  m.hidden = true; await tick();
  ok(d.activeElement === d.getElementById("main-content"),
     "B5 a destroyed launcher falls back to the main landmark, not to body");
}

console.log("\n═══ FOCUS TRAP ═══");
{
  const w = boot(MODAL("rs-refund"));
  const d = w.document, m = d.getElementById("rs-refund");
  m.hidden = false; await tick();
  const items = w.ApexA11y._focusable(m);
  ok(items.length === 4, `C1 four focusable controls found (${items.length})`);
  items[items.length - 1].focus();
  let e = key(w, "Tab");
  ok(e.defaultPrevented && d.activeElement === items[0], "C2 Tab from the last control wraps to the first");
  items[0].focus();
  e = key(w, "Tab", true);
  ok(e.defaultPrevented && d.activeElement === items[items.length - 1], "C3 Shift+Tab from the first wraps to the last");
  items[1].focus();
  e = key(w, "Tab");
  ok(!e.defaultPrevented, "C4 Tab in the middle is left to the browser");
}
{ // a disabled control must not be a trap stop
  const w = boot(MODAL("rs-refund", '<button id="dis" disabled>Disabled</button>'));
  const m = w.document.getElementById("rs-refund");
  m.hidden = false; await tick();
  ok(!w.ApexA11y._focusable(m).some(el => el.id === "dis"), "C5 disabled controls are excluded from the trap");
}
{ // zero focusable controls must not throw or hang
  const w = boot(`<button id="opener">x</button><div class="sp-modal" id="empty" hidden><p>Nothing here</p></div>`);
  const m = w.document.getElementById("empty");
  m.hidden = false; await tick();
  const e = key(w, "Tab");
  ok(e.defaultPrevented, "C6 a dialog with no focusable controls swallows Tab instead of escaping");
}

console.log("\n═══ ESCAPE ═══");
{
  const w = boot(MODAL("rs-refund"));
  const d = w.document, m = d.getElementById("rs-refund");
  d.getElementById("cancel").addEventListener("click", () => { m.hidden = true; });
  m.hidden = false; await tick();
  key(w, "Escape"); await tick();
  ok(m.hidden === true, "D1 Escape dismisses via the dialog's own Cancel control");
}
{ // the money-moving guard
  const w = boot(MODAL("rs-refund"));
  const d = w.document, m = d.getElementById("rs-refund");
  d.getElementById("cancel").addEventListener("click", () => { m.hidden = true; });
  m.hidden = false; await tick();
  w.ApexA11y.setBusy(m, true);
  const e = key(w, "Escape"); await tick();
  ok(m.hidden === false, "D2 Escape CANNOT dismiss a dialog with an operation in flight");
  ok(e.defaultPrevented, "D3 the keystroke is swallowed rather than passed on");
  w.ApexA11y.setBusy(m, false);
  key(w, "Escape"); await tick();
  ok(m.hidden === true, "D4 Escape works again once the operation finishes");
}

console.log("\n═══ .modal-overlay (.open) MECHANISM ═══");
{
  const w = boot(`<button id="opener">Pay</button>
    <div class="modal-overlay" id="pay-modal"><div class="modal"><h3>Pay invoice</h3>
    <button id="a">A</button><button data-a11y-close id="cancel">Cancel</button></div></div>`);
  const d = w.document, m = d.getElementById("pay-modal");
  ok(w.ApexA11y._isVisible(m) === false, "E1 .modal-overlay is treated as closed without .open");
  d.getElementById("opener").focus();
  m.classList.add("open"); await tick();
  ok(m.contains(d.activeElement), "E2 adding .open moves focus into the dialog");
  m.classList.remove("open"); await tick();
  ok(d.activeElement === d.getElementById("opener"), "E3 removing .open returns focus");
}

console.log("\n═══ NESTED / RAPID ═══");
{
  const w = boot(MODAL("rs-detail") + MODAL("rs-refund").replace('id="opener"', 'id="opener2"'));
  const d = w.document, a = d.getElementById("rs-detail"), b = d.getElementById("rs-refund");
  a.hidden = false; await tick();
  b.hidden = false; await tick();
  ok(w.ApexA11y._openStack.length === 2, "F1 a dialog opened from a dialog stacks");
  const items = w.ApexA11y._focusable(b);
  items[items.length - 1].focus(); key(w, "Tab");
  ok(b.contains(d.activeElement), "F2 the trap follows the topmost dialog");
  b.hidden = true; await tick();
  ok(w.ApexA11y._openStack.length === 1 && w.ApexA11y._openStack[0] === a, "F3 closing the top restores the one beneath");
}



console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
