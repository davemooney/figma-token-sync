/**
 * Published-component index.
 *
 * Before per-file analysis we build an index of every *published* component
 * (and component set) across the audited library files. This lets the rules:
 *   - recognise instances pointing at a published (library) component vs. a
 *     local one, and
 *   - flag local components whose *name* duplicates a published one.
 *
 * Source: `GET /v1/files/:key/components` and `/component_sets`. The index is
 * cached on disk (it changes rarely relative to layout edits).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { FigmaClient } from "../figma-client.js";
import type { ComponentsResponse, PublishedComponent } from "./types.js";

export interface LibraryIndex {
  /** Component key → published component. */
  byKey: Map<string, PublishedComponent>;
  /** Normalised name → published component (for duplicate detection). */
  byName: Map<string, PublishedComponent>;
  /** node_id → published component (an instance's componentId can match this). */
  byNodeId: Map<string, PublishedComponent>;
  count: number;
}

/** Normalise a component name for fuzzy duplicate matching. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s/_-]+/g, " ")
    .trim();
}

export function emptyIndex(): LibraryIndex {
  return { byKey: new Map(), byName: new Map(), byNodeId: new Map(), count: 0 };
}

function ingest(index: LibraryIndex, components: PublishedComponent[]): void {
  for (const c of components) {
    if (!c.key) continue;
    index.byKey.set(c.key, c);
    index.byName.set(normalizeName(c.name), c);
    if (c.node_id) index.byNodeId.set(c.node_id, c);
    index.count += 1;
  }
}

async function fetchLibraryForFile(
  client: FigmaClient,
  fileKey: string,
): Promise<PublishedComponent[]> {
  const out: PublishedComponent[] = [];
  for (const endpoint of ["components", "component_sets"]) {
    try {
      const res = await client.getJSON<ComponentsResponse>(
        `/files/${encodeURIComponent(fileKey)}/${endpoint}`,
      );
      const list =
        endpoint === "components"
          ? res.meta?.components
          : res.meta?.component_sets;
      if (list) out.push(...list);
    } catch {
      // A file with no published library returns 404 / empty — fine.
    }
  }
  return out;
}

/**
 * Build the published-component index across one or more library files.
 * Pass the keys of the files that *publish* your design-system library.
 */
export async function buildLibraryIndex(
  client: FigmaClient,
  libraryFileKeys: string[],
  opts: { cacheDir?: string; noCache?: boolean } = {},
): Promise<LibraryIndex> {
  const index = emptyIndex();
  const cacheDir = opts.cacheDir ?? ".figma-audit-cache";
  const cachePath = join(
    cacheDir,
    `library-index-${[...libraryFileKeys].sort().join("_").slice(0, 80)}.json`,
  );

  if (!opts.noCache && existsSync(cachePath)) {
    try {
      const cached = JSON.parse(
        await readFile(cachePath, "utf8"),
      ) as PublishedComponent[];
      ingest(index, cached);
      return index;
    } catch {
      // Fall through to a live rebuild on a corrupt cache.
    }
  }

  const all: PublishedComponent[] = [];
  for (const key of libraryFileKeys) {
    all.push(...(await fetchLibraryForFile(client, key)));
  }
  ingest(index, all);

  if (!opts.noCache) {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cachePath, JSON.stringify(all), "utf8");
  }
  return index;
}

/** Build an index directly from already-fetched component lists (tests). */
export function indexFromComponents(
  components: PublishedComponent[],
): LibraryIndex {
  const index = emptyIndex();
  ingest(index, components);
  return index;
}
