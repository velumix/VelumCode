# Agent tools

[Documentation](README.md) · [Project context](project-context.md) · [Usage](usage.md)

Velum supplies a local MCP bridge for the provider launched in a conversation.
Open **Settings → Preferences → Agent tools** to control it. The bridge runs
on the desktop host and is bound to the current turn, selected project and
current bot. A bot's shared-memory opt-in is respected; turning it off excludes the shared/project vault from that bot's search. Its permissions are separate from the CLI's shell sandbox.
YOLO does not enable desktop screenshots or native input.

## Capabilities

| Tool | Scope and behavior |
| --- | --- |
| `inspect_file` | A relative regular project file, up to 256 MiB; returns size and SHA-256, without its content |
| `delete_file` | Permanently removes one regular file after checking all 64 hexadecimal characters of `inspect_file.sha256`, copied unchanged. Shortened hashes are rejected. Rejects directories, parent traversal, links/redirecting reparse points, alternate streams and Git metadata. A changed file must be inspected again. |
| `workspace_search` | Literal text or filename search, with up to 50 results per page. Follow `next_cursor` until null. Cursors belong to this turn. |
| `git_status` | Reads the selected project's status with `safe.directory` for the detected repository in this command only; it does not edit global Git configuration or ownership. |
| `git_branches` | Lists local branches with upstream tracking for the selected project; same per-command `safe.directory` confinement, no writes. |
| `git_diff` | Reads the working-tree diff against a branch or revision (empty means HEAD), optionally for one repository-relative file; same confinement, no writes. |
| `git_log` | Reads recent commits, newest first (optional `limit` 1–50, default 20); same confinement, no writes. |
| `vault_search` | Searches enabled active shared/project notes and the current bot's private vault. Other projects/bots and pending/archived notes are excluded. Follow `next_offset`. Excerpts can be shorter than a whole note. |
| `turn_diagnostics` | Host clock, current provider token counters when available, their source, and observed MCP connections/calls. No tokenizer or browser timing is invented. |
| `browser_open`, `browser_snapshot`, `browser_action`, `browser_screenshot` | An isolated headless Edge/Chrome preview with navigation, semantic snapshots, CSS actions, page evaluation and PNG capture. Requires installed Edge/Chrome and Node.js 22 or newer. |
| `native_windows`, `native_screenshot` | Visible Windows window discovery and capture of a chosen window rectangle, when desktop screenshot permission is enabled |
| `native_input` | Focus, window-relative clicks, Unicode typing and supported keys, when native input permission is enabled |

Workspace file tools require a project directory; the initial user-profile
root is not a project. Git metadata is read only by the purpose-built status
command and is unavailable to file inspection, removal or search.

### File removal

Copy the complete `inspect_file.sha256` value into `delete_file.expected_sha256`.
A length or format rejection reports how many characters were supplied and
leaves the file intact. Inspect again after changing a file; a valid full hash
for different content is rejected separately.

### Search limits

OneDrive Cloud Files are allowed; reading them can hydrate online-only files through your sync service. Redirecting reparse points, including junctions and symbolic links, remain excluded.

Search excludes `.git`, links and these generated directories by default:
`node_modules`, `.preview`, `target`, `dist`, `dist-ssr`, `.qa`, `build`,
`.gradle`, `vendor`, `coverage`, `playwright-report`, and `test-results`.
It does **not** implement `.gitignore` matching. Unreadable/binary files and
text files over 2 MiB are skipped. Every page reports cumulative skipped
entries, scanned files and omitted categories. A skipped directory counts as
one entry, not as all of its descendants.

To inspect generated output, set `include_generated: true` and choose a
specific subdirectory or file. A page can contain no matches and still have a
continuation cursor because scanning work is bounded. Do not interpret one
page, or a search with omissions, as proof that no matching file exists.

### Browser and desktop access

The preview browser has its own temporary profile and loopback debugging
endpoint. It does not attach to an existing personal browser or reuse its
cookies. It closes when the turn ends and Velum attempts to remove its profile.
Startup verifies that the profile's debugging port has a live, matching browser
endpoint. If the first installed browser cannot start, Velum tries the other
installed browser with a fresh profile. Failure reports distinguish a launch
failure, an early process exit and a readiness timeout.
A crash, Windows lock or failed cleanup can leave a `velum-browser-<UUID>`
directory in the system temporary directory. It can contain page data, cookies
and downloads from that preview session. Review and remove abandoned profiles
when Velum is fully quit. Do not remove your everyday browser profile.

Desktop permissions default to off. Native capture sends visible pixels to
the selected provider; occluding windows and private information can appear.
Native input can interact with Windows apps under your account. It verifies
that Windows accepted focus before sending input. Protected/elevated windows
may reject it. Click coordinates and capture dimensions use physical pixels.
Only enable these capabilities for work you intend the agent
to perform. Screenshots and browser content are separate from the structural
chat layout attachment.

Disabling a capability blocks subsequent calls in an active turn. Enabling
one takes effect on the next turn. An operation already underway may finish.
Stop revokes the current turn's tool credentials; it does not undo changes or
recall data already received by the provider.

## Provider registration

Codex receives a per-turn `mcp_servers.velum_code` stdio configuration. Muse
and Antigravity currently have no equivalent run overlay in their installed
interfaces, so Velum merges a credential-free `velum_code` stdio entry into:

- Muse: `$XDG_CONFIG_HOME/muse/settings.json`, or `~/.config/muse/settings.json`.
- Antigravity: `~/.gemini/config/mcp_config.json`.

Existing settings and MCP servers are preserved, including Muse's existing
MCP spelling (`mcp_servers` or `mcpServers`). Ambiguous use of both is rejected.
Muse's required `schema_version: 1` is added to a new settings file.
Environment references forward the two ephemeral Velum transport variables
through Muse's restricted environment; expanded values are never saved.
Codex uses its `env_vars` allowlist for the same purpose. The Muse registration
is optional, so standalone sessions can continue with that server unavailable.

The exact original JSON file
is backed up once alongside it as `*.json.before-velum-tools`; that backup can
contain existing provider settings or credentials, so protect it like the
original. A conflicting `velum_code` entry or invalid JSON is reported instead
of replaced. The entry points to this Velum executable's `--velum-tool-stdio`
mode. It works only when launched by Velum with ephemeral turn credentials;
an ordinary standalone provider session cannot use it. Disable tools and
remove that managed MCP entry if you no longer want the integration. Existing
provider permission rules can still block MCP connections or calls.

The provider process also receives a selected-repository Git trust entry in
its child environment. A sandbox may strip inherited environment settings.
Use `git_status` in that case. No `safe.directory=*`, global Git edits or
Windows ACL changes are introduced.

## Verify a connection

For automated Windows checks, `npm run check:tools` verifies the isolated MCP
bridge, provider fixtures, project tools, preview browser and host/client timing.
Native desktop permissions stay off and the report marks those checks as
`not_requested`. Run `npm run check:tools:native` from an unlocked interactive
desktop to also test foreground input and window capture. Windows foreground
focus restrictions can make that check fail in unattended or locked sessions.

Open **Context → Diagnostics** after a turn. `turn_measurement.mcp_initialized`
records an actual initialize call, and tool calls/errors describe this run.
A setting or CLI installation alone is not connection evidence. Add the
previewed report to a message to let the agent compare host timing and the
desktop client's independent measurement. Report attachments exclude prompts,
credentials, raw logs and note contents; provider token counts are included.

Implementation references: [Codex MCP configuration](https://developers.openai.com/codex/mcp),
[Muse MCP configuration](https://meta-models.github.io/muse-code-sdk/next/guides/extend/mcp-servers/),
[Antigravity MCP configuration](https://antigravity.google/docs/mcp?tab=cli),
[Git safe.directory](https://git-scm.com/docs/git-config#Documentation/git-config.txt-safedirectory),
[Node WebSocket](https://nodejs.org/api/globals.html#class-websocket),
[Chromium screenshots](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot),
and [Windows SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput).
