/**
 * Shared types for the `audit` subcommand.
 *
 * These model the *subset* of the Figma REST file/component payloads the audit
 * relies on. Figma nodes are deeply recursive and loosely typed in the wire
 * format; we keep optional fields and walk defensively in `analyze.ts`.
 */

/** A node in a Figma document tree (the shape `GET /v1/files/:key` returns). */
export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];

  /** Absolute bounding box (page coordinate space), present on rendered nodes. */
  absoluteBoundingBox?: BoundingBox;

  /** Present on INSTANCE nodes — points at the main component. */
  componentId?: string;

  /** Bound design-variable references, keyed by bindable field. */
  boundVariables?: Record<string, unknown>;

  /** Applied shared styles, keyed by style domain (fill/text/effect/stroke). */
  styles?: Record<string, string>;

  fills?: FigmaPaint[];
  strokes?: FigmaPaint[];
  effects?: FigmaEffect[];

  // Allow unknown extra fields without losing type-safety on the known ones.
  [key: string]: unknown;
}

/** Axis-aligned rectangle in Figma's absolute (page) coordinate space. */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FigmaPaint {
  type: string; // SOLID | GRADIENT_* | IMAGE | ...
  visible?: boolean;
  color?: { r: number; g: number; b: number; a?: number };
  boundVariables?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FigmaEffect {
  type: string; // DROP_SHADOW | INNER_SHADOW | LAYER_BLUR | ...
  visible?: boolean;
  boundVariables?: Record<string, unknown>;
  [key: string]: unknown;
}

/** `GET /v1/files/:key` response (trimmed to what we use). */
export interface FigmaFileResponse {
  name: string;
  version: string;
  lastModified?: string;
  document: FigmaNode;
}

/** `GET /v1/files/:key/components` + `/component_sets` entry. */
export interface PublishedComponent {
  key: string;
  name: string;
  node_id?: string;
  containing_frame?: { name?: string; pageName?: string };
}

export interface ComponentsResponse {
  meta?: { components?: PublishedComponent[]; component_sets?: PublishedComponent[] };
}

export type Severity = "info" | "warning" | "error";

export type RuleId =
  | "adoption"
  | "unbound-value"
  | "adhoc-text"
  | "local-component"
  | "duplicate-component"
  | "detached-candidate";

/** A single flagged node (or aggregate, for adoption). */
export interface Finding {
  fileKey: string;
  fileName: string;
  page: string;
  nodePath: string;
  nodeId: string;
  type: string;
  rule: RuleId;
  severity: Severity;
  message: string;
  figmaDeepLink: string;

  /**
   * Absolute bounding box of the flagged node (when Figma exposed one). Used by
   * the `--thumbnails` overlay to outline the node in place over its frame.
   */
  nodeBox?: BoundingBox;
  /** Nearest FRAME/COMPONENT/COMPONENT_SET ancestor of the flagged node. */
  frameId?: string;
  frameName?: string;
  frameBox?: BoundingBox;
}

/**
 * A frame imaged via `/v1/images` for the `--thumbnails` surfaces. The rendered
 * export is inlined (SVG markup or a PNG `data:` URI) so the report stays
 * self-contained. `overlays` are the flagged-node rects normalised to the
 * frame's own origin/scale.
 */
export interface FrameThumbnail {
  fileKey: string;
  fileName: string;
  page: string;
  frameId: string;
  frameName: string;
  /** Frame box in absolute coords (the export's own bounds). */
  frameBox: BoundingBox;
  /** Inlined image: either raw SVG markup or a `data:` URI for PNG. */
  image: { kind: "svg"; markup: string } | { kind: "png"; dataUri: string };
  /** Pixel scale the image was rendered at (1 unless `--thumb-scale`). */
  scale: number;
  /** Frame-level adoption %, for the gallery's adoption ring. */
  adoptionPct: number;
  /** Flag breakdown for this frame, keyed by rule. */
  flagCounts: Partial<Record<RuleId, number>>;
  /** Findings belonging to this frame, with overlay rects. */
  overlays: ThumbnailOverlay[];
}

/** One outlined flagged node within a frame thumbnail. */
export interface ThumbnailOverlay {
  nodeId: string;
  rule: RuleId;
  severity: Severity;
  message: string;
  /** Rect relative to the frame origin, in the image's pixel space. */
  rect: BoundingBox;
}

/** Per-file adoption + finding rollup. */
export interface FileReport {
  fileKey: string;
  fileName: string;
  version: string;
  instanceCount: number;
  rawCount: number;
  adoptionPct: number;
  findings: Finding[];
  pages: PageReport[];
  error?: string;
}

export interface PageReport {
  name: string;
  nodeId: string;
  instanceCount: number;
  rawCount: number;
  adoptionPct: number;
}

/** Portfolio-wide audit result — the input to every reporter. */
export interface AuditResult {
  generatedAt: string;
  fileCount: number;
  instanceCount: number;
  rawCount: number;
  adoptionPct: number;
  files: FileReport[];
  findings: Finding[];
  countsByRule: Record<RuleId, number>;
  countsBySeverity: Record<Severity, number>;
  libraryComponentCount: number;
  /**
   * Inlined frame thumbnails (only populated when `--thumbnails` ran). The HTML
   * reporter renders the gallery + inline-preview surfaces from these. Absent /
   * empty → the report is byte-identical to the text-only build.
   */
  frameThumbnails?: FrameThumbnail[];
}

/** Build a Figma deep-link to a node. */
export function deepLink(fileKey: string, nodeId: string): string {
  return `https://figma.com/file/${fileKey}?node-id=${encodeURIComponent(nodeId)}`;
}
