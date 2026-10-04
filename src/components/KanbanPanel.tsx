import { useEffect, useRef, useState } from "react";
import {
  columns,
  type Board,
  type BoardRequest,
  type Card,
  type Column,
  taskBlockers,
  localDate,
  isOverdue,
  needsAttention,
  formatDue,
} from "../kanban";
import Icon from "./Icon";
import "./KanbanPanel.css";
import { assignmentFor, type BotProfile } from "../bots";
import BotAvatar from "./BotAvatar";
import ScheduleFields from "./ScheduleFields";

export default function KanbanPanel({
  workspace,
  request,
  onClose,
  onWork,
  readOnly = false,
  bots = [],
  previewSchedule,
}: {
  workspace: string;
  request: (q: BoardRequest) => Promise<Board>;
  onClose: () => void;
  onWork?: (card: Card) => void | Promise<void>;
  readOnly?: boolean;
  bots?: BotProfile[];
  previewSchedule?: (
    cron: string,
    timezone: string,
  ) => Promise<{ times: number[] }>;
}) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<Card | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [search, setSearch] = useState("");
  const [dragging, setDragging] = useState("");
  const [view, setView] = useState<"board" | "attention" | "trash">("board");
  const [purging, setPurging] = useState("");
  const [today, setToday] = useState(localDate);
  const [discard, setDiscard] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const requestRef = useRef(request);
  requestRef.current = request;
  const original = useRef("");
  const dirty = !!editor && JSON.stringify(editor) !== original.current;
  const closeEditor = () => {
    setEditor(null);
    setConfirmDelete(false);
    setDiscard(false);
  };
  const edit = (card: Card) => {
    original.current = JSON.stringify(card);
    setEditor({ ...card });
    setConfirmDelete(false);
  };
  const close = () => {
    if (busy) return;
    if (dirty) {
      setDiscard(true);
      return;
    }
    if (editor) closeEditor();
    else onClose();
  };
  const perform = async (q: BoardRequest, done?: () => void) => {
    if (inFlight.current || (q.action !== "load" && readOnly)) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      setBoard(await requestRef.current(q));
      done?.();
    } catch (e) {
      setError(String(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    void perform({ action: "load" });
    const timer = setInterval(() => setToday(localDate()), 60000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    panel.current?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    if (editor)
      panel.current?.querySelector<HTMLInputElement>("#kanban-title")?.focus();
  }, [editor?.id]);
  const move = (card: Card, column: Column, before: string | null = null) => {
    if (board)
      void perform({
        action: "move",
        revision: board.revision,
        id: card.id,
        column,
        before,
      });
  };
  const project =
    workspace
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || "Workspace";
  const visible =
    board?.cards.filter(
      (c) =>
        `${c.title} ${c.description}`
          .toLowerCase()
          .includes(search.toLowerCase()) &&
        (view !== "attention" || needsAttention(c, board.cards, today)),
    ) || [];
  const attentionCount =
    board?.cards.filter((c) => needsAttention(c, board.cards, today)).length ||
    0;
  const planning = (card: Card) => {
    const blocked = taskBlockers(card, board?.cards || []);
    return (
      <div className="kanban-planning">
        {card.due_date && (
          <span className={isOverdue(card, today) ? "overdue" : ""}>
            {isOverdue(card, today) ? "Overdue · " : "Due "}
            {formatDue(card.due_date)}
          </span>
        )}
        {card.column !== "done" && blocked.length > 0 && (
          <span className="blocked" title={blocked.join("; ")}>
            Waiting on {blocked.length}{" "}
            {blocked.length === 1 ? "prerequisite" : "prerequisites"}
          </span>
        )}
        {view === "attention" && card.column === "review" && (
          <span className="review">Ready for review</span>
        )}
      </div>
    );
  };
  return (
    <div className="kanban-overlay">
      <div
        className="kanban-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kanban-heading"
        tabIndex={-1}
        ref={panel}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            close();
          }
          if (e.key !== "Tab") return;
          const nodes = Array.from(
            panel.current?.querySelectorAll<HTMLElement>(
              "button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)",
            ) || [],
          ).filter((n) => n.offsetParent !== null);
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
        <div className="kanban-header">
          <div>
            <span className="kanban-eyebrow" title={workspace}>
              {project}
            </span>
            <h2 id="kanban-heading">{editor ? "Task details" : "Kanban"}</h2>
          </div>
          <div className="kanban-header-actions">
            <button
              disabled={busy}
              onClick={() => void perform({ action: "load" })}
              title="Load the latest board"
            >
              <Icon name="reset" size={16} />
              Refresh
            </button>
            <button aria-label="Close Kanban" disabled={busy} onClick={close}>
              <Icon name="close" size={18} />
            </button>
          </div>
        </div>
        {error && (
          <p className="kanban-error" role="alert">
            {error}
          </p>
        )}
        {discard && (
          <div className="kanban-discard" role="alert">
            <span>Discard your unsaved card changes?</span>
            <button onClick={closeEditor}>Discard changes</button>
            <button onClick={() => setDiscard(false)}>Keep editing</button>
          </div>
        )}
        {editor ? (
          <form
            className="kanban-editor"
            onSubmit={(e) => {
              e.preventDefault();
              if (board)
                void perform(
                  { action: "save", revision: board.revision, card: editor },
                  closeEditor,
                );
            }}
          >
            <label htmlFor="kanban-title">Title</label>
            <input
              id="kanban-title"
              value={editor.title}
              maxLength={160}
              required
              disabled={busy || readOnly}
              onChange={(e) => setEditor({ ...editor, title: e.target.value })}
              placeholder="What needs to happen?"
            />
            <label htmlFor="kanban-details">Details</label>
            <textarea
              id="kanban-details"
              value={editor.description}
              maxLength={8000}
              rows={8}
              disabled={busy || readOnly}
              onChange={(e) =>
                setEditor({ ...editor, description: e.target.value })
              }
              placeholder="Context, acceptance criteria, links…"
            />
            <div className="kanban-fields">
              <label>
                Status
                <select
                  aria-label="Task status"
                  value={editor.column}
                  disabled={busy || readOnly}
                  onChange={(e) =>
                    setEditor({ ...editor, column: e.target.value as Column })
                  }
                >
                  {columns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Priority
                <select
                  aria-label="Task priority"
                  value={editor.priority}
                  disabled={busy || readOnly}
                  onChange={(e) =>
                    setEditor({
                      ...editor,
                      priority: e.target.value as Card["priority"],
                    })
                  }
                >
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                </select>
              </label>
            </div>
            <label htmlFor="kanban-due">
              Due date <small>(optional)</small>
            </label>
            <input
              id="kanban-due"
              type="date"
              value={editor.due_date || ""}
              disabled={busy || readOnly}
              onChange={(e) =>
                setEditor({ ...editor, due_date: e.target.value || null })
              }
            />
            <fieldset
              className="kanban-dependencies"
              disabled={busy || readOnly}
            >
              <legend>Prerequisites</legend>
              <p>
                Scheduled work waits until every selected task is Done. Choose
                up to 20.
              </p>
              <div>
                {board?.cards
                  .filter((c) => c.id !== editor.id)
                  .map((c) => (
                    <label key={c.id}>
                      <input
                        type="checkbox"
                        checked={editor.dependencies?.includes(c.id) || false}
                        disabled={
                          !editor.dependencies?.includes(c.id) &&
                          (editor.dependencies?.length || 0) >= 20
                        }
                        onChange={(e) =>
                          setEditor({
                            ...editor,
                            dependencies: e.target.checked
                              ? [...(editor.dependencies || []), c.id]
                              : (editor.dependencies || []).filter(
                                  (id) => id !== c.id,
                                ),
                          })
                        }
                      />
                      <span>
                        {c.title}
                        <small>
                          {
                            columns.find((column) => column.id === c.column)
                              ?.title
                          }
                        </small>
                      </span>
                    </label>
                  ))}
              </div>
              {(editor.dependencies || [])
                .filter((id) => !board?.cards.some((c) => c.id === id))
                .map((id) => (
                  <label key={id}>
                    <input
                      type="checkbox"
                      checked
                      onChange={() =>
                        setEditor({
                          ...editor,
                          dependencies: editor.dependencies!.filter(
                            (value) => value !== id,
                          ),
                        })
                      }
                    />
                    <span>
                      Deleted prerequisite
                      <small>
                        Restore it from Trash or uncheck to remove the
                        dependency.
                      </small>
                    </span>
                  </label>
                ))}
              {!board?.cards.some((c) => c.id !== editor.id) &&
                !editor.dependencies?.length && (
                  <p>Add another task to use it as a prerequisite.</p>
                )}
            </fieldset>
            <label>
              Assigned bot
              <span className="kanban-assignee-pick">
                {editor.assignment && (
                  <BotAvatar
                    bot={
                      bots.find(
                        (b) => b.id === editor.assignment!.bot_id,
                      ) || {
                        name: "Removed bot",
                        avatar: "",
                        color: "#92a6c0",
                      }
                    }
                    size={28}
                    status={(() => {
                      const picked = bots.find(
                        (b) => b.id === editor.assignment!.bot_id,
                      );
                      if (!picked) return "disabled";
                      return picked.enabled ? "idle" : "disabled";
                    })()}
                  />
                )}
                <select
                  aria-label="Assigned bot"
                  value={editor.assignment?.bot_id || ""}
                  disabled={busy || readOnly}
                  onChange={(e) => {
                    const bot = bots.find((b) => b.id === e.target.value);
                    setEditor({
                      ...editor,
                      assignment: bot ? assignmentFor(bot) : null,
                    });
                  }}
                >
                  <option value="">Unassigned</option>
                  {bots
                    .filter(
                      (b) => b.enabled || b.id === editor.assignment?.bot_id,
                    )
                    .map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                        {b.enabled ? "" : " (disabled)"}
                      </option>
                    ))}
                  {editor.assignment &&
                    !bots.some((b) => b.id === editor.assignment!.bot_id) && (
                      <option value={editor.assignment.bot_id}>
                        Removed bot · choose another
                      </option>
                    )}
                </select>
              </span>
            </label>
            {editor.assignment && (
              <div className="kanban-schedule">
                <h3>Task schedule</h3>
                <ScheduleFields
                  cron={editor.assignment.cron}
                  timezone={editor.assignment.timezone}
                  automatic={editor.assignment.automatic}
                  disabled={busy || readOnly}
                  preview={previewSchedule}
                  onChange={(value) =>
                    setEditor({
                      ...editor,
                      assignment: { ...editor.assignment!, ...value },
                    })
                  }
                />
                <p className="bot-help">
                  Saving creates or updates this task's job. Unassigning removes
                  it. Manage runs in Bots → Schedules.
                </p>
              </div>
            )}
            {editor.last_summary && (
              <div className="kanban-bot-summary">
                <strong>Last bot update</strong>
                <p>{editor.last_summary}</p>
              </div>
            )}
            <div className="kanban-editor-actions">
              <button
                type="submit"
                className="kanban-primary"
                disabled={busy || readOnly || !editor.title.trim()}
              >
                {busy ? "Saving…" : "Save task"}
              </button>
              <button type="button" disabled={busy} onClick={close}>
                {readOnly ? "Back to board" : "Cancel"}
              </button>
              {board?.cards.some((c) => c.id === editor.id) && !readOnly && (
                <button
                  type="button"
                  className="kanban-delete"
                  disabled={busy}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete task
                </button>
              )}
            </div>
            {confirmDelete && (
              <div className="kanban-discard">
                <span>
                  Move “{editor.title}” to Trash? You can restore it for 30
                  days, up to the 50 most recent deletions.
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (board)
                      void perform(
                        {
                          action: "delete",
                          revision: board.revision,
                          id: editor.id,
                        },
                        closeEditor,
                      );
                  }}
                >
                  Move to Trash
                </button>
                <button type="button" onClick={() => setConfirmDelete(false)}>
                  Keep task
                </button>
              </div>
            )}
          </form>
        ) : (
          <>
            <div className="kanban-tools">
              <div>
                <strong>{board?.cards.length || 0} tasks</strong>
                <span>
                  {board?.cards.filter((c) => c.column === "done").length || 0}{" "}
                  done{readOnly ? " · View only" : " · Saved on your desktop"}
                </span>
              </div>
              <input
                aria-label="Search tasks"
                type="search"
                placeholder="Search tasks…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <nav className="kanban-views" aria-label="Task views">
              <button
                aria-pressed={view === "board"}
                onClick={() => setView("board")}
              >
                Board
              </button>
              <button
                aria-pressed={view === "attention"}
                onClick={() => setView("attention")}
              >
                Needs attention <span>{attentionCount}</span>
              </button>
              <button
                aria-pressed={view === "trash"}
                onClick={() => setView("trash")}
              >
                Trash <span>{board?.trash?.length || 0}</span>
              </button>
            </nav>
            {view === "trash" ? (
              <div className="kanban-trash" aria-busy={busy}>
                <p>
                  Deleted tasks stay here for 30 days, up to the 50 most recent.
                  Restoring keeps their details and turns automatic work off.
                </p>
                {(board?.trash || [])
                  .filter((entry) =>
                    `${entry.card.title} ${entry.card.description}`
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                  )
                  .map((entry) => (
                    <article key={entry.card.id} className="kanban-trash-card">
                      <h3>{entry.card.title}</h3>
                      <small>
                        Deleted{" "}
                        {new Date(entry.deleted_at * 1000).toLocaleDateString()}
                      </small>
                      <p>{entry.card.description}</p>
                      <div>
                        <button
                          disabled={busy || readOnly}
                          aria-label={`Restore ${entry.card.title}`}
                          onClick={() =>
                            board &&
                            void perform({
                              action: "restore",
                              revision: board.revision,
                              id: entry.card.id,
                            })
                          }
                        >
                          Restore task
                        </button>
                        {!readOnly && (
                          <button
                            disabled={busy}
                            onClick={() => setPurging(entry.card.id)}
                          >
                            Delete permanently
                          </button>
                        )}
                      </div>
                      {purging === entry.card.id && (
                        <div className="kanban-discard" role="alert">
                          <span>
                            Permanently delete this task? This cannot be undone.
                          </span>
                          <button
                            disabled={busy || readOnly}
                            onClick={() =>
                              board &&
                              void perform(
                                {
                                  action: "purge",
                                  revision: board.revision,
                                  id: entry.card.id,
                                },
                                () => setPurging(""),
                              )
                            }
                          >
                            Confirm permanent deletion
                          </button>
                          <button onClick={() => setPurging("")}>
                            Keep in Trash
                          </button>
                        </div>
                      )}
                    </article>
                  ))}
                {!board?.trash?.length && (
                  <div className="kanban-empty">Trash is empty.</div>
                )}
              </div>
            ) : (
              <div
                className={`kanban-columns${view === "attention" ? " kanban-attention" : ""}`}
                aria-busy={busy}
              >
                {(view === "attention"
                  ? [{ id: "backlog" as const, title: "Needs attention" }]
                  : columns
                ).map((column) => {
                  const cards =
                    view === "attention"
                      ? [...visible].sort(
                          (a, b) =>
                            (a.due_date || "9999").localeCompare(
                              b.due_date || "9999",
                            ) ||
                            Number(b.column === "review") -
                              Number(a.column === "review"),
                        )
                      : visible.filter((c) => c.column === column.id);
                  return (
                    <section
                      className={`kanban-column ${column.id}`}
                      key={column.id}
                      aria-label={column.title}
                      onDragOver={(e) => {
                        if (dragging && !readOnly && view === "board")
                          e.preventDefault();
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const card = board?.cards.find(
                          (c) => c.id === dragging,
                        );
                        if (card && !readOnly && view === "board")
                          move(card, column.id);
                        setDragging("");
                      }}
                    >
                      <div className="kanban-column-heading">
                        <h3>
                          <i />
                          {column.title}
                        </h3>
                        <span>{cards.length}</span>
                        {view === "board" && (
                          <button
                            aria-label={`Add task to ${column.title}`}
                            disabled={
                              busy ||
                              readOnly ||
                              !board ||
                              board.cards.length >= 300
                            }
                            onClick={() =>
                              edit({
                                id: crypto.randomUUID(),
                                title: "",
                                description: "",
                                column: column.id,
                                priority: "normal",
                              })
                            }
                          >
                            <Icon name="plus" size={18} />
                          </button>
                        )}
                      </div>
                      <div className="kanban-cards">
                        {cards.map((card, index) => (
                          <article
                            className={`kanban-card${dragging === card.id ? " dragging" : ""}`}
                            key={card.id}
                            draggable={
                              !busy && !readOnly && !search && view === "board"
                            }
                            onDragStart={(e) => {
                              e.dataTransfer.setData("text/plain", card.id);
                              e.dataTransfer.effectAllowed = "move";
                              setDragging(card.id);
                            }}
                            onDragEnd={() => setDragging("")}
                            onDrop={(e) => {
                              if (dragging && dragging !== card.id) {
                                e.preventDefault();
                                e.stopPropagation();
                                const from = board?.cards.find(
                                  (c) => c.id === dragging,
                                );
                                if (from) move(from, column.id, card.id);
                                setDragging("");
                              }
                            }}
                          >
                            <span
                              className={`kanban-priority ${card.priority}`}
                            >
                              {card.priority} priority
                            </span>
                            <button
                              className="kanban-card-title"
                              onClick={() => edit(card)}
                            >
                              {card.title}
                            </button>
                            {planning(card)}
                            {card.description && <p>{card.description}</p>}
                            {card.assignment && (
                              <div className="kanban-assignee">
                                <BotAvatar
                                  bot={
                                    bots.find(
                                      (b) => b.id === card.assignment!.bot_id,
                                    ) || {
                                      name: "Removed bot",
                                      avatar: "",
                                      color: "#92a6c0",
                                    }
                                  }
                                  size={24}
                                  status={(() => {
                                    const assignee = bots.find(
                                      (b) => b.id === card.assignment!.bot_id,
                                    );
                                    if (!assignee) return "disabled";
                                    return assignee.enabled
                                      ? "idle"
                                      : "disabled";
                                  })()}
                                />
                                <span>
                                  {bots.find(
                                    (b) => b.id === card.assignment!.bot_id,
                                  )?.name || "Removed bot"}
                                </span>
                                <small>
                                  {card.assignment.automatic
                                    ? "Scheduled"
                                    : "Approval"}
                                </small>
                              </div>
                            )}
                            {card.last_summary && (
                              <p
                                className="kanban-bot-update"
                                title={card.last_summary}
                              >
                                {card.last_summary}
                              </p>
                            )}
                            <div className="kanban-card-actions">
                              <select
                                aria-label={`Move ${card.title}`}
                                value={card.column}
                                disabled={busy || readOnly}
                                onChange={(e) =>
                                  move(card, e.target.value as Column)
                                }
                              >
                                {columns.map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.title}
                                  </option>
                                ))}
                              </select>
                              <button
                                aria-label={`Move ${card.title} up`}
                                disabled={
                                  busy ||
                                  readOnly ||
                                  index === 0 ||
                                  !!search ||
                                  view !== "board"
                                }
                                onClick={() =>
                                  move(card, column.id, cards[index - 1].id)
                                }
                              >
                                ↑
                              </button>
                            </div>
                            {card.column === "review" && !readOnly && (
                              <button
                                className="kanban-work"
                                disabled={
                                  busy ||
                                  taskBlockers(card, board?.cards || [])
                                    .length > 0
                                }
                                onClick={() => move(card, "done")}
                              >
                                Mark done <Icon name="check" size={14} />
                              </button>
                            )}
                            {onWork && !readOnly && (
                              <button
                                className="kanban-work"
                                disabled={
                                  busy ||
                                  taskBlockers(card, board?.cards || [])
                                    .length > 0
                                }
                                onClick={async () => {
                                  setBusy(true);
                                  try {
                                    await onWork(card);
                                  } catch (e) {
                                    setError(String(e));
                                  } finally {
                                    setBusy(false);
                                  }
                                }}
                              >
                                Work on this <Icon name="arrow" size={14} />
                              </button>
                            )}
                          </article>
                        ))}
                        {!cards.length && (
                          <div className="kanban-empty">
                            {busy && !board
                              ? "Loading…"
                              : search
                                ? "No matching tasks"
                                : view === "attention"
                                  ? "Nothing needs attention right now."
                                  : "A little room for what’s next."}
                          </div>
                        )}
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
            <footer className="kanban-footer">
              {onWork && !readOnly
                ? "Work on this prepares a message for your agent. You choose when to send it."
                : "One board per workspace. Refresh to see changes from another screen."}
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
