import { invoke } from '@tauri-apps/api/core';
import { useEffect, useId, useState } from 'react';
import { providerNames, type Provider } from '../providers';

interface Permissions {
  enabled: boolean; file_delete: boolean; vault_search: boolean; browser: boolean;
  native_screenshot: boolean; native_control: boolean;
}
interface Status {
  permissions: Permissions; ready: boolean; browser_available: boolean; native_available: boolean;
  providers: { provider: Provider; installed: boolean; registration: string }[];
}
const choices: { key: keyof Permissions; label: string; hint: string }[] = [
  { key: 'enabled', label: 'Connect Velum tools', hint: 'Supply project tools to Muse, Codex, Claude and Antigravity on their next turn. Muse and Antigravity receive one managed MCP entry in their user configuration; the original file is backed up once. Codex and Claude use per-turn configuration.' },
  { key: 'file_delete', label: 'Delete project files', hint: 'Remove one regular file after checking its content hash. No recursive folders, links or Git metadata.' },
  { key: 'vault_search', label: 'Search saved memory', hint: 'Read active notes in this project and shared memory when the current bot allows sharing, plus its private notes. Pending and archived notes stay excluded.' },
  { key: 'browser', label: 'Browser previews', hint: 'Use an isolated headless Edge or Chrome profile for navigation, page actions and screenshots. Requires Node.js 22 or newer. The browser closes when the turn ends.' },
  { key: 'native_screenshot', label: 'Desktop screenshots', hint: 'Allow the agent to list visible Windows windows and send the pixels of a chosen window to the provider. Visible private content and overlapping windows can be included.' },
  { key: 'native_control', label: 'Control Windows apps', hint: 'Allow the agent to focus a visible window, click, type and press keys. Applies to Windows apps under your account; Windows may block elevated or protected windows.' },
];
export default function ToolsSettings({ search = '' }: { search?: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const id = useId();
  useEffect(() => {
    let active = true;
    invoke<Status>('agent_tools_status').then(next => { if (active && next?.permissions) setStatus(next); }).catch(() => { if (active) setError('Could not load agent tool permissions.'); });
    return () => { active = false; };
  }, []);
  async function change(key: keyof Permissions) {
    if (!status || busy) return;
    setBusy(true); setSaved(false); setError('');
    try { const next = await invoke<Status>('agent_tools_configure', { permissions: { ...status.permissions, [key]: !status.permissions[key] } }); setStatus(next); setSaved(true); }
    catch { setError('Could not save tool permissions. The previous settings remain in effect.'); }
    finally { setBusy(false); }
  }
  async function disconnect(provider: Provider) {
    if (busy) return;
    setBusy(true); setError(''); setSaved(false);
    try { setStatus(await invoke<Status>('agent_tools_disconnect', { provider })); setSaved(true); }
    catch { setError('Could not remove this provider registration. Check the provider’s MCP configuration.'); }
    finally { setBusy(false); }
  }
  const matching = choices.filter(c => !search || `${c.label} ${c.hint}`.toLowerCase().includes(search));
  if (!matching.length) return null;
  return <section className="settings-group" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>Agent tools</h3>
    <p className="settings-info">Tools run on the Velum host with the permissions below. Provider shell sandboxes are separate. Enabling applies to new turns; disabling also blocks new calls in an active turn. YOLO does not enable desktop access.</p>
    {matching.map(choice => {
      const unavailable = choice.key === 'browser' ? !status?.browser_available : choice.key.startsWith('native_') ? !status?.native_available : false;
      return <div key={choice.key} className="setting-row">
        <div className="setting-copy"><label id={`${id}-${choice.key}-label`} htmlFor={`${id}-${choice.key}`}>{choice.label}</label><p id={`${id}-${choice.key}-hint`}>{choice.hint}{unavailable && status ? ' Not available on this installation.' : ''}</p></div>
        <div className="setting-control"><button type="button" id={`${id}-${choice.key}`} className="settings-switch" role="switch" aria-labelledby={`${id}-${choice.key}-label`} aria-checked={!!status?.permissions[choice.key]} aria-describedby={`${id}-${choice.key}-hint`} disabled={!status || busy || (choice.key !== 'enabled' && !status.permissions.enabled) || (unavailable && !status?.permissions[choice.key])} onClick={() => void change(choice.key)}><span /></button></div>
      </div>;
    })}
    {status && <p className="settings-info">{status.ready ? 'Tool host ready.' : 'Tool host unavailable.'} {status.providers.filter(p => p.installed).map(p => `${providerNames[p.provider]}: ${p.registration === 'configured' ? 'registered' : !status.permissions.enabled ? 'disconnected' : p.registration === 'per_turn' ? 'configured per turn' : 'connects on next turn'}`).join(' · ')}. Successful connections appear in the conversation’s diagnostics.</p>}
    {status && !status.permissions.enabled && status.providers.filter(p => p.registration === 'configured').map(provider => <div className="setting-row" key={provider.provider}><div className="setting-copy"><label>{providerNames[provider.provider]} CLI registration</label><p>Remove Velum’s managed entry from this provider. Other MCP entries stay in place. It reconnects only if you enable Velum tools and start another turn.</p></div><div className="setting-control"><button type="button" disabled={busy} onClick={() => void disconnect(provider.provider)}>Remove {providerNames[provider.provider]} registration</button></div></div>)}
    {(error || saved) && <p className="settings-info" role={error ? 'alert' : 'status'}>{error || 'Tool permissions saved.'}</p>}
  </section>;
}
