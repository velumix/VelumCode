export interface SkillManifest {
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  entry: string;
  tags: string[];
}
export interface SkillOrigin {
  repository: string;
  commit: string;
}
export interface InstalledSkill {
  origin?: SkillOrigin | null;
  manifest: SkillManifest;
  enabled: boolean;
  digest: string;
}
export interface SkillPreview {
  origin: SkillOrigin;
  manifest: SkillManifest;
  digest: string;
  bytes: number;
  body: string;
}
export interface SkillContent {
  manifest: SkillManifest;
  body: string;
}
export interface LocalSkillDraft {
  id?: string | null;
  name: string;
  description: string;
  tags: string[];
  body: string;
}
export interface SkillCatalogEntry extends SkillOrigin {
  manifest: SkillManifest;
}
export interface SkillCatalog {
  catalog: { schemaVersion: 1; skills: SkillCatalogEntry[] };
  fetched_at: number;
  notice: string | null;
}
export const MAX_SKILLS_PER_CHAT = 8;
export const SKILL_CONTEXT_BUDGET = 24000;
export function skillSubmissionUrl(preview: SkillPreview): string {
  const url = new URL(
    "https://github.com/velumix/velum-code-skills/issues/new",
  );
  url.searchParams.set("template", "skill.yml");
  url.searchParams.set("title", `Skill: ${preview.origin.repository}`);
  url.searchParams.set("repository", preview.origin.repository);
  url.searchParams.set("commit", preview.origin.commit);
  return url.toString();
}
