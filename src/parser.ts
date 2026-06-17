/**
 * Flattens a Figma Variables payload into a simple, sorted token map.
 *
 * Figma variable names are slash-delimited (e.g. "color/brand/primary").
 * We resolve each variable's value for a collection's default mode and
 * normalise it into a plain string/number suitable for emitting.
 */

import type {
  FigmaVariable,
  FigmaVariableValue,
  FigmaVariablesResponse,
} from "./figma-client.js";

export interface Token {
  /** Dot-delimited path, e.g. "color.brand.primary". */
  name: string;
  /** Resolved, emitter-ready value. */
  value: string | number | boolean;
  type: "color" | "dimension" | "string" | "boolean";
}

/** Stable map keyed by token name. */
export type TokenMap = Record<string, Token>;

function rgbaToHex(c: {
  r: number;
  g: number;
  b: number;
  a: number;
}): string {
  const to = (n: number) =>
    Math.round(Math.max(0, Math.min(1, n)) * 255)
      .toString(16)
      .padStart(2, "0");
  const hex = `#${to(c.r)}${to(c.g)}${to(c.b)}`;
  return c.a < 1 ? `${hex}${to(c.a)}` : hex;
}

function resolveValue(
  variable: FigmaVariable,
  modeId: string,
): { value: string | number | boolean; type: Token["type"] } | null {
  const raw: FigmaVariableValue | undefined = variable.valuesByMode[modeId];
  if (raw === undefined) return null;

  // Aliases (references to other variables) are skipped — emit primitives only.
  if (typeof raw === "object" && "type" in raw && raw.type === "VARIABLE_ALIAS") {
    return null;
  }

  switch (variable.resolvedType) {
    case "COLOR":
      if (typeof raw === "object" && "r" in raw) {
        return { value: rgbaToHex(raw), type: "color" };
      }
      return null;
    case "FLOAT":
      return { value: raw as number, type: "dimension" };
    case "BOOLEAN":
      return { value: raw as boolean, type: "boolean" };
    case "STRING":
    default:
      return { value: String(raw), type: "string" };
  }
}

/** Convert a Figma slash path into a dot path of slugified segments. */
function toTokenName(figmaName: string): string {
  return figmaName
    .split("/")
    .map((s) =>
      s
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter(Boolean)
    .join(".");
}

export function parseVariables(payload: FigmaVariablesResponse): TokenMap {
  const { variables, variableCollections } = payload.meta;
  const out: TokenMap = {};

  for (const variable of Object.values(variables)) {
    const collection = variableCollections[variable.variableCollectionId];
    if (!collection) continue;

    const modeId = collection.defaultModeId;
    const resolved = resolveValue(variable, modeId);
    if (!resolved) continue;

    const name = toTokenName(variable.name);
    if (!name) continue;

    out[name] = { name, value: resolved.value, type: resolved.type };
  }

  // Return a key-sorted object for deterministic output / clean diffs.
  return Object.fromEntries(
    Object.keys(out)
      .sort()
      .map((k) => [k, out[k]]),
  );
}
