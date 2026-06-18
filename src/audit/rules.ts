/**
 * Audit rules — the 5 signals from issue #1 (Refinement v2).
 *
 * Reliability tiers (per the locked scope):
 *   RELIABLE   adoption, unbound-value, adhoc-text, local-component
 *   HEURISTIC  duplicate-component (name match), detached-candidate (best-effort)
 *
 * Each rule is independently enable/disable-able, severity-tiered, and respects
 * an `ignore` list of node ids or glob-ish name patterns. Conservative defaults
 * keep noise low: a clean file produces zero findings.
 */

import type { FigmaNode, RuleId, Severity } from "./types.js";
import type { LibraryIndex } from "./library-index.js";
import { normalizeName } from "./library-index.js";

export interface RuleConfig {
  enabled: boolean;
  severity: Severity;
}

export interface AuditConfig {
  /** Per-rule toggles + severity. */
  rules: Record<RuleId, RuleConfig>;
  /**
   * Ignore list: exact node ids, or `*`-glob patterns matched against the
   * node's name and its slash-joined path.
   */
  ignore: string[];
  /** Node types that count as "raw geometry" for the adoption denominator. */
  rawNodeTypes: string[];
}

export const DEFAULT_CONFIG: AuditConfig = {
  rules: {
    adoption: { enabled: true, severity: "info" },
    "unbound-value": { enabled: true, severity: "warning" },
    "adhoc-text": { enabled: true, severity: "warning" },
    "local-component": { enabled: true, severity: "warning" },
    "duplicate-component": { enabled: true, severity: "warning" },
    "detached-candidate": { enabled: true, severity: "info" },
  },
  ignore: [],
  rawNodeTypes: ["RECTANGLE", "FRAME", "VECTOR", "TEXT", "ELLIPSE", "LINE"],
};

/** Merge a partial user config over the defaults (deep on `rules`). */
export function resolveConfig(partial?: Partial<AuditConfig>): AuditConfig {
  if (!partial) return structuredClone(DEFAULT_CONFIG);
  const merged = structuredClone(DEFAULT_CONFIG);
  if (partial.ignore) merged.ignore = partial.ignore;
  if (partial.rawNodeTypes) merged.rawNodeTypes = partial.rawNodeTypes;
  if (partial.rules) {
    for (const [id, cfg] of Object.entries(partial.rules)) {
      const key = id as RuleId;
      if (merged.rules[key] && cfg) {
        merged.rules[key] = { ...merged.rules[key], ...cfg };
      }
    }
  }
  return merged;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/** Does this node match the ignore list (by id, name, or path)? */
export function isIgnored(
  config: AuditConfig,
  node: FigmaNode,
  nodePath: string,
): boolean {
  for (const entry of config.ignore) {
    if (entry === node.id) return true;
    if (entry.includes("*") || entry.includes("?")) {
      const re = globToRegExp(entry);
      if (re.test(node.name) || re.test(nodePath)) return true;
    } else if (entry === node.name) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Individual signal predicates. Each returns a message string when the node
// is a finding, or null otherwise. Pure + node-local → trivially unit-testable.
// ---------------------------------------------------------------------------

/** SIGNAL 2 — a paint/effect carries a literal value but no bound variable. */
export function unboundValueMessage(node: FigmaNode): string | null {
  const offenders: string[] = [];

  const checkPaints = (paints: unknown, label: string): void => {
    if (!Array.isArray(paints)) return;
    for (const paint of paints) {
      if (!paint || typeof paint !== "object") continue;
      const p = paint as Record<string, unknown>;
      if (p.visible === false) continue;
      // Only solid colours carry a bindable literal we can judge.
      if (p.type !== "SOLID") continue;
      const bound = p.boundVariables as Record<string, unknown> | undefined;
      if (!bound || !bound.color) offenders.push(label);
    }
  };

  checkPaints(node.fills, "fill");
  checkPaints(node.strokes, "stroke");

  if (Array.isArray(node.effects)) {
    for (const effect of node.effects) {
      if (!effect || typeof effect !== "object") continue;
      const e = effect as Record<string, unknown>;
      if (e.visible === false) continue;
      const bound = e.boundVariables as Record<string, unknown> | undefined;
      if (!bound || Object.keys(bound).length === 0) offenders.push("effect");
    }
  }

  if (offenders.length === 0) return null;
  const unique = [...new Set(offenders)];
  return `Literal ${unique.join("/")} with no bound variable (off-token).`;
}

/** SIGNAL 3 — a text node with no applied text style. */
export function adhocTextMessage(node: FigmaNode): string | null {
  if (node.type !== "TEXT") return null;
  const styleId = node.styles?.text;
  if (styleId && styleId.length > 0) return null;
  return "Text node uses ad-hoc typography (no shared text style).";
}

/** SIGNAL 4a — an instance of a local (non-library) component. */
export function localComponentMessage(
  node: FigmaNode,
  library: LibraryIndex,
): string | null {
  if (node.type !== "INSTANCE") return null;
  const componentId = node.componentId;
  if (!componentId) return null;
  // Library instances reference a published component by node_id (or its key).
  if (library.byNodeId.has(componentId) || library.byKey.has(componentId)) {
    return null;
  }
  return "Instance of a local component (not from the published library).";
}

/** SIGNAL 4b — a local COMPONENT whose name duplicates a published one. */
export function duplicateComponentMessage(
  node: FigmaNode,
  library: LibraryIndex,
): string | null {
  if (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET") return null;
  const match = library.byName.get(normalizeName(node.name));
  if (!match) return null;
  // Don't flag the published definition against itself.
  if (match.node_id && match.node_id === node.id) return null;
  return `Local component "${node.name}" duplicates published "${match.name}".`;
}

/**
 * SIGNAL 5 — detached-instance CANDIDATE (HEURISTIC, best-effort).
 *
 * REST has no `wasInstance` flag. We surface frames/groups whose name matches a
 * published component as *candidates for human review* — never ground truth.
 */
export function detachedCandidateMessage(
  node: FigmaNode,
  library: LibraryIndex,
): string | null {
  if (node.type !== "FRAME" && node.type !== "GROUP") return null;
  if (node.componentId) return null; // an actual instance, not detached
  const match = library.byName.get(normalizeName(node.name));
  if (!match) return null;
  // Require a little structure so a bare empty frame named "Button" is skipped.
  const childCount = Array.isArray(node.children) ? node.children.length : 0;
  if (childCount === 0) return null;
  return `Frame "${node.name}" matches published component "${match.name}" — possible detached instance (review).`;
}
