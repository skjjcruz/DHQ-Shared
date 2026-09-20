# Shared session and profile lifecycle

Status: isolated canonical source candidate. No deployment, consumer pin, workflow or hosted state changed. Base is actual owning `skjjcruz/DHQ-Shared` revision `dedbb1614f08459905eef27d0f0b7bce27cd4e15`; branch `codex/readiness-shared-session-lifecycle-20260920`.

## Reproduced failures and resolution

Root executed the full baseline module with deferred local responses: A's refresh 401 deleted subsequently installed B; refresh 200 replaced B with A; A's late profile 401 deleted B. These are high-severity account continuity failures. Exact baseline evidence is `evidence/session-root-reproduction-before.json`. The expanded actual-module regression harness fails 28 of 32 groups on that same baseline and passes all 32 on this candidate.

Refresh and profile operations now capture the modern and legacy session bytes plus observed account generation. Every asynchronous clear, persistence and result publication checks that captured context. A refresh response must retain the original app owner and session version; its user/tier/products must agree with its returned token. Profile reads require the matching user and explicit server entitlement fields. Invalid or incomplete modern storage never falls through into a legacy account. A revoked/expired current modern session clears the older legacy fallback too. Valid token-only old app records can still recover their missing user through the real refresh endpoint.

A 20-second deadline covers both transport and JSON bodies. In-flight refresh work is shared only for the same context and released on completion, so an outage can be retried in the same page. A still-valid same-account session is preserved on network/storage failure; no refreshed token or free entitlement is invented.

Sign-out clears captured browser keys synchronously, retires the cached SDK client and performs only a bounded REST logout with the captured provider token. It never calls asynchronous persistent SDK signOut, whose later cleanup could erase another account. A newly signed-in account suppresses the old operation's reload. The result distinguishes local completion from unconfirmed provider logout.

The SDK receives a guarded auth-storage adapter. Pending work from a retired client cannot restore or erase newer provider state. Independent review found that a provider A→B→A sequence could revive the adapter after it had observed replacement; invalidation is now sticky. Stale adapter writes are ignored rather than thrown: actual SDK testing exposed an internal unhandled recovery rejection with a throwing adapter. Normal provider persistence remains supported. Every general SDK request gets an explicit validated app/legacy Authorization header or the anonymous key, preventing fallback to a stored provider B when modern A is malformed or expired. Explicit OAuth methods still work.

## Verification and independent review

- `node tests/session-lifecycle.cjs`: **32 pass**; exact untouched baseline: **4 pass / 28 fail**. Includes the root three races, late bodies, observed generation changes, normal same-account deduplication, token-only recovery, claims/version/entitlement contradictions, current revocation, malformed modern records, body/transport deadlines, retries, quota failure, profile shape and account checks, signed legacy continuity, SDK persistence and sign-out races.
- `node tests/session-issuer-compatibility.cjs`: **2 groups pass**, executing actual native owning `aa13193` app JWT minter and full legacy get-session-token handler with real local jose signing and mocked DB/rate-limit boundaries. Confirms app subject/user_id/session_version, legacy subject/sleeper_username/expiry, and no malformed-modern fallback. This is not a server authentication or hosted revocation test.
- `node tests/session-lifecycle-browser.cjs` with the documented environment below: **7 Chrome fixture cases pass**, at 320px, using the actual public owner's pinned Supabase SDK **2.101.1**. Includes actual SDK setSession persistence and a delayed actual SDK refresh response after account replacement. Four invalid-modern variants send the anonymous Authorization header despite a valid stored provider B. No unexpected network requests or unhandled page errors.
- Actual Scout owning baseline `78294c8`, isolated `/Users/jacobc/Projects/reconai-readiness-session-validation`: explicit synchronization from this shared candidate followed by Node **20.20.2** Vite build passes. This is compilation evidence only; its consumer pin was not changed.
- `node --check supabase-client.js` and `git diff --check` pass.
- Independent security reviewer ran the earlier 31 full-module and 6 actual-SDK Chrome groups, found the sticky adapter issue, and confirmed that no-op persistence is appropriate. Root owns final review of the complete corrected candidate; final disposition remains pending in this commit.

The source uses the SDK's documented [custom storage interface](https://supabase.com/docs/reference/javascript/auth) and [stopAutoRefresh](https://supabase.com/docs/reference/javascript/auth-stopautorefresh). Stopping a timer alone cannot cancel a pending SDK write; the captured storage boundary is therefore necessary.

## Reproduction commands

Runtime dependencies for the issuer fixture are read from `SESSION_TEST_MODULES` (default the existing isolated ReconAI proxy worktree node_modules). `SESSION_ISSUER_SOURCE` defaults to the read-only actual-native snapshot. No dependency files are edited. Browser tooling is the existing Playwright installation:

```sh
curl --fail --silent --show-error --max-time 30 https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.101.1/dist/umd/supabase.min.js -o /tmp/readiness-supabase-2.101.1.js
PLAYWRIGHT_MODULE_PATH=/Users/jacobc/Projects/warroom-public-readiness/node_modules/@playwright/test node tests/session-lifecycle-browser.cjs
```

The browser fixture verifies SDK SHA-256 `7d4690230324f312db08a0bb7e0d31e04c2ab8d46306c08eb3dabf6aefaeeacd`. All auth, provider, DB and profile responses in browser tests are local fixtures; unknown requests abort. Browser evidence is SDK/module behavior, not a completed production user journey or physical-device/native build.

## Release and remaining scope

Merge the reviewed canonical source through its owning repository, then pin and build each intended consumer before deployment. This branch intentionally contains no Yahoo, ESPN, capital, consumer or workflow changes; parent must integrate the final shared union. No backend migration is required for the issuer contracts tested here.

Other shared data APIs and external callers holding SDK references still require their own request/publication boundaries. This candidate does not claim every cloud save, tutorial, analytics or provider consumer has been audited. The sign-out return/event accurately distinguishes unconfirmed provider logout; existing consumer UI may need to surface that diagnostic. Browser storage offers no atomic cross-tab compare-and-swap; checks protect observed changes before synchronous publication, not a transactional guarantee across arbitrary independent writers. Hosted authentication, provider logout, physical-device behavior and a final integrated consumer release are not proven by this candidate.
