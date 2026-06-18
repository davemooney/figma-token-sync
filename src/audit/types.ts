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
}

/** Build a Figma deep-link to a node. */
export function deepLink(fileKey: string, nodeId: string): string {
  return `https://figma.com/file/${fileKey}?node-id=${encodeURIComponent(nodeId)}`;
}
