import { useState, type ReactNode } from 'react';
import Icon from './Icon';
import './ConversationExperience.css';

export interface ActivityFileChip {
  path: string;
  additions?: number;
  deletions?: number;
  mutated?: boolean;
}

export interface ActivityCategoryBadge {
  key: string;
  label: string;
  count: number;
}

export default function AgentActivity({
  count,
  current,
  failed,
  busy,
  stopped = false,
  children,
  onOpenDashboard,
  touchedFiles,
  categoryBadges,
  thoughtPreview,
  swarmSummary,
  onInspectFile,
}: {
  count: number;
  current: string;
  failed: boolean;
  busy: boolean;
  stopped?: boolean;
  children: ReactNode;
  onOpenDashboard?: () => void;
  touchedFiles?: ActivityFileChip[];
  categoryBadges?: ActivityCategoryBadge[];
  thoughtPreview?: string;
  swarmSummary?: { workers: number; active: number };
  onInspectFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasPreview =
    !open &&
    Boolean(
      thoughtPreview ||
        (touchedFiles && touchedFiles.length > 0) ||
        swarmSummary ||
        (!busy && categoryBadges && categoryBadges.length > 0)
    );

  return (
    <section
      className={`agent-activity${busy ? ' is-busy' : ''}${failed ? ' needs-attention' : ''}`}
      aria-label="Agent activity"
    >
      <div className="activity-header-row">
        <button
          type="button"
          className="activity-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className={`activity-state${busy ? ' busy' : ''}`} aria-hidden="true">
            <Icon name={failed ? 'shield' : busy || stopped ? 'code' : 'check'} size={14} />
          </span>
          <span className="activity-summary">
            <strong>
              {failed
                ? 'An action needs attention'
                : busy
                  ? current
                  : stopped
                    ? 'Activity stopped'
                    : `${count} ${count === 1 ? 'action' : 'actions'} completed`}
            </strong>
            <span>{busy ? `${count} ${count === 1 ? 'action' : 'actions'} so far` : open ? 'Hide log' : 'View log'}</span>
          </span>
          <Icon name="down" size={13} />
        </button>
        {onOpenDashboard && (
          <button
            type="button"
            className="sd-action-chip activity-dashboard-btn"
            title="Open Tool Log in Dashboard"
            onClick={(e) => {
              e.stopPropagation();
              onOpenDashboard();
            }}
          >
            <Icon name="board" size={12} />
            <span>Dashboard</span>
          </button>
        )}
      </div>

      {hasPreview && (
        <div className="activity-preview-strip">
          {thoughtPreview && (
            <span className="activity-thought-pill" title={thoughtPreview}>
              <Icon name="sparkles" size={11} />
              <span>{thoughtPreview}</span>
            </span>
          )}
          {swarmSummary && (
            <span className="activity-swarm-pill">
              <Icon name="layers" size={11} />
              <span>
                Swarm · {swarmSummary.workers}{' '}
                {swarmSummary.workers === 1 ? 'worker' : 'workers'}
                {swarmSummary.active > 0 ? ` (${swarmSummary.active} active)` : ''}
              </span>
            </span>
          )}
          {categoryBadges?.map((cat) => (
            <span key={cat.key} className={`activity-cat-pill cat-${cat.key}`}>
              {cat.label} · {cat.count}
            </span>
          ))}
          {touchedFiles?.map((file) => {
            const label = file.path.split(/[\\/]/).pop() || file.path;
            return (
              <button
                key={file.path}
                type="button"
                className={`activity-file-pill${file.mutated ? ' mutated' : ''}`}
                title={`Inspect ${file.path} in Split Studio`}
                onClick={() => onInspectFile?.(file.path)}
              >
                <Icon name={file.mutated ? 'edit' : 'diff'} size={11} />
                <span>{label}</span>
                {(file.additions || file.deletions) ? (
                  <span className="activity-file-stats">
                    {file.additions ? <em className="add">+{file.additions}</em> : null}
                    {file.deletions ? <em className="del">-{file.deletions}</em> : null}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}

      {failed && !open && (
        <p className="activity-warning">Open the activity to review the failed or blocked action.</p>
      )}
      {open && <div className="activity-content">{children}</div>}
    </section>
  );
}
