# Yahoo completed trade availability and recovery

Status: bounded canonical source candidate on `f72c8e4`, not deployed. Paired actual-public consumer is in `/Users/jacobc/Projects/warroom-readiness-public-yahoo-transactions` from `a980bfc`. No protocol, provider release gate, consumer pin or hosted state changed.

## Reproduction and resolution

The previous provider swallowed a failed transaction request and returned `{}` with no availability metadata. A prior successful feed was lost on the next outage. The old mapper also treated a transaction key suffix as an NFL week, grouped the entire history under the current week, and produced side arrays that did not meet the shared received-asset contract.

The provider now emits the existing ESPN `executed_trades` contract: `ready`, `stale` or `unavailable`, with provider, exact league/year, checked/last-confirmed timestamps and excluded record count. Successful responses validate explicit collection counts, transaction IDs, completion states, timestamps, player movements, team memberships and player-game identity before mapping. Only successful trades enter completed history. Pending or other unconfirmed trade states are explicitly excluded; an unexpected non-trade type or incomplete shape is unavailable. Foreign league/year/game data still rejects the whole hydration through the previously reviewed identity gate.

A memory-only cache preserves confirmed rows, including a confirmed empty feed, for the same account, app token/generation, Yahoo session, league and year. A failure labels those rows stale; a verified empty retry can replace them. Mounted caller closures do not own that retained cache. The new `provider.captureContext(league)` lets the mounted consumer retain an account/session/selection boundary for retry and permanently retires it after an observed mismatch.

Mapped trades expose namespaced/crosswalk player IDs, keyed received sides, adds/drops, roster IDs and provider timestamps. The unknown NFL week is `0`, rather than an invented transaction-ID/current-week mapping. The [Yahoo API documentation](https://sports.yahoo.com/developer/docs/) defines completed transaction keys, trade filtering, completion status, timestamps and source/destination team keys; it does not establish an NFL scoring week from a transaction ID. No actual private Yahoo request was made.

## Verification

- `node tests/yahoo-transactions.cjs`: **18 groups pass**. Exact `f72c8e4:yahoo-api.js` through the same harness: **1 pass / 17 fail**. Includes first outage, prior-good retention, verified-empty recovery, non-complete exclusions, malformed/incomplete/foreign responses, account/session/generation/league/year boundaries, replaced mounted caller, late failed responses, body/transport deadlines and retry.
- Existing Yahoo data-context **14**, response-validation **21**, browser-proof protocol **14** groups pass. The one prior snapshot equality assertion now excludes fresh status timestamps while preserving all mapped data comparisons; the old optional-outage assertion now explicitly requires unavailable status.
- Existing ESPN transaction **18** groups pass unchanged.
- Parent/public candidate executes this actual provider with actual publication/retry/ticker/detail code in Chrome at320×740,390×844,844×390; availability/retry/account-change cases pass. Those fixtures and full public build results belong to the consumer report.
- `node --check yahoo-api.js`, `git diff --check` pass. Logs: `evidence/yahoo-transactions/`.
- Independent review requested from parent; pending at this commit.

## Exact remaining scope

This is completed player-trade history, not adds/drops/waivers, pending trade actions, draft-pick trading or evidence of every historical provider record. Credentials and real ordinary Yahoo transactions are unavailable, so live provider validation remains blocked. No physical device, native build, public release or provider cutover is claimed.

Active Scout still uses legacy `Yahoo.connectLeague` in `js/app.js` at its connect/reconnect paths; that method currently assigns `S.transactions={}`. Scout `js/ui.js`, `js/trade-calc.js` and other transaction consumers require a separate authorized adaptation next. The actual-public Trade Center has its own historical path, outside this ticker/recovery pair. Other transaction-dependent AI/assessment/FAAB calculations and native/public source ports are not certified here.

Next: resolve independent findings; integrate reviewed canonical union and paired public consumer; then adapt the isolated Scout legacy path. Keep the initiating-tab Yahoo protocol and served-asset deployment gate intact. Final shared revision, consumer build and gate manifest must be regenerated/reviewed together later, never inferred from these explicit local source overrides.
