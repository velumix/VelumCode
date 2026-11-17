# Memory vault

Velum Code keeps durable context as local Markdown files. It shares the same vault across **Claude Code**, **Bonsai 2**, **Muse**, **Codex**, and **Antigravity**, while separating project facts from shared preferences. The desktop is the source of truth; the paired phone edits it through the authenticated remote API.

## Everyday use

Open **Memory**, choose **New note**, write one fact or decision, and save. The book icon beside a desktop message, or **Remember** on the phone, starts a note from that message. Long messages are shortened for editing rather than archived wholesale.

Project notes apply to the current workspace. Shared notes are eligible in every enabled workspace. Pin a note to make it eligible even when the current request has no matching keywords. Pending and archived notes never enter new context.

Settings apply per workspace:

| Setting | Behavior |
| --- | --- |
| Use memory | Enables retrieval and learning for this project. |
| Suggest notes for review | Default. Suggestions wait in **Review** until approved. |
| Save new notes automatically | New suggestions become active; an existing active title sends a conflicting suggestion to Review. |
| Only notes I save myself | Stops asking the agent for suggestions. Existing active notes still participate in retrieval. |
| Context limit | 1,000, 3,000 (default), or 8,000 UTF-8 bytes of total memory augmentation per turn. |

The app asks for at most two concise suggestions in the existing agent response. It does not make a second model call. Suggestions are accepted only after a successful process exit and completed turn. Malformed, oversized, or obvious credential-bearing suggestions are rejected; exact duplicates are not stored again. This is format-based capture, not a guarantee that every provider will identify every useful fact. **Remember** and **New note** are independent of model cooperation.

## Lessons from corrections

Use **Correct response** below an answer to explain what should change. Optionally select **Remember a lesson for this project**, review the wording, and send. An accepted correction saves that reviewed lesson as an active, pinned project note. It preserves a matching note's identity, avoiding duplicates when a save is retried. Bot conversations use the bot's private memory. You can edit or archive these notes through the normal editor.

Automatic suggestions can include lessons from user-confirmed corrections. A provider error alone does not establish a lesson. Under the default review mode, proposed notes wait for approval; **Memory** shows the number waiting. [The conversation guide](conversation-experience.md) explains the correction flow and recovery after a failed send or save.

## Files and Obsidian

The default location is the Windows Documents folder under `Velum Code/Memory`. Choose **Memory settings → Open vault folder** to locate it, then open that folder as an Obsidian vault if desired. A redirected Documents folder follows Windows' configured location; Velum does not add its own sync service.

```text
Memory/
  Welcome.md
  shared/
    short-title--<id>.md
  projects/
    <workspace-hash>/
      settings.json
      short-title--<id>.md
```

Each note has YAML frontmatter containing a `velum` metadata object and an Obsidian `aliases` entry, followed by its Markdown body. Preserve the `velum` object when editing externally. Filename changes are supported; moving a note between project folders changes where it is eligible. Plain Markdown files without Velum metadata are skipped with a warning. Create a note in the app first, then edit it anywhere.

The workspace key comes from its canonical path, case-insensitive on Windows. Moving a project to a different path creates a different scope; the old files remain available to move manually. Shared notes have no workspace key.

Reads use the current files on each turn. Content hashes detect edits even when filesystem timestamps are unchanged. The editor rejects a stale save or delete instead of overwriting a newer external edit. Writes use temporary files and rename. Delete is permanent; Archive is reversible. Directory links, linked files, invalid metadata, and oversized files are rejected. Notes are limited to 8,000 body bytes; automatic suggestions have a smaller 1,200-byte body limit.

## Retrieval and cost

Retrieval ranks active notes by words shared with the request, with extra weight for title/tag matches and pinned notes. It picks the most relevant paragraph from each selected note. Up to four excerpts of at most 1,200 bytes each enter a turn. Framing, withdrawal messages, and learning instructions count against the same hard byte limit.

Each live native conversation tracks the revision of notes already supplied. Unchanged excerpts are normally omitted for the next seven turns and become eligible again on the eighth. Edits are eligible immediately; archived/deleted notes get a withdrawal instruction. New conversations retrieve afresh. Failed or stopped turns reset the reuse cache, since the CLI may not have accepted its input.

The compact status strip above the desktop composer shows a context ring, average output-token speed, elapsed time, and memory added. Click it for exact provider counters and remaining context capacity. See [context and usage](usage.md) for availability and measurement details.

Memory usage reports actual bytes added. Memory token figures marked `~` are rough estimates, not billing counts; tokenization varies by model and language. This budget limits the memory added by Velum, not the provider's full conversation history or tool output. Providers may retain earlier context, so disabling or deleting a memory cannot erase it from an existing conversation. Start a fresh conversation to clear that context.

No vector database, embeddings, background summarizer, or full chat archive is created. This first version uses lexical matching rather than semantic search. Similar facts with different wording can still become separate notes; review and merge them manually. Terminal sessions keep their own CLI behavior and do not receive this prompt augmentation.

## Access

Notes are plain text on the desktop. Selected excerpts are passed to the CLI/provider chosen for that turn. Phone access uses the existing pairing, transport-scoped cookie, CSRF check, and control permission. The phone supplies a live session ID; the server resolves its workspace. It cannot provide an arbitrary vault path. Remote API responses are not stored in the service-worker cache.

An unavailable vault does not stop the application or prevent a normal agent turn. The app displays the error and sends the turn without memory. Invalid settings can be reset in the panel without deleting notes.

## Inspiration

[Hermes' memory design](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) demonstrates durable file-backed notes with bounded context and controlled updates. [Codex's local memories](https://learn.chatgpt.com/docs/customization/memories) distinguish lasting task knowledge from an individual conversation. Velum takes the local-file and selective-context ideas and implements its own provider-neutral vault; it does not read or modify either product's private memory store.
