# Bonsai 2 local GPU provider

[Documentation](README.md) · [Multi-provider swarm](swarm.md) · [Usage](usage.md)

Velum Code supports **Bonsai 2** as a first-class local GPU provider (`bonsai`) with native tool calling, streaming reasoning (`<think>`), vision/image input, strict UTF-8 `stream-json` telemetry, and direct integration with [Multi-provider swarm](swarm.md).

## Dual-server architecture

Bonsai 2 runs two local OpenAI-compatible `llama-server` instances plus a companion MCP utility server so deep reasoning and ultra-fast swarm subagents do not wait on one another:

| Service | Default port | Role |
| --- | --- | --- |
| Primary reasoning & vision | `127.0.0.1:8080` | `Bonsai-2-27B` (up to `262,144`-token context with calibrated 4-bit KV cache or `64K` FP16 balanced mode) + multimodal `mmproj` |
| Fast parallel worker | `127.0.0.1:8090` | `Bonsai-2-4B` (~`150 tok/s`, `32K` context + `mmproj`) for instant responses and parallel `bonsai-fast` `/swarm` slices |
| Bonsai Local MCP server | `127.0.0.1:8081` | Exposes 15 local tools (`system_health`, `web_search`, `web_fetch`, `github_api`, `run_python`, workspace helpers, and swarm tools) |

## Model profiles

Choose **Bonsai** from **AI provider** in the assistant controls and select a profile from **Model**:

- **`Bonsai-2-27B` (`64K` Balanced)**: Default FP16 KV cache profile on `:8080` for coding, vision, and complex synthesis.
- **`Bonsai-2-4B` (`Fast Worker :8090`)**: Secondary GPU worker on `:8090` for near-instant local replies.
- **`Bonsai-2-27B-8GB` (`<8GB` Automation)**: Calibrated 4-bit KV cache keeping 64K context under 8 GB VRAM for continuous background bots (`Bonsai Watchdog`).
- **`Bonsai-2-27B-262K` (`Max Context`)**: Full 262,144-token context window on 27B.

## Features supported in Velum Code

- **Streaming reasoning and tool telemetry**: Native `<think>` reasoning streams live into collapsible thinking previews alongside tool input, output, duration, and live checklist (`write_todos`) updates.
- **Vision and image attachments**: Drag, paste, or upload images in chat; Velum passes `[Attached image: ...]` directly to `llama-server` with multimodal projector support.
- **Strict UTF-8 native bridge**: Launched via native `bonsai.exe` so Windows codepages (`cp1252`) cannot corrupt emojis, box drawing, or multi-byte UTF-8 tool output.
- **Local Swarm coordinator**: Use `Bonsai-2-27B` as your free local coordinator to decompose tasks and dispatch parallel sub-tasks to `bonsai-fast`, `claude`, `codex`, `antigravity`, `muse`, or Velum Bots.
