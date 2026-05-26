import { Octokit } from '@octokit/rest';

export interface GitHubClientConfig {
  token: string;
  org: string; // 'TheFactoryOrg'
}

export interface GitHubFile {
  path: string;
  content: string;
}

export interface GitHubRepoInfo {
  full_name: string;
  default_branch: string;
  html_url: string;
}

export interface CommitOptions {
  subject: string;
  persona: string;
  iteration: number;
}

export interface WorkflowRunSummary {
  id: number;
  conclusion: string | null;
  html_url: string;
}

/**
 * Narrow Octokit wrapper for Forge T1. Exposes only the operations Builder
 * and CI/CD need: create repo, push files, set description, list workflow runs.
 */
export class GitHubClient {
  private octokit: Octokit;
  private org: string;

  constructor(config: GitHubClientConfig) {
    this.octokit = new Octokit({ auth: config.token });
    this.org = config.org;
  }

  /** Creates `<org>/solution-<slug>` and returns the repo info. */
  async createSolutionRepo(slug: string, description: string, isPrivate: boolean): Promise<GitHubRepoInfo> {
    const { data } = await this.octokit.repos.createInOrg({
      org: this.org,
      name: `solution-${slug}`,
      description,
      private: isPrivate,
      auto_init: true,
    });
    return {
      full_name: data.full_name,
      default_branch: data.default_branch ?? 'main',
      html_url: data.html_url,
    };
  }

  /** Pushes an initial set of files as one commit on `main`. Returns the new commit SHA. */
  async pushInitialCommit(repo: string, files: GitHubFile[], message: string): Promise<string> {
    return this.commitFiles(repo, 'main', files, message);
  }

  /** Pushes a follow-up commit. Subject is rendered as `<persona>(<iter>): <subject>` per spec §8. */
  async commitAndPush(repo: string, files: GitHubFile[], opts: CommitOptions): Promise<string> {
    const message = `${opts.persona}(${opts.iteration}): ${opts.subject}`;
    return this.commitFiles(repo, 'main', files, message);
  }

  /** Sets the GitHub repo description (used to surface the Vercel preview URL). */
  async setRepoDescription(repo: string, description: string): Promise<void> {
    await this.octokit.repos.update({
      owner: this.org,
      repo,
      description,
    });
  }

  /** Returns the most recent workflow run for `repo`, or null if none have run yet. */
  async listLatestWorkflowRun(repo: string): Promise<WorkflowRunSummary | null> {
    const { data } = await this.octokit.actions.listWorkflowRunsForRepo({
      owner: this.org,
      repo,
      per_page: 1,
    });
    const run = data.workflow_runs[0];
    if (!run) return null;
    return { id: run.id, conclusion: run.conclusion, html_url: run.html_url };
  }

  private async commitFiles(repo: string, branch: string, files: GitHubFile[], message: string): Promise<string> {
    const parentSha = await this.getBranchHeadSha(repo, branch);

    const blobs = await Promise.all(
      files.map(async f => {
        const { data } = await this.octokit.git.createBlob({
          owner: this.org,
          repo,
          content: f.content,
          encoding: 'utf-8',
        });
        return { path: f.path, sha: data.sha };
      }),
    );

    const { data: tree } = await this.octokit.git.createTree({
      owner: this.org,
      repo,
      base_tree: parentSha,
      tree: blobs.map(b => ({ path: b.path, mode: '100644' as const, type: 'blob' as const, sha: b.sha })),
    });

    const { data: commit } = await this.octokit.git.createCommit({
      owner: this.org,
      repo,
      message,
      tree: tree.sha,
      parents: [parentSha],
    });

    await this.octokit.git.updateRef({
      owner: this.org,
      repo,
      ref: `heads/${branch}`,
      sha: commit.sha,
    });

    return commit.sha;
  }

  private async getBranchHeadSha(repo: string, branch: string): Promise<string> {
    const { data } = await this.octokit.git.getRef({
      owner: this.org,
      repo,
      ref: `heads/${branch}`,
    });
    return data.object.sha;
  }
}
