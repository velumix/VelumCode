# Skills for Velum Code

Skills are Markdown instruction packs your agent follows when they fit the task: a review method, a writing style, a release checklist. Open **Skills** in the sidebar to browse the community directory, install from any GitHub repository, or write your own. Turn skills on per conversation with **Skills** beside the composer. A skill's text is added to the turn prompt for Muse, Codex and Antigravity alike; installing a skill never runs code and grants no tool permissions.

## Try Review checklist

1. Open **Skills** in Velum Code.
2. Find **Review checklist** in Browse, or use **Install from GitHub** with `velumix/velum-skill-review-checklist`.
3. Read the full instructions, then **Install skill**.
4. In a conversation, choose **Skills** beside the composer and turn on **Review checklist**. Ask for a review as usual.

The example also lives in [`examples/review-checklist`](../examples/review-checklist) in this repository, ready to copy into your own.

## Using skills

- **Per conversation.** The composer picker lists your enabled skills. Changes apply from your next message and are remembered with the conversation. Up to 8 skills can be on at once; their combined text is capped at 24 KB per turn, and a notice in the conversation names anything skipped (removed, disabled, or over budget).
- **Per bot.** A bot's **Default skills** (Bots → Instructions) seed every new conversation and scheduled run with that bot. Per-conversation choices still win afterward.
- **Library.** **Skills → Installed** enables or disables a skill everywhere, shows its full text, checks GitHub for updates, and removes it. Disabled skills stay out of the picker.
- **Command palette.** Enabled skills appear in **Ctrl+K** as on/off toggles for the current conversation.

When several skills are on, the agent is told to follow each one only when its stated conditions match the current request, and that your current request wins on conflict. Write the "use when" condition into the skill itself; there is no separate trigger engine. Skills do not apply to workspace access checks, and Terminal conversations talk to the CLI directly, so skills apply in Agent view. Conversations opened on the desktop keep their selection on a paired phone; managing skills is desktop-only for now.

## Where skills come from

Every repository skill is a **public GitHub repository** with `SKILL.md` at its root. Browse installs the commit listed in the community directory. Direct repository installs and **Check for updates** resolve the default branch to a commit. Velum downloads `SKILL.md` (and `velum-skill.json` when present) at that commit, shows you the exact text, and installs only those reviewed bytes. Files are copied into the app configuration directory; installed skills work offline.

**Read before you install.** Skill text becomes part of your agent's instructions and is sent to your chosen provider on every turn where the skill is on. That is powerful — and the reason the review screen shows the complete file. A skill cannot widen tool permissions beyond the current policy, but it can steer what the agent tries to do within them. Install skills from authors you trust, and re-read diffs on update: **Check for updates** shows the new text before anything changes. Updates preserve the enabled state. A different repository cannot silently replace an installed skill with the same ID.

The directory loads when you open Browse and is cached for one hour, with a Refresh button. If GitHub is unavailable, Velum keeps the saved list or shows its included starter list. There is no startup polling. Public repositories require no token. Private repositories, GitHub Enterprise, branch selectors and release archives are not supported. Installation review makes two bounded HTTPS requests for a listed commit, or three for a direct repository's current commit. Repository identity and commit pinning are provenance, not a publisher signature or endorsement.

**Local skills** need no repository: **Skills → New skill** writes one on this computer only. Local skills can be edited in place; repository skills are updated from GitHub instead. Removing a skill deletes its local copy.

## Publish to the directory

1. Open **Skills → Publish your skill**.
2. Paste your public GitHub repository and choose **Check repository**.
3. Review the detected details, then choose **Continue on GitHub**.
4. GitHub opens a submission with the repository and exact commit already filled in. Sign in, confirm you maintain the skill, and submit the form.
5. A maintainer reads the instructions and approves publication. GitHub Actions validates the pinned files and generates the directory the app reads.

The app does not collect your GitHub token and does not silently post submissions. Follow progress through **View submissions**. Publish an update through the same flow; existing installations remain pinned until their users review an update.

The directory is a separate public repository: [velumix/velum-code-skills](https://github.com/velumix/velum-code-skills). Approved snapshots are in `entries/`; `catalog.json` is generated automatically. Only a directory maintainer with write access can approve a submission. The workflow rejects duplicate IDs/repositories and malformed packages, and caps the directory at 500 entries / 1 MB. Removing an entry and regenerating the catalog removes its listing, without deleting users' installed skills.

Listings mean a version was accepted into the directory; they are not a security audit or a verified publisher badge. Always read the instructions before installation.

## Create your first skill

The fastest path stays inside the app: **Skills → New skill**, name it, describe when it applies, write the instructions, save. Turn it on in a conversation and iterate with **Edit**.

To share it, publish the same text as a GitHub repository:

```sh
mkdir my-skill && cd my-skill
# write SKILL.md (and optionally velum-skill.json)
git init -b main
git add .
git commit -m "Added skill"
gh repo create YOUR-USERNAME/my-skill --public --source . --remote origin --push
```

Use **Install from GitHub** to try your repository, then **Publish your skill** to share it in Browse. Choose the license for your own repository before distributing your text.

A minimal `SKILL.md`:

```md
---
name: Release notes writer
description: Draft release notes from merged changes, grouped by user impact.
---

# Release notes writer

Use this skill when the user asks for release notes.

## Method
1. Read the merged changes since the last tag.
2. Group by user impact, not by file.
3. Keep each entry to one line.
```

The frontmatter is a flat subset: single-line `key: value` pairs between `---` markers. Velum reads `name` and `description`; everything after the closing marker becomes the instructions (the frontmatter itself is not sent). Without `velum-skill.json`, the skill ID is derived as `owner.<name slug>`, the author is the repository owner, and the version shown is the short commit — so existing Muse `SKILL.md` repositories install as-is when the file sits at the repository root.

Add `velum-skill.json` for a stable ID, a real version and tags:

```json
{
  "apiVersion": 1,
  "id": "yourname.release-notes",
  "name": "Release notes writer",
  "version": "1.0.0",
  "description": "Draft release notes from merged changes, grouped by user impact.",
  "author": "Your name",
  "entry": "SKILL.md",
  "tags": ["writing", "release"]
}
```

IDs use lowercase letters, numbers, dots and hyphens, begin with a letter, and contain 3–64 characters. Use a publisher prefix to avoid collisions. Tags are up to 8 unique lowercase words. Velum rejects unknown manifest fields and unsupported API versions.

## Limits

| Limit | Value |
| --- | --- |
| Installed skills | 64 |
| SKILL.md size | 32 KB |
| Skills on per conversation | 8 |
| Skill text per turn | 24 KB (extras are skipped with a notice) |
| Directory size | 500 skills / 1 MB |

Skill text counts toward the provider's context on every turn where the skill is on, alongside app context, bot instructions and memory excerpts. Keep skills focused: a short skill that always applies beats a long one the agent must wade through. Installed files live under the app configuration directory (`skills/<id>.json` metadata plus a content-addressed `.md`); editing them by hand invalidates the review digest, and Velum will ask you to reinstall rather than run changed text.

## Skills vs plugins vs memory

- **Skills** teach the agent *how to work*: reusable instructions you switch per conversation or per bot.
- **Plugins** add local *commands* that run code in a sandbox and return text on demand; see the [plugin guide](plugins.md).
- **Memory** stores *facts* about you and your projects, recalled selectively per turn; see the [memory guide](memory.md).

## Test and distribute

- Test the skill on requests it should match and requests it should ignore; sharpen the "use when" line until both behave.
- Keep instructions provider-neutral where you can: the same text goes to Muse, Codex and Antigravity.
- Commit `SKILL.md` (and `velum-skill.json` if you use it) at the root of a public GitHub repository. Users install by repository URL and review updates from the default branch.
- Use an appropriate license for your skill text.
- Velum's Rust tests cover manifest validation, frontmatter parsing, review-digest binding and the per-turn budget; the directory repository has its own Node tests for catalog generation.
