# Repository-root legacy frontend — removal list

**REMOVAL COMPLETE (P2-A, 2026-09-09).** All 32 root frontend duplicates were deleted under a three-gate procedure: full suite before, exact-list deletion, full suite after, with `docs/` proven byte-identical by SHA-256 before and after. The sections below are the decision record that preceded it.

## What they are

32 files at the repository root duplicating `docs/`: 13 HTML, 6 JS, 4 CSS,
6 images, `CNAME`, `robots.txt`, `sitemap.xml`.

They were restored deliberately in Group 2.1 as a deployment fallback while the
GitHub Pages publishing root moved to `/docs`. That switch is done.

## Current state

**26 of the 32 have diverged** — `docs/` has received every change since Group 3
and root has not. The root copies are a snapshot of a much older site: no
consent UI, no delegated event wiring, the salmon red palette, the broken
contact-form field names, and the stale plans copy.

## Why they are dangerous now, not merely redundant

They already caused a real defect. `PHASE_F_STATIC_TESTS` and
`PHASE_DE_STATIC_TESTS` read `portal-admin.js` and `portal-customer.js` **from
the root**, so those suites were asserting against files nobody deploys — which
is part of why the stale `DELETE` expectation survived so long. Fixed in P1-B,
but the trap remains as long as the files exist.

## Verified before recommending removal

- Production publishes from `/docs` (owner-confirmed).
- `docs/CNAME` and `docs/.nojekyll` are present.
- No test reads a root frontend file (`PHASE_TEST_SOURCE_GUARD` now enforces this).
- No tooling references a root frontend path.
- Nothing outside the root copies links to them.

## Recommendation

**REMOVED** — all 32. The repository root now contains no frontend files; `PHASE_TEST_SOURCE_GUARD` enforces that no test can read one from there.

Do **not** remove non-frontend root files. The `.sql` and `.md` files at root are
migrations, runbooks and reports; they are not duplicates and several are still
referenced.

## Rollback

`git revert` restores them. Nothing in production depends on them, so a revert
is only needed if the Pages publishing root is moved back.
