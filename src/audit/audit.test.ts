/**
 * Audit unit tests (node:test). Run against authored fixtures — no live token.
 *
 * Build first (`tsc`), then `node --test dist/audit/*.test.js`. Covers the rule
 * predicates, adoption math, aggregation, library matching, and HTML/JSON
 * report generation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { analyzeFiles, analyzeFile } from "./analyze.js";
import { indexFromComponents, emptyIndex } from "./library-index.js";
import {
  unboundValueMessage,
  adhocTextMessage,
  localComponentMessage,
  duplicateComponentMessage,
  detachedCandidateMessage,
  resolveConfig,
  isIgnored,
} from "./rules.js";
import { renderHtmlReport } from "./report-html.js";
import { renderJsonReport } from "./report-json.js";
import type { FigmaFileResponse, PublishedComponent, FigmaNode } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) =>
  JSON.parse(readFileSync(join(here, "__fixtures__", name), "utf8"));

const sampleFile = fx("sample-file.json") as FigmaFileResponse;
const components = fx("components.json") as PublishedComponent[];
const library = indexFromComponents(components);

// --- rule predicates ---------------------------------------------------------

test("unbound-value flags literal solid fill, not bound fill", () => {
  const unbound: FigmaNode = {
    id: "a", name: "x", type: "RECTANGLE",
    fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
  };
  const bound: FigmaNode = {
    id: "b", name: "y", type: "RECTANGLE",
    fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, boundVariables: { color: { id: "V:1" } } }],
  };
  assert.ok(unboundValueMessage(unbound));
  assert.equal(unboundValueMessage(bound), null);
});

test("unbound-value ignores invisible paints", () => {
  const node: FigmaNode = {
    id: "a", name: "x", type: "RECTANGLE",
    fills: [{ type: "SOLID", visible: false, color: { r: 0, g: 0, b: 0 } }],
  };
  assert.equal(unboundValueMessage(node), null);
});

test("adhoc-text flags text without a style, passes styled text", () => {
  assert.ok(adhocTextMessage({ id: "a", name: "t", type: "TEXT" }));
  assert.equal(
    adhocTextMessage({ id: "a", name: "t", type: "TEXT", styles: { text: "200:1" } }),
    null,
  );
  assert.equal(adhocTextMessage({ id: "a", name: "r", type: "RECTANGLE" }), null);
});

test("local-component flags non-library instance, passes library instance", () => {
  assert.equal(
    localComponentMessage({ id: "a", name: "i", type: "INSTANCE", componentId: "100:1" }, library),
    null,
  );
  assert.ok(
    localComponentMessage({ id: "a", name: "i", type: "INSTANCE", componentId: "999:9" }, library),
  );
});

test("duplicate-component flags local component matching a published name", () => {
  assert.ok(
    duplicateComponentMessage({ id: "2:1", name: "Button", type: "COMPONENT" }, library),
  );
  // The published definition itself (same node_id) is not flagged.
  assert.equal(
    duplicateComponentMessage({ id: "100:1", name: "Button", type: "COMPONENT" }, library),
    null,
  );
  assert.equal(
    duplicateComponentMessage({ id: "x", name: "Totally Unique", type: "COMPONENT" }, library),
    null,
  );
});

test("detached-candidate is heuristic: matching frame w/ children only", () => {
  assert.ok(
    detachedCandidateMessage(
      { id: "a", name: "Card", type: "FRAME", children: [{ id: "c", name: "x", type: "TEXT" }] },
      library,
    ),
  );
  // empty frame → skipped
  assert.equal(
    detachedCandidateMessage({ id: "a", name: "Card", type: "FRAME", children: [] }, library),
    null,
  );
  // a real instance is not a detached candidate
  assert.equal(
    detachedCandidateMessage(
      { id: "a", name: "Card", type: "FRAME", componentId: "100:2", children: [{ id: "c", name: "x", type: "TEXT" }] },
      library,
    ),
    null,
  );
});

// --- adoption math + aggregation --------------------------------------------

test("analyzeFile computes adoption and all five signals on the fixture", () => {
  const report = analyzeFile("file-key-1", sampleFile, library, resolveConfig());

  assert.equal(report.instanceCount, 2);
  assert.equal(report.rawCount, 7);
  assert.equal(report.adoptionPct, 22.2); // 2/9

  const byRule = (rule: string) => report.findings.filter((f) => f.rule === rule).length;
  assert.equal(byRule("unbound-value"), 1, "one unbound hero fill");
  assert.equal(byRule("adhoc-text"), 1, "one un-styled text");
  assert.equal(byRule("local-component"), 1, "one non-library instance");
  assert.equal(byRule("duplicate-component"), 1, "local Button dup");
  assert.equal(byRule("detached-candidate"), 1, "Card frame candidate");

  // deep link shape
  const f = report.findings[0];
  assert.match(f.figmaDeepLink, /^https:\/\/figma\.com\/file\/file-key-1\?node-id=/);
});

test("adoption is 0% when there are no instances or nodes", () => {
  const empty: FigmaFileResponse = {
    name: "Empty", version: "v0",
    document: { id: "0:0", name: "Document", type: "DOCUMENT", children: [] },
  };
  const report = analyzeFile("k", empty, emptyIndex(), resolveConfig());
  assert.equal(report.adoptionPct, 0);
  assert.equal(report.findings.length, 0);
});

test("aggregate rolls up counts across files", () => {
  const result = analyzeFiles(
    [
      { fileKey: "k1", file: sampleFile },
      { fileKey: "k2", file: sampleFile },
    ],
    library,
  );
  assert.equal(result.fileCount, 2);
  assert.equal(result.instanceCount, 4);
  assert.equal(result.countsByRule["unbound-value"], 2);
  assert.equal(result.libraryComponentCount, 3);
  assert.equal(result.findings.length % 2, 0);
});

test("fetch errors surface as a per-file error, not a throw", () => {
  const result = analyzeFiles([{ fileKey: "bad", error: "403 forbidden" }]);
  assert.equal(result.fileCount, 1);
  assert.equal(result.files[0].error, "403 forbidden");
  assert.equal(result.findings.length, 0);
});

// --- config: toggles + ignore ------------------------------------------------

test("disabling a rule suppresses its findings", () => {
  const cfg = { rules: { "unbound-value": { enabled: false } } } as never;
  const report = analyzeFile("k", sampleFile, library, resolveConfig(cfg));
  assert.equal(report.findings.filter((f) => f.rule === "unbound-value").length, 0);
});

test("ignore list matches by id, name, and glob", () => {
  const cfg = resolveConfig();
  cfg.ignore = ["1:5", "Custom*"];
  assert.ok(isIgnored(cfg, { id: "1:5", name: "Subhead", type: "TEXT" }, "Hero / Subhead"));
  assert.ok(isIgnored(cfg, { id: "x", name: "Custom Widget", type: "INSTANCE" }, "Hero / Custom Widget"));
  assert.equal(isIgnored(cfg, { id: "z", name: "Headline", type: "TEXT" }, "Hero / Headline"), false);
});

// --- reporters ---------------------------------------------------------------

test("HTML report is self-contained and embeds findings", () => {
  const result = analyzeFiles([{ fileKey: "k1", file: sampleFile }], library);
  const html = renderHtmlReport(result);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Component-Adoption Audit/);
  assert.ok(html.includes("const FINDINGS ="), "embeds findings JSON");
  assert.ok(!/<script\s+src=/.test(html), "no external script src");
  assert.ok(html.includes("candidates flagged for human review") || html.includes("candidates for human review"));
  // adoption % rendered
  assert.ok(html.includes("22.2%"));
});

test("JSON report round-trips the result", () => {
  const result = analyzeFiles([{ fileKey: "k1", file: sampleFile }], library);
  const parsed = JSON.parse(renderJsonReport(result));
  assert.equal(parsed.fileCount, 1);
  assert.equal(parsed.adoptionPct, 22.2);
  assert.ok(Array.isArray(parsed.findings));
});
