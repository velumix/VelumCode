import { invoke } from "@tauri-apps/api/core";

export interface GitHubUserProfile {
  authenticated: boolean;
  login: string;
  name?: string;
  avatar_url: string;
  bio?: string;
  company?: string;
  location?: string;
  blog?: string;
  email?: string;
  public_repos: number;
  total_private_repos?: number;
  followers: number;
  following: number;
  html_url: string;
  auth_source: "cli" | "pat" | "env" | "unauthenticated" | string;
  scopes: string[];
  rate_limit_limit?: number;
  rate_limit_remaining?: number;
}

export interface GitHubRepoDetails {
  owner: string;
  name: string;
  full_name: string;
  description?: string;
  private: boolean;
  fork: boolean;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  stars: number;
  forks: number;
  open_issues_count: number;
  default_branch: string;
  topics: string[];
  permissions?: {
    admin?: boolean;
    push?: boolean;
    pull?: boolean;
  };
  visibility: string;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  user_login: string;
  user_avatar: string;
  state: string;
  draft: boolean;
  html_url: string;
  created_at: string;
  updated_at: string;
  head_ref: string;
  base_ref: string;
}

export interface GitHubLabel {
  name: string;
  color: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  user_login: string;
  user_avatar: string;
  state: string;
  labels: GitHubLabel[];
  comments: number;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export interface GitHubAuthStatus {
  has_pat: boolean;
  has_cli: boolean;
  cli_account?: string;
  active_source: "pat" | "cli" | "env" | "unauthenticated" | string;
}

export async function fetchGitHubAuthStatus(): Promise<GitHubAuthStatus> {
  return invoke<GitHubAuthStatus>("github_auth_status");
}

export async function fetchGitHubUserProfile(): Promise<GitHubUserProfile> {
  return invoke<GitHubUserProfile>("github_user_profile");
}

export async function fetchGitHubRepoDetails(
  workspace: string,
  repo?: string,
): Promise<GitHubRepoDetails> {
  return invoke<GitHubRepoDetails>("github_repo_details", {
    workspace,
    repo: repo || null,
  });
}

export async function fetchGitHubPulls(
  workspace: string,
  repo?: string,
  stateFilter: "open" | "closed" | "all" = "open",
): Promise<GitHubPullRequest[]> {
  return invoke<GitHubPullRequest[]>("github_repo_pulls", {
    workspace,
    repo: repo || null,
    stateFilter,
  });
}

export async function fetchGitHubIssues(
  workspace: string,
  repo?: string,
  stateFilter: "open" | "closed" | "all" = "open",
): Promise<GitHubIssue[]> {
  return invoke<GitHubIssue[]>("github_repo_issues", {
    workspace,
    repo: repo || null,
    stateFilter,
  });
}

export async function createGitHubIssue(
  workspace: string,
  title: string,
  body: string,
  repo?: string,
): Promise<GitHubIssue> {
  return invoke<GitHubIssue>("github_create_issue", {
    workspace,
    repo: repo || null,
    title,
    body,
  });
}

export async function saveGitHubPat(token: string): Promise<GitHubUserProfile> {
  return invoke<GitHubUserProfile>("github_save_pat", { token });
}

export async function clearGitHubPat(): Promise<void> {
  return invoke<void>("github_clear_pat");
}
