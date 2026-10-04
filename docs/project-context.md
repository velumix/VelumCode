# Project context and diagnostics

Choose a project with the folder button beneath the desktop composer, then **Apply**. Velum checks that its host process can list the folder before changing the conversation workspace. An unreadable folder leaves the current conversation and draft intact. Applying a different project starts a new provider session in that tab.

Open **Project context and diagnostics** beside Send, or **Project context & diagnostics** on your phone. The report separates the Velum host process from the active provider session. Each operation has a pass, fail, blocked or untested status, path, timestamp, execution environment and sanitized error detail. A host pass never establishes agent access.

**Test host access** checks listing, a known fixture read, exclusive file creation, editing, read-back and cleanup through the host filesystem API. **Test agent access** runs a real turn through the active provider session and its current permission mode. It uses a uniquely named temporary directory in the selected project and touches no existing user files. Listing and reads use separate PowerShell calls; Codex creation, editing and deletion use `apply_patch`. An assistant's summary and a zero process exit code cannot establish a pass. PowerShell error records override apparent command success.

The host seeds a known read fixture, and removes its own fixtures after the turn, including failed or cancelled turns. Host cleanup is reported separately from agent cleanup. An operation without tool evidence stays untested, including unsupported provider result formats. A failure lists a safe error category/code; raw output is excluded. Unexpected files inside a probe directory are left in place, and cleanup failure is reported. Phone diagnostics view the active session's evidence and never start write probes.

Changing Standard/YOLO invalidates cached checks and starts a fresh provider conversation on the next turn. A notice explains that the visible transcript remains while previous provider context is not replayed. Mode changes are disabled during a running turn. Recovery persists the last launched mode; older sessions with unknown modes start fresh. Standard Codex turns explicitly select the project and request `workspace-write` with only that project as the added writable root. Effective restrictions, when available, come from that active Codex thread's permission metadata; launch flags are labelled separately. Velum does not change Windows ACLs or provider permission rules. Its agent tools bridge manages one credential-free MCP registration for Muse and Antigravity; Codex uses a per-turn configuration. See [Agent tools](agent-tools.md) for the registration, backup and host permission details.

## What the agent receives

Every request carries a reference block capped at 16 KB with the Velum version, host OS, workspace path, Git root and branch when available, provider, model, reasoning, permission mode and request source (desktop, phone or scheduler). It includes separate host and active-agent check results with their permission revision. Without agent evidence, agent operations are explicitly untested. Exceptionally long fields are omitted with an explanation instead of supplying an incomplete path. No process is launched to inspect Git, and repository remotes and credentials are not read.

The reference block describes available context; it does not add tools or grant permissions. Installed does not mean signed in. Connection health and UI/document discovery are explicitly **untested** unless actual evidence exists. Velum has no live UI/document discovery implementation; it does not assert an attached session count. Filesystem checks do not verify authentication, external connectors or memory retrieval.

Two optional attachments are available:

- **Diagnostics:** a previewable JSON report with workspace paths replaced by placeholders, and without conversation text, credentials, raw logs, environment variables or memory contents. Copy it, or add it to the current draft.
- **Chat layout:** a structural snapshot captured when the panel opens, including viewport dimensions, selected provider/model, chat region bounds and overflow. It excludes message text, input values, other tabs and dialogs. It is not a screenshot or a live browser connection.

Adding an attachment never sends the message. Existing drafts are preserved. View-only phones may inspect and copy reports but cannot attach them to a message. Diagnostics run on demand; the panel loads only when opened.

Memory remains a separate Markdown vault. Search and inspect saved notes in **Memory**. Recalled titles and their byte cost appear below the conversation; successful saves produce a notice. Proposing a note alone does not prove that it was saved. Bot-private memory is managed in the bot's own Memory screen and is not counted in the shared/project report.

## Git branches and diff

Open **Git** in the conversation toolbar (or `Ctrl+K` → Open Git branches and diff) to see the selected project's repository: current branch, upstream ahead/behind, local branches with upstream tracking, working-tree status grouped into staged, unstaged and untracked, recent commits, and per-file unified diffs with line numbers, find-in-diff and copy. The branch picker switches the comparison base for the diff; the panel never checks out branches, stages, commits, or edits files — switch branches in a terminal. Refresh the panel after an agent turn to see what changed. The same read-only readers back the `git_branches`, `git_diff` and `git_log` agent tools: per-command `safe.directory`, 10 s timeout, 24 KB bounded output, no global configuration writes.

The footer shows a live branch chip for the selected conversation (`branch · N changed`, ringed count only when the tree is dirty, plus an ahead/behind marker when the branch tracks an upstream); it refreshes on tab switches, folder changes, run settles, panel close and window focus, clears the old branch the moment the folder changes, retries transient Git failures with backoff (a plain non-repo folder stays quiet by design), and opens the Git panel on click. Each conversation pill in the sidebar names what is answering — model first, then bot or provider — followed by the live state: the current running detail (`Responding.`, `Running Shell.`), queue depth, or the settled state. Terminal tabs keep the provider name with terminal state.

## Antigravity command permissions

Antigravity can return a successful process exit even when a tool was denied because headless mode could not ask for permission. Velum marks these turns **blocked**, preserves partial output, skips memory proposals and board actions, and immediately pauses scheduled work. Background notifications also report blocked turns.

On the desktop, choose **Continue this conversation in terminal** after the headless turn settles. Velum opens `agy --conversation <saved id>` in the same workspace. Answer native prompts there; `/permissions` opens the CLI's permission settings if a command rule needs attention. The regular **Terminal** tab still starts a separate conversation. A running separate terminal must be exited before reusing its view for continuation. Velum does not silently enable YOLO or rewrite global permission settings.

The backend reserves a continued conversation until the terminal exits or is closed, and rejects simultaneous chat/phone turns into it. **Close terminal and return to chat** releases it after reaping the child. Terminal output stays in the terminal view; later chat turns resume the provider's saved conversation. This continuation is desktop-only and cannot approve an already-denied headless call. Scheduled blocked turns remain paused for review.

See Google's [headless mode](https://antigravity.google/docs/cli/headless/) and [permission rules](https://antigravity.google/docs/permissions?tab=cli) documentation.

### Interactive approval system

Research and implementation on 2026-10-03 included consultations with the installed Muse and Antigravity CLIs through `cmd.exe`, inspection of exported protocol schemas, and direct protocol discovery. The work followed the headless-permissions goal in priority order: Muse, Antigravity, then Codex. Muse implemented the MSP view projection and reviewed the approval transport; Antigravity reviewed native continuation and its ownership constraints.

Muse now launches durable `muse serve`; Codex launches its private stdio `app-server`. Their control adapters preserve request identities and decisions separately from transcript events. Antigravity retains its CLI headless transport with the explicit native continuation described above.

#### Shared backend and UI

A Rust approval broker belongs to each running provider adapter. Entries carry the Velum turn generation, request revision, action/arguments, offered choices and scope, and resolution state. Provider identities, requirement tokens, RPC IDs and response shapes remain in backend bindings. User-input questions share the delivery infrastructure with a separate answer contract.

Desktop and phone show the same pending request. A paired phone requires current control access. Neither client can supply arbitrary provider RPC methods, grant scopes, or command arguments. The backend accepts only an offered choice for a currently pending request and sends it through that request's owning adapter. A successful send means **submitting**; the provider's resolution establishes **approved**, **denied**, or a new pending requirement.

Pending state is separate from historical transcript events. Phone reconnects fetch the live pending set. Desktop reloads reattach to an existing native session and reconcile numbered events; transcript replay never re-enables old buttons. Competing desktop/phone decisions are serialized. Stop, provider death and replacement expire outstanding requests. The broker audit records outcomes and their desktop/phone/provider origin, omitting transport credentials and submitted question answers. Provider-generated transcript content follows normal history retention.

Pending/submitting requests show a waiting state and suspend the silence watchdog. Stop stays available. Background notifications announce new requests when enabled. Queues advance only after the turn settles; declined permissions pause follow-up work and prevent completed-task side effects. Scheduled runs show their pending requests in **Bots > Activity** and on controlling phones, remain admitted as active runs, and exclude human waiting time from their execution limit. Disabling, pausing or invalidating the job still stops it. Absence of a reviewer never grants permission.

#### Muse: durable MSP over stdio

`muse serve` retains stdin throughout the turn. The runner keeps per-turn child ownership and MCP registration: initialize a host, start/resume the durable provider session, run the turn, exchange decisions, and close after completion and settlement. Early turn events wait for the acknowledged turn ID. Multi-stage requests replace the offered requirement; rejected decisions reconcile with `approval/listPending`. Process reuse can follow once MCP grant lifetimes support it.

The installed Muse 1.4.2 host completed live approval round trips through the native Rust runner and paired phone on 2026-10-03: phone **Allow once** permitted a marker write/read-back, desktop **Reject** prevented the second file, reload recovered the same pending request, and a competing response was rejected. MSP requires canonical `workspaceRoots`, including the Windows extended-length prefix; the adapter canonicalizes before submission. Its stable schema fingerprint is `sha256:61afea3112e0906e9dc3a536144278a74cb4b36fc6e20901a91d4432ba3568e2`; fingerprint changes alone are warnings, while required methods/shapes must be supported.

- Read the handshake's durability. `--no-session-log` produces an ephemeral host that intentionally omits session read/resume; do not use it for resumable conversations. See [durability profiles](https://meta-models.github.io/muse-code-sdk/next/guides/msp-concepts/durability-profiles/).
- Acknowledge server `approval/request` with an empty JSON-RPC result. That receipt does not authorize execution. Send a separate `approval/decide` using a UUIDv7 command ID, session ID, approval ID, the current requirement object (`approvalId` plus `sourceIndex`), and an offered choice ID. Fold `approval/updated` and `approval/resolved` into the same card. See [Muse approvals](https://meta-models.github.io/muse-code-sdk/next/guides/msp-concepts/approvals/).
- Use the installed item/view notifications for rendering and `approval/listPending` for reconciliation. This release reserves `rawLog` and does not grant it; the existing exec JSONL fold cannot simply be reused as the MSP parser.
- Let the server mint new session IDs. An isolated exec-created UUIDv4 session reached resume handling, but was refused because its retained `:auto-review` permission profile required a reviewer unavailable on the serve host. Existing exec history therefore needs an explicit compatibility path; do not overwrite it, weaken its policy, or silently replace its session ID.
- Select approval policy explicitly on the wire, including after resume, and preserve model/reasoning and workspace constraints. Sandbox posture is fixed when the host starts.

#### Antigravity: capability boundary and alternatives

Installed `agy` 1.2.14 accepts user messages through stream-JSON. It has no documented approval-response channel there; `control_request` and `control_response` are rejected. Permission-required actions can finish as soft denials. Do not implement approval buttons that merely send text into this stream. See [headless input and permission behavior](https://antigravity.google/docs/cli/headless/).

Two distinct integration options remain:

1. **Keep CLI sign-in:** a synchronous `PreToolUse` hook can bridge a specific proposed action to Velum and return allow/deny. Registration is documented through workspace/global/plugin files, not a per-process CLI flag. Before selecting this adapter, establish timeout/spawn/parse-failure behavior, conflicting-hook precedence, nested/MCP coverage, and a registration lifecycle that preserves existing configuration. No-response must never become an implicit grant. These behaviors were not established by the consultation. See [CLI hooks](https://antigravity.google/docs/hooks/).
2. **Use the SDK as a separate backend:** Google's Python SDK documents an asynchronous `ask_user` policy handler suitable for a Velum approval bridge. Its documented setup uses a Gemini API key or Google Cloud credentials, so it must not silently replace the existing CLI account/billing path. See [SDK policies](https://antigravity.google/docs/sdk/policies/) and [SDK setup](https://antigravity.google/docs/sdk/overview/).

The implemented fallback finishes/reaps the headless process, then launches `agy --conversation <id>` in ConPTY with exclusive ownership of the saved conversation. Muse's legacy-session fallback uses `muse resume <id>`. No CLI hook gate is installed: the missing failure/precedence contract remains a prerequisite for a future headless Antigravity bridge. No public ACP adapter or embeddable Remote Control API was established.

#### Codex: app-server v2 over stdio

The adapter follows the installed Codex 0.157.0 generated protocol and the [official app-server documentation](https://learn.chatgpt.com/docs/app-server). It starts/resumes durable threads, streams items and usage, and uses `on-request` with the user as reviewer in Standard mode. The selected project is the writable root; the turn explicitly sets sandbox policy. Existing CLI sign-in is retained.

Command approvals offer supported one-action/session decisions. File approvals show the proposed changes and offer one-action approval, denial or cancellation; the unstable file grant-root session choice is omitted. Additional filesystem/network permission requests can grant only the requested access for the current turn or deny it. Questions use the provider's offered options/free-text rules. A written response stays submitting until `serverRequest/resolved`; that notification records that the request cleared, without asserting the tool executed. Unknown interaction methods stop the turn without granting access.

MCP form/URL elicitations currently display their details with decline/cancel controls. Accepting those forms/browser flows is not implemented. Subagent requests require an observed thread relationship to the active conversation.

#### Implementation sequence

- [x] Add the approval store, adapter commands, and durable Muse MSP transport, including explicit compatibility handling for existing sessions.
- [x] Add scoped desktop/phone choices, question forms, live refresh, submitting/resolved states, and control-access enforcement.
- [x] Integrate waiting with cancellation, queues, scheduler review, history, diagnostics and watchdog timing; reattach live desktop sessions after reload.
- [x] Establish Antigravity's documented boundary and implement protected native continuation. Its headless hook bridge remains deferred until its failure and precedence contract is established.
- [x] Implement Codex app-server after Muse and Antigravity, including its request/decision/resolution path and explicit unsupported interaction handling.
- [x] Finish Rust/TypeScript build checks and diff review: `cargo check --lib`, `npm run build`, and `git diff --check` passed.

#### Requested test follow-through (2026-10-03)

The user then requested testing. Muse added broker/view unit tests; the native harness exercises the Rust runner and WebView plus a mobile Chromium client over the real USB HTTP transport. ADB is simulated; no physical phone is required. All native runs use a separate app identity, configuration, WebView profile, and scratch workspace under `.qa`.

| Coverage | Result |
| --- | --- |
| Real Muse | Phone allow writes and reads the marker; desktop Reject leaves its file absent; pending request survives desktop/phone reload; duplicate response rejected. |
| Real Antigravity | The configured provider policy allowed the harmless command. Its saved session opens in the native terminal, excludes a competing headless send, and releases ownership when closed. This live run is not evidence of an Agy denial round trip. |
| Real Codex | Phone allow executes the requested command; the offered **Cancel this turn** rejects the second command and leaves its file absent. Reload and duplicate-response checks pass. The host offered accept, a policy amendment, and cancel for this action; Velum did not invent a decline choice. |
| Native MSP/Agy fixtures | Allow/reject, pre-acknowledgement request buffering, mirrored requests, stage updates, stale decisions, question answer encoding, Stop, offline recovery, revoked/view-only phone rejection, exact-session terminal ownership, and natural terminal exit pass. |
| Rust | 256 passed, 1 explicitly ignored GitHub network test. Includes broker validation/backpressure, both adapters, transcript folding, child ownership, and human-wait watchdog/scheduler accounting. |
| Frontend/build | All 187 Playwright UI tests pass. TypeScript/Vite production build and the plugin SDK test pass. |

Testing fixed five product defects: noncanonical Windows MSP roots prevented turns from starting; reload could replace newer native recovery state with an older disk checkpoint; ConPTY could hold a terminal lease after process exit; the continuation notice crowded the fixed composer at small window sizes; and Codex completion could report success with an unanswered approval. Regression tests preserve these behaviors. Old launch assertions and IPC fixtures were updated for the new transport.

Repeat the targeted native suite with `npm run check:permissions` (passed after the final rebuild). Append `-- --live-muse`, `-- --live-agy`, or `-- --live-codex` to exercise the installed, signed-in provider; these variants perform small file operations in the isolated scratch workspace. The new native harness is `scripts/permissions-smoke.mjs`. Evidence folders from successful live runs are `.qa/permissions-live-1791078502029`, `.qa/permissions-live-antigravity-1791079247542`, and `.qa/permissions-live-codex-1791079503600`; the final expanded fixture run is `.qa/permissions-fixture-1791079875013`.

Live subagent approvals, provider crash/reconnect, scheduled-bot review, native notification delivery, and physical-phone behavior have not been exercised by this suite. Antigravity still requires native continuation when its headless policy denies an action. Tests use the debug app; no installer was published or installed.

#### Compact approval interface (2026-10-03)

The follow-up UI polish replaces the always-open provider payload and guidance box with a compact request card. Commands and affected files have short previews; **Details** retains the exact full payload. **Allow once** and rejection stay in the action row. **More options** shows broader scopes and proposed saved rules; **Add guidance** opens feedback specifically for declining. Settled requests and transcript approval events use small expandable records on desktop and phone. Waiting status is no longer repeated beneath an active card.

Questions use responsive option rows, an optional written-answer disclosure, and client-side selection limits matching the broker. A filled disclosure says **Edit your answer**. Private answers remain password inputs. Ordinary snapshot updates preserve drafts; a changed request revision intentionally clears them because it represents a new provider requirement. The generation/id/revision checks, duplicate-submit guard, and backend authorization remain authoritative.

The shared controls follow the existing themes, offer 44 px phone targets, and keep the heading and actions visible at a 760×480 desktop size. Small desktop windows also use a shorter composer. Display helpers safely handle unknown provider labels and preserve full commands/patches behind the preview.

Muse reviewed the changes through its CLI; its question-validation and filled-answer findings were addressed. Scope labels, decline-only feedback, and resetting changed provider requirements were checked against the broker contract. Agy's two read-only review attempts timed out without findings, and a bounded Muse follow-up reached its step limit; neither is treated as a review sign-off.

Verification: the full 197-test UI suite passed before the final question-validation and display-label refinements. The final interaction/phone rerun passed all 57 tests, including the six added cases. TypeScript/Vite build and the rebuilt native permission suite passed on the final code. Native coverage includes approve/reject, question wire shapes, stale stages, Stop, reload, offline recovery, revoked/view-only phones, and Antigravity terminal ownership. Evidence: `.qa/approval-full-ui.log`, `.qa/approval-final-ui.log`, `.qa/approval-native-final.log`, and `.qa/permissions-fixture-1791083064174`. Desktop/phone previews are `.qa/approval-graphite-desktop.png`, `.qa/approval-daylight-phone.png`, and `.qa/approval-question-phone.png`. The installed app has not been updated.

## Live tools and timing

The optional [agent tools bridge](agent-tools.md) supplies paged project search, hash-guarded file removal, scoped vault search, isolated browser tools and separately enabled Windows screenshots/input. Layout attachments remain structural data. Diagnostics now include provider token counts, a per-run Rust monotonic timer, observed MCP initialize/call evidence, and the desktop client?s independent timing. Raw tool arguments, screenshots, browser contents and note contents are not included in the diagnostics report. A phone receiving replay snapshots reports independent timing as unavailable.
