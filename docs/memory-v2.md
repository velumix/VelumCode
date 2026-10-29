# Memory v2 design (smarter retrieval, clean-break store)

Status: design only, no implementation yet.
Decisions locked this round: focus = smarter retrieval; storage = clean break from the Markdown vault; deliverable = this doc.

## What v1 does today

Source: `docs/memory.md`, `src-tauri/src/memory.rs`, `docs/bots.md`.

- Store: local Markdown files under `Documents/Velum Code/Memory`, with `velum` JSON in frontmatter. Obsidian opens the same folder.
- Scopes: `shared/` plus `projects/<workspace-hash>/`. Bots get separate vaults under `bots/<bot-id>/`.
- Retrieval: lexical overlap only. Score = title/tag overlap x6 + body overlap + pinned bonus. Top 4 notes, best `"\n\n"` paragraph from each, max 1,200 bytes per excerpt, turn budget 1K/3K/8K bytes including framing.
- Reuse: unchanged excerpts suppressed for 7 turns, eligible again on the 8th. Edits eligible immediately; removed notes emit a withdrawal line.
- Capture: at most 2 model proposals per turn in a `velum-memory` fence, saved after successful exit. Default goes to Review; exact-duplicate bodies are dropped.
- Explicit non-goals in v1: no embeddings, no vector DB, no summarizer, no chat archive.

Where Obsidian parity hurts: filenames carry identity, frontmatter cannot evolve freely, links/backlinks are unused at query time, every turn re-reads files, and paraphrased facts become duplicates.

## Goal

Keep local-first and provider-neutral, but beat file-plus-keywords on retrieval quality:

1. Paraphrase queries still find the note.
2. Long notes return the right chunk, not the best paragraph guess.
3. Stale/duplicated knowledge merges or decays instead of piling up.
4. Bot, project, and task context filter at query time instead of living in separate vaults.

Non-goals for v2 slice 1: cloud sync, full conversation archive, background chat summarizer, cross-device merge.

## Storage: SQLite becomes truth, Markdown becomes export

Clean break means the app no longer treats hand-edited Markdown as the write path.

```text
<vault>/.v2/
  store.db          # source of truth (default journal; WAL not needed single-process)
  exports/          # generated Obsidian-readable view, one-way
    shared/*.md
    projects/<workspace-hash>/*.md
```

Tables (as implemented; `chunks`/`links`/embeddings stay future work):

- `records(id TEXT PK, title TEXT, body TEXT, tags JSON, scope TEXT, project_key TEXT, project_path TEXT, bot_id TEXT NULL, status TEXT, pinned INT, kind TEXT, source TEXT, created_at INT, updated_at INT, use_count INT, last_used INT, boost REAL)`
- `settings(project_key TEXT PK, enabled INT, capture TEXT, budget_bytes INT)`
- `tombstones(id TEXT PK)` so deletes survive re-sync
- `records_fts` (FTS5 on title, tags, body; `id UNINDEXED`) for candidate retrieval; chunks are ranked in Rust with BM25 plus boosts

Rules:

- All writes go through the app IPC command. The export folder is regenerated, never read back.
- `project_key` stays the canonical-path hash so existing scope semantics survive; also store the display path so a moved project can be re-pointed instead of orphaned.
- Slice 1 keeps one `.v2` store per vault (main plus each bot vault), so bot isolation stays directory-based for now; unifying into one store with a `bot_id` query filter is slice 3 work. The `bot_id` column already exists in the schema.
- Embeddings are local only (quantized ONNX MiniLM-class model shipped with the app, no network). A note without an embedding still retrieves lexically.
- Keep v1 safety rails: atomic writes, revision-checked edits, credential-pattern rejection, size caps. Add optional Windows DPAPI encryption for `store.db` later, not in slice 1.

## Retrieval: hybrid candidates, then cheap rerank

Per turn, one query path replaces the current `terms()` intersection:

1. Build query: current request + workspace path + bot id + card id (when launched from Kanban). Strip framing/credentials the same way v1 does.
2. Candidates: union of top ~20 from FTS5/BM25 and top ~20 from embedding cosine (chunk level). Pinned notes and notes linked to the active card are always candidates, not auto-included context.
3. Rerank with cheap local signals: BM25 rank, cosine rank, title/tag match, pin boost, recency decay, `use_count`/`score_boost` from explicit corrections, scope match (project > shared > other-project). Reciprocal-rank fusion is enough; no cross-encoder in slice 1.
4. Pack chunks greedily into the byte budget: best chunk first, then its immediate neighbor only if it adds query terms. Replace the fixed "4 notes x 1,200 bytes" with "as many chunks as fit, 6 chunk cap". Keep budgets byte-based (1K/3K/8K) so existing settings and usage UI keep working; add token estimates only as display.
5. Keep v1 session behavior: suppress unchanged chunk sets for 7 turns, withdraw edited/archived notes, reset the reuse cache on failed/stopped turns.

Why this beats Obsidian search: Obsidian finds words in files; v2 finds meaning across chunks, then explains itself with note titles plus chunk offsets in the usage strip.

## Capture: structured proposals with merge

Replace free-form title/body/tag proposals with a typed envelope (still max 2 per turn, still saved only after successful exit):

```json
[{"kind":"fact|decision|preference|lesson|entity","title":"...","body":"...","tags":[],"links":[],"supersedes":[],"expires_at":null}]
```

- `SaveLesson` from corrections writes `kind=lesson` with `score_boost` and a link to the corrected turn.
- On save, check duplicates by normalized body (v1 rule) OR embedding cosine above threshold plus title overlap. Duplicates route to Review as "merge into X" instead of creating a second note.
- `expires_at` plus `last_used` drive a "stale" review queue. Nothing auto-deletes; the user confirms archive.
- Provenance (`source`, `origin_turn`, card id) is stored but only titles/bytes enter future prompts, as today.

## UI and Obsidian story

- Memory panel stays the editor. Add chunk-level "why recalled" (matched terms + score class) in the recall strip; no raw vectors shown.
- "Open vault folder" becomes "Open export folder". Users who like Obsidian keep graph view and external editing as readers; the app re-imports nothing automatically. An explicit "Import dropped Markdown" action can exist for one-off files.
- Bot memory screen keeps working; it now filters the same store by `bot_id`.

## Migration from v1

One-time, explicit, reversible:

1. On first launch, detect `Documents/Velum Code/Memory` with v1 frontmatter.
2. Import each note: new UUID, preserve title/body/tags/scope/status/pinned/source/created/updated, compute `project_path` from the folder when known. Record `v1_file` in `source` for traceability.
3. Rename the old folder to `Memory.v1.backup-<date>`. Generate the first `exports/` tree.
4. Keep a read-only v1 importer for one release so a user can re-import a missed external edit, then remove it.

Rollback is copying the backup folder back and running the previous app version; v2 never writes v1 files.

## Rollout slices

1. (Implemented, behind `VELUM_MEMORY_V2=1`.) SQLite store at `<vault>/.v2/store.db` (rusqlite, bundled) with the v2 record schema, FTS5 candidate retrieval plus BM25 chunk ranking, one-way v1 sync by id with tombstones, v1-compatible framing/budgets/reuse, typed capture path, and one-way Obsidian export to `.v2/exports/`. A leftover slice-1a `store.json` is imported once on first open.
2. Add local embeddings and hybrid fusion; "why recalled" UI.
3. Merge suggestions, stale queue, card-linked recall, bot-filter unification.

## Open questions for the next round

- Ship size limit for the embedding model (target under ~50 MB quantized?).
- Keep per-workspace `settings.json` or move settings into `store.db` with a per-project row.
- Phone API stays excerpt-based; confirm no embedding bytes ever leave the desktop.
