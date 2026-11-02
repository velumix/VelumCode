import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import Icon from "./Icon";
import "./PluginPanel.css";
import "./PluginDirectory.css";
import "./SkillsPanel.css";
import {
  skillSubmissionUrl,
  type InstalledSkill,
  type LocalSkillDraft,
  type SkillCatalog,
  type SkillContent,
  type SkillPreview,
} from "../skills";

function Tags({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <span className="skill-tags">
      {tags.map((t) => (
        <span className="skill-tag" key={t}>
          {t}
        </span>
      ))}
    </span>
  );
}

function SkillDirectory({
  skills,
  busy,
  onReview,
  onManage,
  onAdd,
  onNew,
}: {
  skills: InstalledSkill[];
  busy: boolean;
  onReview: (repo: string, id?: string, commit?: string) => void;
  onManage: () => void;
  onAdd: () => void;
  onNew: () => void;
}) {
  const [view, setView] = useState<SkillCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const flight = useRef(false);
  const alive = useRef(true);
  const load = async (refresh: boolean) => {
    if (flight.current) return;
    flight.current = true;
    setLoading(true);
    setError("");
    try {
      const next = await invoke<SkillCatalog>("skills_catalog", { refresh });
      if (alive.current) setView(next);
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      flight.current = false;
      if (alive.current) setLoading(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    void load(false);
    return () => {
      alive.current = false;
    };
  }, []);
  const list =
    view?.catalog.skills.filter((s) =>
      `${s.manifest.name} ${s.manifest.description} ${s.manifest.author} ${s.repository} ${s.manifest.tags.join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) || [];
  return (
    <section className="plugin-directory" aria-label="Skill directory">
      <div className="plugin-directory-tools">
        <label className="plugin-search">
          <Icon name="search" size={17} />
          <input
            aria-label="Search skills"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search skills…"
            type="search"
          />
        </label>
        <button
          disabled={loading || busy}
          onClick={() => void load(true)}
          aria-label="Refresh skill directory"
        >
          <Icon name="reset" size={16} />
        </button>
      </div>
      {view?.notice && (
        <p className="plugin-catalog-notice" role="status">
          {view.notice}
        </p>
      )}
      {error && (
        <p className="plugin-error" role="alert">
          {error}
        </p>
      )}
      <div className="plugin-directory-heading">
        <span>
          {loading
            ? "Loading directory…"
            : `${list.length} ${list.length === 1 ? "skill" : "skills"}`}
        </span>
        <span>Reviewed listings · Works with every provider</span>
      </div>
      <div className="plugin-directory-grid" aria-busy={loading}>
        {list.map((s) => {
          const installed = skills.find((i) => i.manifest.id === s.manifest.id);
          const same = installed?.origin?.repository === s.repository;
          const exact = same && installed?.origin?.commit === s.commit;
          return (
            <article className="plugin-listing" key={s.manifest.id}>
              <div className="plugin-listing-heading">
                <span className="plugin-listing-icon">
                  <Icon name="sparkles" size={22} />
                </span>
                <div>
                  <h3>{s.manifest.name}</h3>
                  <span>By {s.manifest.author}</span>
                </div>
                <span className="plugin-listing-version">
                  v{s.manifest.version}
                </span>
              </div>
              <p>{s.manifest.description}</p>
              <Tags tags={s.manifest.tags} />
              <span className="plugin-listing-meta">
                Instructions only · No code runs
              </span>
              <div className="plugin-listing-actions">
                <button
                  className={exact ? "" : "plugin-primary"}
                  disabled={busy || loading}
                  onClick={() =>
                    exact
                      ? onManage()
                      : onReview(s.repository, s.manifest.id, s.commit)
                  }
                >
                  {exact
                    ? "Installed"
                    : installed
                      ? "Review listed version"
                      : "Review & install"}
                </button>
                <button
                  className="plugin-source-link"
                  onClick={() =>
                    void openUrl(
                      `https://github.com/${s.repository}/tree/${s.commit}`,
                    ).catch((e) => setError(String(e)))
                  }
                >
                  View on GitHub ↗
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {!loading && !list.length && (
        <div className="plugin-empty">
          <Icon name="search" size={27} />
          <strong>
            {search ? "No matching skills" : "The directory is getting started"}
          </strong>
          <p>
            {search
              ? "Try a different name, author or tag."
              : "Write your first skill, install one from any GitHub repository with a SKILL.md, or publish yours for everyone."}
          </p>
          {!search && (
            <button className="plugin-primary" onClick={onNew} disabled={busy}>
              New skill
            </button>
          )}
        </div>
      )}
      <div className="plugin-directory-note">
        <span>Already have a repository link?</span>
        <button onClick={onAdd} disabled={busy}>
          Install from GitHub
        </button>
      </div>
    </section>
  );
}

function PublishSkill() {
  const [repository, setRepository] = useState("");
  const [preview, setPreview] = useState<SkillPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [opened, setOpened] = useState(false);
  const nextButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (preview) {
      nextButton.current?.scrollIntoView({ block: "nearest" });
      nextButton.current?.focus();
    }
  }, [preview]);
  const check = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setPreview(null);
    setOpened(false);
    try {
      setPreview(
        await invoke<SkillPreview>("skills_preview", {
          repository: repository.trim(),
        }),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="plugin-publish" aria-label="Publish your skill">
      <span className="plugin-eyebrow">Made something useful?</span>
      <h3>Share it with everyone.</h3>
      <p>
        Your skill stays in your own GitHub repository as a SKILL.md file.
        Submit it once, and people can find and install it right here.
      </p>
      {!preview && (
        <ol className="plugin-publish-steps">
          <li>
            <strong>Check your repository</strong>
            <span>We read its SKILL.md and skill details.</span>
          </li>
          <li>
            <strong>Submit on GitHub</strong>
            <span>Sign in and send the prefilled submission.</span>
          </li>
          <li>
            <strong>Appear in the directory</strong>
            <span>A maintainer reviews the instructions before they go live.</span>
          </li>
        </ol>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void check();
        }}
      >
        <input
          aria-label="Your skill repository"
          placeholder="https://github.com/you/your-skill"
          value={repository}
          disabled={busy}
          onChange={(e) => {
            setRepository(e.target.value);
            setPreview(null);
            setOpened(false);
          }}
        />
        <button
          className="plugin-primary"
          disabled={busy || !repository.trim()}
        >
          {busy ? "Checking…" : "Check repository"}
        </button>
      </form>
      {error && (
        <p className="plugin-error" role="alert">
          {error}
        </p>
      )}
      {preview && (
        <div className="plugin-review">
          <div className="plugin-card-heading">
            <strong>{preview.manifest.name}</strong>
            <span>v{preview.manifest.version}</span>
          </div>
          <p>{preview.manifest.description}</p>
          <p>
            {preview.origin.repository} · {preview.origin.commit.slice(0, 7)}
          </p>
          <Tags tags={preview.manifest.tags} />
          <p>Repository checks passed · {Math.ceil(preview.bytes / 1024)} KB of instructions</p>
          <button
            ref={nextButton}
            className="plugin-primary"
            onClick={() => {
              void openUrl(skillSubmissionUrl(preview))
                .then(() => setOpened(true))
                .catch((e) => setError(String(e)));
            }}
          >
            Continue on GitHub ↗
          </button>
          <p className="plugin-publish-hint">
            GitHub opens with your repository and version filled in. Review the
            form and choose Submit new issue. Nothing is posted until you submit
            it there.
          </p>
        </div>
      )}
      {opened && (
        <p role="status" className="plugin-catalog-notice">
          Submission opened on GitHub. After you submit it, you can follow its
          review there.
        </p>
      )}
      <div className="plugin-directory-note">
        <button
          onClick={() =>
            void openUrl(
              "https://github.com/velumix/velum-code-skills/issues",
            ).catch((e) => setError(String(e)))
          }
        >
          View submissions ↗
        </button>
        <button
          onClick={() =>
            void openUrl(
              "https://github.com/velumix/VelumCode/blob/main/docs/skills.md",
            ).catch((e) => setError(String(e)))
          }
        >
          Create your first skill ↗
        </button>
      </div>
    </section>
  );
}

function SkillEditor({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial: LocalSkillDraft;
  busy: boolean;
  onSave: (draft: LocalSkillDraft) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [tagsText, setTagsText] = useState(initial.tags.join(", "));
  const [body, setBody] = useState(initial.body);
  const bytes = new TextEncoder().encode(body).length;
  const save = () => {
    const tags = Array.from(
      new Set(
        tagsText
          .toLowerCase()
          .split(/[,\s]+/)
          .map((t) => t.replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, ""))
          .filter(Boolean),
      ),
    ).slice(0, 8);
    onSave({
      id: initial.id ?? null,
      name: name.trim(),
      description: description.trim(),
      tags,
      body,
    });
  };
  return (
    <section className="skill-editor" aria-label={initial.id ? "Edit skill" : "New skill"}>
      <h3>{initial.id ? "Edit skill" : "New skill"}</h3>
      <p>
        Skills are plain Markdown instructions. When you enable a skill for a
        conversation, its text is sent to your chosen provider with each turn.
        Say when the skill applies, then how to work.
      </p>
      {initial.id && (
        <p className="skill-editor-id">
          ID <code>{initial.id}</code>
        </p>
      )}
      <label className="skill-field">
        Name
        <input
          aria-label="Skill name"
          value={name}
          disabled={busy}
          maxLength={80}
          placeholder="Release notes writer"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="skill-field">
        Description <span>(shown in Browse and the picker)</span>
        <input
          aria-label="Skill description"
          value={description}
          disabled={busy}
          maxLength={500}
          placeholder="Draft release notes from merged changes, grouped by user impact."
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <label className="skill-field">
        Tags <span>(comma separated, up to 8)</span>
        <input
          aria-label="Skill tags"
          value={tagsText}
          disabled={busy}
          placeholder="writing, release"
          onChange={(e) => setTagsText(e.target.value)}
        />
      </label>
      <label className="skill-field">
        Instructions
        <textarea
          className="skill-body-editor"
          aria-label="Skill instructions"
          value={body}
          disabled={busy}
          placeholder={
            "# Release notes writer\n\nUse this skill when the user asks for release notes.\n\n## Method\n1. Read the merged changes since the last tag.\n2. Group by user impact, not by file.\n3. Keep each entry to one line."
          }
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <div className="plugin-actions">
        <button
          className="plugin-primary"
          disabled={busy || !name.trim() || !description.trim() || !body.trim() || bytes > 32 * 1024}
          onClick={save}
        >
          {busy ? "Saving…" : initial.id ? "Save changes" : "Create skill"}
        </button>
        <button disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <small>
          {(bytes / 1024).toFixed(1)} KB / 32 KB
        </small>
      </div>
    </section>
  );
}

export default function SkillsPanel({
  skills,
  activeSkillIds,
  onToggleSkill,
  onRefresh,
  onClose,
}: {
  skills: InstalledSkill[];
  activeSkillIds: string[];
  onToggleSkill?: (id: string, on: boolean) => void;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const [repository, setRepository] = useState("");
  const [view, setView] = useState<"browse" | "installed" | "add" | "publish" | "edit">("browse");
  const [preview, setPreview] = useState<SkillPreview | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [remove, setRemove] = useState<string | null>(null);
  const [viewing, setViewing] = useState<SkillContent | null>(null);
  const [editDraft, setEditDraft] = useState<LocalSkillDraft | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    panel.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    const body = panel.current?.querySelector(".plugin-body");
    if (body) body.scrollTop = 0;
  }, [view, viewing]);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const review = (repo: string, expectedId?: string, commit?: string) =>
    void run(async () => {
      setNotice("");
      setPreview(null);
      setViewing(null);
      setView("add");
      const next = await invoke<SkillPreview>("skills_preview", {
        repository: repo,
        ...(commit ? { commit } : {}),
      });
      if (expectedId && next.manifest.id !== expectedId)
        throw new Error(
          "This repository changed its skill ID. Review it as a new installation.",
        );
      const current = skills.find((s) => s.manifest.id === next.manifest.id);
      if (
        current?.origin?.commit === next.origin.commit &&
        current.digest === next.digest
      ) {
        setNotice(`${next.manifest.name} is up to date.`);
        return;
      }
      setRepository(next.origin.repository);
      setPreview(next);
      requestAnimationFrame(() =>
        panel.current
          ?.querySelector(".plugin-install")
          ?.scrollIntoView({ block: "start" }),
      );
    });
  const openEditor = (skill?: InstalledSkill) =>
    void run(async () => {
      setNotice("");
      setViewing(null);
      if (skill) {
        const content = await invoke<SkillContent>("skills_content", {
          id: skill.manifest.id,
        });
        setEditDraft({
          id: skill.manifest.id,
          name: skill.manifest.name,
          description: skill.manifest.description,
          tags: skill.manifest.tags,
          body: content.body,
        });
      } else {
        setEditDraft({ id: null, name: "", description: "", tags: [], body: "" });
      }
      setView("edit");
    });
  const viewingSkill = viewing
    ? skills.find((s) => s.manifest.id === viewing.manifest.id)
    : undefined;
  const goView = (next: typeof view) => {
    setView(next);
    setViewing(null);
    setError("");
    setNotice("");
    setPreview(null);
  };
  return (
    <div
      className="plugin-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="plugin-panel"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="skills-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
          if (e.key !== "Tab") return;
          const nodes = Array.from(
            panel.current?.querySelectorAll<HTMLElement>(
              "button:not(:disabled), input, textarea, a[href]",
            ) || [],
          ).filter((el) => el.offsetParent !== null);
          const first = nodes[0],
            last = nodes[nodes.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          }
          if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }}
      >
        <div className="plugin-header">
          <div>
            <span className="plugin-eyebrow">Teach it your way</span>
            <h2 id="skills-title">Skills</h2>
          </div>
          <button
            className="plugin-close"
            aria-label="Close skills"
            onClick={onClose}
          >
            <Icon name="close" size={18} />
          </button>
        </div>
        <p className="plugin-intro">
          Instruction packs your agent follows when they fit the task. Pick
          skills per conversation from the composer; they work with Muse,
          Codex and Antigravity.
        </p>
        {!viewing && view !== "edit" && (
          <nav className="plugin-navigation" aria-label="Skill sections">
            <div>
              {(
                [
                  ["browse", "Browse"],
                  ["installed", `Installed (${skills.length})`],
                ] as const
              ).map(([id, title]) => (
                <button
                  key={id}
                  aria-current={view === id ? "page" : undefined}
                  disabled={busy}
                  onClick={() => goView(id)}
                >
                  {title}
                </button>
              ))}
            </div>
            <div className="skill-nav-actions">
              <button disabled={busy} onClick={() => openEditor()}>
                New skill
              </button>
              <button
                className="plugin-primary"
                disabled={busy}
                aria-current={view === "publish" ? "page" : undefined}
                onClick={() => goView("publish")}
              >
                Publish your skill
              </button>
            </div>
          </nav>
        )}
        {error && (
          <p className="plugin-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="plugin-notice" role="status">
            {notice}
          </p>
        )}
        <div className="plugin-body">
          {viewing ? (
            <>
              <button className="plugin-back" onClick={() => setViewing(null)}>
                ← All skills
              </button>
              <section className="plugin-run" aria-label="Skill instructions">
                <span className="plugin-eyebrow">
                  {viewingSkill?.origin ? viewingSkill.origin.repository : "Local skill"}
                </span>
                <h3>{viewing.manifest.name}</h3>
                <p>{viewing.manifest.description}</p>
                <Tags tags={viewing.manifest.tags} />
                <p>
                  By {viewing.manifest.author} · v{viewing.manifest.version} ·{" "}
                  {Math.ceil(new TextEncoder().encode(viewing.body).length / 1024)} KB
                </p>
                <div className="plugin-result">
                  <pre className="skill-body">{viewing.body}</pre>
                </div>
                <div className="plugin-actions">
                  {viewingSkill && onToggleSkill && (
                    <button
                      className="plugin-primary"
                      disabled={busy || !viewingSkill.enabled}
                      aria-pressed={activeSkillIds.includes(viewing.manifest.id)}
                      onClick={() =>
                        onToggleSkill(
                          viewing.manifest.id,
                          !activeSkillIds.includes(viewing.manifest.id),
                        )
                      }
                    >
                      {activeSkillIds.includes(viewing.manifest.id)
                        ? "On in this conversation ✓"
                        : "Use in this conversation"}
                    </button>
                  )}
                  {viewingSkill && !viewingSkill.origin && (
                    <button disabled={busy} onClick={() => openEditor(viewingSkill)}>
                      Edit
                    </button>
                  )}
                  {viewingSkill && !viewingSkill.enabled && (
                    <small>Enable this skill in Installed to use it.</small>
                  )}
                </div>
              </section>
            </>
          ) : view === "edit" && editDraft ? (
            <SkillEditor
              key={editDraft.id || "new"}
              initial={editDraft}
              busy={busy}
              onCancel={() => goView("installed")}
              onSave={(draft) =>
                void run(async () => {
                  const saved = await invoke<InstalledSkill>("skills_save_local", {
                    draft,
                  });
                  await onRefresh();
                  setEditDraft(null);
                  setView("installed");
                  setNotice(`${saved.manifest.name} saved. Enable it for a conversation from the composer.`);
                })
              }
            />
          ) : (
            <>
              {view === "browse" && (
                <SkillDirectory
                  skills={skills}
                  busy={busy}
                  onReview={review}
                  onManage={() => goView("installed")}
                  onAdd={() => goView("add")}
                  onNew={() => openEditor()}
                />
              )}
              {view === "publish" && <PublishSkill />}
              {view === "add" && (
                <section className="plugin-install" aria-label="Install a skill">
                  <h3>Install from GitHub</h3>
                  <p>
                    Every skill is a repository with a SKILL.md file. Paste its
                    public GitHub URL to read the full instructions before
                    installing.
                  </p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      review(repository.trim());
                    }}
                  >
                    <input
                      aria-label="GitHub repository"
                      placeholder="owner/repository or GitHub URL"
                      value={repository}
                      onChange={(e) => {
                        setRepository(e.target.value);
                        setPreview(null);
                        setNotice("");
                      }}
                      disabled={busy}
                    />
                    <button disabled={busy || !repository.trim()}>
                      {busy ? "Please wait…" : "Review skill"}
                    </button>
                  </form>
                  {preview && (
                    <div className="plugin-review">
                      <div className="plugin-card-heading">
                        <strong>{preview.manifest.name}</strong>
                        <span>
                          v{preview.manifest.version} ·{" "}
                          {Math.ceil(preview.bytes / 1024)} KB
                        </span>
                      </div>
                      <p>{preview.manifest.description}</p>
                      <p>By {preview.manifest.author} · Publisher not verified</p>
                      <Tags tags={preview.manifest.tags} />
                      <p className="plugin-origin">
                        {preview.origin.repository} · Commit{" "}
                        {preview.origin.commit.slice(0, 7)}{" "}
                        <button
                          disabled={busy}
                          onClick={() =>
                            void openUrl(
                              `https://github.com/${preview.origin.repository}/tree/${preview.origin.commit}`,
                            ).catch((e) => setError(String(e)))
                          }
                        >
                          View source ↗
                        </button>
                      </p>
                      {skills.some((s) => s.manifest.id === preview.manifest.id) && (
                        <p>
                          Update from v
                          {
                            skills.find((s) => s.manifest.id === preview.manifest.id)
                              ?.manifest.version
                          }
                          . Its enabled state is kept.
                        </p>
                      )}
                      <h4>Instructions sent to your provider when enabled</h4>
                      <p>
                        Read these in full. They become part of your agent's
                        instructions on turns where this skill is on. They grant
                        no tool permissions beyond the current policy.
                      </p>
                      <div className="plugin-result">
                        <pre className="skill-body">{preview.body}</pre>
                      </div>
                      <div className="plugin-actions">
                        <button
                          className="plugin-primary"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await invoke("skills_install", {
                                repository: preview.origin.repository,
                                reviewedDigest: preview.digest,
                              });
                              setPreview(null);
                              setRepository("");
                              await onRefresh();
                              setView("installed");
                              setNotice(`${preview.manifest.name} installed. Turn it on for a conversation from the composer.`);
                            })
                          }
                        >
                          Install skill
                          {skills.some((s) => s.manifest.id === preview.manifest.id)
                            ? " update"
                            : ""}
                        </button>
                        <button disabled={busy} onClick={() => setPreview(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              )}
              {view === "installed" && (
                <section aria-label="Installed skills">
                  <div className="plugin-section-title">
                    <h3>Installed</h3>
                    <span>{skills.length} / 64</span>
                  </div>
                  {!skills.length && (
                    <div className="plugin-empty">
                      <Icon name="sparkles" size={28} />
                      <strong>Teach it once, reuse it everywhere.</strong>
                      <p>
                        Install a skill from Browse or GitHub, or write your
                        own. Then turn it on per conversation from the composer.
                      </p>
                      <button className="plugin-primary" onClick={() => openEditor()} disabled={busy}>
                        New skill
                      </button>
                    </div>
                  )}
                  {skills.map((s) => (
                    <article className="plugin-card" key={s.manifest.id}>
                      <div className="plugin-card-heading">
                        <strong>{s.manifest.name}</strong>
                        <span>v{s.manifest.version}</span>
                        {activeSkillIds.includes(s.manifest.id) && (
                          <span className="skill-active-chip">On in this chat</span>
                        )}
                        <button
                          disabled={busy}
                          role="switch"
                          aria-checked={s.enabled}
                          aria-label={`Enable ${s.manifest.name}`}
                          onClick={() =>
                            void run(async () => {
                              await invoke("skills_enable", {
                                id: s.manifest.id,
                                enabled: !s.enabled,
                              });
                              await onRefresh();
                            })
                          }
                        >
                          {s.enabled ? "Enabled" : "Disabled"}
                        </button>
                      </div>
                      <p>{s.manifest.description}</p>
                      <Tags tags={s.manifest.tags} />
                      <small>By {s.manifest.author}</small>
                      {s.origin ? (
                        <div className="plugin-origin">
                          <button
                            onClick={() =>
                              void openUrl(
                                `https://github.com/${s.origin!.repository}/tree/${s.origin!.commit}`,
                              ).catch((e) => setError(String(e)))
                            }
                          >
                            {s.origin.repository} ↗
                          </button>
                          <span>{s.origin.commit.slice(0, 7)}</span>
                          <button
                            disabled={busy}
                            onClick={() => review(s.origin!.repository, s.manifest.id)}
                          >
                            Check for updates
                          </button>
                        </div>
                      ) : (
                        <p>Local skill · Stored only on this computer</p>
                      )}
                      <div className="plugin-commands">
                        <button
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              setViewing(
                                await invoke<SkillContent>("skills_content", {
                                  id: s.manifest.id,
                                }),
                              );
                            })
                          }
                        >
                          View instructions<span>↗</span>
                        </button>
                        {!s.origin && (
                          <button disabled={busy} onClick={() => openEditor(s)}>
                            Edit<span>↗</span>
                          </button>
                        )}
                        {onToggleSkill && (
                          <button
                            disabled={busy || !s.enabled}
                            aria-pressed={activeSkillIds.includes(s.manifest.id)}
                            onClick={() =>
                              onToggleSkill(
                                s.manifest.id,
                                !activeSkillIds.includes(s.manifest.id),
                              )
                            }
                          >
                            {activeSkillIds.includes(s.manifest.id)
                              ? "On in this chat ✓"
                              : "Use in this chat"}
                          </button>
                        )}
                      </div>
                      <button
                        className="plugin-remove"
                        disabled={busy}
                        onClick={() => setRemove(s.manifest.id)}
                      >
                        Remove
                      </button>
                      {remove === s.manifest.id && (
                        <div className="plugin-remove-confirm">
                          <span>Remove this skill from this computer?</span>
                          <button
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await invoke("skills_remove", { id: s.manifest.id });
                                setRemove(null);
                                await onRefresh();
                              })
                            }
                          >
                            Remove skill
                          </button>
                          <button onClick={() => setRemove(null)}>Keep</button>
                        </div>
                      )}
                    </article>
                  ))}
                </section>
              )}
            </>
          )}
        </div>
        <div className="plugin-footer">
          <span>Write your own</span>
          <button
            onClick={() =>
              void openUrl(
                "https://github.com/velumix/VelumCode/blob/main/docs/skills.md",
              ).catch((e) => setError(String(e)))
            }
          >
            Skill guide & example ↗
          </button>
        </div>
      </div>
    </div>
  );
}
