import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VercelClient } from '../lib/vercel.js';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  // @ts-expect-error — assign global fetch for the duration of the test
  globalThis.fetch = fetchMock;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('VercelClient', () => {
  it('createProject POSTs to /v9/projects with framework + gitRepository', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'prj_123', name: 'solution-foo' }));
    const client = new VercelClient({ token: 'tkn', orgId: 'team_x' });
    const project = await client.createProject({ slug: 'foo', githubFullName: 'TheFactoryOrg/solution-foo' });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.vercel.com/v9/projects?teamId=team_x');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.name).toBe('solution-foo');
    expect(body.framework).toBe('nextjs');
    expect(body.gitRepository).toEqual({ type: 'github', repo: 'TheFactoryOrg/solution-foo' });
    expect(project).toEqual({ id: 'prj_123', name: 'solution-foo' });
  });

  it('setEnvVars POSTs one entry per key', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ created: true })));
    const client = new VercelClient({ token: 'tkn', orgId: 'team_x' });
    await client.setEnvVars('prj_123', { APP_NAME: 'Foo', APP_DESCRIPTION: 'desc' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url1, init1] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url1).toBe('https://api.vercel.com/v10/projects/prj_123/env?teamId=team_x');
    const body1 = JSON.parse(init1.body as string);
    expect(body1).toMatchObject({ key: 'APP_NAME', value: 'Foo', type: 'encrypted', target: ['production', 'preview'] });
  });

  it('attachDomain POSTs to /v10/projects/<id>/domains', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ name: 'foo.example.com', verified: false }));
    const client = new VercelClient({ token: 'tkn', orgId: 'team_x' });
    const result = await client.attachDomain('prj_123', 'foo.example.com');
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.vercel.com/v10/projects/prj_123/domains?teamId=team_x');
    expect(result).toEqual({ name: 'foo.example.com', verified: false });
  });

  it('getLatestDeployment returns the most recent deployment', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      deployments: [
        { uid: 'dpl_2', state: 'READY', url: 'solution-foo-2.vercel.app', createdAt: 200 },
        { uid: 'dpl_1', state: 'READY', url: 'solution-foo-1.vercel.app', createdAt: 100 },
      ],
    }));
    const client = new VercelClient({ token: 'tkn', orgId: 'team_x' });
    const dep = await client.getLatestDeployment('prj_123');
    expect(dep).toEqual({ uid: 'dpl_2', state: 'READY', url: 'solution-foo-2.vercel.app' });
  });

  it('throws if the API responds non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'forbidden' } }, 403));
    const client = new VercelClient({ token: 'tkn', orgId: 'team_x' });
    await expect(client.createProject({ slug: 'foo', githubFullName: 'TheFactoryOrg/solution-foo' }))
      .rejects.toThrow(/vercel api 403/i);
  });
});
