export interface VercelClientConfig {
  token: string;
  orgId: string; // Vercel team id; matches VERCEL_ORG_ID env var
}

export interface VercelProject {
  id: string;
  name: string;
}

export interface VercelDeployment {
  uid: string;
  state: string; // QUEUED | BUILDING | READY | ERROR | CANCELED
  url: string;   // hostname without scheme
}

export interface VercelDomainAttachResult {
  name: string;
  verified: boolean;
}

/**
 * Narrow Vercel REST wrapper. Endpoints used:
 *   POST  /v9/projects
 *   POST  /v10/projects/:id/env
 *   POST  /v10/projects/:id/domains
 *   GET   /v6/deployments?projectId=:id
 */
export class VercelClient {
  private token: string;
  private orgId: string;

  constructor(config: VercelClientConfig) {
    this.token = config.token;
    this.orgId = config.orgId;
  }

  async createProject(opts: { slug: string; githubFullName: string }): Promise<VercelProject> {
    const data = await this.request<{ id: string; name: string }>(
      'POST',
      '/v9/projects',
      {
        name: `solution-${opts.slug}`,
        framework: 'nextjs',
        gitRepository: { type: 'github', repo: opts.githubFullName },
      },
    );
    return { id: data.id, name: data.name };
  }

  /**
   * Set encrypted env vars on the project, applied to production + preview.
   * One POST per key — Vercel doesn't expose a batch endpoint for plain key/value pairs.
   */
  async setEnvVars(projectId: string, vars: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(vars)) {
      await this.request(
        'POST',
        `/v10/projects/${projectId}/env`,
        { key, value, type: 'encrypted', target: ['production', 'preview'] },
      );
    }
  }

  async attachDomain(projectId: string, domain: string): Promise<VercelDomainAttachResult> {
    const data = await this.request<{ name: string; verified?: boolean }>(
      'POST',
      `/v10/projects/${projectId}/domains`,
      { name: domain },
    );
    return { name: data.name, verified: data.verified ?? false };
  }

  async getLatestDeployment(projectId: string): Promise<VercelDeployment | null> {
    const data = await this.request<{ deployments: Array<{ uid: string; state: string; url: string; createdAt: number }> }>(
      'GET',
      `/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=1`,
    );
    const d = data.deployments[0];
    if (!d) return null;
    return { uid: d.uid, state: d.state, url: d.url };
  }

  private async request<T>(method: 'GET' | 'POST', pathAndQuery: string, body?: unknown): Promise<T> {
    const sep = pathAndQuery.includes('?') ? '&' : '?';
    const url = `https://api.vercel.com${pathAndQuery}${sep}teamId=${encodeURIComponent(this.orgId)}`;
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Vercel API ${res.status}: ${text.slice(0, 500)}`);
    }
    return (await res.json()) as T;
  }
}
