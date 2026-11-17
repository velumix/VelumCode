# Interactive studio chat & conversation UX

Velum Code translates CLI transcripts from **Claude Code**, **Bonsai 2**, **Codex**, **Google Antigravity**, and **Muse** into one clean interactive studio without losing per-provider power.

[Documentation](README.md) · [Multi-provider swarm](swarm.md) · [Bonsai 2 local GPU](bonsai.md)

![Focused conversation with expandable activity](images/focused-conversation.png)

## Reading, diffs & interactive markdown

- **Theme-safe syntax highlighting**: Code blocks tokenize TS/JS/TSX, Rust, Python, Luau, JSON, Shell/PowerShell, CSS, TOML/YAML, and SQL using contrast-verified colors across all twelve dark, light, and Crystal Glass themes.
- **Code block actions**: Headers expose clickable file badges (`tsx:src/App.tsx`), line counts, a **Wrap** toggle, **Insert** (into composer), **Run** (for shell snippets), and clean raw-text **Copy**.
- **Clickable file pills**: Inline file references (`src/App.tsx`, `src-tauri/src/providers.rs`, `file:///...`) render as interactive chips that jump straight into **Split Studio → Diff** for that file.
- **GitHub alerts**: Blockquotes beginning with `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, or `[!CAUTION]` render as semantic callouts.
- **Image input & lightbox**: Drag, paste (`Ctrl+V`), or click the image icon to attach PNG/JPEG/WebP/GIF/SVG screenshots or mockups; click thumbnails in sent messages to open the full-screen lightbox viewer.

## Actionable activity cards & Swarm Worker Grid

Consecutive tool invocations fold cleanly into an expandable **Agent activity** card so long tool runs never flood the reading feed:

- **Live collapsed telemetry**: Even before expanding, `AgentActivity` displays live thought snippets, category counters (`Files`, `Shell`, `Git`, `MCP`), Swarm worker counts, and clickable **file pills** with `+add / -del` line stats. Failures and blocks always highlight automatically.
- **Category-styled tool cards**: Expanded tool cards show color-coded left borders per category, duration telemetry, 1-click **Diff** buttons on file tools, and inline unified diffs for `edit_file` / `write_file`.
- **Swarm Worker Cards**: Calling `run_swarm`, `delegate_task`, or `swarm_board` displays a multi-column **Swarm Worker Grid** showing each delegated model (`bonsai-fast`, `claude`, `codex`, etc.), status, runtime seconds, and summary right inside the card.
- **Mission Plan (`todos`)**: Active task checklists display a compact progress bar beside the composer and expand into a full status checklist (`✓`, `◉`, `○`).

Under **Settings → Preferences → Conversation preferences**, turn off **Compact assistant controls** or **Group agent activity** if you prefer always-expanded controls or ungrouped tool cards.

## Studio layout modes & Turn controls

Use the chat header's view toggle (**Stream**, **Split**, **Dashboard**) to keep just the conversation or open **Session Dashboard** beside it for live **Diff**, **Tasks**, **Tools Log** (with category filtering & command search), **Telemetry**, and **GitHub Hub**.

- **Prompt Edit & Resend / Re-run**: Hover any previous user prompt to **Edit and resend message** inline or **Re-run** without scrolling back to copy/paste.
- **Assistant Actions**: Every completed reply includes **Correct response**, **Retry** (re-running the preceding prompt), **Inspect diff (N)** when files changed, and **Remember** to seed a Markdown note.
- **Turn Scorecard & Follow-ups**: The latest completed assistant reply displays a scoped **Turn complete** scorecard with touched file chips, one-click **Quick follow-ups** (`Run tests`, `Review diff`, `Summarize changes`), and recommended peer **Hand off** buttons.

## Review permissions, questions & queues

- **Interactive approvals**: Permission prompts and multi-choice questions appear inside the stream with previews, **Allow once**, **Details**, and **Add guidance** when declining; phone clients with control permission share the same controls.
- **Message Queue**: Sending while an agent is working appends to an ordered queue above the composer with Pause, Resume, Edit, and Remove controls synced with any paired phone.
- **Recovery & Corrections**: Interrupted or failed turns expose **Retry request** and **Revise request**. Clicking **Correct response** lets you steer the answer while keeping any unfinished draft in your main composer untouched, with an explicit opt-in checkbox to save a **Lesson for next time** into [Memory](memory.md).
