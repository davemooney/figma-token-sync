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
import { normalizeRect, buildFrameThumbnails } from "./thumbnails.js";
import { FigmaClient } from "../figma-client.js";
import type {
  FigmaFileResponse,
  PublishedComponent,
  FigmaNode,
} from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) =>
  JSON.parse(readFileSync(join(here, "__fixtures__", name), "utf8"));

const sampleFile = fx("sample-file.json") as FigmaFileResponse;
const boxesFile = fx("frame-with-boxes.json") as FigmaFileResponse;
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

// --- thumbnails (#3) ---------------------------------------------------------

test("normalizeRect: child rect is frame-relative, scaled", () => {
  const frame = { x: 100, y: 200, width: 400, height: 300 };
  const node = { x: 120, y: 220, width: 200, height: 100 };
  // scale 1: (120-100, 220-200) = (20,20), size unchanged.
  assert.deepEqual(normalizeRect(node, frame, 1), {
    x: 20,
    y: 20,
    width: 200,
    height: 100,
  });
  // scale 2 doubles origin + size.
  assert.deepEqual(normalizeRect(node, frame, 2), {
    x: 40,
    y: 40,
    width: 400,
    height: 200,
  });
});

test("normalizeRect: clamps an overflowing child into the frame", () => {
  const frame = { x: 0, y: 0, width: 100, height: 100 };
  const node = { x: 80, y: 80, width: 200, height: 200 };
  const r = normalizeRect(node, frame, 1);
  assert.equal(r.x, 80);
  assert.equal(r.y, 80);
  assert.equal(r.width, 20); // clamped to remaining room (100-80)
  assert.equal(r.height, 20);
});

test("normalizeRect: scale<=0 falls back to 1", () => {
  const frame = { x: 0, y: 0, width: 100, height: 100 };
  const node = { x: 10, y: 10, width: 20, height: 20 };
  assert.deepEqual(normalizeRect(node, frame, 0), {
    x: 10,
    y: 10,
    width: 20,
    height: 20,
  });
});

/** A FigmaClient whose getJSON is stubbed to return an /v1/images response. */
function mockImagesClient(urlByFrame: Record<string, string>): FigmaClient {
  const client = new FigmaClient({ token: "fake", fetchImpl: (async () =>
    new Response("{}")) as unknown as typeof fetch });
  // Override the rate-limited getJSON to answer /images/:key?ids=:frameId.
  (client as unknown as { getJSON: (p: string) => Promise<unknown> }).getJSON =
    async (path: string) => {
      const m = path.match(/ids=([^&]+)/);
      const id = m ? decodeURIComponent(m[1]) : "";
      return { images: { [id]: urlByFrame[id] ?? null } };
    };
  return client;
}

const SVG_BYTES = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
function svgFetch(): typeof fetch {
  return (async () =>
    new Response(SVG_BYTES, {
      status: 200,
      headers: { "content-type": "image/svg+xml" },
    })) as unknown as typeof fetch;
}

test("buildFrameThumbnails groups findings by frame and inlines bytes", async () => {
  const result = analyzeFiles([{ fileKey: "k1", file: boxesFile }], library);
  // Findings should carry frameId/frameBox/nodeBox from the box fixture.
  const withFrame = result.findings.filter((f) => f.frameId && f.nodeBox);
  assert.ok(withFrame.length >= 2, "fixture yields multiple boxed findings");

  const client = mockImagesClient({ "1:1": "https://s3.example/hero.svg" });
  const thumbs = await buildFrameThumbnails(client, result.findings, {
    format: "svg",
    scale: 1,
    noCache: true,
    fetchImpl: svgFetch(),
  });
  assert.equal(thumbs.length, 1, "one unique frame imaged");
  const t = thumbs[0];
  assert.equal(t.frameId, "1:1");
  assert.equal(t.image.kind, "svg");
  assert.ok(t.overlays.length >= 2, "all frame findings overlaid");
  // overlay rect is frame-relative: Hardcoded BG at (120,220) in frame (100,200)
  const bg = t.overlays.find((o) => o.nodeId === "1:2");
  assert.ok(bg);
  assert.deepEqual(bg!.rect, { x: 20, y: 20, width: 200, height: 100 });
});

test("--thumb-max truncates the imaged frame set (logged)", async () => {
  // Two distinct frames across two files.
  const f2: FigmaFileResponse = JSON.parse(JSON.stringify(boxesFile));
  const result = analyzeFiles(
    [
      { fileKey: "k1", file: boxesFile },
      { fileKey: "k2", file: f2 },
    ],
    library,
  );
  const logs: string[] = [];
  const client = mockImagesClient({ "1:1": "https://s3.example/hero.svg" });
  const thumbs = await buildFrameThumbnails(client, result.findings, {
    format: "svg",
    scale: 1,
    max: 1,
    noCache: true,
    fetchImpl: svgFetch(),
    log: (m) => logs.push(m),
  });
  assert.equal(thumbs.length, 1, "capped to 1 frame");
  assert.ok(
    logs.some((l) => l.includes("--thumb-max")),
    "truncation logged",
  );
});

test("thumbnails OFF → report byte-identical to default", () => {
  const result = analyzeFiles([{ fileKey: "k1", file: boxesFile }], library);
  const a = renderHtmlReport(result);
  const b = renderHtmlReport(result, { thumbnails: false });
  assert.equal(a, b, "off-flag matches no-opts");
  // Even with thumbnails embedded but the flag off, output is unchanged.
  result.frameThumbnails = [];
  const c = renderHtmlReport(result, { thumbnails: true });
  assert.equal(a, c, "empty thumbnails → unchanged");
  assert.ok(!a.includes("Flagged-frame gallery"));
  assert.ok(!a.includes("<th>Preview</th>"), "no preview column header when off");
  assert.ok(a.includes("const THUMBS_ON = false"), "client flag off");
});

test("thumbnails ON → gallery + inline previews are inlined (no external img src)", async () => {
  const result = analyzeFiles([{ fileKey: "k1", file: boxesFile }], library);
  const client = mockImagesClient({ "1:1": "https://s3.example/hero.svg" });
  result.frameThumbnails = await buildFrameThumbnails(client, result.findings, {
    format: "svg",
    scale: 1,
    noCache: true,
    fetchImpl: svgFetch(),
  });
  const html = renderHtmlReport(result, { thumbnails: true });

  assert.ok(html.includes("Flagged-frame gallery"), "gallery section present");
  assert.ok(html.includes("<th>Preview</th>"), "inline preview column present");
  assert.ok(html.includes('class="gallery"'));
  // Self-containment: no external image/script src; the only http link is the webfont <link>.
  assert.ok(!/<img\s+src=["']http/i.test(html), "no external <img src=http>");
  assert.ok(!/<image[^>]+href=["']http/i.test(html), "no external svg <image href=http>");
  assert.ok(!/<script\s+src=/i.test(html), "no external script src");
  // The S3 url must NOT appear (we inlined the bytes, not the URL).
  assert.ok(!html.includes("s3.example"), "S3 url not embedded");
  // Inlined frame SVG present as a data URI image.
  assert.ok(html.includes("data:image/svg+xml;base64,"), "frame svg inlined as data uri");
});

test("PNG thumbnails inline as a base64 data URI", async () => {
  const result = analyzeFiles([{ fileKey: "k1", file: boxesFile }], library);
  const client = mockImagesClient({ "1:1": "https://s3.example/hero.png" });
  const pngFetch = (async () =>
    new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: { "content-type": "image/png" },
    })) as unknown as typeof fetch;
  result.frameThumbnails = await buildFrameThumbnails(client, result.findings, {
    format: "png",
    scale: 2,
    noCache: true,
    fetchImpl: pngFetch,
  });
  assert.equal(result.frameThumbnails.length, 1);
  assert.equal(result.frameThumbnails[0].image.kind, "png");
  const html = renderHtmlReport(result, { thumbnails: true });
  assert.ok(html.includes("data:image/png;base64,"), "png inlined as data uri");
  assert.ok(!html.includes("s3.example"));
});
