import type { ApprovalChoice } from './interactions';

const toolNames: Record<string, string> = {
  powershell: 'PowerShell', shell: 'Shell', bash: 'Bash',
  'item/commandExecution/requestApproval': 'Command',
  'item/fileChange/requestApproval': 'Files',
  'item/permissions/requestApproval': 'Permissions',
  'item/tool/requestUserInput': '',
};

const knownLabel = (labels: Record<string, string>, value: string) =>
  Object.prototype.hasOwnProperty.call(labels, value) ? labels[value] : undefined;

export const interactionTool = (tool: string) => knownLabel(toolNames, tool) ?? tool;
export const permissionScope = (scope: string) => knownLabel({
  once: 'This action only', turn: 'This turn', session: 'This provider session',
  localPersistent: 'Saved for this workspace',
}, scope) ?? scope;
export const isApproval = (choice: ApprovalChoice) => /^(approve|accept|allow)/i.test(choice.decision);

export const interactionStatus = (status: string) => knownLabel({
  approved: 'Allowed', denied: 'Denied', rejected: 'Rejected', answered: 'Answered',
  cancelled: 'Cancelled', expired: 'Expired', resolved: 'Resolved', aborted: 'Cancelled',
  submitting: 'Confirming', pending: 'Awaiting response', requested: 'Requested',
}, status) ?? status.replace(/_/g, ' ').replace(/^./, letter => letter.toUpperCase());

/** Display only. The full provider payload remains available for review. */
export function actionPreview(details: string): { command: string; description: string; structured: boolean; files?: string[] } {
  const source = details.trim();
  // Providers can append another value after their first JSON object.
  let depth = 0, quoted = false, escaped = false, end = -1;
  if (source.startsWith('{')) {
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{' || char === '[') depth++;
      else if ((char === '}' || char === ']') && --depth === 0) { end = index + 1; break; }
    }
  }
  if (end > 0) {
    try {
      const value = JSON.parse(source.slice(0, end)) as Record<string, unknown>;
      let argumentsValue: Record<string, unknown> = {};
      try { argumentsValue = JSON.parse(source.slice(end).trim().replace(/^Proposed item:\s*/, '')); } catch { /* Optional provider suffix. */ }
      const string = (value: unknown) => typeof value === 'string' ? value : '';
      const changes = value.changes ?? argumentsValue?.changes;
      const files = Array.isArray(changes) ? changes.flatMap(change => change && typeof change.path === 'string' ? [change.path as string] : []) : [];
      const path = string(value.path) || string(value.filePath);
      if (!files.length && path) files.push(path);
      return {
        command: string(value.command) || string(argumentsValue?.command),
        description: string(value.reason) || string(value.description) || string(argumentsValue?.description) || (files.length ? `Review changes to ${files.length} ${files.length === 1 ? 'file' : 'files'}.` : ''),
        structured: true,
        ...(files.length ? {files} : {}),
      };
    } catch { /* Unrecognized payloads are shown as text. */ }
  }
  return { command: '', description: source, structured: false };
}
