# Velum Code documentation

[Back to the project](../README.md)

## Start here

- [Getting started](getting-started.md): install, connect cloud or local providers, pick a workspace, and run your first turn.
- [Interactive chat & studio](conversation-experience.md): syntax-highlighted code, clickable file chips, activity timelines, queue controls, inline prompt edits, and reviewed lessons.
- [Multi-provider swarm (`/swarm`)](swarm.md): delegate subtasks and run parallel swarms across Bonsai Fast, Bonsai 27B, Claude Code, Codex, Antigravity, Muse, and Velum Bots.
- [Bonsai 2 local GPU provider](bonsai.md): dual-server GPU setup (`:8080` + `:8090`), `<8GB` KV-cache automation profile, vision input, and 15-tool local MCP bridge (`:8081`).
- [Troubleshooting and support](support.md): common problems and how to gather useful diagnostics.
- [Data controls](data-controls.md): storage, retention, deletion, and uninstalling.
- [App updates](updates.md): signed automatic updates and GitHub release automation.

## Features

| Guide | Covers |
| --- | --- |
| [Appearance](appearance.md) | Twelve dark/light themes, Crystal Glass sliders, typography, layout, and profiles |
| [Agent tools](agent-tools.md) | Composer ToolPicker, scoped file/git tools, vault search, browser previews, Swarm delegation, and desktop control |
| [Multi-provider swarm](swarm.md) | Composer Swarm picker, roster selection, Council Compare, and shared swarm boards |
| [Bonsai 2 local GPU](bonsai.md) | Local ternary 27B + 4B servers, 262K / `<8GB` profiles, vision, and strict UTF-8 CLI bridge |
| [Project context](project-context.md) | Workspace access probes, app context, and diagnostic attachments |
| [Usage](usage.md) | Provider token counts, Claude plan windows, Bonsai reporting, and tok/s telemetry |
| [Memory](memory.md) | Obsidian-ready shared/project Markdown notes, review queue, and context byte budgets |
| [Bots](bots.md) | Named personas, `soul.md`/`agent.md`, private memory, cron schedules, and handoffs |
| [Kanban](kanban.md) | Tasks, dependencies, bot assignments, Trash recovery, and GitHub issue bridging |
| [Plugins](plugins.md) | Community directory, permissions, installation, and TypeScript SDK |
| [Skills](skills.md) | `SKILL.md` instruction packs, GitHub directory search, and per-chat picking |
| [Remote access](remote-access.md) | Phone pairing via Tailscale HTTPS or USB cable, permissions, and revocation |
| [Android](android.md) | APK installation, QR pairing, and USB debugging setup |

## Legal and security

- [Legal status](../LEGAL.md), [terms draft](../TERMS.md), and [privacy draft](../PRIVACY.md).
- [Third-party notices](../THIRD_PARTY_NOTICES.txt) and [dependency inventory](../legal/dependencies.json).
- [Security reporting](../SECURITY.md).
- [Legal release guide](legal-release.md) for the publisher's remaining decisions.

## Development

- [Development guide](development.md): prerequisites, architecture, standalone Tauri builds, and test suites.
- [Contributing](../CONTRIBUTING.md): workflow and contribution/license status.
- [Brand notes](brand.md): background-free crystal `V` master, icon pipeline, and NSIS artwork.
- [Windows workspace standard](windows-workspace-standard-2026-09-29.md): local repository organization.

## Validation records

QA reports describe a specific build and environment; they are not guarantees about every future release, provider, or device. Recent records:

- [Host tool follow-up, October 1](qa-host-tools-2026-10-01.md).
- [Live counter diagnostics follow-up, September 30](qa-live-counters-2026-09-30.md).
- [Agent tools and independent timing, September 30](qa-agent-tools-2026-09-30.md).
- [Focused conversation UX, September 30](qa-focused-experience-2026-09-30.md).
- [Queue, status and provider metrics, September 30](qa-queue-provider-metrics-2026-09-30.md).
- [Themes and settings, September 30](qa-ui-customization-2026-09-30.md).
- [Recovery and reliability, September 30](qa-reliability-2026-09-30.md).
- [Provider access, September 29](provider-validation-2026-09-29.md).
- [Phone and USB, September 29](phone-qa-2026-09-29.md).
- [Legal/documentation audit, September 30](legal-audit-2026-09-30.md).
- [Installed documentation update, September 30](qa-legal-install-2026-09-30.md).

Older `qa-*.md` reports remain in this directory as historical records.
