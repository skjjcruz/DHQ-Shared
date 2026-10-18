# ESPN provider: season and request-boundary correction

Candidate: `codex/readiness-espn-boundaries-20260920`, isolated from actual shared source `dedbb1614f08459905eef27d0f0b7bce27cd4e15`. Only `espn-api.js`, a standalone runtime regression and evidence are changed. No Yahoo, engine, entitlement, backend, provider account or published consumer pin is changed.

## Two reproduced high-severity failures

The independent actual-public ESPN review (`df76964`, report-only `8caf247`) found that the hub's initial validation and final result guard did not cover the canonical provider's second fetch or intermediate private request.

1. A validated 2025 hub league was followed by a 2026 raw provider response. `hydrate()` mapped that response as 2025. The new regression fails on the untouched baseline with “Missing expected rejection.”
2. Hold A's private league fetch; install app account B; resolve A. The old provider called `fetchTransactions` with A's captured ESPN cookies but B's freshly read app token. Its caller discarded the final result but had already sent that request. The exact new regression also fails on the untouched baseline.

[Original failures](evidence/espn-provider-before.log), [corrected actual-provider groups](evidence/espn-provider-after.log).

## Correction

- Every league fetch and every hydrate (including cached input) validates exact raw league ID and season, a named league, nonempty scoring rules/roster-slot settings, unique complete team/roster containers, and supplied team count. Missing/foreign/partial data fails visibly; it cannot be relabeled or published as a successful empty response. Empty player entries remain valid for a genuinely empty/preseason roster.
- Capture app/legacy credential records, the observed transport token, connection keys, session-only ESPN cookies and a storage-event epoch once. The private proxy uses that captured token. Check before requests, after headers and body reads, before transaction follow-up and before return. A changed account, credential, connection or same-byte storage event prevents subsequent work.
- If a modern app session exists, its `sub`, `app_metadata.user_id`, cached user and live finite expiry must agree; a contradictory token getter cannot cause another identity to be used. This is a client consistency check, not server authentication. Existing no-modern-session legacy/private and public direct transport remain supported and tested.
- An optional caller `isCurrent` callback also fences same-account view navigation/unmount. The actual-public `LeagueDetail` passes its load sequence plus the existing ESPN league-context guard to foreground and background hydration.
- Bound fetch plus JSON reads at 20 seconds, with an abort signal and no late write/follow-up. Private-cookie pairs must be complete.
- Reuse raw cache only for the same still-valid scope, app token and explicit cookies. Stale saved credential records cannot override the selected league/season. The legacy mutating connector also checks its captured active-league bridge before applying a result, so a late legacy connect cannot overwrite a newer active league.

The module remains a classic global-attaching script, and provider capabilities/exported API remain compatible. The `ctx.isCurrent` option is optional for older consumers; default request/account boundaries apply even without it.

## Tests and compatibility

`npx --yes --package=node@20.20.2 node tests/espn-provider-boundaries.cjs`: **18 actual-provider groups pass**. No mocking of the provider/request implementation. Coverage includes both original failures, complete/foreign payloads, delayed headers/body, account/token/cookie/connection/storage-epoch changes, view cancellation, transaction-stage identity rejection, same-account private token continuity, timed-out retry, scoped cached raw, legacy bridge preservation, mismatched credentials, modern token/profile mismatch, and legacy/public compatibility.

To replay the two original failures safely:

```sh
ESPN_PROVIDER_SOURCE=/path/to/untouched-dedbb161/espn-api.js \
ESPN_TEST_FILTER='initialReadCannot|privateAccountSwitch' \
node tests/espn-provider-boundaries.cjs
```

Both selected tests fail on the baseline and pass on this candidate. All requests use local fixtures and fake credentials. The filter only selects diagnostic cases; the normal command executes all 18 groups.

Actual public caller integration in `warroom-readiness-public-espn` additionally passes **16 source groups**, including the actual `loadLeagueDetails` function with this real provider for valid, wrong-season, account-switch and closed-view cases. Valid selection completes; rejected continuations make no transaction request or hydration publication. The existing browser hub suite passes **320×740, 390×844 and 844×390**; the browser's LeagueDetail component is still a handoff fixture. Existing public **198 tests** and preview build pass against explicit candidate shared bytes. Shared-source ESLint via the public browser configuration passes; the public caller retains one preexisting unused-function warning.

## Remaining boundaries and release

No release, live/provider mutation, purchase or account setup occurred. Independent root review remains the final source gate before the candidate is frozen.

The original hub patch can be integrated separately as a bounded recovery improvement while downstream high-severity findings remain open. Closing these two provider findings requires the corrected shared bytes in the consumer build. The optional lifecycle callback alone cannot stop the old provider's follow-up. Coordinate shared integration and the public caller commit; do not advance consumer pins before the canonical candidate is reviewed and published through its established owner process.

This is not full ESPN readiness. Real supported historical/private-provider payloads and complete LeagueDetail rendering/engine flows still require evidence. Generic transaction-provider failure currently retains the preexisting catch-and-empty behavior and is **not** cleared as truthful missing-data handling by this batch. Broad ownership/migration of legacy profile/provider records and downstream intel/tag/docs/tutorial async work remain open as documented in the public candidate. No unknown old cookie/profile record is assigned to a new owner by this correction.
