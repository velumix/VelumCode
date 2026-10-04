import { useEffect, useId, useRef, useState } from 'react';
import type { RecoverableRequest } from '../conversationUX';
import Icon from './Icon';
import './ConversationExperience.css';

export default function RequestRecovery({ request, disabled, queued, paused, maxLength = 64000, submit }: {
  request: RecoverableRequest;
  disabled: boolean;
  queued: boolean;
  paused: boolean;
  maxLength?: number;
  submit: (prompt: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(request.prompt);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const fieldId = useId();
  const hintId = useId();
  const lengthHintId = useId();
  const prompt = (editing ? text : request.prompt).trim();
  const overLimit = Array.from(prompt).length > maxLength;

  useEffect(() => { if (editing) field.current?.focus(); }, [editing]);

  async function retry() {
    if (disabled || inFlight.current || submitted || !prompt || overLimit) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      if (await submit(prompt)) setSubmitted(true);
      else setError('The request was not sent. Your edits are still here.');
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function cancelEdit() {
    setEditing(false);
    setText(request.prompt);
    setError('');
    editButton.current?.focus();
  }

  if (submitted) return <p className="request-recovery-result" role="status">Request submitted.</p>;

  const hint = request.status === 'not_sent'
    ? 'Your separate draft stays in the composer.'
    : request.status === 'blocked'
      ? 'Resolve the permission issue above and review any partial changes before retrying.'
      : 'Review any partial changes before sending this request again.';

  return <section className="request-recovery" aria-label="Recover request">
    <p id={hintId} className="request-recovery-hint">{hint}{queued ? ` The retry joins the end of the queue.${paused ? ' Resume the queue when ready.' : ''}` : ''}</p>
    {overLimit && <p id={lengthHintId} className="request-recovery-hint" role="status">This request is too long to retry here. Revise it to {maxLength.toLocaleString()} characters or fewer.</p>}
    <form onSubmit={event => { event.preventDefault(); void retry(); }} onKeyDown={event => {
      if (event.key === 'Escape' && editing && !busy) { event.preventDefault(); event.stopPropagation(); cancelEdit(); }
    }}>
      {editing && <div className="request-recovery-editor">
        <label htmlFor={fieldId}>Request to retry</label>
        <textarea ref={field} id={fieldId} aria-describedby={`${hintId}${overLimit ? ` ${lengthHintId}` : ''}`} rows={4} maxLength={maxLength} value={text} disabled={disabled || busy} onChange={event => setText(event.target.value)} />
      </div>}
      {error && <p className="request-recovery-error" role="alert">{error}</p>}
      <div className="recovery-actions">
        <button type="submit" disabled={disabled || busy || !prompt || overLimit}><Icon name="reset" size={14}/>{busy ? 'Sending…' : queued ? 'Queue retry' : 'Retry request'}</button>
        <button ref={editButton} type="button" disabled={disabled || busy} onClick={() => editing ? cancelEdit() : setEditing(true)}>{editing ? 'Cancel edit' : 'Revise request'}</button>
      </div>
    </form>
  </section>;
}
