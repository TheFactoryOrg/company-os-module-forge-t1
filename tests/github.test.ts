import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubClient, type GitHubFile } from '../lib/github.js';

// Mock @octokit/rest by capturing the constructor arg and exposing call records.
const mockCalls: Array<{ method: string; args: unknown }> = [];

const mockRest = {
  repos: {
    createInOrg: vi.fn(async (args: unknown) => {
      mockCalls.push({ method: 'repos.createInOrg', args });
      return { data: { full_name: 'TheFactoryOrg/solution-foo', default_branch: 'main', html_url: 'https://github.com/TheFactoryOrg/solution-foo' } };
    }),
    get: vi.fn(async (args: unknown) => {
      mockCalls.push({ method: 'repos.get', args });
      return { data: { default_branch: 'main' } };
    }),
    update: vi.fn(async (args: unknown) => {
      mockCalls.push({ method: 'repos.update', args });
      return { data: {} };
    }),
  },
  git: {
    getRef: vi.fn(async (args: unknown) => {
      mockCalls.push({ method: 'git.getRef', args });
      return { data: { object: { sha: 'parent-sha-abc' } } };
    }),
    createBlob: vi.fn(async (args: unknown) => {
      mockCalls.push({ method: 'git.createBlob', args });
      return { data: { sha: 'blob-sha-' + ((args as { content: string }).content.length) } };
    }),
    createTree: vi.fn(async (args: unknown) => {
      mockCalls.push({ method: 'git.createTree', args });
      return { data: { sha: 'tree-sha-xyz' } };
    }),
    createCommit: vi.fn(async (args: unknown) => {
      mockCalls.push({ method: 'git.createCommit', args });
      return { data: { sha: 'commit-sha-123' } };
    }),
    updateRef: vi.fn(async (args: unknown) => {
      mockCalls.push({ method: 'git.updateRef', args });
      return { data: { object: { sha: 'commit-sha-123' } } };
    }),
  },
  actions: {
    listWorkflowRunsForRepo: vi.fn(async (args: unknown) => {
      mockCalls.push({ method: 'actions.listWorkflowRunsForRepo', args });
      return { data: { workflow_runs: [{ id: 1, conclusion: 'success', html_url: 'https://gh/run/1' }] } };
    }),
  },
};

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(() => mockRest),
}));

beforeEach(() => {
  mockCalls.length = 0;
  vi.clearAllMocks();
});

describe('GitHubClient', () => {
  it('createSolutionRepo creates a repo under TheFactoryOrg', async () => {
    const client = new GitHubClient({ token: 't', org: 'TheFactoryOrg' });
    const result = await client.createSolutionRepo('foo', 'a solution', false);
    expect(mockRest.repos.createInOrg).toHaveBeenCalledOnce();
    const call = mockCalls.find(c => c.method === 'repos.createInOrg');
    expect(call?.args).toMatchObject({ org: 'TheFactoryOrg', name: 'solution-foo', private: false });
    expect(result).toEqual({ full_name: 'TheFactoryOrg/solution-foo', default_branch: 'main', html_url: 'https://github.com/TheFactoryOrg/solution-foo' });
  });

  it('pushInitialCommit creates blobs, a tree, a commit, and updates main', async () => {
    const client = new GitHubClient({ token: 't', org: 'TheFactoryOrg' });
    const files: GitHubFile[] = [
      { path: 'README.md', content: 'hello' },
      { path: 'package.json', content: '{}' },
    ];
    const sha = await client.pushInitialCommit('solution-foo', files, 'initial commit');
    expect(sha).toBe('commit-sha-123');
    expect(mockRest.git.createBlob).toHaveBeenCalledTimes(2);
    expect(mockRest.git.createTree).toHaveBeenCalledOnce();
    expect(mockRest.git.createCommit).toHaveBeenCalledOnce();
    expect(mockRest.git.updateRef).toHaveBeenCalledOnce();
  });

  it('commitAndPush formats the commit message with persona + iter prefix', async () => {
    const client = new GitHubClient({ token: 't', org: 'TheFactoryOrg' });
    await client.commitAndPush('solution-foo', [{ path: 'app/page.tsx', content: 'x' }], {
      subject: 'add hero section',
      persona: 'builder',
      iteration: 2,
    });
    const commitCall = mockCalls.find(c => c.method === 'git.createCommit');
    expect((commitCall?.args as { message: string }).message).toBe('builder(2): add hero section');
  });

  it('setRepoDescription delegates to repos.update', async () => {
    const client = new GitHubClient({ token: 't', org: 'TheFactoryOrg' });
    await client.setRepoDescription('solution-foo', 'Preview at https://solution-foo.vercel.app');
    expect(mockRest.repos.update).toHaveBeenCalledOnce();
    const args = mockRest.repos.update.mock.calls[0][0] as { description: string };
    expect(args.description).toBe('Preview at https://solution-foo.vercel.app');
  });

  it('listLatestWorkflowRun returns the most recent run conclusion', async () => {
    const client = new GitHubClient({ token: 't', org: 'TheFactoryOrg' });
    const run = await client.listLatestWorkflowRun('solution-foo');
    expect(run).toEqual({ id: 1, conclusion: 'success', html_url: 'https://gh/run/1' });
  });
});
