# ESPN transaction-feed truthfulness — 2026-09-20

Status: local bounded candidate, pending independent review and coordinated shared/consumer release. Based on reviewed account/season-boundary commit `d45b5f5`; the canonical pin is unchanged. No provider credentials, real league data, remote mutations, push or deployment were used.

## Failure and correction

The provider converted failed or malformed `mTransactions2` reads into an empty transaction map. Consumers could overwrite a previously confirmed feed and treat missing information as no trades. The existing ESPN trade mapper also emitted only `sides` and `timestamp` with raw numeric player IDs, while the actual ticker expects roster IDs, add/drop ownership maps and its player dictionary IDs.

The hydrated result now includes optional `transactionStatus` with exact provider, league and season, `scope: executed_trades`, `status: ready | stale | unavailable`, attempt and last-success timestamps. A confirmed empty feed is `ready`; an outage is never a confirmed zero. A memory-only cache retains last confirmed rows, including an explicitly empty prior response, only for the same account, credential context and league/season. It survives ordinary same-account view reloads without retaining an invalid old caller closure; cross-account/credential/storage-boundary changes invalidate it. Failed/late replies cannot replace newer confirmed data. Cached rows are cloned so consumer mutation cannot poison later recovery.

Malformed feed envelopes or malformed trade participants/assets fail into the unavailable/stale path. Supplied raw league/season identifiers must match; the established endpoint's optional absence of those fields is not promoted to an independent provider-identity proof. The existing `topics` trade contract is preserved. Other topic types remain filtered by the existing trade-only mapper; no claim of complete adds/drops/waivers or complete historical-provider coverage is made.

The mapper adds Sleeper-compatible `roster_ids`, `adds`, `drops`, `created` and `status_updated` while retaining `timestamp` and correcting `sides` to roster-keyed received `{players, picks}` objects, matching the shared engine and Trade Center helper contract. Player IDs use the existing crosswalk or explicit `espn_` namespace; supplied scoring periods determine buckets instead of assigning every historical trade to the current NFL week. No scores, trade events, dates or players are invented. Missing empty add/drop lists remain supported; malformed or wholly unmappable trade content cannot become a blank success row.

## Independent-review corrections

Root found that non-executed trades were still mapped as `pending` but the actual ticker displayed them as occurred activity. The feed now explicitly includes only ESPN status `EXECUTED`; pending, rejected and unknown statuses return no history row. `excludedTradeCount` is preserved with confirmed cached rows and the consumer explains the exclusion. A missing/blank status fails the feed instead of pretending completion. This is a completed-trade history contract, not a pending-offer interface. Other topic types remain outside its established scope.

Root also found the old array `sides` incompatible with `tradeSideReceivedAssets`. The keyed received-side correction is verified by executing that actual consumer helper and its sent-side counterpart with the actual mapper output. The Trade Center's current Trade Log source is separately `App.LI.tradeHistory` or `WrTxns.fetchLeagueTxns` (Sleeper); it does not yet consume the provider's `S.transactions`. The shared engine's non-Sleeper cold path starts trade history empty. Consequently this mapper correction is necessary compatibility evidence, not proof that ESPN Trade Log integration is complete.

## Verification

- `node tests/espn-transactions.cjs`: **18 actual-provider groups** pass. [Log](evidence/espn-transactions/provider.log).
- Against exact original `d45b5f5` producer bytes, the same suite records **17 failures / 1 existing account-guard pass**, reproducing the empty-success and missing normalized-field behavior. [Before](evidence/espn-transactions/before.log).
- `node tests/espn-provider-boundaries.cjs`: **18 prior account/season/cache/transport groups** still pass. [Log](evidence/espn-transactions/boundaries.log). The fixture exports are reusable; its normal CLI still runs every prior group and no assertions were removed.
- Cases include first outage, confirmed empty, malformed/foreign envelope, valid retry, stale retention/timestamps, account/cookie/season isolation, same-account view recreation, late failure/body timeout, mutation resistance, mapper ownership and namespaced IDs, and omitted-empty-list compatibility.
- ESLint through the actual public config reports no shared-source warnings/errors. [Log](evidence/espn-transactions/lint.log). `git diff --check` passes.

## Consumer coordination and remaining limits

The paired actual-public candidate carries these flags to the current league and dashboard, presents truthful retry/stale/empty states, omits untagged legacy global history from ESPN feed publication, and preserves the distinction in background-sync outcome. Its detailed evidence is in the consumer report. Publishing only this shared change does not prove old consumers interpret uncertainty correctly; publishing only the consumer treats old producer metadata as unavailable.

Real ESPN authenticated/public feeds and historical API completeness are not verified here. Broader advice/AI/history consumers that infer behavior from transaction counts still need their own completeness audit; the new flag is not a claim that every reader honors it. Yahoo/MFL transaction outage behavior is separate. Canonical integration, exact served-byte verification, actual frontend release access and post-release provider journeys remain required. Independent review: root reran the initial provider, boundary and caller suites and raised the two issues above. Corrections are implemented with explicit regressions; final root spot-review remains pending.
