# Development and technical notes

[Back to VelumCode](../README.md)

Run the commands below from the repository root.

## Prerequisites

- Node.js 24 + npm (the tested version is pinned in `.node-version`)
- Rust via rustup + MSVC build tools (the tested toolchain is pinned in `rust-toolchain.toml`)
- At least one supported CLI: `claude`, `bonsai` ([Bonsai 2 local GPU](bonsai.md)), `codex`, `agy`, or `muse`

## Develop

```sh
git clone https://github.com/velumix/VelumCode.git
cd VelumCode
npm ci
npm run tauri dev
```

## Install / uninstall

```powershell
.\scripts\install.ps1 -Build            # release build + silent install
.\scripts\install.ps1 -Build -Launch    # ...and launch it
.\scripts\install.ps1 -Uninstall         # silent uninstall
```

The installer is a custom NSIS bundle (`src-tauri/nsis/`): branded
welcome/finish pages, custom header/sidebar art, plus a post-install check
that migrates the previous default Muse Code installation and registers native notifications.

For signed publisher builds, use `scripts/build-release.ps1`. It produces the
installer, signature and `latest.json` updater feed under `artifacts/release`.
For a preview without signing secrets, use:

```powershell
npx.cmd tauri build --bundles nsis --config src-tauri/tauri.preview.conf.json
```

> Use `npx.cmd tauri build` (not raw `cargo build --release`) when building standalone `.exe` binaries so `tauri/custom-protocol` embeds `dist/` cleanly instead of connecting to `localhost:1420`.

See [App updates](updates.md) for GitHub release automation and the first updater
installation.

Brand exports are generated from the saved transparent master with
`.\scripts\make-assets.ps1` (UI mark, favicon, platform icons, and NSIS artwork).
See [the brand notes](brand.md) for the master asset, generation prompt, and export process.

The [Windows CI workflow](https://github.com/velumix/VelumCode/actions/workflows/windows.yml)
runs the frontend, browser, Rust, formatting, and Clippy checks, then builds an NSIS installer.
Open a successful workflow run and download **VelumCode-windows-x64** under Artifacts. These
are unsigned development builds. Native tray/notification smoke tests require an interactive
Windows desktop and are run locally using the commands below.

## Shortcuts

- `Ctrl+T` new session, `Ctrl+Tab` / `Ctrl+Shift+Tab` switch sessions
- `Enter` send chat message, `Shift+Enter` newline, `Stop` interrupts the turn
- Agent/Terminal toggle in the conversation header
- `Ctrl+K` command palette, `Ctrl+L` focus message input, `Ctrl+1`–`Ctrl+9` jump to a tab
- `Ctrl+,` settings: themes, glass, layout, typography, terminal, and conversation preferences
- Arrow keys / Home / End move between focused session tabs; Delete closes the focused tab
- `Ctrl+F` find in terminal, `Enter` / `Shift+Enter` next/previous match
- `Ctrl+=` / `Ctrl+-` / `Ctrl+0` terminal zoom in/out/reset
- Standard / YOLO toggle inside the composer controls YOLO (`--yolo`: no approvals/sandbox) for that tab's turns

See [appearance and customization](appearance.md) for the settings controls and profile format. The default Enter shortcut can be changed in Settings; Ctrl+0 restores the configured terminal font size.

## Tests

```sh
npm run check          # TypeScript + production frontend build + browser tests + Rust tests
npm run check:tools    # unattended Windows MCP, provider fixtures, search/vault scope, isolated browser and real client timing (no model calls)
npm run check:tools:native # same checks plus foreground desktop input and window capture (unlocked interactive desktop required)
npm run check:provider-mcp # CLI configuration + Muse/Codex real adapter discovery (no model calls)
npm run check:native   # Windows debug build + real WebView2/IPC/ConPTY smoke test
npm run check:remote   # real Tailscale HTTPS + native app + phone browser (Tailscale sign-in required)
npm run check:extensions # GitHub plugins, Kanban, permissions and restart/crash recovery (internet required)
npm run check:bots      # Windows native bot identity, private memory, scheduled handoffs and cancellation (no model calls)
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

On Windows with PowerShell script execution disabled, use `npm.cmd` / `npx.cmd`.
Browser tests use installed Chrome or Edge; set `BROWSER_PATH` for another Chromium executable.
The native test starts Vite if needed, launches a separate debug app with an isolated WebView2
profile, and substitutes a deterministic CLI fixture only in that child's environment. It
does not use the configured AI provider, alter the installed app, or change your CLI settings.
The agent-tools smoke uses an explicit separate app identifier and can run
alongside the user's app. Other native harnesses require Velum fully quit.
The default `check:tools` leaves native desktop permissions off and records
native checks as `not_requested`. Use `check:tools:native` from an unlocked
interactive Windows desktop to verify foreground focus, Unicode input and
window capture. Windows can reject `SetForegroundWindow` in a background,
locked or unattended session; an explicitly requested native check then fails.
For release or installed tool checks, run `node scripts/agent-tools-smoke.mjs --release`
or `node scripts/agent-tools-smoke.mjs --installed`; add `--native`
to include desktop input and capture.
Use `node scripts/native-smoke.mjs --release`
for the packaged build, or `node scripts/native-smoke.mjs --installed --notifications` after
installing the current bundle to also verify Windows Notification Center delivery and the
registered COM activation path. These checks use isolated notification preferences.
Test artifacts are written to ignored `test-results/` and `.qa/` directories.

For real signed-in Muse and Agy checks, opt in with
`node scripts/providers-live-smoke.mjs --live --installed` (omit `--installed`
for the debug build). This uses the existing provider accounts and creates new
CLI sessions, isolated Velum preferences and a disposable project. It verifies
replies, resume, Standard file probes, cleanup and permission-session resets;
provider rate limits or outages can fail it. Agy's configured headless policy
may block the shell probe, which must be reported as blocked rather than passed.
It does not edit permission rules or run a YOLO turn. See the
[Muse and Agy validation report](provider-validation-2026-09-29.md).

For current-turn token metrics across Muse, Codex, and Antigravity, use
`node scripts/providers-live-smoke.mjs --live --metrics-only --installed`.
This requests two short replies per provider (fresh and resumed), using existing CLI
accounts and a disposable project. It requires positive output counters and a measured
duration. Codex counts must also match the change in its retained session totals, so a
resumed thread cannot pass with cumulative counters. It runs no access probes or permission
changes. Service outages or
expired sign-in can fail it. Use `--provider muse`, `codex`, or `antigravity` to check one.

`scripts/bots-smoke.mjs` substitutes all three CLI protocols, checks identity and private
recall across providers, runs a Muse → Codex → Antigravity task handoff, and verifies stale
board rejection, cancellation, non-overlap, bounded history, and restart behavior. Use
`node scripts/bots-smoke.mjs --release` to exercise the packaged frontend. The [bots guide](bots.md)
describes the user-facing behavior and the validated response protocol.

The remote smoke test uses the real signed-in Tailscale client and a temporary foreground
Serve route on 8443. It requires that port to be unused, and refuses to attach to a running
VelumCode instance. It pairs a separate browser with isolated app settings, runs fixture
turns while the desktop is hidden, stops a fixture process tree, reloads history, and revokes
the phone. It removes its own route on exit. For the installed bundle use
`node scripts/remote-smoke.mjs --installed`. This test is intentionally not run in CI because
it needs a signed-in tailnet; Rust HTTP tests cover the access boundary without a network.

For USB without a physical phone or tailnet, run
`node scripts/remote-smoke.mjs --release --usb-fixture` after a release build. It compiles a
small ADB fixture in `.qa`, then exercises the real loopback server, browser cookies,
desktop approval, tray control, disconnect/reconnect, stop, and revocation. It never invokes
real ADB. Android unit tests cover USB launch intents and strict loopback URL validation;
a connected Android phone is still needed to verify the physical cable and WebView.

Run `npm run build` before testing the phone interface in a debug native build. Tauri's asset
resolver serves the built `dist/remote.html` and assets; Vite hot reload is desktop-only.
See [remote access](remote-access.md) for permissions, lifecycle, limits, and setup.

Coverage includes chat/tool/todo rendering, final answers, error recovery, workspace changes,
tab and mode preservation, race-prone startup/teardown, keyboard/clipboard interactions,
accessibility, PTY decoding, native process trees, close-to-tray survival, single-instance
restoration, notification activation, and explicit Quit cleanup.
See [the QA report](qa-2026-09-26.md) for findings, evidence, and remaining work.

## Documentation and legal packaging

User guides start at the [documentation index](README.md). Legal files are
explicit drafts until the publisher completes the [legal release guide](legal-release.md).
Do not present a draft as a binding agreement.

`npm run legal:notices` generates the Windows dependency inventory and full
license/NOTICE texts from locked local dependencies and pinned upstream notices.
`npm run legal:notices:check` verifies the generated files without changing them;
`npm run legal:check` checks links, fingerprints and source-archive/resource inclusion.
Use `npm run legal:release` before a final public release; it intentionally rejects
the current unfinished publisher/license/acceptance fields. These are document
and packaging checks, not a legal certification.

Windows bundles include notices and unmodified covered-source archives. The
Android build script and CI enable `scripts/legal-android.gradle`, which resolves
runtime artifacts and refreshes the companion's existing notices asset before
packaging. Dependency changes need a notice/source review; unknown Android
licenses and changed native loader/installer versions require explicit updates.

## Session behavior

Closing the window (including Alt+F4) hides Velum Code in the Windows system tray. Running Agent
turns, terminals, tabs, and drafts stay alive. Click the Velum Code tray icon or open the desktop
shortcut to restore the existing instance. Right-click the tray icon and choose **Quit Velum Code** to stop background work and exit; Quit is also available in the command palette.

Background Agent turns send native Windows notifications when they complete or fail while
Velum Code is hidden, minimized, or unfocused. Click a notification to open its conversation.
Notification text contains no prompt, answer, or workspace details. Mute notifications using
the footer bell or tray menu; this preference survives restarts. The tray menu and command
palette include **Send a test Windows notification**. Windows notification settings and Do
not disturb still control delivery. Install the NSIS bundle to register Velum Code's notification
identity and activation handler; the development executable alone does not install them.

Switching between Agent and Terminal preserves both views until the tab closes. Terminal is
a **separate conversation** launched in the tab's workspace; it does not share the Agent
transcript. Applying a different valid workspace starts a fresh chat and restarts an existing
terminal in that directory. Invalid workspace paths preserve the current conversation.
Restart resets only the currently selected mode. Closing a tab stops its processes; closing
the window preserves them. Explicit Quit stops every owned agent and terminal process.

Open desktop tabs, drafts, options and bounded transcripts recover after Quit, a crash or a
Windows restart. `history.rs` checkpoints dirty event logs and desktop state once a second
on one background thread, using atomic file replacement. Normal exit flushes the latest native
state. Browser local storage provides fast draft reads; native checkpoints make them durable
even if WebView2 is killed. Unavailable or full browser storage falls back to an in-memory
cache while native recovery continues to save tabs and drafts. Native saves run in order,
so a delayed tab checkpoint cannot overwrite a newer draft. A crash can lose changes since
the last checkpoint.
Provider resume IDs are saved alongside transcripts. Interrupted turns are marked cancelled
and never replayed as new commands. Missing resume IDs are disclosed before continuing.
Terminal processes and scrollback are not restored. Closing a tab deletes its recovery data;
CLI logs are separate. There is no browser for closed conversations yet.
The separate [memory vault](memory.md) is persistent. Phone drafts use bounded local storage
for reload/process recovery; they are cleared on logout or detected revocation and expire
after seven days without a draft update. They do not restore a desktop session that has ended.
Headless chat displays approval notices and auto-cancels `request_user_input`; it cannot
collect interactive approval/question responses. Use a separate Terminal conversation for
those workflows. YOLO changes approval/sandbox behavior; it does not add interactive responses.

If a message cannot be submitted, it stays visible with **Not sent** and can be copied.
An empty composer restores the failed prompt; a newer draft stays intact. Unsent messages
are excluded from plugin conversation context and bot handoff excerpts.

## Layout

- `src/` — React UI: `TitleBar`, `TabBar`, `ChatView`, `TerminalView`, `SearchBar`
- `src-tauri/src/history.rs` / `src/desktopHistory.ts` — bounded native recovery and draft checkpoints
- `src-tauri/src/plugins.rs` — package review, installation, permissions and confined file reads
- `src-tauri/src/plugin_github.rs` — bounded GitHub downloads pinned to a commit, with no clone or build step
- `src-tauri/src/plugin_catalog.rs` / `src/components/PluginDirectory.tsx` — cached community directory, browsing, and GitHub submission handoff
- `src-tauri/src/kanban.rs` / `src/components/KanbanPanel.tsx` — atomic workspace boards and shared desktop/phone UI
- `src/pluginRuntime.ts` / `src/pluginBridge.js` — lazy, isolated worker runtime
- `packages/plugin-sdk/` / `examples/project-tools/` — plugin SDK and working starter
- `src-tauri/src/runner.rs` — headless agent sessions, one `muse exec --json`
  child per turn (`agent_new/send/stop/destroy`, `agent-event` events)
- `src-tauri/src/events.rs` — tolerant fold of the `--json` stream into UI events
- `src-tauri/src/pty.rs` — multi-session PTY manager
  (`pty_spawn/write/resize/kill`, `pty-data` / `pty-exit` events)
- `src-tauri/src/desktop.rs` — tray lifetime, single-instance restoration, notification settings
- `src-tauri/src/memory.rs` — Markdown vault, scoped retrieval, bounded context, suggestion capture
- `src/components/MemoryPanel.tsx` — shared desktop/phone memory editor and review controls
- `src-tauri/src/windows_notifications.rs` — Windows toasts and COM conversation activation
- `src/remote/` — mobile interface, reconnects, and transcript rendering
- `src/components/RemotePanel.tsx` — desktop pairing and device management
- `src-tauri/src/remote.rs` — loopback HTTP API, cookies, live events, and remote commands
- `src-tauri/src/remote_auth.rs` — one-use pairing and revocable device credentials
- `src-tauri/src/session_log.rs` — backend event replay independent of the desktop WebView
- `src-tauri/src/tailscale.rs` — client discovery, connection status, and owned Serve lifecycle
- `src-tauri/src/usb.rs` — ADB discovery, USB forwarding, and Android app launch
- `src-tauri/nsis/` — installer hooks + custom bitmaps
- `scripts/` — `install.ps1`, `make-assets.ps1`
- `docs/rich-agent-ui.md` — rich-agent-UI design + CLI probe findings
