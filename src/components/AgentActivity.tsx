import { useState, type ReactNode } from 'react';
import Icon from './Icon';
import './ConversationExperience.css';
export default function AgentActivity({ count, current, failed, busy, stopped = false, children, onOpenDashboard }: { count: number; current: string; failed: boolean; busy: boolean; stopped?: boolean; children: ReactNode; onOpenDashboard?: () => void }) {
  const [open, setOpen] = useState(false);
  return <section className={`agent-activity${failed ? ' needs-attention' : ''}`} aria-label="Agent activity">
    <div style={{ display: "flex", alignItems: "center" }}>
      <button type="button" className="activity-toggle" aria-expanded={open} onClick={()=>setOpen(value=>!value)} style={{ flex: 1 }}>
        <span className={`activity-state${busy ? ' busy' : ''}`} aria-hidden="true">
          <Icon name={failed ? 'shield' : busy || stopped ? 'code' : 'check'} size={14}/>
        </span>
        <span className="activity-summary">
          <strong>{failed ? 'An action needs attention' : busy ? current : stopped ? 'Activity stopped' : `${count} ${count===1?'action':'actions'} completed`}</strong>
          <span>{busy ? `${count} ${count===1?'action':'actions'} so far` : 'View details'}</span>
        </span>
        <Icon name="down" size={13}/>
      </button>
      {onOpenDashboard && (
        <button
          type="button"
          className="sd-action-chip"
          style={{ marginRight: "10px", padding: "3px 7px", fontSize: "10px" }}
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
    {failed && !open && <p className="activity-warning">Open the activity to review the failed or blocked action.</p>}
    {open && <div className="activity-content">{children}</div>}
  </section>;
}
