import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import type { MemoryRequest, MemoryView } from "../memory";
import {
  newBot,
  botPresets,
  duplicateBot,
  when,
  type BotProfile,
  type BotRequest,
  type BotView,
  type AutomationView,
  type AutomationRequest,
} from "../bots";
import {
  providerNames,
  type Provider,
  type RunOptions,
  type ModelCatalog,
} from "../providers";
import BotAvatar from "./BotAvatar";
import ModelControls from "./ModelControls";
import ScheduleFields from "./ScheduleFields";
import Markdown from "./Markdown";
import Icon from "./Icon";
import "./BotsPanel.css";
const MemoryPanel = lazy(() => import("./MemoryPanel"));
const cleanView: BotView = { profiles: [], root: "", warnings: [] };
type Props = {
  renderInteractions?: (sessionId: string) => ReactNode;
  workspace: string;
  provider: Provider;
  options: RunOptions;
  request: (q: BotRequest) => Promise<BotView>;
  automation: (q: AutomationRequest) => Promise<any>;
  memory: (id: string, q: MemoryRequest) => Promise<MemoryView>;
  loadModels: (p: Provider, refresh: boolean) => Promise<ModelCatalog>;
  onClose: () => void;
  onChat?: (p: BotProfile) => void | Promise<void>;
  chatLabel?: string;
  onChange?: () => void;
  openFolder?: (id: string) => Promise<void>;
  readOnly?: boolean;
  initialPage?: "profiles" | "schedules" | "activity";
  openMemory?: (id: string) => Promise<void>;
};
export default function BotsPanel(props: Props) {
  const { request, automation, readOnly = false } = props;
  const [view, setView] = useState(cleanView);
  const [page, setPage] = useState<"profiles" | "schedules" | "activity">(
    props.initialPage || "profiles",
  );
  const [editor, setEditor] = useState<BotProfile | null>(null);
  const [section, setSection] = useState<
    "identity" | "instructions" | "automation"
  >("identity");
  const [jobs, setJobs] = useState<AutomationView | null>(null);
  const [selectedRun, setSelectedRun] = useState("");
  const [memory, setMemory] = useState<BotProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [discard, setDiscard] = useState(false);
  const [removing, setRemoving] = useState(false);
  const original = useRef("");
  const panel = useRef<HTMLDivElement>(null);
  const api = useRef(props);
  api.current = props;
  const dirty = !!editor && JSON.stringify(editor) !== original.current;
  useEffect(() => {
    let alive = true;
    const focus = document.activeElement as HTMLElement;
    panel.current?.focus();
    void api.current
      .request({ action: "list" })
      .then((v) => {
        if (alive) setView(v);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
      focus?.focus();
    };
  }, []);
  useEffect(() => {
    if (page === "profiles") return;
    let alive = true;
    let flight = false;
    const load = async () => {
      if (flight) return;
      flight = true;
      try {
        const v = await api.current.automation({ action: "list" });
        if (alive) setJobs(v);
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        flight = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [page]);
  const edit = (bot: BotProfile) => {
    original.current = JSON.stringify(bot);
    setEditor({ ...bot, options: { ...bot.options } });
    setSection("identity");
    setRemoving(false);
    setError("");
  };
  const close = () => {
    if (busy) return;
    if (dirty) {
      setDiscard(true);
      return;
    }
    if (editor) setEditor(null);
    else props.onClose();
  };
  const patch = (value: Partial<BotProfile>) =>
    setEditor((p) => (p ? { ...p, ...value } : p));
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const jobAction = (q: AutomationRequest) =>
    void run(async () => setJobs(await automation(q)));
  const preview = useRef((cron: string, timezone: string) =>
    api.current.automation({ action: "preview", cron, timezone }),
  ).current;
  const upload = async (file: File) => {
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 5 * 1024 * 1024
    )
      throw Error("Choose a PNG, JPEG or WebP under 5 MB.");
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 160;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw Error("Could not prepare the picture.");
      const side = Math.min(bitmap.width, bitmap.height);
      ctx.drawImage(
        bitmap,
        (bitmap.width - side) / 2,
        (bitmap.height - side) / 2,
        side,
        side,
        0,
        0,
        160,
        160,
      );
      const avatar = canvas.toDataURL("image/webp", 0.8);
      if (avatar.length > 48000) throw Error("Choose a smaller picture.");
      patch({ avatar });
    } finally {
      bitmap.close();
    }
  };
  if (memory)
    return (
      <Suspense fallback={null}>
        <MemoryPanel
          ownerName={memory.name}
          openVault={
            props.openMemory ? () => props.openMemory!(memory.id) : undefined
          }
          request={(q) => props.memory(memory.id, q)}
          onClose={() => setMemory(null)}
          readOnly={readOnly}
        />
      </Suspense>
    );
  const result = jobs?.runs.find((r) => r.id === selectedRun);
  return (
    <div className="bots-overlay">
      <div
        className="bots-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bots-heading"
        tabIndex={-1}
        ref={panel}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            close();
          }
          if (e.key !== "Tab") return;
          const nodes = [
            ...panel.current!.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]',
            ),
          ].filter((n) => n.offsetParent !== null);
          const first = nodes[0],
            last = nodes[nodes.length - 1];
          if (
            e.shiftKey &&
            (document.activeElement === first ||
              document.activeElement === panel.current)
          ) {
            e.preventDefault();
            last?.focus();
          } else if (
            !e.shiftKey &&
            (document.activeElement === last ||
              document.activeElement === panel.current)
          ) {
            e.preventDefault();
            first?.focus();
          }
        }}
      >
        <header className="bots-header" role="presentation">
          <div>
            <span className="bots-eyebrow">Your team</span>
            <h2 id="bots-heading">
              {editor ? editor.name || "New bot" : "Bots"}
            </h2>
            <p>
              {editor
                ? "A consistent identity, wherever the work runs."
                : "Personalities, private memory, and work that keeps moving."}
            </p>
          </div>
          <button aria-label="Close bots" disabled={busy} onClick={close}>
            <Icon name="close" size={18} />
          </button>
        </header>
        {error && (
          <p className="bot-error" role="alert">
            {error}
          </p>
        )}
        {discard && (
          <div className="bot-confirm" role="alert">
            <span>Discard unsaved bot changes?</span>
            <button
              onClick={() => {
                setDiscard(false);
                setEditor(null);
              }}
            >
              Discard changes
            </button>
            <button onClick={() => setDiscard(false)}>Keep editing</button>
          </div>
        )}
        {editor ? (
          <>
            <nav className="bots-nav" aria-label="Bot settings">
              {(["identity", "instructions", "automation"] as const).map(
                (s) => (
                  <button
                    key={s}
                    aria-pressed={section === s}
                    onClick={() => setSection(s)}
                  >
                    {s === "identity"
                      ? "Profile"
                      : s === "instructions"
                        ? "Personality & instructions"
                        : "Automation"}
                  </button>
                ),
              )}
              <button
                disabled={!editor.revision || busy}
                onClick={() => setMemory(editor)}
              >
                Memory
              </button>
            </nav>
            <form
              className="bot-editor"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const next = await request({
                    action: "save",
                    profile: editor,
                  });
                  setView(next);
                  const saved = next.profiles.find((p) => p.id === editor.id);
                  if (saved) edit(saved);
                  props.onChange?.();
                  setEditor(null);
                });
              }}
            >
              {section === "identity" && (
                <>
                  {!editor.revision && !readOnly && (
                    <details className="bot-presets">
                      <summary>Start with a preset</summary>
                      <p className="bot-help">
                        Use a starting personality and working style. Your
                        provider and model stay selected. You can edit
                        everything before saving.
                      </p>
                      <div>
                        {botPresets.map((preset) => (
                          <button
                            type="button"
                            key={preset.id}
                            disabled={busy}
                            onClick={() =>
                              patch({
                                name: editor.name || preset.name,
                                role: preset.role,
                                color: preset.color,
                                soul: preset.soul,
                                agent: preset.agent,
                                automatic: false,
                              })
                            }
                          >
                            {preset.name}
                            <small>{preset.role}</small>
                          </button>
                        ))}
                      </div>
                    </details>
                  )}
                  <div className="bot-picture">
                    <BotAvatar bot={editor} size={72} />
                    <div>
                      <label className="bot-file-button">
                        Upload picture
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          disabled={readOnly || busy}
                          onChange={async (e) => {
                            const input = e.currentTarget;
                            const file = input.files?.[0];
                            // Android's picker-backed file must stay selected until
                            // the asynchronous decoder has finished reading it.
                            if (file) await run(() => upload(file));
                            input.value = "";
                          }}
                        />
                      </label>
                      {editor.avatar && (
                        <button
                          type="button"
                          disabled={readOnly || busy}
                          onClick={() => patch({ avatar: "" })}
                        >
                          Use initials
                        </button>
                      )}
                    </div>
                    <label>
                      Accent
                      <input
                        type="color"
                        aria-label="Bot accent color"
                        value={editor.color}
                        disabled={readOnly || busy}
                        onChange={(e) => patch({ color: e.target.value })}
                      />
                    </label>
                  </div>
                  <div className="bot-fields">
                    <label>
                      Name
                      <input
                        aria-label="Bot name"
                        autoFocus
                        required
                        maxLength={80}
                        disabled={readOnly || busy}
                        value={editor.name}
                        placeholder="Grokbot"
                        onChange={(e) => patch({ name: e.target.value })}
                      />
                    </label>
                    <label>
                      Specialty
                      <input
                        aria-label="Bot specialty"
                        maxLength={500}
                        disabled={readOnly || busy}
                        value={editor.role}
                        placeholder="Implementation, code review, research…"
                        onChange={(e) => patch({ role: e.target.value })}
                      />
                    </label>
                  </div>
                  <label>
                    Preferred provider
                    <select
                      aria-label="Bot preferred provider"
                      value={editor.provider}
                      disabled={readOnly || busy}
                      onChange={(e) =>
                        patch({
                          provider: e.target.value as Provider,
                          options: { model: "", reasoning: "" },
                        })
                      }
                    >
                      {Object.entries(providerNames).map(([id, name]) => (
                        <option key={id} value={id}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <ModelControls
                    provider={editor.provider}
                    options={editor.options}
                    disabled={readOnly || busy}
                    load={props.loadModels}
                    onChange={async (options) => patch({ options })}
                  />
                  <p className="bot-help">
                    Used for new conversations and scheduled work. Switching
                    providers keeps this bot's identity and memory.
                  </p>
                  <label className="bot-check">
                    <input
                      type="checkbox"
                      checked={editor.enabled}
                      disabled={readOnly || busy}
                      onChange={(e) => patch({ enabled: e.target.checked })}
                    />
                    Bot enabled
                  </label>
                </>
              )}
              {section === "instructions" && (
                <>
                  <label>
                    soul.md{" "}
                    <span className="bot-help">
                      Personality, voice, values, and identity. {"{{name}}"}{" "}
                      uses the profile name.
                    </span>
                    <textarea
                      aria-label="soul.md"
                      rows={8}
                      maxLength={12000}
                      disabled={readOnly || busy}
                      value={editor.soul}
                      onChange={(e) => patch({ soul: e.target.value })}
                    />
                  </label>
                  <label>
                    agent.md{" "}
                    <span className="bot-help">
                      How this bot works, verifies results, and collaborates.
                    </span>
                    <textarea
                      aria-label="agent.md"
                      rows={8}
                      maxLength={12000}
                      disabled={readOnly || busy}
                      value={editor.agent}
                      onChange={(e) => patch({ agent: e.target.value })}
                    />
                  </label>
                  {props.openFolder && (
                    <button
                      type="button"
                      disabled={!editor.revision || busy}
                      onClick={() =>
                        void run(() => props.openFolder!(editor.id))
                      }
                    >
                      Open bot folder
                    </button>
                  )}
                  <label className="bot-check">
                    <input
                      type="checkbox"
                      checked={editor.shared_memory}
                      disabled={readOnly || busy}
                      onChange={(e) =>
                        patch({ shared_memory: e.target.checked })
                      }
                    />
                    Also recall shared and project memory
                  </label>
                  <label>
                    Combined memory budget
                    <select
                      aria-label="Bot memory budget"
                      value={editor.memory_budget}
                      disabled={readOnly || busy}
                      onChange={(e) =>
                        patch({ memory_budget: Number(e.target.value) })
                      }
                    >
                      <option value={1000}>1 KB · minimal</option>
                      <option value={3000}>3 KB · balanced</option>
                      <option value={8000}>8 KB · more context</option>
                    </select>
                  </label>
                  <p className="bot-help">
                    Only relevant excerpts are recalled. Private notes belong to
                    this bot and are kept across provider changes. Memory
                    settings control whether new notes need review.
                  </p>
                </>
              )}
              {section === "automation" && (
                <>
                  <h3>When a task is assigned</h3>
                  <ScheduleFields
                    cron={editor.default_cron}
                    timezone={editor.timezone}
                    automatic={editor.automatic}
                    disabled={readOnly || busy}
                    preview={preview}
                    onChange={(v) =>
                      patch({
                        default_cron: v.cron,
                        timezone: v.timezone,
                        automatic: v.automatic,
                      })
                    }
                  />
                  <div className="bot-fields">
                    <label>
                      Run time limit (minutes)
                      <input
                        type="number"
                        aria-label="Bot run time limit"
                        min={1}
                        max={120}
                        disabled={readOnly || busy}
                        value={editor.max_minutes}
                        onChange={(e) =>
                          patch({ max_minutes: Number(e.target.value) })
                        }
                      />
                    </label>
                  </div>
                  <label className="bot-check">
                    <input
                      type="checkbox"
                      disabled={readOnly || busy}
                      checked={editor.allow_handoffs}
                      onChange={(e) =>
                        patch({ allow_handoffs: e.target.checked })
                      }
                    />
                    Allow handoffs to teammates
                  </label>
                  <p className="bot-help">
                    One scheduled run at a time. Handoffs carry a summary into
                    the next bot's own provider session, with a maximum of four
                    steps. Three failed runs pause a job. Each task has a daily
                    limit of 24 automatic runs.
                  </p>
                </>
              )}
              <footer className="bot-editor-footer">
                <button type="button" disabled={busy} onClick={close}>
                  Back
                </button>
                {editor.revision && !readOnly && (
                  <button
                    type="button"
                    className="bot-danger"
                    disabled={busy}
                    onClick={() => setRemoving(true)}
                  >
                    Remove bot
                  </button>
                )}
                <span />
                {!readOnly && (
                  <button
                    className="bot-primary"
                    disabled={busy || !editor.name.trim()}
                  >
                    {busy ? "Saving…" : "Save bot"}
                  </button>
                )}
              </footer>
              {removing && (
                <div className="bot-confirm" role="alert">
                  <p>
                    Remove this bot? Its Markdown files and memory are kept.
                    Assigned jobs will stop until reassigned.
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        setView(
                          await request({
                            action: "delete",
                            id: editor.id,
                            revision: editor.revision,
                          }),
                        );
                        setEditor(null);
                        setRemoving(false);
                        props.onChange?.();
                      })
                    }
                  >
                    Remove bot
                  </button>
                  <button type="button" onClick={() => setRemoving(false)}>
                    Keep bot
                  </button>
                </div>
              )}
            </form>
          </>
        ) : (
          <>
            <nav className="bots-nav" aria-label="Bots pages">
              <button
                aria-pressed={page === "profiles"}
                onClick={() => setPage("profiles")}
              >
                Your bots
              </button>
              <button
                aria-pressed={page === "schedules"}
                onClick={() => setPage("schedules")}
              >
                Schedules
              </button>
              <button
                aria-pressed={page === "activity"}
                onClick={() => setPage("activity")}
              >
                Activity
              </button>
              <span />
              {page === "profiles" && (
                <button
                  aria-label="Refresh bots"
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      setView(await request({ action: "list" })),
                    )
                  }
                >
                  <Icon name="reset" size={16} />
                </button>
              )}
              {page === "profiles" && !readOnly && (
                <button
                  className="bot-primary"
                  onClick={() => edit(newBot(props.provider, props.options))}
                >
                  New bot
                </button>
              )}
            </nav>
            <div className="bots-body">
              {view.warnings.map((w) => (
                <p key={w} className="bot-error" role="alert">
                  {w}
                </p>
              ))}
              {page === "profiles" && (
                <div className="bot-grid">
                  {view.profiles.map((bot) => (
                    <article className="bot-card" key={bot.id}>
                      <div className="bot-card-title">
                        <BotAvatar bot={bot} size={44} />
                        <div>
                          <h3>{bot.name}</h3>
                          <small>
                            {providerNames[bot.provider]} ·{" "}
                            {bot.options.model || "Choose a model"}
                          </small>
                        </div>
                        {!bot.enabled && <small>Disabled</small>}
                      </div>
                      <p>
                        {bot.role || "Your own personality and working style."}
                      </p>
                      <div className="bot-card-actions">
                        {props.onChat && (
                          <button
                            className="bot-primary"
                            disabled={!bot.enabled || busy}
                            onClick={() =>
                              void run(async () => {
                                await props.onChat!(bot);
                              })
                            }
                          >
                            {props.chatLabel || "Chat"}
                          </button>
                        )}
                        <button onClick={() => edit(bot)}>
                          {readOnly ? "View profile" : "Edit bot"}
                        </button>
                        <button onClick={() => setMemory(bot)}>Memory</button>
                        {!readOnly && (
                          <button
                            title="Copy this profile with fresh private memory and automatic scheduling off"
                            disabled={busy || view.profiles.length >= 32}
                            onClick={() => edit(duplicateBot(bot))}
                          >
                            Duplicate
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
                  {!view.profiles.length && (
                    <div className="bot-empty">
                      <Icon name="code" size={32} />
                      <h3>Give your team a personality.</h3>
                      <p>
                        Create a bot with a name, picture, working style, and
                        preferred model. Its memory stays with it.
                      </p>
                      {!readOnly && (
                        <button
                          className="bot-primary"
                          onClick={() =>
                            edit(newBot(props.provider, props.options))
                          }
                        >
                          Create your first bot
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
              {page === "schedules" && (
                <>
                  {jobs ? (
                    <>
                      <div className="bot-schedule-heading">
                        <div>
                          <h3>
                            {jobs.enabled
                              ? "Scheduling is on"
                              : "Scheduling is paused"}
                          </h3>
                          <p className="bot-help">
                            Assign a bot in Kanban to create its job. Your
                            desktop must stay awake with Velum running.
                          </p>
                        </div>
                        <button
                          disabled={readOnly || busy}
                          onClick={() =>
                            jobAction({
                              action: "configure",
                              enabled: !jobs.enabled,
                            })
                          }
                        >
                          {jobs.enabled
                            ? "Pause scheduling"
                            : "Resume scheduling"}
                        </button>
                      </div>
                      {jobs.warning && (
                        <p className="bot-error" role="alert">
                          {jobs.warning}
                        </p>
                      )}
                      {jobs.jobs.length ? (
                        jobs.jobs.map((job) => (
                          <article className="bot-job" key={job.id}>
                            <div>
                              <h3>{job.title}</h3>
                              <p>
                                {view.profiles.find(
                                  (p) => p.id === job.assignment.bot_id,
                                )?.name || "Removed bot"}{" "}
                                · {job.status}
                                {job.paused ? " · Paused" : ""}
                              </p>
                              <small>
                                {job.workspace?.replace(/^\\\\\?\\/, "")}
                                <br />
                                {job.assignment.cron} ·{" "}
                                {job.assignment.timezone}
                                {job.status !== "complete"
                                  ? ` · Next: ${when(job.next_run)}`
                                  : ""}
                              </small>
                              {job.last_error && (
                                <p className="bot-error">{job.last_error}</p>
                              )}
                              {!!job.blocked_by?.length && (
                                <p className="bot-waiting">
                                  Waiting for: {job.blocked_by.join("; ")}.
                                  Scheduling continues once prerequisites are
                                  Done.
                                </p>
                              )}
                              {job.due_date && (
                                <p className="bot-help">Due {job.due_date}</p>
                              )}
                            </div>
                            <div className="bot-card-actions">
                              {job.status === "running" ? (
                                <button
                                  disabled={readOnly || busy}
                                  onClick={() =>
                                    jobAction({ action: "stop", id: job.id })
                                  }
                                >
                                  Stop
                                </button>
                              ) : (
                                <>
                                  <button
                                    disabled={
                                      readOnly ||
                                      busy ||
                                      job.status === "complete" ||
                                      !!job.blocked_by?.length
                                    }
                                    onClick={() =>
                                      jobAction({ action: "run", id: job.id })
                                    }
                                  >
                                    Run now
                                  </button>
                                  <button
                                    disabled={
                                      readOnly ||
                                      busy ||
                                      job.status === "complete"
                                    }
                                    onClick={() =>
                                      jobAction({
                                        action: "pause",
                                        id: job.id,
                                        paused: !job.paused,
                                      })
                                    }
                                  >
                                    {job.paused ? "Resume" : "Pause"}
                                  </button>
                                </>
                              )}
                            </div>
                          </article>
                        ))
                      ) : (
                        <div className="bot-empty">
                          <h3>No scheduled tasks yet.</h3>
                          <p>
                            Open Kanban, edit a task, and assign a bot. Its
                            schedule appears here automatically.
                          </p>
                        </div>
                      )}
                    </>
                  ) : (
                    <p role="status">Loading schedules…</p>
                  )}
                </>
              )}
              {page === "activity" && (
                <>
                  {result ? (
                    <article className="bot-run-detail">
                      <button onClick={() => setSelectedRun("")}>
                        Back to activity
                      </button>
                      <h3>{result.task}</h3>
                      <p>
                        {result.workspace?.replace(/^\\\\\?\\/, "")}
                        <br />
                        {result.bot_name} · {providerNames[result.provider]} ·{" "}
                        {result.status} · {when(result.started_at)}
                      </p>
                      {result.detail && (
                        <p
                          className={
                            result.status === "completed" || result.detail.startsWith('Waiting for your response.')
                              ? "bot-help"
                              : "bot-error"
                          }
                        >
                          {result.detail}
                        </p>
                      )}
                      <Markdown
                        text={result.output || "No response text was recorded."}
                      />
                      {result.status === 'running' && props.renderInteractions?.(result.session_id)}
                    </article>
                  ) : jobs ? (
                    <>
                      {[...jobs.runs].reverse().map((run) => (
                        <button
                          className="bot-run-row"
                          key={run.id}
                          onClick={() => setSelectedRun(run.id)}
                        >
                          <BotAvatar
                            bot={
                              view.profiles.find(
                                (p) => p.id === run.bot_id,
                              ) || {
                                name: run.bot_name,
                                avatar: "",
                                color: "#79a9ff",
                              }
                            }
                          />
                          <span>
                            <strong>{run.task}</strong>
                            <small>
                              {run.bot_name} · {providerNames[run.provider]} ·{" "}
                              {when(run.started_at)}
                            </small>
                          </span>
                          <span className={`bot-run-status ${run.status}`}>
                            {run.detail.startsWith('Waiting for your response.') ? 'awaiting response' : run.status}
                          </span>
                        </button>
                      ))}
                      {!jobs.runs.length && (
                        <div className="bot-empty">
                          <h3>A clear record of the work.</h3>
                          <p>
                            Scheduled runs and handoffs appear here with their
                            results. The most recent 100 runs are kept.
                          </p>
                        </div>
                      )}
                    </>
                  ) : (
                    <p role="status">Loading activity…</p>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
