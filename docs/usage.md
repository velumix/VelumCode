# Context and usage

The desktop and phone status strips sit directly above the composer. The desktop uses the space previously occupied by memory usage. The strip keeps the context ring, percentage used, average token speed, turn duration, and memory estimate compact. Click anywhere on it for details; Escape closes the panel. The ring becomes amber at 80% and red at 95%. A dashed ring and a dash mean the provider has not reported capacity, rather than zero usage.

## What the numbers mean

- **Context** uses the active Codex thread's latest `last_token_usage.total_tokens` and `model_context_window`. This is the last reported model snapshot, including input and output, not lifetime billable tokens. The unsent draft is excluded. The details show the measurement time, counts, and remaining capacity. No model limits are hardcoded.
- **Token speed** is reported output tokens divided by elapsed provider-process time, including reasoning, tools, startup, and process exit. It is a whole-turn average. The desktop uses the live elapsed timer while running and the final measured duration after completion. Each queued response starts a fresh measurement.
- **Input, cached input, output, and reasoning** use each provider's accounting. Cached and reasoning counts are displayed separately; they are not added again to input or output.
- **Memory** shows actual bytes added by Velum this turn and a separately labelled rough estimate of one token per four bytes. It does not measure the conversation's full context. Details retain the names of recalled notes, without copying their contents into telemetry.

## Availability and lifetime

| Provider | Current-turn token counts |
| --- | --- |
| Claude Code | Reports per-turn `input_tokens`, `cache_read_input_tokens`, `output_tokens`, context window snapshots, and signed-in subscription rate-limit utilization windows (`Plan %`). |
| Bonsai 2 | Reports live `usage` token counts and active `context` window usage (`used_tokens` and `window_tokens`, e.g., `65536` / `32768`) directly from local `llama-server` `stream-json` events. |
| Muse | Its retained `runtime.session` records report `model_completed.usage`. Velum reads numeric counters only for the current root run and session UUID, starting at the file size before launch. Earlier turns, child runs, and duplicate records are excluded. Context occupancy is a labeled estimate: the high-water mark of this run's per-step `input_tokens` (each step's input already contains the conversation history). It is flagged `estimated`, shown with a `~` prefix, and never rendered as a percentage. |
| Codex | Completion counters are checked against the active session's totals. Some CLI versions return cumulative completion counters on resume; matching totals use a pre-launch baseline. Otherwise the documented per-turn completion counts are preserved. Missing baselines or decreasing totals remain unavailable. Also exposes account rate-limit windows when reported. |
| Antigravity | `step_update.usage` reports per-step counts. Snapshots replace the previous counts for that step, then sum across this invocation. A cumulative resumed `result.usage` cannot inflate the rate. A result without step counts is used only when it identifies a single-turn conversation. |

Codex context metadata is read only from the active session UUID, respecting `CODEX_HOME`. Reads are bounded to the last 512 KiB and retain numeric usage data and its timestamp. Muse's incremental monitor respects `XDG_DATA_HOME` (default `~/.local/share`) and reads that session's `muse/sessions/YYYY/MM/DD/<UUID>/session.jsonl`. It skips oversized records and retains counters and record IDs. Both monitors check once per second, finish after process exit, and cannot publish to a replacement native session.

Muse requires readable retained session logs for this CLI version. Missing logs or counters leave speed unavailable. Muse and Antigravity context capacity stays unavailable until reported by a supported schema; for Muse the strip shows the estimated occupancy instead of a percentage. No model limit or text-length estimate is substituted for provider counts.

Usage events are kept with conversation history for recovery. A fresh session, workspace change, model change, or permission change that replaces the provider conversation clears old counters. Starting another turn retains the last context snapshot and clears the prior turn's speed/counts. Provider-managed compaction may reduce the next reported context value.

## Message queue and status

Send remains available during an Agent response. Enter or the send button adds the next message to that conversation's native queue. Pending messages appear above the composer and enter the transcript when their turn starts. The same queue is visible on a paired phone; devices with control permission can edit, remove, pause, clear, and resume it.

Messages run in submission order after the previous provider process exits. After 2 minutes without provider output, the app posts a waiting notice; after 10 minutes without output, it stops that turn and reports a failure. Each turn owns its timeout and process handle, so cleanup cannot stop a later turn. After process exit or a terminal event, output cleanup is limited to 2 seconds, including background descendants that hold stdout or stderr open. A completion read during timeout cleanup keeps its completed status and answer. Pause lets the current response finish. Stop, a failed or blocked response, or a launch failure preserves pending messages and pauses dispatch until Resume. Queues recovered after a restart always wait for review. Each conversation has its own queue, limited to 20 pending messages and 256 KiB of prompt text; a rejected submission stays available for copying or retrying. Scheduled runs and access probes cannot interleave with pending chat work.

Each message retains its submission permission mode. Phone submissions use Standard permissions. Model, workspace, and permission changes wait until pending messages are finished or cleared. Selecting another provider opens its separate conversation, preserving the original queue.

Muse connection phases update even when retry metadata is absent. New response text and tool starts clear the current retry warning. Completion and Stop clear live connection status; diagnostics may retain the prior retry as historical evidence. Status labels use the selected provider's name.

The normalized events are `usage` (independent `context` and `turn` snapshots) and `usage_reset`. The phone renders the same counters from authenticated desktop replay, including resets and per-turn memory. On narrow screens memory details stay in the expandable panel. The phone shows measured provider elapsed time when available; it does not start a misleading timer when reconnecting midway through a turn.

The phone keeps workspace tools together, anchors its conversation menu below its trigger, and uses a side-by-side conversation/composer layout in landscape. With an extremely short keyboard viewport, it prioritizes the draft and Send/Stop; the other controls return when the keyboard closes.

Protocol references: [Codex non-interactive JSON output](https://learn.chatgpt.com/docs/non-interactive-mode#make-output-machine-readable), [Codex exec event types](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs), and [Antigravity headless events](https://antigravity.google/docs/cli/headless/). The Muse adapter uses the local 1.4.1 CLI's retained event schema; numeric metadata was inspected without exporting conversation text or credentials.

## Attached measurement report

Context > Diagnostics exposes `turn_measurement` with an opaque run ID, provider, start timestamp, monotonic host elapsed time, first event/output offsets, completion flag, provider counters and their source. `tokens_per_second` uses the same reported output count and host duration as the final UI rate. A missing provider count remains null. No host tokenizer is installed or claimed.

The desktop adds `client_measurement`, timed independently with `performance.now()` from receipt of the authoritative turn start through receipt of turn end. It includes the client rate, final displayed rate and host/client duration difference. It does not time an optimistic Send click, replayed history or a different run. The clocks have different delivery boundaries: launch/start-event delivery, UI event delivery and host browser cleanup can cause differences. The client comparison uses provider counts rather than independently validating a model tokenizer. Phone replay polling cannot establish a precise independent duration and reports it as unavailable.

Preview the exact JSON, then use Add to message to attach it to an existing draft. It is never sent automatically. The agent can also read its active host measurement with `turn_diagnostics` when the [tools bridge](agent-tools.md) is connected.

An agent calling `turn_diagnostics` during its own response sees a running turn (`finished: false`). It cannot inspect that turn's final process-exit rate before it finishes. Live provider snapshots, when reported, update both the UI and host diagnostics; they remain provisional while the elapsed clock advances. Missing output counts keep the rate null. After completion, open or refresh Context > Diagnostics and attach that completed report in the next message to compare final host and client rates. Desktop screenshots and native input are separate optional permissions; neither is needed to measure token speed.
