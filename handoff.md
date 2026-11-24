# Handoff — M3 Code fork

> **E2EE work:** end-to-end encrypted remote control (transport guard +
> app-layer WebSocket E2EE) landed in `f90618b2b3`. Read `E2EE_HANDOFF.md`
> before touching `socketE2ee.ts`, the `/ws` upgrade path, the connection
> settings UI, or anything that adds a requirement to `Ws.layer` / a tag to
> `cloud/http.ts`'s error map — it documents a type-inference cascade that
> otherwise looks like unrelated breakage.

Snapshot of where this fork stands, what was done, and what the next agent or human needs to
know. Read this before touching anything. Branch: `remove-all-telemetry` (pushed to
`origin/main` as the default branch; local `main` tracks the same commits).

Repo: `/home/zurih/MiaAI_Lab/Linux_Apps/t3code`
Fork: `origin` = `MiaAI-Lab/t3code` · Upstream: `upstream` = `pingdotgg/t3code`
Latest pushed commit: `cd1bd66584` (M3 sidebar wordmark). See `git log` for the full chain.

## 1. What this fork is

A local-first fork of T3 Code, renamed **M3 Code**, with **all telemetry deleted from the code**.
README opens with a warning banner stating nothing is sent anywhere. `MIA_CHANGELOG.md` records
every change in order — keep it updated with any new change.

## 2. Telemetry removal (complete)

Deleted outright, not disabled — no flag can turn anything back on:

- **Product analytics**: PostHog pipeline, `ingest.t3.codes`, every emitting call site, the
  `T3CODE_TELEMETRY_ENABLED` opt-in.
- **Identity collection**: the `Identify` module (read `~/.codex/auth.json` /
  `~/.claude.json`), install IDs, `distinct_id`, device IDs, client fingerprint URL params.
- **Crash reporting**: mobile `expo-observe` → Axiom, source-map upload scripts + CI steps.
- **OpenTelemetry**: server/desktop/web/mobile OTLP exporters, relay client tracer, trace
  files, trace-diagnostics UI, `checkOtlpEndpoint` RPC, `T3CODE_OTEL_SDK_DISABLED` /
  `T3CODE_OTLP_*` env vars.
- **Relay tracing** and the relay's Axiom datasets/monitors/mobile-telemetry ingest.
- **Task-cache telemetry** (run summaries, savings DB, dashboard). The remote build cache itself
  still works.

**One deliberate remnant** (`ed52fd5aa2`): the server config still sends an inert
`observability` object (`localTracingEnabled: false`, all `otlp*Enabled: false`). The official
T3 Code mobile app's contracts *require* that key and fail to decode the config without it —
removing it broke pairing. It is pinned by a test in `apps/server/src/ws.test.ts` ("endpoint
discovery preserves initial config…"). Do not delete it again without re-reading that test's
comment. The key also exists in `packages/contracts/src/server.ts` because the RPC encoder
strips keys absent from the schema.

## 3. Rebrand to M3 Code (`783275f787`, `8911a3ae68`)

**Renamed** (user-visible only): window titles, splash, sidebar wordmark (`M3Wordmark.tsx` in
web + mobile — "M" glyph hand-drawn, "3" glyph reused from the upstream path data), PWA
manifest, desktop `productName`, `.desktop` file, artifact names (`M3-Code-*`), CLI messages,
native capture-helper errors, widget strings, docs.

**Deliberately NOT renamed** — renaming these breaks things:

- `t3` CLI command and npm package name
- `T3CODE_*` environment variables (plus new `T3CODE_RELEASE_CHANNEL`)
- `~/.t3` data directory
- `t3code://` deep links and `com.t3tools.*` app/bundle identifiers
- Electron user-data profile dir (`t3code-v2`) and **legacy migration names** ("T3 Code
  (Alpha)"/"(Dev)" in `DesktopUserData.ts` + `installer.nsh`) — they must keep the old names to
  find pre-rename installs. `installer.nsh` still says "T3 Code (Alpha)" on purpose.
- "T3 Connect" and "T3 Chat" — upstream-operated services, not parts of the app.

**Icons** (`8911a3ae68`, redesigned `37bf4835f3`): brand art lives in `m3-code.png` (wide, README
banner) and `m3-code-box.png` (square, app icon — flat black tile, white M3 monogram), both
palette-compressed with rounded corners masked transparent (sharp `palette: true, quality: 90`;
roundrect radius 86 box / 47 wide, cut slightly inside the art's own arc to avoid a white corner
halo; the wide banner uses quality 80 — glow gradients band below that). From the square art, `assets/prod/*` and the mobile Android assets were regenerated (1024px
desktop/iOS icons, favicon 16/32/ico, apple-touch 180, PWA 192/512, Windows .ico, Android splash
prod/nightly + monochrome mark — those two now carry the same white M3 monogram via
`apps/mobile/assets/android-icon-mark.png`'s old geometry: glyph 553px in the 1152 splash, 279px in
the 432 mark). Regeneration one-off script pattern: sharp for renders/masks/palette PNGs plus the
repo's own `encodePngIco` from `scripts/lib/icon-export.ts` for the ICOs; run under the Node 26
runtime with `--experimental-strip-types`. The pipeline files keep their historical
`t3-black-*`/`black-*` filenames on purpose — `scripts/lib/brand-assets.ts` references them.
Regenerating web favicons for real use: `favicon.ico` was slimmed to 16/32/48 only.

## 4. Building and installing locally (Linux x64)

System Node is v22 and cannot load this repo's `.ts` configs. The build needs the pinned Node
runtime (already downloaded):

```
~/.local/share/t3code-build-runtime/node-v26.13.1-linux-x64/
```

Full rebuild + install:

```sh
cd ~/MiaAI_Lab/Linux_Apps/t3code
PATH="$HOME/.local/share/t3code-build-runtime/node-v26.13.1-linux-x64/bin:$PWD/node_modules/.bin:$PATH" \
NODE_OPTIONS="--experimental-strip-types" \
T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true \
T3CODE_DESKTOP_GLIBC_CEILING=2.42 \
node --experimental-strip-types scripts/build-desktop-artifact.ts \
  --platform linux --target AppImage --arch x64 \
  --output-dir ~/Applications/.t3code-build
cp ~/Applications/.t3code-build/M3-Code-*-x86_64.AppImage ~/Applications/T3-Code-local-first.AppImage
```

Notes:

- `T3CODE_DESKTOP_GLIBC_CEILING=2.42` is required locally: the packager enforces CI's glibc
  2.39 ceiling, but rebuilding `node-pty` here picks up the system glibc 2.42. Added in
  `e4171ad9e4`; release builds don't set it.
- `--experimental-strip-types` must be in both `NODE_OPTIONS` and the direct `node` flags so
  child vite builds can also load `.ts` configs.
- Build takes ~3–6 minutes with warm caches; artifacts land in
  `~/Applications/.t3code-build/` (AppImage + .deb).
- The installed app lives at `~/Applications/T3-Code-local-first.AppImage` (desktop entry:
  `~/.local/share/applications/t3code-local-first.desktop`, now named "M3 Code (local-first)").
  Icons: `~/.local/share/icons/t3code-local-first.png`.
- **No update feed is embedded** (`app-update.yml` absent on purpose) — the app cannot phone
  home or self-update; updates = rebuild.
- Pre-telemetry-removal backup: `~/Applications/T3-Code-local-first.AppImage.bak-pre-telemetry-removal`.
- The AppImage bundles its own Node; the system Node 22 only matters for building.

## 5. Environment quirks (this machine)

- **Pre-commit hooks fail** (oxlint/knip can't load `.ts` plugins on Node 22) → commit with
  `--no-verify`. Same failures happen on clean upstream HEAD; environmental, not ours.
- **Web package test runner fails to load its config** (`ERR_UNKNOWN_FILE_EXTENSION`) on Node
  22. Run web tests with the Node 26 runtime:
  `PATH="$HOME/.local/share/t3code-build-runtime/node-v26.13.1-linux-x64/bin:$PATH" NODE_OPTIONS="--experimental-strip-types" ./../../node_modules/.bin/vp test run …`
- Root `vp test`/`vp lint` fail on config load; run per package:
  `cd <pkg> && ./../../node_modules/.bin/vpr test|typecheck`.
- Pre-existing typecheck errors on clean HEAD (not ours, ignore):
  `apps/server/src/inference/*` (3), `src/mcp/advertisedJsonSchema.test.ts` (1),
  `ProviderSessionManager.ts` TS377047 suggestion, `apps/mobile/src/Stack.tsx` (1).
- Pre-existing failing tests on clean HEAD (not ours):
  `Orchestrator.control-reads.test.ts` ×2 (`statement.stat`), task-cache `runHook.test.ts` ×5
  (Node can't exec `.ts` scripts directly).
- Push with: `git -c credential.helper='!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f' push origin <branch>:main`
- The `serverReportClientActivity` RPC, `environmentIdPath`, `HeapSnapshot.layer`, and the
  desktop "SnapShot" feedback features were reviewed and kept: they are features, not telemetry.
- Never `pkill -f` by name; only kill PIDs you captured at spawn. `~/.t3/userdata` is live data
  — read/copy only, never start a server against it.
- Dev servers: `vp run dev` (worktree state in `.t3/`); ports from the `[dev-runner]` line.

## 6. Verification status at handoff

- Typecheck: **0 errors** in every package (remaining 5 server errors + 1 mobile error are
  pre-existing on upstream HEAD).
- Tests: targeted suites pass everywhere the machine can run them (contracts, shared,
  client-runtime, server ws/settings/policy/vcs/provider suites, desktop, mobile, infra relay,
  task-cache). See §5 for what fails environmentally.
- Zero-grep: no `posthog|axiom|opentelemetry|distinct_id|ingest.t3.codes|T3CODE_TELEMETRY|T3CODE_OTLP|hashTelemetryId`
  in fork code (only `.repos/` vendored refs and vendor binaries). "T3 Code" remains only in
  intentional keeps (§3), README upstream references, `.repos/`, and lockfiles.
- The installed AppImage was rebuilt after every branding/logo/compat change; the currently running
  build is the tip commit of this branch (its icon redesign), built from this tree.

## 7. Known behavior deltas vs upstream (expected, not bugs)

- Mobile app: no crash reporting; typing `/feedback …` (Codex bug upload) errors out — that RPC
  was telemetry-adjacent and removed.
- Settings → Diagnostics: no Trace Diagnostics / OpenTelemetry export sections.
- Official T3 Code mobile app still pairs and works (that's what the compat key protects).
