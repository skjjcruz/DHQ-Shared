# Yahoo initiating-browser proof — owning shared proposal

Source: actual skjjcruz/DHQ-Shared baseline dedbb1614f08459905eef27d0f0b7bce27cd4e15. Isolated branch codex/readiness-yahoo-browser-binding-20260920. This changes only yahoo-api.js and its focused regression harness. Capital and ESPN candidates remain separate and must be merged before choosing a final consumer pin.

## Finding and correction

Root reproduced a transferred unused proxy start URL at provider candidate 5d4bed8/b1aaddc: another browser acquired its cookie and completed fixture consent, causing one token exchange and storage under the initiating app account. This proves an owner/browser mismatch. It does **not** prove the attacker obtained the random resulting session ID or that real Yahoo consent was exercised.

The browser now saves a random 256-bit verifier in tab session storage before any request. Only its SHA-256 challenge is sent with an authenticated initiation request. The provider callback only relays a short-lived authorization code and state in an app URL fragment; it does not exchange or store provider tokens. The actual Scout index first-inline-head script removes the fragment before assets/actions. The shared helper completes with the saved verifier, exact recorded origin/path/query, and the same account/version. The proxy consumes one matching state/account/version/return URL/challenge before exchange. Client response checks also stop account-switch writes. The hash is a browser-to-proxy proof; this is **not** a claim that Yahoo implements provider PKCE.

Completion requests are bounded to 20 seconds including response body reads and are never automatically replayed. An uncertain completion or failed browser save offers a fresh connection instead of claiming success. Existing saved Yahoo sessions and provider APIs remain supported; existing legacy signed Sleeper owner support remains, without app session-version revocation parity.

## Required coordinated consumer

ReconAI-sandbox-dev owning proposal (reconai-readiness-actual-proxies): index.html captures/scrubs callback before assets; js/app.js calls/awaits Yahoo.handleCallback before any league fetch and reports failure. The shared module alone is insufficient. Its build must vendor the exact reviewed canonical revision. Public/native dashboards and C2 WarRoom currently contain hidden Yahoo new-connect placeholders and no startAuth/handleCallback callers; their gates are unchanged. Restoring a promised public Yahoo entry flow remains separate product work.

New helper + old proxy deliberately rejects the absent v2 response before navigation. Old helper + new proxy receives explicit refresh/restart errors. Old pending cookie flows cannot be resumed under v2. Deploy and verify the consumer first, then the proxy, and verify both served revisions; cached clients must refresh. Do not restore the insecure callback path as a rollback. Neither source proposal was pushed or deployed by this agent.

## Verification

`node tests/yahoo-browser-binding.cjs`: 14 actual-module groups pass, covering proof confinement, storage denial, token/profile mismatch, duplicate start, delayed account switch, unsupported protocol/URL, reload, another browser, wrong state/version/path, denial, late completion, storage events, save failure, timeout, and existing sessions.

Owning ReconAI adds actual client+handler integration, executable actual Scout boot-order/error tests, and Chrome fixture contexts. Those evidence levels are recorded in its yahoo-initiation-binding-20260920.md. No real Yahoo credentials, provider consent, hosted source change, device, or store evidence is claimed. Independent correction review is pending.

Security reference: RFC 9700 sections 2.1.1 and 4.7 require transaction-specific user-agent binding and warn against assuming PKCE support: https://www.rfc-editor.org/rfc/rfc9700.html
