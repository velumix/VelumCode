# Bots, memory, and scheduled work

[Back to Velum Code](../README.md)

A bot is a named identity you own. Its preferred CLI can change without changing its personality or private memory. **Claude Code**, **Bonsai 2**, **Muse**, **Codex**, and **Antigravity** all receive the same Velum instructions in Agent view (plus optional **Bonsai 2 `<8GB` Automation** profiles for continuous background watchdogs). Each CLI keeps its own authentication and conversation session.

## Create your team

Open **Bots → New bot** on desktop or a paired phone with control access.

1. Give the bot a name, specialty, picture, and accent color. Pictures are cropped locally to 160 × 160; no image host is used.
2. Choose its preferred provider, model, and reasoning level. Model availability comes from the installed CLI. These preferences apply to new chats and scheduled runs.
3. Edit **Personality & instructions**. `soul.md` describes identity, voice, values, and boundaries. `agent.md` describes how to work, verify results, use Kanban, and hand off. `{{name}}` and `{{role}}` expand to profile values.
4. Set its default schedule, timezone, run limit, and whether assigned tasks run automatically. Each card can override the schedule and automatic mode.
5. Save, then choose **Chat**. Selecting another provider opens a separate conversation with the same bot identity and memory.

New profiles offer **Builder**, **Reviewer**, and **Researcher** presets under **Start with a preset**. These fill the specialty, color, personality, and working instructions while retaining your chosen name, provider, and model. Presets start with automatic scheduling off; everything remains editable before saving.

**Duplicate** copies a saved profile into a new draft with a new identity. Its private memory starts empty and automatic scheduling is off. The original profile and vault remain unchanged. Save the draft to add it to your team; shared/project memory is still available if enabled in the profile.

Example `soul.md`:

```markdown
You are {{name}}, a calm and direct teammate specializing in {{role}}.
Explain uncertainty plainly. Keep answers concise and useful.
Never say work is finished without evidence.
```

Example `agent.md`:

```markdown
Check the supplied Kanban snapshot before choosing work.
Inspect the relevant files, implement the smallest complete change, and verify it.
Update the card with what changed, what passed, and any blockers.
When another bot has the right specialty, hand off with a concrete next step.
Keep durable project knowledge in memory; keep transient progress on the card.
```

Use **Open bot folder** to edit the Markdown in another editor. Changes are read on the next turn. Profiles live under the app configuration directory in `bots/<bot-id>/`; each contains `profile.json`, `soul.md`, and `agent.md`. Saves reject conflicting edits. Removing a bot unregisters it and stops its assigned work; its Markdown and memory remain on disk.

The profile approach is inspired by [Hermes profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles/) and [personality files](https://hermes-agent.nousresearch.com/docs/user-guide/features/personality). Velum has its own storage, runner, and handoff protocol. It does not import Hermes sessions or claim to reproduce model behavior exactly. Raw Terminal sessions remain the CLI's own interface; Velum personas apply in Agent view.

## Private, bounded memory

Each bot gets its own Markdown vault at `Documents/Velum Code/Memory/bots/<bot-id>/`. Within that vault, shared notes belong to the bot across workspaces; project notes belong to that bot in one workspace. Other bots do not recall those notes. **Bots → Memory** lets you create, edit, review, pin, archive, or delete them. Desktop users can open the private vault directly in Obsidian.

Optionally let the bot also recall the app's shared/project vault. This adds reference knowledge without giving other bots access to its private notes. Explicit handoff summaries can carry relevant knowledge to a teammate.

The 1 KB, 3 KB, or 8 KB profile budget includes memory excerpts and their framing/learning instructions, combined across both vaults. Shared recall can use up to a third; private recall can use the remainder, including unused shared space. The vault's own lower budget still applies. Personality and board context have separate limits; the memory budget is **not** the total prompt size or a token count.

Retrieval ranks relevant or pinned excerpts, limits each vault to four selected notes, skips unchanged notes for subsequent turns, and refreshes them periodically. Parsed notes are cached; manual Markdown edits are picked up on the next read. Full conversation archives and embedding services are not loaded into context.

New learned notes require review by default. Choose **Manual**, **Review**, or **Automatic** in that bot's memory settings for the workspace. Pending and archived notes never enter prompts. Failed or cancelled turns cannot save proposed memories, and malformed/oversized proposals are discarded.

## Kanban creates the jobs

Edit a Kanban card and choose **Assigned bot**. Saving creates one persistent job for that workspace/card. Set a preset or a five-field cron expression and an IANA timezone such as `America/Los_Angeles`. The editor previews the next three run times in your local display timezone.

| Schedule | Meaning |
| :-- | :-- |
| `*/15 * * * *` | Every 15 minutes |
| `0 * * * *` | Every hour |
| `0 9 * * 1-5` | Weekdays at 9 AM in the selected timezone |
| `30 18 * * *` | Daily at 6:30 PM in the selected timezone |

With **Run automatically on schedule** enabled, an assigned Backlog or In progress task runs when due. Otherwise it waits for **Run now**. **Bots → Schedules** provides Run now, Pause/Resume, Stop, and a global scheduling pause. Pausing global scheduling prevents new automatic starts; use Stop to end an active run. Manual Run now remains available while global scheduling is paused.

Tasks with unfinished or deleted prerequisites show **Waiting** with the blocker names. Neither automatic work nor Run now starts until all prerequisites are Done. Due dates and priorities order eligible automatic jobs; they do not change the cron expression. See [task planning and Trash](kanban.md) for details.

Velum must be running, either open or in the tray, and Windows must be awake. This is an in-app scheduler, not a Windows service or a wake timer. Quitting ends work. Jobs persist across restarts; a missed schedule runs once when available rather than replaying every missed interval. A crash marks active runs interrupted and pauses their jobs for review.

- One scheduled run at a time, with no overlap with an interactive turn in the same workspace.
- A per-bot limit of 1–120 minutes per run, 20 by default.
- Three failed runs pause the job; a cancelled run or rejected board action pauses it immediately.
- At most 24 automatic runs per card per UTC day. The job becomes eligible the next day; Run now is an explicit override.
- Review and Done stop future runs. Removing/reassigning the card or disabling/removing its bot stops the old run within the scheduler's five-second check interval.
- Up to 32 bot profiles, 500 assigned jobs, and 100 recent run records. Stored output is bounded to 16 KB per run; these records are not a complete audit archive.

Scheduled runs use standard provider permissions, never Velum's YOLO option. A provider requiring interactive approval may refuse the action; inspect the result and continue manually when needed. Profile instructions cannot grant tool permissions.

## Board updates and handoffs

You can ask, “Check Kanban, finish your assigned work, update the card, and hand off to Reviewer if it needs a review.” Bots receive a bounded board snapshot with their current task first and enabled teammates' names, IDs, specialties, and providers. For very large boards, omitted tasks are explicitly disclosed.

The CLI requests changes in a final `velum-action` JSON fence. Velum hides that protocol text from the conversation, validates it, and reports whether it was applied. It supports task updates, handoffs of existing tasks, and delegation of new tasks from interactive bot chats. It is a response protocol, not a CLI-native tool or MCP server; model compliance varies.

Every request is tied to a per-turn ticket and the board revision it saw. The host rejects stale revisions, unknown operations, invalid IDs, changes to another bot's tasks, disabled targets, and duplicate or oversized envelopes. Scheduled runs can change only their assigned card and cannot create additional cards. Actions apply only after the provider exits successfully. The app never assumes a request has already taken effect.

A task handoff changes the card's owner and transfers a concise summary into a **fresh** session using the receiving bot's provider/model/reasoning. It retains the card's existing automatic-run permission and uses the target's default cron/timezone. Automatic handoffs become eligible after five seconds; approval-mode handoffs still require Run now. Chains stop at four handoffs. The target does not inherit the previous bot's private vault or provider transcript.

Successful scheduled work without an explicit board action moves to Review. An explicit In progress update leaves the schedule active; Review/Done stops it. Rejected actions appear in Activity and pause the job for inspection.

For a conversational handoff, use **Hand off** beside the bot picker, then choose a teammate. Velum prepares a new conversation with a bounded excerpt of the last four messages. Review the draft and send it when ready; the source conversation stays intact.

## Review the results

**Bots → Activity** shows who ran each task, its provider, status, output, and any validation error. Background Windows notifications open Activity for scheduled work. A paired phone can manage the same profiles, private memory, schedules, and results; view-only devices cannot modify them or start runs.

Back up the app's `bots` directory, `automation.json`, your Markdown memory vault, and workspace Kanban files together. If schedule storage is unreadable, Velum pauses scheduling and preserves a copy before allowing new schedules to be written. If preservation fails, scheduling stays read-only until the storage issue is repaired.
