export type Provider = "muse" | "codex" | "claude" | "antigravity";
export const providerNames: Record<Provider, string> = { muse: "Muse", codex: "Codex", claude: "Claude", antigravity: "Antigravity" };
export interface RunOptions { model: string; reasoning: string }
export const defaultOptions: RunOptions = { model: "", reasoning: "" };
export interface ModelInfo { id: string; label: string; description: string; efforts: string[]; default_effort: string; is_default?: boolean }
export interface ModelCatalog { models: ModelInfo[]; notice: string | null; defaults?: RunOptions }
export function resolveOptions(options: RunOptions, catalog: ModelCatalog): RunOptions {
  const modelId = options.model || catalog.defaults?.model || catalog.models.find((m) => m.is_default)?.id || catalog.models[0]?.id || "";
  const model = catalog.models.find((m) => m.id === modelId);
  if (!model) return { model: modelId, reasoning: options.reasoning || (catalog.defaults?.model === modelId ? catalog.defaults.reasoning : "") || "" };
  const candidates = [options.reasoning, catalog.defaults?.model === modelId ? catalog.defaults.reasoning : "", model.default_effort];
  return { model: modelId, reasoning: candidates.find((effort) => effort && model.efforts.includes(effort)) || model.efforts[0] || "" };
}
export function preferredOptions(provider: Provider): RunOptions {
  try { const value = JSON.parse(localStorage.getItem(`velum-options-${provider}`) || "{}"); return { model: typeof value.model === "string" ? value.model : "", reasoning: typeof value.reasoning === "string" ? value.reasoning : "" }; } catch { return { ...defaultOptions }; }
}
export function saveOptions(provider: Provider, options: RunOptions) {
  try { localStorage.setItem(`velum-options-${provider}`, JSON.stringify(options)); } catch { /* Preferences are optional. */ }
}
export function preferredProvider(): Provider {
  try { const value = localStorage.getItem("velum-provider"); if (value === "codex" || value === "claude" || value === "antigravity") return value; } catch { /* Storage is optional. */ }
  return "muse";
}
