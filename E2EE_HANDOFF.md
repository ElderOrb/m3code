# E2EE handoff — end-to-end encrypted remote control

What was built, where it lives, how to verify it, and what the next agent needs
to know before touching it. Companion to `handoff.md` (fork-wide state) — read
both. Everything below landed in commit `f90618b2b3` ("feat: end-to-end
encrypted remote control (transport guard + app-layer E2EE)"); `MIA_CHANGELOG.md`
carries the user-facing summary. `plan.md` (untracked, do not commit) is the
original implementation plan this work followed.

## 0. Orientation

Two opt-in, additive protections for remote control of an M3 Code host. Defaults
are `remoteTransportPolicy: "any"` and `e2eeMode: "off"`, so **the official T3
Code mobile app and every older client keep pairing and working unchanged**.
This is a hard constraint — the `observability` compat key in
`packages/contracts/src/server.ts` exists for the same reason (see `handoff.md`
§2).

1. **Transport guard**: the host can refuse remote connections that do not ride
   a private end-to-end-encrypted transport (loopback/SSH, Tailscale), rejecting
   tunnels (Cloudflare/T3 Connect), public proxies, and plain-LAN peers.
2. **App-layer E2EE**: when a client pinned the server's identity key at pairing,
   the WebSocket RPC stream is encrypted and authenticated end to end, so even a
   Cloudflare tunnel or untrusted network cannot read it.

## 1. File map

| File | What it is |
| --- | --- |
| `packages/shared/src/socketE2ee.ts` | The whole crypto protocol: identity keys, handshake, record framing, socket wrappers. Exported via `@t3tools/shared/socketE2ee` (added to `packages/shared/package.json` exports). |
| `packages/shared/src/socketE2ee.test.ts` | Protocol tests: handshake + round trip, ciphertext opacity, wrong pin, cross-environment transcript, tamper/replay/reorder, plaintext rejection, fresh ephemerals per reconnect. |
| `apps/server/src/auth/transportSecurity.ts` | `classifyRequestTransport` (loopback / tailscale / tunnel / lan-or-proxy) + `transportAllowedByPolicy`. |
| `apps/server/src/auth/transportSecurity.test.ts` | Classification unit tests (the security-relevant core; the ws-level fixture was abandoned, see §6). |
| `apps/server/src/auth/ServerE2eeIdentity.ts` | Service wrapping `ServerSecretStore`: get-or-create the Ed25519 seed (`e2ee-identity-seed-v1`), public key + fingerprint, `rotate()`. |
| `apps/server/src/ws.ts` | `/ws` route gates (policy → E2EE_NOT_SUPPORTED → E2EE_REQUIRED), socket wrap on upgrade, `transportSecurity` in the config snapshot, `layerE2eeCrypto` provided at `Ws.layer`. |
| `apps/server/src/auth/http.ts` | Transport gate inside `layerAuthenticatedAuth` (covers every authenticated environment HTTP request). `serviceOption(ServerSettings)` so narrow test runtimes skip it. |
| `apps/server/src/cloud/CloudLink.ts` | `CloudLinkTransportPolicyError`; guard in `applyRelayConfig`, `startManagedTunnelIfOriginConfirmed`, `reconcileDesiredLinkIfStillDesired`. |
| `apps/server/src/cloud/http.ts` | Maps the new error tag to `EnvironmentHttpForbiddenError` in `connectErrorCases`. **Do not remove** — an unhandled tag there explodes the CLI's inferred requirements (§7). |
| `apps/server/src/startupAccess.ts` | `buildPairingUrl(cs, token, { serverIdentityKey? })` can embed `pk`, but no server caller passes it yet (see §6). |
| `apps/server/src/cli/pair.ts` | `t3 pair` does **not** embed `pk` yet (§6). |
| `packages/contracts/src/settings.ts` | `RemoteTransportPolicy`, `E2eeMode`, `ServerSettings.remoteTransportPolicy` + `e2eeMode`, patch fields (both route to `AuthAccessWriteScope` in `requiredScopesForServerSettingsPatch`). |
| `packages/contracts/src/server.ts` | `TransportSecurity` struct + optional `ServerConfig.transportSecurity`. |
| `packages/shared/src/remote.ts` | `pk` hash-param helpers (`getPairingServerKeyFromUrl`, `setPairingServerKeyOnUrl`); `ResolvedRemotePairingTarget.serverIdentityKey`. |
| `packages/client-runtime/src/connection/catalog.ts` | `BearerConnectionProfile.serverIdentityKey` — the pin, persisted with the registry catalog. |
| `packages/client-runtime/src/connection/onboarding.ts` | Copies `target.serverIdentityKey` into the profile at pairing. |
| `packages/client-runtime/src/connection/model.ts` | `PreparedConnection.e2eeServerIdentityKey`. |
| `packages/client-runtime/src/connection/resolver.ts` | Bearer broker threads the pin from the profile onto the prepared connection. |
| `packages/client-runtime/src/rpc/session.ts` | Connect-time decision tree (§4): `?e2ee=1`, socket wrap, fail-closed errors. |
| `packages/client-runtime/src/connection/presentation.ts` | `connectionSecurityBadge` + `connectionSecurityBadgeText` (badge kinds: `local`, `e2ee-transport`, `e2ee-app`, `tls-tunnel`, `unencrypted`). |
| `apps/web/src/components/settings/SavedEnvironmentRows.tsx` | "Private transports only" + "End-to-end encryption" rows (`TransportSecurityControl` prop), badge text in row subtitles. |
| `apps/web/src/components/settings/ConnectionsSettings.tsx` | Passes `transportSecurity` into `CloudLinkRow`. |
| `apps/web/src/components/settings/pairingUrls.ts`, `ConnectionsSettings.logic.ts` | Pairing-URL builders accept `serverIdentityKey`. |
| `apps/web/src/components/settings/AuthorizedClientsSettings.tsx` | Reads `transportSecurity.identityPublicKey` off the environment config and embeds `pk` into pairing URLs/QR. |
| `apps/mobile/src/features/connection/environmentStatusText.ts` | `connectionSecuritySummaryText` — transport-level badge from the mobile summary. |
| `apps/mobile/src/features/connection/ConnectionEnvironmentRow.tsx` | Appends the badge to the row status. |
| `apps/{web,mobile,desktop}/src/i18n/translations/*` | Generated (`gt generate` per app) + hand-translated keys. |

## 2. Wire protocol (v1)

Negotiated by query param `?e2ee=1` (same pattern as `frameParts=1`). Protocol
version is 1 everywhere; a mismatched version byte fails the handshake.

- **Identity**: Ed25519 seed (32 B) in `ServerSecretStore` as
  `e2ee-identity-seed-v1`. Fingerprint = uppercase hex of the first 8 bytes of
  `SHA-256(pub)`, grouped `XXXX-XXXX-XXXX-XXXX`.
- **ClientHello**: `0xC1 0x01 ‖ 32B X25519 eph pub ‖ 32B nonce`.
- **ServerHello**: `0xC2 0x01 ‖ 32B eph pub ‖ 32B nonce ‖ 32B identity pub ‖
  64B Ed25519 sig ‖ u16 len ‖ environmentId (utf8)`.
- **Transcript**: `SHA-256("m3code-e2ee-v1" ‖ u16be(len) ‖ environmentId ‖
  clientEph ‖ clientNonce ‖ serverEph ‖ serverNonce ‖ identityPub)`. The
  environment id is length-prefixed; the client uses its *expected* id, so a
  cross-environment relay of a valid ServerHello still fails signature
  verification.
- **Keys**: `c2s = HKDF-SHA256(shared, salt=transcript, "m3code-e2ee-v1-c2s")`,
  `s2c` likewise with `-s2c`. Shared = client eph × server eph.
- **Key confirmation**: the client's first record (counter 0) encrypts an empty
  payload under `c2s`; the server requires it to be empty before serving RPC.
- **Records**: binary frames `[0x01][8B BE counter][ct‖16B tag]`. Cipher
  XChaCha20-Poly1305, nonce = 16 zero bytes ‖ counter (BE), AAD =
  `[0x01][direction 0x01 c2s / 0x02 s2c][counter]`. Counters are strictly
  monotonic per direction; any gap, repeat, tag failure, or plaintext frame
  fails the socket. Hard cap at `2^32−1` records (close, reconnect = fresh
  keys). Handshake timeout: 15 s.
- **Error codes on the wire** (HTTP before/during upgrade):
  `REMOTE_TRANSPORT_NOT_ALLOWED` (403, policy), `E2EE_REQUIRED` (403, require
  mode without `e2ee=1` from a non-loopback peer), `E2EE_NOT_SUPPORTED` (403,
  client asked for E2EE the server can't offer). In-band:
  `E2EE_IDENTITY_MISMATCH` (pin vs ServerHello identity) as a `SocketError`
  whose `reason.cause` is the typed error.
- **Cipher choice**: XChaCha20-Poly1305 via Effect's `Aead`
  (`effect/crypto`), which vendors Cure53-audited `@noble/ciphers` 2.4.0 and
  runs pure TS on every surface (Hermes has no `crypto.subtle`). A future
  protocol version can negotiate AES-256-GCM where available.

## 3. Settings & config flow

- `ServerSettings.remoteTransportPolicy` (default `"any"`) and `e2eeMode`
  (default `"off"`). Both are in `ServerSettingsPatch` and count as
  `AuthAccessWriteScope` changes, so the UI switch uses the same permission as
  device approval.
- `ServerConfig.transportSecurity` is assembled in `ws.ts`
  (`layerWsRpc`): the identity descriptor is resolved **once** per layer build
  (`serviceOption` — absent in test fixtures ⇒ field omitted), while
  `remoteTransportPolicy`/`e2eeMode` are read **fresh per snapshot** so setting
  changes propagate.
- Rotation today = stop the server, delete `e2ee-identity-seed-v1` from the
  secrets dir, restart. Pinned clients then fail their next handshake with
  `E2EE_IDENTITY_MISMATCH` until re-paired. (A rotate RPC was built and
  reverted — §7.)

## 4. Client connect decision tree (`rpc/session.ts`)

Pin = `connection.e2eeServerIdentityKey` (base64url from the profile).

- No pin → exactly the old behavior (no `e2ee=1`, no wrap). This is what keeps
  the official mobile app working.
- Pin present, malformed → `ConnectionBlockedError` ("saved key is invalid").
- Pin present → `?e2ee=1` added and the socket wrapped with
  `wrapClientSocketWithE2ee`. The `Aead` service is optional
  (`serviceOption`): absent (runtimes without the crypto layer) ⇒ fail closed
  with a clear "update the app" block, never plaintext. `layerE2eeCrypto`
  (`Aead.layerWebCrypto` + `SecureRandom.layerWebCrypto`) is provided **inside**
  the socket layer, so the factory's requirements stay `never`.
- A server that ignores/refuses `e2ee=1` never completes the handshake → the
  connection fails; combined with the server's explicit `E2EE_NOT_SUPPORTED`
  there is no silent-downgrade path.

Server `/ws` order: orchestration-protocol check → transport-policy gate →
E2EE_NOT_SUPPORTED gate → E2EE_REQUIRED gate → auth → upgrade with the socket
wrapped E2EE-outermost / frame-split-inner (E2EE records are binary, so the
splitter is a no-op on them).

## 5. Verification status

- Typecheck: **0 errors** in contracts, shared, client-runtime, server, web,
  mobile, desktop (remaining known errors are the pre-existing ones listed in
  `handoff.md` §5: `apps/server/src/inference/*`, `advertisedJsonSchema.test.ts`,
  `ProviderSessionManager.ts`, `apps/mobile/src/Stack.tsx`).
- Tests: `socketE2ee.test.ts` 8/8; `transportSecurity.test.ts` 6/6;
  presentation badge tests; session tests 93/93 unchanged; ws compression suite
  unchanged. Pre-existing failures (verified NOT caused by this work by stash
  re-runs): `orchestration-v2/runtimeLayer.test.ts` ×3,
  `src/connection/resolver.test.ts` ×1 ("prepares a primary environment…",
  query-param drift), plus the ones `handoff.md` §5 already listed.
- i18n: `gt generate` run for web, mobile, and desktop;
  `node scripts/i18n-check.ts` passes from any app dir. Note the generator
  re-sorts every catalog, so translation diffs look huge — that is normal.
- Committed: `f90618b2b3` (push with the credential helper one-liner in
  `handoff.md` §5 if asked).

**Not yet verified end to end in a live app** (the plan's manual checklist):
pair a client over `vp run dev --share` with `e2eeMode: "require"`, inspect
DevTools → Network → WS (all post-handshake frames must be opaque binary), and
confirm the official mobile app still pairs under `prefer` + `any`. The server
wrapping path (upgrade transform in `ws.ts`) is only exercised indirectly —
budget a manual pass before trusting `require` mode. Also unverified on real
device hardware: mobile's E2EE handshake needs `crypto.getRandomValues`
(`SecureRandom.layerWebCrypto` inside `layerE2eeCrypto`); Expo SDK 58 is
expected to polyfill it, but no device test ran.

## 6. Known gaps / deferred

- **Wiring bug fixed after first live look:** `ServerE2eeIdentity.layer` was never provided
  in `server.ts`, so the host had no identity key and E2EE was inert (no fingerprint row, no
  `pk`). It is now provided there. Tests could not catch it because they build their own layers.
- **Only web-UI pairing links carry `pk`.** `t3 pair` and the headless `t3 serve` startup URL do
  not, so clients paired that way stay unpinned. The web link omits `pk` while `e2eeMode` is
  `off`: a pin makes the client demand E2EE and the host would refuse it (`E2EE_NOT_SUPPORTED`).

- **Attachment/file HTTP endpoints** are outside the E2EE tunnel; they remain
  protected by the transport only. The plan's preferred fix (stream chunks over
  the WS RPC) was not built.
- **Rotate-key button** and **`require`-mode UI selection** deferred. The UI
  switch only sets `prefer`; turning E2EE off from the UI is allowed but shows a
  warning toast (a pinned client fails to connect until re-paired). `require` = set `e2eeMode: "require"` in `settings.json`.
- **Mobile badge is transport-level only** (summaries carry no route profiles,
  so the `e2ee-app` badge is web/desktop).
- **TOFU**: pins persist only when the pairing link carried `pk`. A client that
  first connects without a pin does not adopt one later.
- **ws-level upgrade test** (403 gates + full E2EE over a real server socket)
  was attempted and abandoned — see §7; the classification and protocol units
  are covered instead.

## 7. Gotchas discovered (Effect 4.1.3 / this repo)

- **The tsgo `any`-requirements cascade.** Adding a requirement to `Ws.layer`'s
  route context, adding an RPC to `WsRpcGroup`, or leaving an unhandled tag in
  `cloud/http.ts`'s `connectErrorCases` map made `binCli.ts` infer the CLI
  program's requirements as `any` (errors `TS377030`/`TS377004` at
  `binCli.ts:134/140` plus every `src/cli/*.test.ts`). Root cause: the CLI
  graph reaches `server.ts` through a dynamic import (`src/cli/server.ts`), so
  any type-level instability in the server's giant layer graph degrades to
  `any`. Fixes that work: satisfy new services **inside** the layer
  (`Layer.provide(layerE2eeCrypto)` at `Ws.layer`), handle every new error tag
  in `connectErrorCases`, and avoid growing `WsRpcGroup` (that's why the rotate
  RPC was reverted).
- **`vpr typecheck` caches per package** — stash bisects gave contradictory
  counts until double runs on the same tree. Never trust a single bisect data
  point; re-run twice.
- **Socket error shapes**: fail with
  `new Socket.SocketError({ reason: new Socket.SocketReadError({ cause }) })`.
  The reason classes are not assignable to the `SocketError` type, and
  `Schema.is` can return false for valid instances (a custom `TaggedError` in
  `cause`), so tests duck-type `_tag`.
- **Handshake/writer lifecycle**: the handshake runs inside the reader
  acquisition (once per connection → fresh ephemerals per reconnect). The
  writer is connection-independent, so each acquisition installs a
  `Deferred` ticket into a `Ref` (succeeded on handshake completion, retired by
  a reader-scope finalizer, failed with the handshake error) and the writer
  awaits the current ticket. Do not "recheck the latest ticket" after awaiting —
  the ref already points at the next connection's ticket and writes hang.
- **Effect 4 API diffs** hit while writing this: no `Effect.catchAll` /
  `Effect.either` / `timeoutFail` / `Ref.setAndCascade` / `Queue.takeAll`
  (that one *waits for the queue to finish* — use `Queue.clear` for a
  non-blocking snapshot). Use `Effect.catchIf(pred, h)` (predicates can't
  clear the error channel — wrap with `Effect.result` + `Result.isSuccess`),
  `Effect.timeout` + `Cause.isTimeoutError`, `Exit.match`, and yield yieldable
  errors directly (`yield* new MyError()` — `Effect.fail` wrapping is a lint
  error). `Schema.is` on `Schema.TaggedError` classes works, but not reliably
  through nested schema-encoded causes.
- **The abandoned ws.test fixture**: providing a mock `ServerSettingsService`
  into the real router build does not reliably win the duplicate-tag resolution
  against `layerConfigSources`' real service, and building a second
  `ServerConfig.layerTest` for the identity store pulls `FileSystem` etc. If
  anyone revives that test, start from the compression-test harness
  (`negotiates compression…`) and provide the policy mock as the **last**
  `Layer.provide`, or set the policy through the real settings service.
- **i18n**: `vp run i18n:generate` only exists per app (`cd apps/web && vp run
  i18n:generate`; `vpx run` is wrong, and there is no root task). The generator
  re-sorts catalogs — expect whole-file diffs.
- Pre-commit hooks and root `vp test`/`vp lint` still fail on this machine for
  environment reasons — commit with `--no-verify`, run per-package
  (`cd <pkg> && ./../../node_modules/.bin/vpr typecheck|test`) with the Node 26
  runtime and `NODE_OPTIONS="--experimental-strip-types"` (see `handoff.md` §5).

## 8. Suggested follow-ups

1. Manual end-to-end pass (§5 checklist) + a device test of mobile E2EE.
2. Rotate-key RPC + UI (needs the `WsRpcGroup` growth problem in §7 solved —
   maybe a separate small group or an HTTP-only endpoint).
3. Route attachment uploads/downloads through the WS (or encrypt HTTP bodies)
   to close the last plaintext gap under `require`.
4. TOFU pin adoption + a "trust new key" re-verify dialog on
   `E2EE_IDENTITY_MISMATCH`.
5. `require`-mode UI selection (cycling Off → Prefer → Require) once pinned
   clients are proven in the wild.
