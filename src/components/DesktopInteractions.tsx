import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import InteractionPanel from './InteractionPanel';
import { emptyInteractions, mergeInteractionResponse, type InteractionSnapshot } from '../interactions';

/** Live scheduled sessions have no mounted ChatView of their own. */
export default function DesktopInteractions({ sessionId }: { sessionId: string }) {
  const [snapshot, setSnapshot] = useState(emptyInteractions);
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let closed = false, version = 0;
    let unlisten: (() => void) | undefined;
    setSnapshot(emptyInteractions());
    refresh.current = async () => {
      const before = version;
      const next = await invoke<InteractionSnapshot>('agent_interactions', {id: sessionId});
      if (!closed && before === version) setSnapshot(next);
    };
    void listen<{ id: string; snapshot: InteractionSnapshot }>('agent-interactions', event => {
      if (closed || event.payload.id !== sessionId) return;
      version++;
      setSnapshot(previous => previous.generation === event.payload.snapshot.generation ? mergeInteractionResponse(previous, event.payload.snapshot) : event.payload.snapshot);
    }).then(stop => {
      if (closed) stop();
      else { unlisten = stop; void refresh.current().catch(() => {}); }
    });
    return () => { closed = true; unlisten?.(); refresh.current = async () => {}; };
  }, [sessionId]);
  return <InteractionPanel snapshot={snapshot} canRespond onRefresh={() => refresh.current()} onRespond={async decision => {
    const next = await invoke<InteractionSnapshot>('agent_respond', {id:sessionId, decision});
    setSnapshot(previous => mergeInteractionResponse(previous, next));
  }}/>;
}
