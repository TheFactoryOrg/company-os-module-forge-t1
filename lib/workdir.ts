import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface WorkdirFile {
  path: string;     // RELATIVE path inside the workdir; no leading slash, no ..
  content: string;
}

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ShellOpts {
  timeoutMs: number;        // hard kill after this
  env?: Record<string, string>;
}

/**
 * A per-build local clone of a solution repo. The coordinator constructs
 * one at scaffold time (via Workdir.cloneRepo) and reuses it across
 * iterations. Tools write into it; the sandbox runs commands in it;
 * commit_to_solution commits + pushes from it.
 */
export class Workdir {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) {
      throw new Error(`Workdir root must be absolute (got "${root}")`);
    }
    fs.mkdirSync(root, { recursive: true });
  }

  static async cloneRepo(httpsUrl: string, root: string, token: string): Promise<Workdir> {
    // Clone with an embedded token. The clone URL is rewritten so the token
    // appears in the local .git/config but never in any process arg list.
    const authenticatedUrl = httpsUrl.replace('https://', `https://x-access-token:${token}@`);
    const wd = new Workdir(root);
    const r = await wd.runShellOutsideRoot(`git clone --depth 1 ${shellQuote(authenticatedUrl)} ${shellQuote(root)}`, { timeoutMs: 60_000 });
    if (r.exitCode !== 0) throw new Error(`git clone failed: ${r.stderr.slice(-500)}`);
    wd.seedDefaultGitignore();
    return wd;
  }

  /**
   * Local-mode workdir (Phase 11): initialize a fresh git repo at `root`
   * with no remote. Used when forge_runs.local=1 so the build proceeds
   * without ever calling GitHub. The sandbox + commits run unchanged;
   * `stageCommitLocal` replaces `stageCommitPush` (no push).
   */
  static async initLocal(root: string): Promise<Workdir> {
    const wd = new Workdir(root);
    if (!fs.existsSync(path.join(root, '.git'))) {
      const init = await wd.runShell('git init -q -b main', { timeoutMs: 30_000 });
      if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.slice(-500)}`);
    }
    wd.seedDefaultGitignore();
    return wd;
  }

  /**
   * Write a minimal default .gitignore if none exists. Prevents
   * Workdir.stageCommitPush's `git add -A` from staging the entire
   * node_modules tree produced by sandbox (npm install) — that tree
   * caused `git pack-objects` to OOM-kill in the 2026-05-28 prod E2E.
   * The agent can still overwrite via writeFiles; this is just the floor.
   */
  private seedDefaultGitignore(): void {
    const p = path.join(this.root, '.gitignore');
    if (fs.existsSync(p)) return;
    fs.writeFileSync(p, 'node_modules/\n.env\n', 'utf-8');
  }

  get path(): string { return this.root; }

  async writeFiles(files: WorkdirFile[]): Promise<void> {
    for (const f of files) {
      if (path.isAbsolute(f.path)) throw new Error(`writeFiles: path must be relative (got absolute "${f.path}")`);
      const resolved = path.resolve(this.root, f.path);
      if (!resolved.startsWith(this.root + path.sep) && resolved !== this.root) {
        throw new Error(`writeFiles: path traversal blocked ("${f.path}" → "${resolved}")`);
      }
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, f.content, 'utf-8');
    }
  }

  async runShell(cmd: string, opts: ShellOpts): Promise<ShellResult> {
    return this.runShellAt(this.root, cmd, opts);
  }

  private async runShellOutsideRoot(cmd: string, opts: ShellOpts): Promise<ShellResult> {
    return this.runShellAt(process.cwd(), cmd, opts);
  }

  private async runShellAt(cwd: string, cmd: string, opts: ShellOpts): Promise<ShellResult> {
    return new Promise<ShellResult>(resolve => {
      const started = Date.now();
      const child = spawn('bash', ['-lc', cmd], {
        cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      }, opts.timeoutMs);
      child.stdout.on('data', d => { stdout += d.toString(); if (stdout.length > 100_000) stdout = stdout.slice(-100_000); });
      child.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 100_000) stderr = stderr.slice(-100_000); });
      child.on('close', code => {
        clearTimeout(timer);
        resolve({
          exitCode: code ?? -1,
          stdout, stderr,
          timedOut,
          durationMs: Date.now() - started,
        });
      });
    });
  }

  async stageCommitPush(message: string): Promise<string> {
    const add = await this.runShell('git add -A', { timeoutMs: 30_000 });
    if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr}`);
    const commit = await this.runShell(`git -c user.email=forge-t1@thefactoryorg.dev -c user.name="Forge T1" commit -m ${shellQuote(message)}`, { timeoutMs: 30_000 });
    if (commit.exitCode !== 0 && !commit.stdout.includes('nothing to commit')) {
      throw new Error(`git commit failed: ${commit.stderr}`);
    }
    const push = await this.runShell('git push origin HEAD', { timeoutMs: 60_000 });
    if (push.exitCode !== 0) throw new Error(`git push failed: ${push.stderr}`);
    const sha = await this.runShell('git rev-parse HEAD', { timeoutMs: 10_000 });
    return sha.stdout.trim();
  }

  /**
   * Same as stageCommitPush but skips the `git push` — for local-mode builds.
   * Returns the new HEAD sha so callers can record final_commit_sha unchanged.
   */
  async stageCommitLocal(message: string): Promise<string> {
    const add = await this.runShell('git add -A', { timeoutMs: 30_000 });
    if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr}`);
    const commit = await this.runShell(`git -c user.email=forge-t1@thefactoryorg.dev -c user.name="Forge T1" commit -m ${shellQuote(message)}`, { timeoutMs: 30_000 });
    if (commit.exitCode !== 0 && !commit.stdout.includes('nothing to commit')) {
      throw new Error(`git commit failed: ${commit.stderr}`);
    }
    const sha = await this.runShell('git rev-parse HEAD', { timeoutMs: 10_000 });
    return sha.stdout.trim();
  }

  async listFiles(): Promise<string[]> {
    const r = await this.runShell('git ls-files', { timeoutMs: 10_000 });
    return r.stdout.split('\n').filter(l => l.trim().length > 0);
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
