// P2-C — structured data honesty, social metadata completeness, sitemap consistency
import { readFileSync, readdirSync, existsSync } from "fs";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("PASS " + m)) : (fail++, console.log("FAIL " + m)); };
const D = new URL("../docs/", import.meta.url).pathname;
const read = f => readFileSync(D + f, "utf8");
const BASE = "https://apexliftsolutionsusa.com/";
const PUBLIC = ["index.html","about.html","services.html","plans.html","contact.html","careers.html",
                "privacy.html","terms.html","refund-policy.html","cookie-policy.html","accessibility.html"];
const PORTAL = ["portal-login.html","portal-forgot.html","portal-reset.html","portal-customer.html","portal-admin.html"];
// Visible text EXCLUDES script blocks, so the JSON-LD cannot satisfy a test
// that asks whether a claim appears on the page.
const text = f => read(f).replace(/<(script|style|noscript)[\s\S]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ");

console.log("═══ STRUCTURED DATA STATES ONLY WHAT THE SITE STATES ═══");
{
  const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(read("index.html"));
  const d = JSON.parse(m[1]);
  ok(d["@type"] === "Organization", "S1 Organization — not a LocalBusiness with unconfirmed hours and address");
  ok(!("priceRange" in d), "S2 no priceRange — the site publishes no prices");
  ok(!("address" in d), "S3 no address — the owner has not decided to publish one (B2)");
  ok(!("openingHoursSpecification" in d), "S3a no hours — unconfirmed (register item B3)");
  ok(!("hasOfferCatalog" in d), "S3b no offer catalog — services are described in copy, not asserted as offers");
  const site = PUBLIC.map(text).join(" ");   // script blocks stripped: JSON-LD cannot vouch for itself
  ok(d.telephone === "+15166447187" && /\(516\) 644-7187/.test(site), "S5 telephone matches the visible number");
  ok(d.email === "info@apexliftsolutionsusa.com" && site.includes(d.email), "S6 email matches the visible address");
  ok(/apexliftsolutionsusa\.com\/?$/.test(d.url), "S7 url is the canonical origin");
  ok(d.image === BASE + "og-image.jpg" && existsSync(D + "og-image.jpg"), "S8 image is absolute and the file exists");
  ok(d.logo === BASE + "logo.jpg" && existsSync(D + "logo.jpg"), "S8a logo is absolute and the file exists");
  ok(!/aggregateRating|review|ratingValue/i.test(m[1]), "S10 no invented ratings or reviews");
  for (const a of d.areaServed.map(x => x.name.split(",")[0]))
    ok(new RegExp(a, "i").test(site), `S11 areaServed "${a}" appears in visible copy`);
}

console.log("\n═══ SOCIAL METADATA ON EVERY PUBLIC PAGE ═══");
for (const f of PUBLIC) {
  const s = read(f);
  for (const p of ["og:title", "og:description", "og:url", "og:image"])
    ok(new RegExp(`property="${p}"`).test(s), `M1 ${f} has ${p}`);
  ok(/name="twitter:card" content="summary_large_image"/.test(s), `M2 ${f} has twitter:card`);
  const img = (/property="og:image" content="([^"]+)"/.exec(s) || [])[1] || "";
  ok(img.startsWith("https://") && existsSync(D + img.replace(BASE, "")), `M3 ${f} og:image is absolute and exists`);
  const url = (/property="og:url" content="([^"]+)"/.exec(s) || [])[1] || "";
  const canon = (/rel="canonical" href="([^"]+)"/.exec(s) || [])[1] || "";
  ok(url === canon, `M4 ${f} og:url equals canonical (${url === canon ? "yes" : url + " vs " + canon})`);
}

console.log("\n═══ SITEMAP / CANONICAL / NOINDEX AGREE ═══");
{
  const sm = read("sitemap.xml");
  const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  const canons = PUBLIC.map(f => (/rel="canonical" href="([^"]+)"/.exec(read(f)) || [])[1]);
  ok(locs.length === PUBLIC.length, `X1 sitemap has ${locs.length} URLs for ${PUBLIC.length} public pages`);
  ok(canons.every(c => locs.includes(c)), "X2 every canonical is in the sitemap");
  ok(locs.every(l => canons.includes(l)), "X3 every sitemap URL is a canonical");
  ok(locs.every(l => l.startsWith("https://")), "X4 all sitemap URLs are https");
  for (const p of PORTAL) {
    ok(!sm.includes(p), `X5 sitemap excludes ${p}`);
    ok(/noindex,nofollow,noarchive/.test(read(p)), `X6 ${p} is noindexed`);
    ok(!/rel="canonical"/.test(read(p)), `X7 ${p} has no canonical`);
  }
  const r = read("robots.txt");
  ok(!/Disallow: \/portal/.test(r), "X8 robots.txt does not disallow portal pages (noindex must be crawlable)");
  ok(/Sitemap: https:\/\/apexliftsolutionsusa\.com\/sitemap\.xml/.test(r), "X9 robots references the sitemap");
}

console.log("\n═══ DEPLOY CHECKLIST EXISTS ═══");
{
  const p = new URL("../internal-docs/DEPLOY_VERIFICATION_CHECKLIST.md", import.meta.url).pathname;
  ok(existsSync(p), "K1 checklist present");
  const t = readFileSync(p, "utf8");
  for (const s of ["Exposure boundary", "Cache-busting", "Structured data", "Social preview", "Consent", "Contact form", "Payment session"])
    ok(t.includes(s), `K2 covers ${s}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
