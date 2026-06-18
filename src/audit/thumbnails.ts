/**
 * `--thumbnails`: image each flagged frame once via `GET /v1/images`, inline the
 * rendered bytes (so the report stays self-contained), and normalise each
 * finding's bounding box into the frame's own pixel space for the overlay.
 *
 * Why one image per FRAME (not per leaf): `/v1/images` is rate-limited and the
 * returned S3 URLs are time-boxed. The analyzer already tagged every finding
 * with its nearest FRAME/COMPONENT ancestor (`frameId`/`frameBox`), so we dedupe
 * to unique frames, image each once, and overlay all its findings.
 *
 * Self-containment: Figma returns an S3 URL, never inline bytes. We fetch the
 * bytes promptly (the URL expires) and inline them — SVG as raw markup, PNG as a
 * `data:` URI — caching the *bytes* (not the URL) under the existing
 * `.figma-audit-cache`, keyed by `(fileKey, version, frameId, format, scale)`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { FigmaClient } from "../figma-client.js";
import type {
  BoundingBox,
  Finding,
  FrameThumbnail,
  ThumbnailOverlay,
} from "./types.js";

export interface ThumbnailOptions {
  format?: "svg" | "png";
  /** Pixel scale passed to `/v1/images` (1–4). */
  scale?: number;
  /** Cap the number of frames imaged; logged when truncated. */
  max?: number;
  /** Parallel `/v1/images` + S3 byte fetches. */
  concurrency?: number;
  cacheDir?: string;
  noCache?: boolean;
  /** Per-frame `version` (for cache keying), keyed by fileKey. */
  fileVersions?: Record<string, string>;
  /** Injectable for tests — fetches the S3 bytes URL. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  onProgress?: (done: number, total: number, frameId: string) => void;
  log?: (msg: string) => void;
}

/**
 * THE fiddly bit (issue #3). `/v1/images` renders the frame at its own bounds,
 * so the export's pixel origin is the frame's top-left. A flagged child node's
 * rect in the image = (child absolute box − frame absolute origin) × scale.
 *
 * Pure + clamped to the frame so a slightly-overflowing child can't paint
 * outside the thumbnail. Exported for direct unit testing.
 */
export function normalizeRect(
  nodeBox: BoundingBox,
  frameBox: BoundingBox,
  scale: number,
): BoundingBox {
  const s = scale > 0 ? scale : 1;
  const relX = (nodeBox.x - frameBox.x) * s;
  const relY = (nodeBox.y - frameBox.y) * s;
  const w = nodeBox.width * s;
  const h = nodeBox.height * s;

  const frameW = frameBox.width * s;
  const frameH = frameBox.height * s;

  // Clamp into [0, frameW/H]; keep at least a hairline so a 0-size box still
  // shows. Order matters: clamp origin, then clamp size to the remaining room.
  const x = Math.max(0, Math.min(relX, frameW));
  const y = Math.max(0, Math.min(relY, frameH));
  const width = Math.max(1, Math.min(w, frameW - x));
  const height = Math.max(1, Math.min(h, frameH - y));

  // Round to whole pixels for stable SVG output / golden tests.
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/** Cache path for a frame's inlined bytes. */
function cachePath(
  dir: string,
  fileKey: string,
  version: string,
  frameId: string,
  format: string,
  scale: number,
): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(
    dir,
    `thumb_${safe(fileKey)}@${safe(version)}__${safe(frameId)}__${format}@${scale}.txt`,
  );
}

interface FrameGroup {
  fileKey: string;
  fileName: string;
  page: string;
  frameId: string;
  frameName: string;
  frameBox: BoundingBox;
  findings: Finding[];
}

/**
 * Group findings into unique imageable frames. A finding without a `frameId` +
 * `frameBox` (Figma didn't expose a box, or it's a page-level aggregate) can't
 * be overlaid, so it's skipped here (still appears in the text table).
 */
function groupByFrame(findings: Finding[]): FrameGroup[] {
  const groups = new Map<string, FrameGroup>();
  for (const f of findings) {
    if (!f.frameId || !f.frameBox) continue;
    const key = `${f.fileKey}::${f.frameId}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        fileKey: f.fileKey,
        fileName: f.fileName,
        page: f.page,
        frameId: f.frameId,
        frameName: f.frameName ?? f.frameId,
        frameBox: f.frameBox,
        findings: [],
      };
      groups.set(key, g);
    }
    g.findings.push(f);
  }
  return [...groups.values()];
}

/** Adoption % for a frame = instances / (instances + raw) among its findings'
 * sibling nodes is not knowable here; instead approximate from finding mix:
 * we report the share of the frame's nodes that are *not* flagged-as-raw. With
 * only findings to hand, we use 100 − (raw-style findings / total findings)·100,
 * which gives a sensible per-frame health ring. */
function frameAdoption(findings: Finding[]): number {
  if (findings.length === 0) return 100;
  const rawish = findings.filter(
    (f) =>
      f.rule === "unbound-value" ||
      f.rule === "adhoc-text" ||
      f.rule === "local-component",
  ).length;
  const pct = Math.round((1 - rawish / findings.length) * 1000) / 10;
  return Math.max(0, Math.min(100, pct));
}

function buildOverlays(g: FrameGroup, scale: number): ThumbnailOverlay[] {
  const out: ThumbnailOverlay[] = [];
  for (const f of g.findings) {
    if (!f.nodeBox) continue;
    out.push({
      nodeId: f.nodeId,
      rule: f.rule,
      severity: f.severity,
      message: f.message,
      rect: normalizeRect(f.nodeBox, g.frameBox, scale),
    });
  }
  return out;
}

function flagCounts(findings: Finding[]): FrameThumbnail["flagCounts"] {
  const counts: FrameThumbnail["flagCounts"] = {};
  for (const f of findings) counts[f.rule] = (counts[f.rule] ?? 0) + 1;
  return counts;
}

/** `GET /v1/images/:key?...` → `{ images: { [nodeId]: url } }`. */
interface ImagesResponse {
  err?: string | null;
  images: Record<string, string | null>;
}

/**
 * Fetch one frame's rendered bytes (via the rate-limited client + a prompt S3
 * fetch) and inline them. Returns null on failure (a broken export shouldn't
 * abort the whole gallery).
 */
async function fetchInlineImage(
  client: FigmaClient,
  fetchImpl: typeof fetch,
  fileKey: string,
  frameId: string,
  format: "svg" | "png",
  scale: number,
): Promise<FrameThumbnail["image"] | null> {
  const qs = new URLSearchParams({
    ids: frameId,
    format,
    scale: String(scale),
  });
  const resp = await client.getJSON<ImagesResponse>(
    `/images/${encodeURIComponent(fileKey)}?${qs.toString()}`,
  );
  const url = resp.images?.[frameId];
  if (!url) return null;

  const res = await fetchImpl(url);
  if (!res.ok) return null;

  if (format === "svg") {
    const markup = await res.text();
    return { kind: "svg", markup };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const dataUri = `data:image/png;base64,${buf.toString("base64")}`;
  return { kind: "png", dataUri };
}

async function readImageCache(
  path: string,
  format: "svg" | "png",
): Promise<FrameThumbnail["image"] | null> {
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf8");
  return format === "svg"
    ? { kind: "svg", markup: raw }
    : { kind: "png", dataUri: raw };
}

async function writeImageCache(
  path: string,
  image: FrameThumbnail["image"],
): Promise<void> {
  const payload = image.kind === "svg" ? image.markup : image.dataUri;
  await writeFile(path, payload, "utf8");
}

/**
 * Build the `FrameThumbnail[]` for every flagged frame. Bounded concurrency,
 * byte-level caching, `--thumb-max` cap (logged when hit). Frames whose export
 * fails are dropped (and logged) rather than aborting the run.
 */
export async function buildFrameThumbnails(
  client: FigmaClient,
  findings: Finding[],
  options: ThumbnailOptions = {},
): Promise<FrameThumbnail[]> {
  const format = options.format ?? "svg";
  const scale = options.scale && options.scale > 0 ? options.scale : 1;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const cacheDir = options.cacheDir ?? ".figma-audit-cache";
  const noCache = options.noCache ?? false;
  const fetchImpl = options.fetchImpl ?? fetch;
  const versions = options.fileVersions ?? {};
  const log = options.log ?? (() => {});

  let groups = groupByFrame(findings);
  if (options.max !== undefined && groups.length > options.max) {
    log(
      `⚠ --thumb-max ${options.max}: imaging ${options.max} of ${groups.length} flagged frame(s) (truncated).`,
    );
    groups = groups.slice(0, options.max);
  }

  if (!noCache) await mkdir(cacheDir, { recursive: true }).catch(() => {});

  const out: (FrameThumbnail | null)[] = new Array(groups.length).fill(null);
  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= groups.length) return;
      const g = groups[i];
      const version = versions[g.fileKey] ?? "";
      const path = cachePath(
        cacheDir,
        g.fileKey,
        version,
        g.frameId,
        format,
        scale,
      );

      let image: FrameThumbnail["image"] | null = null;
      try {
        if (!noCache) image = await readImageCache(path, format);
        if (!image) {
          image = await fetchInlineImage(
            client,
            fetchImpl,
            g.fileKey,
            g.frameId,
            format,
            scale,
          );
          if (image && !noCache) {
            await writeImageCache(path, image).catch(() => {});
          }
        }
      } catch (err) {
        log(
          `⚠ thumbnail failed for ${g.frameName} (${g.frameId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        image = null;
      }

      done += 1;
      options.onProgress?.(done, groups.length, g.frameId);
      if (!image) continue;

      out[i] = {
        fileKey: g.fileKey,
        fileName: g.fileName,
        page: g.page,
        frameId: g.frameId,
        frameName: g.frameName,
        frameBox: g.frameBox,
        image,
        scale,
        adoptionPct: frameAdoption(g.findings),
        flagCounts: flagCounts(g.findings),
        overlays: buildOverlays(g, scale),
      };
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, groups.length) }, () =>
      worker(),
    ),
  );

  return out.filter((t): t is FrameThumbnail => t !== null);
}
