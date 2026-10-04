export interface ApprovalChoice {
  id: string;
  label: string;
  scope: string;
  decision: string;
  accepts_feedback: boolean;
  rule?: unknown;
}
export interface InteractionQuestion {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string }[];
  multiple: boolean;
  free_text: boolean;
  secret: boolean;
  min: number;
  max: number;
}
export interface InteractionRequest {
  id: string;
  revision: number;
  kind: 'approval' | 'question';
  title: string;
  tool: string;
  details: string;
  choices: ApprovalChoice[];
  questions: InteractionQuestion[];
  status: string;
  message?: string | null;
  source?: string | null;
}
export interface InteractionSnapshot {
  generation: string;
  revision: number;
  active: boolean;
  requests: InteractionRequest[];
}
export interface InteractionAnswer {
  question_id: string;
  selected?: string[];
  text?: string;
}
export interface InteractionDecision {
  generation: string;
  id: string;
  revision: number;
  choice_id?: string;
  feedback?: string;
  answers?: InteractionAnswer[];
  cancel?: boolean;
}
export const emptyInteractions = (): InteractionSnapshot => ({ generation: '', revision: 0, active: false, requests: [] });

/** Responses to clicks cannot replace state from a newer turn. */
export function mergeInteractionResponse(current: InteractionSnapshot, next: InteractionSnapshot): InteractionSnapshot {
  return current.generation === next.generation && next.revision >= current.revision ? next : current;
}
