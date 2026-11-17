# Multi-provider swarm and task delegation

[Documentation](README.md) · [Bonsai 2 local GPU](bonsai.md) · [Agent tools](agent-tools.md)

**Multi-provider swarm (`/swarm`)** lets any model inside Velum Code — including local **Bonsai 2**, **Claude Code**, **Codex**, **Google Antigravity**, and **Muse** — inspect what other CLIs and Velum Bots are available on your machine, delegate focused subtasks to the best model, or fan out 2–6 independent worker tasks in parallel and synthesize their results via a shared swarm board.

## Using Swarm in the composer

Open **Swarm** in the composer action strip beside **Skills** and **Tools**:

1. **Enable automatic swarm instructions** (`Swarm · N`): attaches `<velum-swarm-roster targets="...">` instructions to your turns so the active model sees your chosen worker roster cleanly (rendered as a compact badge above your visible prompt rather than raw XML).
2. **Pick your roster targets**:
   - **`bonsai-fast`** (`Bonsai 2 4B · Fast (:8090)`): ~150 tok/s secondary local GPU worker for parallel reads, audits, summaries, and sub-slices.
   - **`bonsai`** (`Bonsai 2 27B · Local (:8080)`): deep local reasoning, code generation, and vision tasks.
   - **`codex`**: OpenAI Codex CLI (`codex exec`).
   - **`claude`**: Anthropic Claude Code (`claude -p`).
   - **`antigravity`**: Google Antigravity CLI (`agy`).
   - **`muse`**: Velum Muse CLI (`muse`).
   - **Velum Bots** (`bot:<id>`): any enabled named bot profile (such as `Bonsai Builder`, `Bonsai Reviewer`, `Bonsai Watchdog`, or custom bots) using its configured provider, model, `soul.md`, and `agent.md`.
3. **One-click actions and slash commands**:
   - **Launch `/swarm`**: prepares a parallel multi-worker orchestration prompt.
   - **Delegate Subtask**: prepares a targeted handoff via `delegate_task`.
   - **Council Compare**: runs a `read_only=true` multi-provider comparison across selected models and summarizes agreements/differences on `swarm_board`.
   - Type **`/swarm`** or **`/delegate`** directly in the composer to open the same structured commands from the slash menu.

## Swarm tools and MCP aliases

Depending on whether a provider calls native Bonsai tools or Velum Code's host MCP bridge, the same four swarm capabilities are exposed:

| Capability | Bonsai native / local MCP | Velum MCP (`--velum-tool-stdio`) | Purpose |
| --- | --- | --- | --- |
| Discover roster | `list_swarm_providers` | `swarm_list_providers` | Lists installed provider CLIs, default models, and enabled Velum Bots. |
| Single delegation | `delegate_task` | `swarm_delegate_task` | Delegates one self-contained subtask to a chosen provider or `bot:<id>` and waits for its output. |
| Parallel fan-out | `run_swarm` | `swarm_run` | Runs 2–6 independent worker subtasks concurrently across mixed providers and saves results to a board. |
| Shared board | `swarm_board` | `swarm_board` | Lists, reads, or posts coordinator notes on persistent swarm boards (`~/.bonsai2/swarms/`). |

When swarm tools run, `AgentActivity` renders live streaming progress updates (`RUNNING` -> `DONE`) and **Swarm Worker Cards** directly in the conversation showing each worker's name, provider/model, status, elapsed seconds, and result summary.

## Permissions and safety boundaries

- **Toggleable bridge permission**: Toggle **Multi-provider swarm delegation** inside **Tools** in the composer or **Settings → Preferences → Agent tools**. Enabling Swarm in the composer automatically enables `swarm` permission in the host bridge.
- **Read-only by default when reviewing**: Workers can be launched with `read_only=true`, confining CLIs (`--read-only` / `--mode plan` / `--permission-mode plan` / `-s read-only`) so parallel audits and Council Comparisons cannot modify project files.
- **Recursion guard**: Child workers run with incremented `VELUM_SWARM_DEPTH` so spawned workers do not infinitely spawn sub-swarms.
- **Permission inheritance**: Standard vs **YOLO** execution respects the parent session's active permission mode (`--yolo` is only passed when explicitly enabled on the parent turn and `read_only` is false).
