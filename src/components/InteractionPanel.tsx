import { useId, useMemo, useRef, useState } from 'react';
import type { ApprovalChoice, InteractionAnswer, InteractionDecision, InteractionQuestion, InteractionRequest, InteractionSnapshot } from '../interactions';
import { actionPreview, interactionStatus, interactionTool, isApproval, permissionScope } from '../interactionPresentation';
import Icon from './Icon';
import './InteractionPanel.css';

interface Props {
  snapshot: InteractionSnapshot;
  canRespond: boolean;
  disabledReason?: string;
  onRespond: (decision: InteractionDecision) => Promise<void>;
  onRefresh?: () => Promise<void>;
}

export function PermissionRecord({ status, tool = '', details, source, message }: {
  status: string; tool?: string; details: string; source?: string | null; message?: string | null;
}) {
  return <details className="interaction-record">
    <summary>
      <Icon name={['approved', 'answered', 'resolved'].includes(status) ? 'check' : 'shield'} size={14} />
      <span>{interactionStatus(status)}</span>
      {tool && <span className="interaction-record-tool">{interactionTool(tool)}</span>}
      {source && <span className="interaction-record-source">Response from {source}</span>}
      <Icon name="chevron" size={13} className="interaction-chevron" />
    </summary>
    {message && <p className="interaction-meta">{message}</p>}
    {details && <pre className="interaction-payload">{details}</pre>}
  </details>;
}

function RequestCard({ request, snapshot, canRespond, disabledReason, onRespond, onRefresh }: Props & { request: InteractionRequest }) {
  const [feedback, setFeedback] = useState('');
  const [answers, setAnswers] = useState<Record<string, InteractionAnswer>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<'details' | 'guidance' | 'options' | null>(null);
  const submitting = useRef(false);
  const disclosureId = useId();
  const pending = snapshot.active && (request.status === 'pending' || request.status === 'submitting');
  const confirming = busy || request.status === 'submitting';
  const enabled = canRespond && snapshot.active && request.status === 'pending' && !busy;
  const preview = useMemo(() => actionPreview(request.details), [request.details]);
  const answersReady = request.questions.every(question => {
    const answer = answers[question.id];
    if (answer?.text?.trim()) return question.free_text && Array.from(answer.text).length <= 500;
    const selected = answer?.selected || [];
    return selected.length >= question.min && selected.length <= question.max
      && (question.multiple || selected.length === 1);
  });
  const primary = request.choices.find(choice => isApproval(choice) && choice.scope === 'once' && choice.rule == null);
  const direct = request.choices.filter(choice => choice !== primary && !isApproval(choice) && choice.rule == null);
  const more = request.choices.filter(choice => choice !== primary && !direct.includes(choice));
  const title = request.title.replace(/^(?:Command )?Permission required(?:: .+)?$/i, 'Permission required');

  async function submit(response: Partial<InteractionDecision>) {
    if (!enabled || submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      await onRespond({ generation: snapshot.generation, id: request.id, revision: request.revision, ...response });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await onRefresh?.().catch(() => {});
    } finally { submitting.current = false; setBusy(false); }
  }

  function choose(choice: ApprovalChoice) {
    void submit({ choice_id: choice.id, ...(choice.accepts_feedback && feedback.trim() ? { feedback: feedback.trim() } : {}) });
  }

  function answerQuestion(id: string, update: Partial<InteractionAnswer>) {
    setAnswers(previous => ({ ...previous, [id]: { ...previous[id], ...update, question_id: id } }));
  }

  function writeAnswer(question: InteractionQuestion) {
    return <label className="interaction-feedback">{question.options.length ? 'Or write your answer' : 'Write your answer'}{question.secret
      ? <input type="password" autoComplete="off" maxLength={500} value={answers[question.id]?.text || ''} onChange={e => answerQuestion(question.id, { text: e.target.value, selected: [] })} />
      : <textarea rows={2} maxLength={500} value={answers[question.id]?.text || ''} onChange={e => answerQuestion(question.id, { text: e.target.value, selected: [] })} />}</label>;
  }

  function disclosure(name: 'details' | 'guidance' | 'options', label: string) {
    return <button type="button" className="interaction-link" aria-expanded={expanded === name} aria-controls={`${disclosureId}-${name}`} onClick={() => setExpanded(expanded === name ? null : name)}>
      {label}<Icon name="chevron" size={12} className="interaction-chevron" />
    </button>;
  }

  if (!pending) return <section className="interaction-card interaction-settled" aria-label={request.title}>
    <PermissionRecord status={request.status} tool={request.tool} details={request.details} source={request.source} message={request.message} />
  </section>;

  return <section className="interaction-card interaction-pending" aria-label={request.title}>
    <div className="interaction-heading">
      <Icon name={request.kind === 'question' ? 'chat' : 'shield'} size={16} />
      <strong>{title}</strong>
      {interactionTool(request.tool) && <span className="interaction-tool">{interactionTool(request.tool)}</span>}
    </div>
    {request.kind === 'approval' && <>
      {preview.description && <p className="interaction-description">{preview.description}</p>}
      {preview.command && <div className="interaction-command"><Icon name="terminal" size={14} /><code>{preview.command}</code></div>}
      {!preview.command && preview.files && <div className="interaction-command"><Icon name="folder" size={14} /><code>{preview.files.slice(0, 2).join('\n')}{preview.files.length > 2 ? `\n+${preview.files.length - 2} more files` : ''}</code></div>}
      {!preview.command && !preview.description && request.details && <p className="interaction-description">Review the requested access in Details.</p>}
      <div className="interaction-toolbar">
        <div className="interaction-disclosures">
          {request.details && disclosure('details', 'Details')}
          {request.choices.some(choice => choice.accepts_feedback) && disclosure('guidance', feedback.trim() ? 'Edit guidance' : 'Add guidance')}
          {more.length > 0 && disclosure('options', 'More options')}
        </div>
        <div className="interaction-actions">
          {direct.map(choice => <button type="button" key={choice.id} disabled={!enabled} title={permissionScope(choice.scope)} onClick={() => choose(choice)}>{choice.label}</button>)}
          {primary && <button type="button" className="interaction-primary" disabled={!enabled} title={permissionScope(primary.scope)} onClick={() => choose(primary)}><Icon name="check" size={14} />{primary.label}</button>}
        </div>
      </div>
      {request.details && <div id={`${disclosureId}-details`} hidden={expanded !== 'details'} className="interaction-expanded"><pre className="interaction-payload">{request.details}</pre></div>}
      {request.choices.some(choice => choice.accepts_feedback) && <div id={`${disclosureId}-guidance`} hidden={expanded !== 'guidance'} className="interaction-expanded">
        <label className="interaction-feedback">Optional guidance when declining<textarea rows={2} maxLength={2000} placeholder="Suggest a different approach…" value={feedback} onChange={e => setFeedback(e.target.value)} disabled={!enabled} /></label>
      </div>}
      {more.length > 0 && <div id={`${disclosureId}-options`} hidden={expanded !== 'options'} className="interaction-expanded interaction-more">
        {more.map(choice => <div key={choice.id} className="interaction-choice">
          <div><span className="interaction-scope">{permissionScope(choice.scope)}</span>
            {choice.rule != null && <pre className="interaction-rule">{typeof choice.rule === 'string' ? choice.rule : JSON.stringify(choice.rule, null, 2)}</pre>}
          </div>
          <button type="button" disabled={!enabled} aria-label={choice.label} title={choice.label} onClick={() => choose(choice)}>{choice.scope === 'localPersistent' && choice.rule != null && /^Always allow in this workspace:/.test(choice.label) ? 'Always allow' : choice.label}</button>
        </div>)}
      </div>}
    </>}
    {request.kind === 'question' && <form onSubmit={e => {
      e.preventDefault();
      if (!answersReady) return;
      void submit({ answers: request.questions.map(question => {
        const answer = answers[question.id];
        return answer?.text?.trim() ? { question_id: question.id, text: question.secret ? answer.text : answer.text.trim() } : { question_id: question.id, selected: answer?.selected || [] };
      }) });
    }}>
      {request.questions.map(question => <fieldset key={question.id} disabled={!enabled}>
        <legend className={question.question === title && request.questions.length === 1 ? 'interaction-sr-only' : undefined}>{question.question || question.header}</legend>
        {question.multiple && <p className="interaction-meta">Select {question.min === question.max ? question.min : `${question.min}–${question.max}`} {question.max === 1 ? 'option' : 'options'}{question.free_text ? ', or write an answer.' : '.'}</p>}
        <div className="interaction-options">{question.options.map(option => <label key={option.label} className="interaction-option">
          <input type={question.multiple ? 'checkbox' : 'radio'} name={`${request.id}:${question.id}`} checked={answers[question.id]?.selected?.includes(option.label) || false} disabled={question.multiple && !answers[question.id]?.selected?.includes(option.label) && (answers[question.id]?.selected?.length || 0) >= question.max} onChange={e => {
            const selected = answers[question.id]?.selected || [];
            answerQuestion(question.id, { text: undefined, selected: question.multiple ? e.target.checked ? [...selected, option.label] : selected.filter(value => value !== option.label) : [option.label] });
          }} />
          <span>{option.label}{option.description && <small>{option.description}</small>}</span>
        </label>)}</div>
        {question.free_text && (question.options.length ? <details className="interaction-write-answer"><summary>{answers[question.id]?.text?.trim() ? 'Edit your answer' : 'Write your own answer'}<Icon name="chevron" size={12} className="interaction-chevron" /></summary>{writeAnswer(question)}</details> : writeAnswer(question))}
      </fieldset>)}
      {request.details && <details className="interaction-question-details"><summary>Details</summary><pre className="interaction-payload">{request.details}</pre></details>}
      <div className="interaction-actions interaction-question-actions"><button type="button" disabled={!enabled} onClick={() => void submit({ cancel: true })}>Decline to answer</button><button type="submit" className="interaction-primary" disabled={!enabled || !answersReady}>Send answers<Icon name="arrow" size={14} /></button></div>
    </form>}
    {confirming && <p className="interaction-state" role="status">Waiting for confirmation…{request.source && <span>Response from {request.source}</span>}</p>}
    {!canRespond && <p className="interaction-meta interaction-state">{disabledReason || 'Control access is required to answer this request.'}</p>}
    {request.message && <p className="interaction-meta interaction-state">{request.message}</p>}
    {error && <p role="alert" className="interaction-error">{error}</p>}
  </section>;
}

export default function InteractionPanel(props: Props) {
  if (!props.snapshot.requests.length) return null;
  const pending = props.snapshot.requests.filter(request => props.snapshot.active && ['pending', 'submitting'].includes(request.status));
  const settled = props.snapshot.requests.filter(request => !pending.includes(request));
  // A request revision means a different provider requirement. Never carry an
  // answer or decision draft into it. Ordinary status changes only bump the snapshot.
  const card = (request: InteractionRequest) => <RequestCard key={`${props.snapshot.generation}:${request.id}:${request.revision}`} {...props} request={request} />;
  return <div className="interaction-panel" aria-label="Agent requests" aria-live="polite">
    {settled.length > 1 ? <details className="interaction-history"><summary><Icon name="shield" size={14} />{settled.length} past requests<Icon name="chevron" size={13} className="interaction-chevron" /></summary>{settled.map(card)}</details> : settled.map(card)}
    {pending.map(card)}
  </div>;
}
