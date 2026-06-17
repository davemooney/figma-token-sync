/**
 * Emitters: turn a TokenMap into a Style Dictionary JSON tree and a
 * CSS custom-properties file.
 */

import type { Token, TokenMap } from "./parser.js";

/** Style Dictionary nested-object shape: { color: { brand: { primary: { value } } } }. */
export interface StyleDictionaryLeaf {
  value: string | number | boolean;
  type: Token["type"];
}
export type StyleDictionaryTree = {
  [key: string]: StyleDictionaryTree | StyleDictionaryLeaf;
};

export function toStyleDictionary(tokens: TokenMap): StyleDictionaryTree {
  const tree: StyleDictionaryTree = {};

  for (const token of Object.values(tokens)) {
    const segments = token.name.split(".");
    let node = tree;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (!(seg in node) || "value" in (node[seg] as StyleDictionaryLeaf)) {
        node[seg] = {} as StyleDictionaryTree;
      }
      node = node[seg] as StyleDictionaryTree;
    }
    node[segments[segments.length - 1]] = {
      value: token.value,
      type: token.type,
    };
  }

  return tree;
}

export function toStyleDictionaryJSON(tokens: TokenMap): string {
  return JSON.stringify(toStyleDictionary(tokens), null, 2) + "\n";
}

function cssVarName(name: string): string {
  return `--${name.replace(/\./g, "-")}`;
}

function cssValue(token: Token): string {
  if (token.type === "dimension" && typeof token.value === "number") {
    return `${token.value}px`;
  }
  return String(token.value);
}

export function toCSS(tokens: TokenMap): string {
  const lines = Object.values(tokens).map(
    (t) => `  ${cssVarName(t.name)}: ${cssValue(t)};`,
  );
  return `:root {\n${lines.join("\n")}\n}\n`;
}
