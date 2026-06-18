/**
 * Bulk, cached, concurrency-capped fetch of many Figma files for the audit.
 *
 * Hitting hundreds of files through `GET /v1/files/:key` will trip Figma's
 * rate limits without care, so this layer adds:
 *   - bounded concurrency (a small worker pool),
 *   - an on-disk response cache keyed by the file `version` (a no-op edit-free
 *     re-run costs one cheap metadata request per file, not a full tree fetch),
 *   - delegation of per-request backoff/limiting to `FigmaClient.getJSON`.
 *
 * The cache stores the full file payload under `<cacheDir>/<key>@<version>.json`.
 * We read the lightweight `?depth=1` metadata first to learn the current
 * `version`; if a matching cache file exists we skip the heavy download.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { FigmaClient } from "../figma-client.js";
import type { FigmaFileResponse } from "./types.js";

export interface BulkFetchOptions {
  /** Max files fetched in parallel. Conservative by default. */
  concurrency?: number;
  /** Directory for the on-disk version cache. */
  cacheDir?: string;
  /** Disable the cache entirely (always re-download). */
  noCache?: boolean;
  /** Progress callback: (done, total, fileKey). */
  onProgress?: (done: number, total: number, fileKey: string) => void;
}

export interface BulkFetchResult {
  fileKey: string;
  file?: FigmaFileResponse;
  fromCache: boolean;
  error?: string;
}

function cachePath(dir: string, fileKey: string, version: string): string {
  const safeVersion = version.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(dir, `${fileKey}@${safeVersion}.json`);
}

/**
 * Enumerate file keys for a whole team via the projects → files endpoints.
 * `GET /v1/teams/:id/projects` → `GET /v1/projects/:id/files`.
 */
export async function listTeamFileKeys(
  client: FigmaClient,
  teamId: string,
): Promise<string[]> {
  const projects = await client.getJSON<{ projects: { id: string }[] }>(
    `/teams/${encodeURIComponent(teamId)}/projects`,
  );
  const keys: string[] = [];
  for (const project of projects.projects ?? []) {
    const files = await client.getJSON<{ files: { key: string }[] }>(
      `/projects/${encodeURIComponent(project.id)}/files`,
    );
    for (const f of files.files ?? []) keys.push(f.key);
  }
  return keys;
}

async function fetchOne(
  client: FigmaClient,
  fileKey: string,
  opts: Required<Pick<BulkFetchOptions, "cacheDir" | "noCache">>,
): Promise<BulkFetchResult> {
  try {
    if (!opts.noCache) {
      // Cheap metadata read to learn the current version.
      const meta = await client.getJSON<{ version: string }>(
        `/files/${encodeURIComponent(fileKey)}?depth=1`,
      );
      const path = cachePath(opts.cacheDir, fileKey, meta.version);
      if (existsSync(path)) {
        const cached = JSON.parse(
          await readFile(path, "utf8"),
        ) as FigmaFileResponse;
        return { fileKey, file: cached, fromCache: true };
      }
      const file = await client.getJSON<FigmaFileResponse>(
        `/files/${encodeURIComponent(fileKey)}`,
      );
      await mkdir(opts.cacheDir, { recursive: true });
      await writeFile(path, JSON.stringify(file), "utf8");
      return { fileKey, file, fromCache: false };
    }

    const file = await client.getJSON<FigmaFileResponse>(
      `/files/${encodeURIComponent(fileKey)}`,
    );
    return { fileKey, file, fromCache: false };
  } catch (err) {
    return {
      fileKey,
      fromCache: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Fetch many files with a bounded worker pool. Failures are captured per-file
 * (an unreadable file shouldn't abort an audit of hundreds), never thrown.
 */
export async function bulkFetchFiles(
  client: FigmaClient,
  fileKeys: string[],
  options: BulkFetchOptions = {},
): Promise<BulkFetchResult[]> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const cacheDir = options.cacheDir ?? ".figma-audit-cache";
  const noCache = options.noCache ?? false;
  const onProgress = options.onProgress;

  const results: BulkFetchResult[] = new Array(fileKeys.length);
  let next = 0;
  let done = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= fileKeys.length) return;
      const key = fileKeys[index];
      results[index] = await fetchOne(client, key, { cacheDir, noCache });
      done += 1;
      onProgress?.(done, fileKeys.length, key);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, fileKeys.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
