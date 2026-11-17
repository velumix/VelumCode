# Getting started

Signed Windows releases from GitHub check for updates during Velum Code's opening animation, verify signatures, download new installers automatically, and reopen cleanly while keeping your tabs, drafts, and preferences. Offline launches open the installed version immediately. See [App updates](updates.md).

[Documentation](README.md) · [Multi-provider swarm](swarm.md) · [Bonsai 2 local GPU](bonsai.md)

## 1. Install and connect a provider

Download `Velum.Code_<version>_x64-setup.exe` from [**GitHub Releases**](https://github.com/velumix/VelumCode/releases) (or the latest Windows CI artifact in [the project README](../README.md#get-velumcode)) and run the installer. The NSIS installer registers the Windows AppUserModelID required for native toast notifications and tray activation.

Install and sign in to at least one supported CLI (or set up **Bonsai 2** locally):

- **Claude Code (`claude`)**: install `@anthropic-ai/claude-code`, choose **Claude**, and sign in via browser or API key.
- **Bonsai 2 (`bonsai`)**: run local `Bonsai-2-27B` (`:8080`) and optional `Bonsai-2-4B` fast worker (`:8090`). See [Bonsai guide](bonsai.md).
- **Codex (`codex`)**: install OpenAI Codex CLI and sign in with ChatGPT or API credentials.
- **Google Antigravity (`agy`)**: install Antigravity CLI, choose **Antigravity**, and complete the dedicated sign-in screen.
- **Muse (`muse`)**: uses your installed Muse CLI session.

Velum checks CLI health and prefills model/reasoning catalogs automatically, showing `CLI ready` (version and model count) in **Assistant settings**. Non-responsive probes are cleanly cleaned up after 30 seconds. Review [legal status](../LEGAL.md) and the [privacy notice draft](../PRIVACY.md) before sending sensitive code to cloud CLIs.

## 2. Choose a project

Click **Project folder** below the composer and choose the workspace folder the agent should work in. Keep clean Git commits before running destructive commands. Standard vs **YOLO** execution permissions are toggled in the composer action strip.

Use the composer pickers anytime to tailor each turn:
- **Skills**: attach up to 8 `SKILL.md` instruction packs (`Skills`)
- **Tools**: configure host tool scopes (`file_delete`, `vault_search`, `browser`, desktop capture/control, `swarm`)
- **Swarm**: enable multi-provider `/swarm` delegation across local and cloud CLIs

## 3. Work in the studio conversation

Type a prompt or type `/` for slash commands (`/review`, `/test`, `/swarm`, `/delegate`, `/refactor`, `/bug`, `/clear`), or switch between **Stream**, **Split**, and **Dashboard** views in the chat header to inspect diffs and tool telemetry alongside the feed.

| Action | What happens |
| --- | --- |
| Send while the agent is working | Your prompt enters the ordered native queue without interrupting the active turn |
| Click **Edit & Resend** on any prompt | Edit a previous prompt inline and resend it directly from history |
| Click a file chip in markdown or activity | Opens Split Studio right on that file's Git diff |
| Click **Skills / Tools / Swarm** | Adjusts per-turn instructions, host tool permissions, or delegation roster |
| Toggle **Agent / Terminal** | Switches between the structured studio feed and a full interactive Windows ConPTY shell |

## 4. Keep work running in the tray

Closing the window or pressing `Alt+F4` hides Velum Code to the Windows system tray while background agent turns, scheduled bot jobs, and phone remote access stay alive. Choose **Quit Velum Code** from the tray menu or `Ctrl+K` to exit completely.

## 5. Expand when you need more

- [Orchestrate a multi-provider `/swarm`](swarm.md) across fast local workers and cloud specialists.
- [Pair your Android phone](remote-access.md) over Tailscale HTTPS or USB.
- [Build a custom Bot team](bots.md) with scheduled [Kanban](kanban.md) assignments and private Markdown memory.
- [Install Plugins](plugins.md) and [Skills](skills.md), or tune themes and Crystal Glass in `Ctrl+,` ([Appearance](appearance.md)).
