import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { providerNames, type Provider, type RunOptions, type ModelCatalog } from "../providers";
import ModelControls from "./ModelControls";
import AntigravityLogin from "./AntigravityLogin";
import Icon from './Icon';
import './ConversationExperience.css';
interface Info { id: Provider; installed: boolean; setup_url: string }
interface Warmup { installed: boolean; version: string | null; catalog_models: number; catalog_notice: string | null; elapsed_ms: number }
// Cache each provider's advisory CLI check until the user refreshes it.
const warmupCache = new Map<Provider, Promise<Warmup | null>>();
const failedWarmup: Warmup = { installed: true, version: null, catalog_models: 0, catalog_notice: "Could not check the CLI.", elapsed_ms: 0 };
function isAuthFailure(text: string): boolean {
  if (!text) return false;
  // Unexpected process termination or generic troubleshooting messages are NOT auth errors.
  if (/ended without a completion event|produced no output|not found|permission/i.test(text)) return false;
  return /please sign[ -]?in|sign[ -]?in to (?:use|load)|not authenticated|unauthorized|auth.*(?:required|expired|failed)|token.*expired|invalid_grant/i.test(text);
}
function checkWarmup(provider: Provider): Promise<Warmup | null> {
  const cached = warmupCache.get(provider);
  if (cached) return cached;
  const task = invoke<Warmup>("provider_warmup", { provider }).then(
    (report) => report ?? failedWarmup,
    () => failedWarmup,
  );
  warmupCache.set(provider, task);
  return task;
}
export default function ProviderPicker({ value, onChange, failure, options, onOptionsChange, disabled, terminal, botPicker, actions, compact = true }: { value: Provider; onChange: (provider: Provider) => void; failure?: string; options: RunOptions; onOptionsChange: (options: RunOptions) => Promise<void>; disabled: boolean; terminal: boolean; botPicker?: ReactNode; actions?: ReactNode; compact?: boolean }) {
  const controlsId = useId();
  const [expanded, setExpanded] = useState(!compact);
  const [display, setDisplay] = useState({model:options.model,reasoning:options.reasoning});
  useEffect(()=>{setExpanded(!compact);},[compact]);
  const [providers, setProviders] = useState<Info[]>([]);
  const [error, setError] = useState("");
  const [signIn, setSignIn] = useState(false);
  const [modelsKey, setModelsKey] = useState(0);
  const initialMount = useRef(true);
  const lastFailureRef = useRef(failure);
  useEffect(() => {
    if (initialMount.current) {
      initialMount.current = false;
      // On app launch or restored tab mount, never pop up a modal dialog.
      // Verify CLI warmup & models quietly in the background.
      if (value === "antigravity" && failure && isAuthFailure(failure)) {
        warmupCache.delete(value);
        setWarmupKey((k) => k + 1);
        setModelsKey((k) => k + 1);
      }
      return;
    }
    // Only open the sign-in modal for new live turn failures during the active session
    if (failure !== lastFailureRef.current) {
      lastFailureRef.current = failure;
      if (value === "antigravity" && failure && isAuthFailure(failure)) {
        setSignIn(true);
      }
    }
  }, [value, failure]);
  const refresh = () => invoke<Info[]>("provider_status").then((result) => { setProviders(Array.isArray(result) ? result : []); setError(""); }).catch((error) => setError(String(error)));
  useEffect(() => { void refresh(); }, []);
  const current = providers.find((item) => item.id === value);
  useEffect(()=>{if (error || current?.installed === false) setExpanded(true);},[error,current?.installed]);
  const [warming, setWarming] = useState(false);
  const [warm, setWarm] = useState<Warmup | null>(null);
  const [warmupKey, setWarmupKey] = useState(0);
  useEffect(() => {
    if (!current?.installed) { setWarming(false); setWarm(null); return; }
    let live = true;
    setWarming(true);
    void checkWarmup(value).then((report) => { if (live) { setWarm(report); setWarming(false); } });
    return () => { live = false; };
  }, [value, current?.installed, warmupKey]);
  return <div className={`assistant-controls${expanded ? ' expanded' : ''}`}>
    {compact && <button type="button" className="assistant-summary" aria-label="Assistant settings" aria-expanded={expanded} aria-controls={controlsId} onClick={()=>setExpanded(open=>!open)}><span className="assistant-summary-provider"><Icon name="chat" size={14}/>{providerNames[value]}</span><span className="assistant-summary-model">{display.model || 'Loading model…'}{display.reasoning && <span> · {display.reasoning}</span>}</span><span className="assistant-summary-action">{expanded ? 'Hide controls' : 'Customize'}<Icon name="down" size={12}/></span></button>}
    <div id={controlsId} hidden={!expanded} className={`provider-bar${botPicker ? " has-bot-picker" : ""}`}>
    <div className="provider-field">
      <label htmlFor="provider-choice">AI provider</label>
      <select id="provider-choice" value={value} onChange={(event) => onChange(event.target.value as Provider)} title="Choosing a different provider opens a new conversation">
        {Object.entries(providerNames).map(([id, name]) => <option key={id} value={id}>{name}{id === "codex" ? " · ChatGPT" : ""}</option>)}
      </select>
    </div>
    <ModelControls provider={value} options={options} onChange={onOptionsChange} disabled={disabled} refreshKey={modelsKey} load={(provider, refresh) => invoke<ModelCatalog>("provider_models", { provider, refresh })} onSummary={(model,reasoning)=>setDisplay(previous=>previous.model===model&&previous.reasoning===reasoning?previous:{model,reasoning})} onRefresh={() => { warmupCache.delete(value); setWarmupKey(key => key + 1); void refresh(); }} refreshLabel="Refresh providers and models">
      {botPicker && <div className="provider-bot-field">{botPicker}</div>}
    </ModelControls>
    {(error || (current && !current.installed)) && <span className="provider-note">{error || "CLI not installed"}</span>}
    {current?.installed && warming && <span className="provider-terminal-note">Checking {providerNames[value]} CLI…</span>}
    {current?.installed && !warming && warm?.installed && warm.version && <span className="provider-terminal-note">{providerNames[value]} CLI ready · {warm.version}{warm.catalog_models > 0 && ` · ${warm.catalog_models} models`}</span>}
    {current?.installed && !warming && warm && (!warm.installed || !warm.version) && <span className="provider-note">{providerNames[value]} CLI did not respond — check the Terminal view, then refresh.</span>}
    <div className="provider-actions">
      {current && !current.installed && <button className="status-btn" onClick={() => void openUrl(current.setup_url).catch((error) => setError(String(error)))}>Setup</button>}
      {value === "antigravity" && current?.installed && <button className="status-btn" onClick={() => setSignIn(true)}>Sign in</button>}
      {actions}
    </div>
    {terminal && <p className="provider-terminal-note">Terminal changes apply when you restart the session.</p>}
    </div>
    {signIn && <AntigravityLogin onClose={() => { setSignIn(false); setModelsKey((n) => n + 1); }} />}
  </div>;
}
