# Yahoo selected league, season and response validation

Status: bounded source candidate verified with isolated fixtures; not deployed and not full Yahoo readiness.

## Reproduction and correction

Base `dac0284` fenced account/provider-session/caller context but accepted raw provider metadata for another selected league or year. Missing settings and truncated rosters could map to invented defaults or empty collections. Exact-baseline actual-module tests: **1 passed / 20 failed**. Corrected candidate: **21 passed / 0 failed**.

All selected key representations must agree, and selected season/context must agree. Authenticated `nfl.l.ID` aliases resolve through the provider's NFL game metadata before league requests. Required settings, teams and rosters must have the same canonical league key and confirmed year, complete memberships and explicit counts. Required scoring/roster settings and each populated player must be usable by the actual mapper. Missing/empty scoring modifiers and partial player rows fail; explicit zero-player preseason rosters remain valid. Split Yahoo player metadata is normalized so valid populated players are retained. The network path no longer substitutes the computer's current year for absent provider season. Invalid bundles never enter the raw cache; cache reads are also checked against the requested year. Foreign transaction identity is rethrown rather than treated as an optional outage.

Yahoo documents numeric game keys and sport-code aliases in its [Fantasy Sports API guide](https://sports.yahoo.com/developer/docs/). This supports alias resolution, not a claim that these fixtures contacted Yahoo or verified every provider scoring rule.

## Verification

- `node tests/yahoo-league-validation.cjs`: 21 groups pass, including the exact settings/player partial-response findings from independent review.
- `node tests/yahoo-data-context.cjs`: 14 groups pass.
- `node tests/yahoo-browser-binding.cjs`: 14 groups pass.
- `PLAYWRIGHT_MODULE_PATH=/Users/jacobc/Projects/warroom-public-readiness/node_modules/@playwright/test node tests/yahoo-data-browser.cjs`: 2 Chrome fixture cases pass.
- Separate owning Scout integration worktree `/Users/jacobc/Projects/reconai-readiness-yahoo-data-validation`, base `8d6cf54`, synchronized this candidate explicitly: 4 actual handshake/boot integration groups, 3 Chrome handshake cases and Node 20.20.2 Vite build pass.
- No real Yahoo credentials, consent, network data or hosted mutation were used. Independent reviewer `security_boundaries` reran 21 groups and inspected the final zero-length scoring gate. The two original partial-shape findings are resolved; no unresolved material account/league identity or shape finding remains in this bounded delta. Reviewer did not run the two Chrome data cases.

Evidence logs are in `evidence/yahoo-league-validation-{before,after,context,protocol,browser}.log`. The `before` run uses the exact `dac0284:yahoo-api.js` source through the same actual-module harness.

## Release and remaining requirements

Do not use the separate consumer build as a release manifest: its committed shared pin and served-asset manifest intentionally still describe frozen protocol `2ba9248` / Scout `ed259cf`. Parent must merge the reviewed canonical union, pin the exact final revision, rebuild the owning consumer, regenerate and review the asset manifest, deploy/verify that consumer, then allow the provider gate. Existing sessions remain supported; cached old connection clients receive explicit refresh/restart recovery.

Ordinary transaction-provider outages still become empty transaction collections; truthful history availability remains an open follow-up. Actual live provider consent/read/write, hidden public/native new-connection entry policy, physical-device behavior and store evidence remain unproven. No suite or complete Yahoo readiness claim is made.
