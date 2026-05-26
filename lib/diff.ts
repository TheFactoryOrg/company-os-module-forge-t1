export interface SeedFeatureSnapshot {
  feature_id: string;
  version: number;
  /** File paths (relative to solution repo root) materialized by this feature. */
  files: string[];
}

export interface SeedSnapshot {
  features: SeedFeatureSnapshot[];
}

export type FileChunk =
  | { path: string; origin: 'from-feature'; feature_id: string; version: number }
  | { path: string; origin: 'new-code' };

/**
 * Classify each file in the final commit tree as either coming from a seed
 * feature (with the feature_id + version it was materialized from) or
 * authored fresh during the build.
 *
 * If two features claim the same path, the first one in seed.features wins.
 */
export function classifyFiles(seed: SeedSnapshot, finalFiles: string[]): FileChunk[] {
  const featureFor = new Map<string, { feature_id: string; version: number }>();
  for (const feat of seed.features) {
    for (const path of feat.files) {
      if (!featureFor.has(path)) {
        featureFor.set(path, { feature_id: feat.feature_id, version: feat.version });
      }
    }
  }

  return finalFiles.map(path => {
    const owner = featureFor.get(path);
    if (owner) {
      return { path, origin: 'from-feature', feature_id: owner.feature_id, version: owner.version };
    }
    return { path, origin: 'new-code' };
  });
}
