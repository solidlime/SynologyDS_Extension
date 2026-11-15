/** Kept free of imports so the path fallback can be unit-tested without a NAS. */

export const TASK_API = 'SYNO.DownloadStation.Task';

export interface ApiInfo {
  path: string;
  maxVersion: number;
  minVersion: number;
}

/** APIs that must not fall back to entry.cgi when discovery fails (102 otherwise). */
export const DEFAULT_PATHS: Record<string, string> = {
  [TASK_API]: 'DownloadStation/task.cgi',
};

/** Discovered path, else a known-good default, else entry.cgi. */
export function pathFor(apiInfo: Record<string, ApiInfo>, api: string): string {
  return apiInfo[api]?.path || DEFAULT_PATHS[api] || 'entry.cgi';
}
