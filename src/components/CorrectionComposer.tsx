import { useEffect, useId, useRef, useState } from 'react';
import { lessonDraft } from '../conversationUX';
import Icon from './Icon';
import './ConversationExperience.css';

export interface CorrectionResult { sent: boolean; remembered: boolean; error?: string; notice?: string }
export default function CorrectionComposer({ running, disabled, owner, submit, remember, onClose }: {
  running: boolean; disabled: boolean; owner?: string;
  submit: (correction: string, lesson: string | null) => Promise<CorrectionResult>;
  remember: (lesson: string) => Promise<string | undefined>;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const fieldId = useId();
  const lessonId = useId();
  const [keep, setKeep] = useState(false);
  const [lesson, setLesson] = useState('');
  const edited = useRef(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [result, setResult] = useState<CorrectionResult | null>(null);
  const [error, setError] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { field.current?.focus(); }, []);
  useEffect(() => { if (!edited.current) setLesson(lessonDraft(text)); }, [text]);
  async function send() {
    if (inFlight.current || disabled || !text.trim() || (keep && !lesson.trim())) return;
    inFlight.current = true; setBusy(true); setError('');
    try { const next = await submit(text, keep ? lesson : null); setResult(next); setError(next.error || ''); }
    catch (error) { setError(String(error)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function retrySave() {
    if (inFlight.current || disabled || !lesson.trim()) return;
    inFlight.current = true; setBusy(true); setError('');
    try { const notice = await remember(lesson); setResult({sent:true,remembered:true,notice}); }
    catch (error) { setError(`The correction was sent. The lesson could not be saved: ${String(error)}`); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const finished = result?.sent && (!keep || result.remembered);
  return <section className="correction-composer" aria-label="Correct this response">
    <header><span className="correction-icon"><Icon name="edit" size={17}/></span><div><strong>{finished ? 'Correction sent' : 'Help the next attempt'}</strong><p role={finished?'status':undefined}>{finished ? result?.notice || (result?.remembered ? `Lesson saved${owner ? ` for ${owner}` : ''} in this project.` : 'Your existing draft is still in the composer.') : 'Say what missed the mark and what should change.'}</p></div><button type="button" aria-label="Close correction" disabled={busy} onClick={onClose}><Icon name="close" size={15}/></button></header>
    {!finished && <form onKeyDown={e=>{if(e.key==='Escape'&&!busy){e.preventDefault();e.stopPropagation();onClose();}else if((e.ctrlKey||e.metaKey)&&e.key==='Enter'&&!busy){e.preventDefault();void (result?.sent ? retrySave() : send());}}} onSubmit={e=>{e.preventDefault();void (result?.sent ? retrySave() : send());}}>
      {!result?.sent && <><label htmlFor={fieldId}>What should change?</label><textarea ref={field} id={fieldId} aria-label="What should change?" rows={3} value={text} maxLength={2000} disabled={busy || disabled} placeholder="For example: keep the existing layout and fix only the navigation." onChange={e=>setText(e.target.value)}/><label className="correction-keep"><input type="checkbox" checked={keep} disabled={busy || disabled} onChange={e=>setKeep(e.target.checked)}/><span>Remember a lesson for this project</span></label></>}
      {keep && <div className="correction-lesson"><label htmlFor={lessonId}>Lesson for next time</label><textarea id={lessonId} aria-label="Lesson for next time" rows={2} maxLength={1200} value={lesson} disabled={busy || disabled} onChange={e=>{edited.current=true;setLesson(e.target.value);}}/><p>Review this wording. Saved lessons guide future work{owner ? ` by ${owner}` : ' across providers'}; you can edit or remove them in Memory.</p></div>}
      {error && <p className="correction-error" role="alert">{error}</p>}
      <div className="correction-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="correction-primary" disabled={busy || disabled || (!result?.sent && !text.trim()) || (keep && !lesson.trim())}>{busy ? result?.sent ? 'Saving…' : 'Sending…' : result?.sent ? 'Retry saving lesson' : running ? keep ? 'Queue & save lesson' : 'Queue correction' : keep ? 'Send & save lesson' : 'Send correction'}<Icon name="arrow" size={14}/></button></div>
    </form>}
    {finished && <button type="button" className="correction-done" onClick={onClose}>Back to the conversation<Icon name="arrow" size={14}/></button>}
  </section>;
}
