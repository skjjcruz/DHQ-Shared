# Scout Yahoo state and confirmed transaction data

Candidate branch: codex/readiness-yahoo-scout-20260920. Base: b104ce4, following root's reviewed Yahoo feed producer (root union 2aee3a8). Canonical actual owning repository: skjjcruz/DHQ-Shared. No deployment, pin, provider source or release manifest change.

## Reproduced issue and correction

Scout's active legacy `Yahoo.connectLeague` populated `S.transactions = {}` even when validated hydration could return completed Yahoo trades. Its old duplicated mapping path did not carry transaction availability. The exact b104ce4 module fails all five new state groups; the corrected module passes five.

The legacy entry now delegates to the same validated provider hydration and publishes its transactions/status. A private WeakMap ties the published S object to its original account, provider session, selected league/year and connection generation. `isStateCurrent` and `captureStateContext` expose only opaque booleans. A copied/restored S cannot claim a confirmed live scope. The captured guard remains invalid after supersession; an old retry cannot overwrite a later successful reconnect even when the account, S object and league IDs are unchanged.

Validated transaction player metadata is retained alongside the scoped last-good feed, so historical assets absent from current rosters have their supplied names. Current roster metadata retains precedence. Account/provider cache invalidation applies to both trade rows and these names; no player identity, score or week is invented.

## Verification

- `node tests/yahoo-scout-state.cjs`: 5 groups pass (same harness against b104ce4: 0 pass, 5 fail).
- Existing Yahoo transaction 18, account/caller context 14, league/shape validation 21 and browser-binding protocol 14 groups pass.
- Existing ESPN transaction 18 groups pass unchanged.
- Actual Scout consumer integration and 320/390/844 Chrome recovery are recorded in the separate ReconAI candidate report `scout-yahoo-transactions-20260920.md`.
- Logs: `evidence/yahoo-scout/`. An initial mistyped validation command named a nonexistent file; corrected `yahoo-league-validation.cjs` passed all 21 groups. The missing-file result is not counted as validation.

## Release dependency and limits

This is a source proposal requiring independent review and integration with the final canonical shared union. Scout's separate client candidate must consume the exact final reviewed revision. Its existing provider release guard must be regenerated only after final pin/build review, then confirm the exact consumer assets are actually served before any provider cutover. This local work used an explicit source override, not a published revision.

No real Yahoo credentials or consent are available. Live provider pagination/completeness and authorized real trade history remain unverified; this feed covers confirmed completed player trades, not add/drop/waiver history, historical valuation, or draft-pick detail. No native install/device/store evidence is claimed.
