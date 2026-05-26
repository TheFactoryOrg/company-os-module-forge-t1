import { describe, it, expect } from 'vitest';
import { classifyFiles, type SeedSnapshot } from '../lib/diff.js';

describe('classifyFiles', () => {
  it('classifies files that exist in seed as from-feature', () => {
    const seed: SeedSnapshot = {
      features: [
        { feature_id: 'feat-landing', version: 1, files: ['app/page.tsx', 'app/layout.tsx'] },
        { feature_id: 'feat-seo', version: 2, files: ['app/sitemap.ts'] },
      ],
    };
    const finalFiles = ['app/page.tsx', 'app/layout.tsx', 'app/sitemap.ts'];
    const chunks = classifyFiles(seed, finalFiles);
    expect(chunks).toEqual([
      { path: 'app/page.tsx', origin: 'from-feature', feature_id: 'feat-landing', version: 1 },
      { path: 'app/layout.tsx', origin: 'from-feature', feature_id: 'feat-landing', version: 1 },
      { path: 'app/sitemap.ts', origin: 'from-feature', feature_id: 'feat-seo', version: 2 },
    ]);
  });

  it('classifies files absent from seed as new-code', () => {
    const seed: SeedSnapshot = {
      features: [{ feature_id: 'feat-landing', version: 1, files: ['app/page.tsx'] }],
    };
    const finalFiles = ['app/page.tsx', 'app/hero.tsx', 'lib/analytics.ts'];
    const chunks = classifyFiles(seed, finalFiles);
    expect(chunks).toContainEqual({ path: 'app/page.tsx', origin: 'from-feature', feature_id: 'feat-landing', version: 1 });
    expect(chunks).toContainEqual({ path: 'app/hero.tsx', origin: 'new-code' });
    expect(chunks).toContainEqual({ path: 'lib/analytics.ts', origin: 'new-code' });
  });

  it('handles empty seed (no features pulled) — everything is new-code', () => {
    const seed: SeedSnapshot = { features: [] };
    const finalFiles = ['app/page.tsx', 'README.md'];
    const chunks = classifyFiles(seed, finalFiles);
    expect(chunks.every(c => c.origin === 'new-code')).toBe(true);
  });

  it('first-wins on overlapping feature file paths', () => {
    const seed: SeedSnapshot = {
      features: [
        { feature_id: 'feat-a', version: 1, files: ['app/layout.tsx'] },
        { feature_id: 'feat-b', version: 1, files: ['app/layout.tsx'] },
      ],
    };
    const chunks = classifyFiles(seed, ['app/layout.tsx']);
    expect(chunks[0]).toMatchObject({ path: 'app/layout.tsx', feature_id: 'feat-a' });
  });
});
