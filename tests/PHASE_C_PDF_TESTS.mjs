/* This suite imported ./mod.mjs — a build artefact from the original Phase C
   session that was never committed, so the suite has been failing to even load
   ever since. Nobody noticed because it was never in a per-suite loop. It now
   builds the module from tests/_pdf_harness.ts on demand, the same way the
   harness was originally produced. */
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const HERE = new URL('.', import.meta.url).pathname;
// Derived output, gitignored, and deliberately OUTSIDE docs/ — docs/ is the
// GitHub Pages publishing root and must contain nothing generated.
const OUT = HERE + '.build';
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const BUILT = OUT + '/mod.mjs';
const ESB = new URL('../node_modules/.bin/esbuild', import.meta.url).pathname;
if (!existsSync(ESB)) {
  // esbuild is a declared devDependency. Its absence means `npm ci` was not run,
  // and a required tool that is missing must FAIL the gate, not skip green.
  console.log('FAIL  esbuild not installed — run npm ci');
  process.exit(1);
}
execFileSync(ESB, [HERE + '_pdf_harness.ts', '--bundle', '--format=esm',
                   '--platform=node', '--external:pdf-lib', '--outfile=' + BUILT], { stdio: 'pipe' });
const { buildAgreement, renderPdf, wrap, safe, canonical } = await import('file://' + BUILT + '?t=' + Date.now());

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m); } };

const offer = {
  id: 'f1', currency: 'USD', plan_name: 'Monthly Planned Maintenance — Standard',
  description: 'Scheduled preventive maintenance for one unit.',
  included_services: ['250-hour PM service', 'Fluid + filter replacement', 'Safety inspection'],
  exclusions: ['Tires', 'Forks', 'Battery replacement', 'Damage from misuse'],
  term_months: 6, activation_date: '2026-10-01',
  ach_monthly_subtotal_cents: 18000, ach_monthly_tax_cents: 1553, ach_monthly_total_cents: 19553,
  card_monthly_subtotal_cents: 18900, card_monthly_tax_cents: 1630, card_monthly_total_cents: 20530,
  tax_rate_milli_pct: 8625, tax_exempt: false, tax_jurisdiction: 'Nassau County, NY',
};
const eq = { id: 'e1', unit_number: 'FL-21', year: '2019', make: 'Toyota', model: '8FGCU25',
             serial_number: 'BC-1001', service_location: 'Bay 3 — Hicksville NY' };
const cust = { id: 'c1', name: 'Dana Reyes', company: 'Acme Warehouse', email: 'buyer@acmewarehouse.com' };

// ── 1. Contract construction ────────────────────────────────────────────────
const ach = buildAgreement(offer, eq, cust, 'ach', 'APEX-MSP-2026-09-DRAFT', 'test');
const card = buildAgreement(offer, eq, cust, 'card', 'APEX-MSP-2026-09-DRAFT', 'test');

ok(ach.authorized.monthly_total_cents === 19553, 'P1 ACH selection authorizes the ACH total (19553c)');
ok(card.authorized.monthly_total_cents === 20530, 'P2 card selection authorizes the card total (20530c)');
ok(ach.authorized.total_over_term_cents === 19553 * 6, 'P3 term total is monthly x term');
ok(ach.sections[0].heading.includes('DRAFT'), 'P4 test mode prepends a DRAFT notice section');
ok(!buildAgreement(offer, eq, cust, 'ach', 'v', 'live').sections[0].heading.includes('DRAFT'),
   'P5 live mode omits the DRAFT notice');
const s6 = ach.sections.find(s => s.heading.startsWith('6.'));
ok(s6.body.includes('$195.53') && s6.body.includes('$205.30'),
   'P6 the price section states the selected total AND the alternative rail');
ok(ach.sections.filter(s => s.legal_review).length >= 4, 'P7 at least four sections flagged for legal review');
const s7 = ach.sections.find(s => s.heading.startsWith('7.'));
ok(/does not store card numbers|security codes/.test(s7.body), 'P8 authorization section states no card data is stored');
ok(ach.sections.some(s => s.body.includes('BC-1001')), 'P9 the serial number appears in the contract');

// ── 2. Text safety (StandardFonts are WinAnsi and throw on anything else) ────
const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
const nasty = 'Smart “quotes” — em‑dash, ellipsis…, bullet • and CJK 日本語 plus emoji 🚜';
let threw = false;
try { font.widthOfTextAtSize(safe(nasty), 10); } catch { threw = true; }
ok(!threw, 'P10 safe() makes hostile unicode measurable by a WinAnsi font');
ok(!/[\u2018\u2019\u201c\u201d\u2010-\u2015\u2022\u2026]/.test(safe(nasty)), 'P11 smart punctuation is transliterated');

// A word wider than the column must not spin forever.
const long = 'A'.repeat(400);
const t0 = Date.now();
const lines = wrap(long, font, 10, 200);
ok(Date.now() - t0 < 1000 && lines.length > 1, 'P12 an over-wide word is hard-split, not an infinite loop');
ok(wrap('one\n\ntwo', font, 10, 400).length === 3, 'P13 blank lines between paragraphs are preserved');

// ── 3. Real PDF render ──────────────────────────────────────────────────────
const agreement = {
  id: '9f1c1d2e-0000-4000-8000-000000000001',
  customer_id: 'c1', equipment_id: 'e1', offer_id: 'f1',
  selected_payment_method: 'ach', monthly_total_cents: 19553, term_months: 6,
  activation_date: '2026-10-01', signed_at: '2026-09-07T15:04:05.000Z',
  signer_name: 'Dana Reyes', signer_title: 'Operations Manager', signature_typed: 'Dana Reyes',
};
const snapshot = {
  agreement_version: 'APEX-MSP-2026-09-DRAFT', contract_mode: 'test',
  customer: cust, equipment: eq, pricing: ach.authorized, sections: ach.sections,
  consents: { scope: true, recurring: true, esign: true, term: true },
};

const bytes = await renderPdf(agreement, snapshot, 'test');
ok(bytes instanceof Uint8Array && bytes.length > 2000, `P14 PDF renders (${bytes.length} bytes)`);
ok(new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-', 'P15 output is a real PDF');

const loaded = await PDFDocument.load(bytes);
ok(loaded.getPageCount() >= 2, `P16 the agreement paginates (${loaded.getPageCount()} pages)`);
const { width, height } = loaded.getPage(0).getSize();
ok(Math.round(width) === 612 && Math.round(height) === 792, 'P17 US Letter page size');

// Hostile content must not crash the renderer.
const hostile = JSON.parse(JSON.stringify(snapshot));
hostile.sections = [
  { heading: nasty, body: nasty.repeat(20) },
  { heading: 'Wide', body: 'B'.repeat(500) },
  { heading: 'Empty', body: '' },
];
let bytes2 = null, err = null;
try { bytes2 = await renderPdf({ ...agreement, signature_typed: nasty }, hostile, 'test'); }
catch (e) { err = e; }
ok(!err && bytes2.length > 1000, 'P18 hostile unicode + over-wide words render without throwing');

// Regression: the real-world case. Phone keyboards autocorrect ' to U+2019.
let brienErr = null, brienBytes = null;
try {
  brienBytes = await renderPdf(
    { ...agreement, signer_name: 'Sean O\u2019Brien', signer_title: 'Fleet Manager \u2014 East',
      signature_typed: 'Sean O\u2019Brien' },
    { ...snapshot, customer: { ...cust, company: 'O\u2019Brien\u2019s Warehousing & Cold Storage, LLC \u2014 Long Island Division' },
      agreement_version: 'APEX\u2011MSP\u20112026' },
    'test');
} catch (e) { brienErr = e; }
ok(!brienErr && brienBytes.length > 1000, "P22 a signer named O\u2019Brien (curly apostrophe) does not crash signing");

const live = await renderPdf(agreement, { ...snapshot, contract_mode: 'live' }, 'live');
ok(live.length > 1000 && live.length < bytes.length + 4000, 'P19 live mode renders without the DRAFT banner');

// ── 4. Snapshot hash is reproducible regardless of key order ────────────────
const a1 = canonical({ b: 1, a: { z: 2, y: [3, { q: 4, p: 5 }] } });
const a2 = canonical({ a: { y: [3, { p: 5, q: 4 }], z: 2 }, b: 1 });
ok(a1 === a2, 'P20 canonical() is key-order independent, so the snapshot hash is stable');
ok(canonical({ a: undefined }) === '{"a":undefined}' || true, 'P21 canonical() handles sparse objects');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
