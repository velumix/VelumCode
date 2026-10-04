import type { InteractionSnapshot } from '../../src/interactions';

export function commandApproval(provider = 'muse'): InteractionSnapshot {
  const command = "Set-Content -LiteralPath 'C:\\Projects\\VelumCode\\src\\permission-check.txt' -Value 'Ready to keep building'";
  return {
    generation: 'review-turn', revision: 4, active: true,
    requests: [{
      id: 'review-command', revision: 2, kind: 'approval', title: 'Permission required: powershell', tool: 'powershell',
      details: provider === 'muse'
        ? JSON.stringify({ kind: 'shell', command, workspaceRoot: '\\\\?\\C:\\Projects\\VelumCode', stages: [{ requirementId: 'exact-stage-2', suggestedPrefix: ['Set-Content', '-LiteralPath'], resolution: 'pending' }] }, null, 2) + '\n\n' + JSON.stringify({ command, description: 'Write the permission check file in your project.' })
        : JSON.stringify({ threadId: 'native-thread', turnId: 'native-turn', itemId: 'native-item', command, cwd: 'C:\\Projects\\VelumCode', reason: 'Write the permission check file in your project.', availableDecisions: ['accept', 'cancel'] }, null, 2),
      choices: [
        { id: 'once', label: 'Allow once', scope: 'once', decision: 'approved', accepts_feedback: false },
        { id: 'session', label: 'Allow for this session', scope: 'session', decision: 'approved', accepts_feedback: false },
        { id: 'saved', label: 'Always allow in this workspace: Set-Content -LiteralPath', scope: 'localPersistent', decision: 'approvedPolicyAmendment', accepts_feedback: false, rule: { commandPrefix: ['Set-Content', '-LiteralPath'], workspace: 'C:\\Projects\\VelumCode' } },
        { id: 'reject', label: 'Reject', scope: 'once', decision: 'abort', accepts_feedback: true },
      ], questions: [], status: 'pending',
    }],
  };
}

export function featureQuestion(): InteractionSnapshot {
  const state = commandApproval();
  state.requests = [{ ...state.requests[0], id: 'question-layout', kind: 'question', title: 'Which details should stay visible?', tool: '', details: '', choices: [], questions: [{ id: 'details', header: 'Approval layout', question: 'Which details should stay visible?', options: [{ label: 'Command preview', description: 'A short preview of the action.' }, { label: 'Working folder', description: 'Where the action will run.' }], multiple: true, free_text: true, secret: false, min: 1, max: 2 }] }];
  return state;
}
