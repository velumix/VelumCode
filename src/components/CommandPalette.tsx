import { useEffect, useMemo, useRef, useState } from "react";
import Icon, { type IconName } from "./Icon";

export interface PaletteAction {
  id: string;
  title: string;
  hint?: string;
  icon?: IconName;
  run: () => void;
}

interface CommandPaletteProps {
  actions: PaletteAction[];
  onClose: () => void;
}

// Rank: prefix > word-prefix > substring > subsequence. -1 = no match.
function matchScore(title: string, q: string): number {
  if (!q) return 0;
  const t = title.toLowerCase();
  const query = q.toLowerCase();
  if (t.startsWith(query)) return 0;
  if (t.split(/\s+/).some((w) => w.startsWith(query))) return 1;
  if (t.includes(query)) return 2;
  let ti = 0;
  for (const ch of query) {
    ti = t.indexOf(ch, ti);
    if (ti === -1) return -1;
    ti += 1;
  }
  return 3;
}

export default function CommandPalette({ actions, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const q = query.trim();
    return actions
      .map((a) => ({ a, s: matchScore(`${a.title} ${a.hint ?? ""}`, q) }))
      .filter((m) => m.s >= 0)
      .sort((x, y) => x.s - y.s)
      .map((m) => m.a);
  }, [actions, query]);

  useEffect(() => {
    setIndex(0);
  }, [query]);
  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, matches.length - 1)));
  }, [matches.length]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const step = (dir: 1 | -1) => {
    if (matches.length === 0) return;
    setIndex((i) => Math.min(Math.max(i + dir, 0), matches.length - 1));
  };

  const runSelected = () => {
    const sel = matches[index];
    if (sel) {
      onClose();
      requestAnimationFrame(() => sel.run());
    }
  };

  return (
    <div
      className="palette-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette"
        onKeyDown={(e) => {
          if (e.key === "Tab") { e.preventDefault(); inputRef.current?.focus(); }
          if (e.key === "Escape") { e.preventDefault(); onClose(); }
        }}>
        <div className="palette-search"><Icon name="search" size={20} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              step(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              step(-1);
            } else if (e.key === "Enter") {
              e.preventDefault();
              runSelected();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder="Find a command or conversation…"
          aria-label="Command palette"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-options"
          aria-activedescendant={matches[index] ? `option-${matches[index].id}` : undefined}
          spellCheck={false}
        />
        <kbd aria-hidden="true">Esc</kbd>
        </div>
        <div ref={listRef} id="palette-options" className="palette-list" role="listbox" aria-label="Commands">
          {matches.map((a, i) => (
            <button
              key={a.id}
              type="button"
              id={`option-${a.id}`}
              tabIndex={-1}
              role="option"
              aria-selected={i === index}
              data-active={i === index}
              className={`palette-item${i === index ? " active" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => {
                onClose();
                requestAnimationFrame(() => a.run());
              }}
            >
              <Icon name={a.icon || (a.id.startsWith("cmd-goto-") ? "chat" : a.id === "cmd-new" ? "plus" : "command")} size={16} />
              <span>{a.title}</span>
              {a.hint && <kbd>{a.hint}</kbd>}
            </button>
          ))}
          {matches.length === 0 && <div className="palette-empty">No matching commands</div>}
        </div>
        <div className="palette-foot"><span>↑↓ navigate <span aria-hidden="true">·</span> Enter run</span><span>{matches.length} {matches.length === 1 ? "result" : "results"}</span></div>
      </div>
    </div>
  );
}
