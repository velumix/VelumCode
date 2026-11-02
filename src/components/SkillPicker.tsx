import { useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import "./SkillPicker.css";
import { MAX_SKILLS_PER_CHAT, type InstalledSkill } from "../skills";

export default function SkillPicker({
  skills,
  skillIds,
  onChange,
  onManage,
  disabled,
}: {
  skills: InstalledSkill[];
  skillIds: string[];
  onChange: (ids: string[]) => void;
  onManage: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const enabled = skills.filter((s) => s.enabled);
  const enabledIds = new Set(enabled.map((s) => s.manifest.id));
  const unavailable = skillIds.filter((id) => !enabledIds.has(id)).length;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  const toggle = (id: string, on: boolean) => {
    const next = on
      ? [...skillIds.filter((s) => s !== id), id].slice(0, MAX_SKILLS_PER_CHAT)
      : skillIds.filter((s) => s !== id);
    onChange(next);
  };
  return (
    <span className="skill-picker" ref={root}>
      <button
        type="button"
        className={`yolo-btn${skillIds.length ? " on" : ""}`}
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Skills for this conversation"
        title={
          skillIds.length
            ? `${skillIds.length} skill${skillIds.length === 1 ? "" : "s"} on for this conversation`
            : "Choose skills for this conversation"
        }
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="sparkles" size={16} />
        <span>Skills{skillIds.length ? ` (${skillIds.length})` : ""}</span>
      </button>
      {open && (
        <div className="skill-picker-menu" role="group" aria-label="Skills for this conversation">
          <div className="skill-picker-head">
            <strong>Skills</strong>
            <span>
              {skillIds.length} of {MAX_SKILLS_PER_CHAT} · Applies from your next message
            </span>
          </div>
          <div className="skill-picker-list">
            {!enabled.length && (
              <p className="skill-picker-empty">
                {skills.length
                  ? "All installed skills are disabled. Enable one in Skills → Installed."
                  : "No skills yet. Browse the directory, install from GitHub, or write your own."}
              </p>
            )}
            {enabled.map((s) => {
              const on = skillIds.includes(s.manifest.id);
              const atCap = !on && skillIds.length >= MAX_SKILLS_PER_CHAT;
              return (
                <label
                  key={s.manifest.id}
                  className={`skill-picker-item${atCap ? " capped" : ""}`}
                  title={atCap ? `Up to ${MAX_SKILLS_PER_CHAT} skills per conversation` : s.manifest.description}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={atCap}
                    onChange={(e) => toggle(s.manifest.id, e.target.checked)}
                  />
                  <span className="skill-picker-copy">
                    <strong>{s.manifest.name}</strong>
                    <span>{s.manifest.description}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {unavailable > 0 && (
            <p className="skill-picker-note" role="status">
              {unavailable} selected skill{unavailable === 1 ? " is" : "s are"} unavailable
              (removed or disabled) and will be skipped.{" "}
              <button
                type="button"
                onClick={() => onChange(skillIds.filter((id) => enabledIds.has(id)))}
              >
                Clear
              </button>
            </p>
          )}
          <div className="skill-picker-foot">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onManage();
              }}
            >
              Browse & manage skills…
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
