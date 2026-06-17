/**
 * Drift validator: compare the committed tokens against the live Figma tokens
 * and produce a structured list of differences.
 */

import type { TokenMap } from "./parser.js";

export type DriftKind = "added" | "removed" | "changed";

export interface Drift {
  kind: DriftKind;
  name: string;
  /** Value in the committed tokens (undefined for "added"). */
  committed?: string | number | boolean;
  /** Value in the live Figma file (undefined for "removed"). */
  live?: string | number | boolean;
}

export interface DriftReport {
  drifts: Drift[];
  hasDrift: boolean;
}

/**
 * @param committed tokens currently checked into the repo
 * @param live      tokens freshly pulled from Figma
 */
export function detectDrift(committed: TokenMap, live: TokenMap): DriftReport {
  const drifts: Drift[] = [];
  const names = new Set([...Object.keys(committed), ...Object.keys(live)]);

  for (const name of [...names].sort()) {
    const c = committed[name];
    const l = live[name];

    if (c && !l) {
      drifts.push({ kind: "removed", name, committed: c.value });
    } else if (!c && l) {
      drifts.push({ kind: "added", name, live: l.value });
    } else if (c && l && c.value !== l.value) {
      drifts.push({
        kind: "changed",
        name,
        committed: c.value,
        live: l.value,
      });
    }
  }

  return { drifts, hasDrift: drifts.length > 0 };
}

/** Load a committed Style Dictionary JSON tree back into a flat TokenMap. */
export function tokenMapFromStyleDictionary(tree: unknown): TokenMap {
  const out: TokenMap = {};

  const walk = (node: unknown, path: string[]): void => {
    if (node && typeof node === "object" && "value" in (node as object)) {
      const leaf = node as { value: string | number | boolean; type?: string };
      const name = path.join(".");
      out[name] = {
        name,
        value: leaf.value,
        type: (leaf.type as TokenMap[string]["type"]) ?? "string",
      };
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, [...path, k]);
      }
    }
  };

  walk(tree, []);
  return out;
}
