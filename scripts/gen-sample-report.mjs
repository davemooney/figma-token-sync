/**
 * Generate examples/sample-audit-report.html from a synthetic multi-file
 * dataset (no live Figma token needed). Produces a substantial, realistic
 * report so the artifact reads like a real portfolio audit.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { analyzeFiles } from "../dist/audit/analyze.js";
import { indexFromComponents } from "../dist/audit/library-index.js";
import { renderHtmlReport } from "../dist/audit/report-html.js";
import { normalizeRect } from "../dist/audit/thumbnails.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- synthetic published library --------------------------------------------
const library = indexFromComponents([
  { key: "k-button", name: "Button", node_id: "L:1" },
  { key: "k-card", name: "Card", node_id: "L:2" },
  { key: "k-input", name: "Input", node_id: "L:3" },
  { key: "k-badge", name: "Badge", node_id: "L:4" },
  { key: "k-nav", name: "Nav Bar", node_id: "L:5" },
  { key: "k-modal", name: "Modal", node_id: "L:6" },
]);

let nid = 0;
const id = () => `n:${++nid}`;

const instance = (name, comp) => ({ id: id(), name, type: "INSTANCE", componentId: comp });
const text = (name, styled) => ({ id: id(), name, type: "TEXT", ...(styled ? { styles: { text: "S:1" } } : {}) });
const rect = (name, bound) => ({
  id: id(), name, type: "RECTANGLE",
  fills: [{ type: "SOLID", color: { r: 0.4, g: 0.4, b: 0.9 }, ...(bound ? { boundVariables: { color: { id: "V:1" } } } : {}) }],
});
const frame = (name, children, opts = {}) => ({ id: id(), name, type: "FRAME", children, ...opts });

function page(name, children) {
  return { id: id(), name, type: "CANVAS", children };
}

/**
 * Lay out a frame's children in a grid and stamp absoluteBoundingBox on the
 * frame + each child, so the analyzer captures frameBox/nodeBox and the
 * thumbnail overlays land. Pure synthetic geometry (token-free).
 */
const FRAME_W = 480, FRAME_H = 360, PAD = 24, COLS = 3, GAP = 16;
function layoutFrame(name, children, originX, originY) {
  const cellW = Math.floor((FRAME_W - PAD * 2 - GAP * (COLS - 1)) / COLS);
  const cellH = 64;
  children.forEach((c, i) => {
    const col = i % COLS, row = Math.floor(i / COLS);
    c.absoluteBoundingBox = {
      x: originX + PAD + col * (cellW + GAP),
      y: originY + PAD + 40 + row * (cellH + GAP),
      width: cellW,
      height: cellH,
    };
  });
  return {
    id: id(), name, type: "FRAME", children,
    absoluteBoundingBox: { x: originX, y: originY, width: FRAME_W, height: FRAME_H },
  };
}

const SCREEN_NAMES = ["Hero", "Pricing", "Features", "Footer", "Sign-up", "Dashboard", "Settings", "Profile"];

// Build a file with tunable mix of good/bad signals, split across several
// laid-out screen frames so the gallery has real cards to show.
function makeFile(name, version, { goodInstances, localInstances, styledText, adhocText, boundRects, unboundRects, dupComponents, detachedFrames }) {
  const libComps = ["L:1", "L:2", "L:3", "L:4", "L:5", "L:6"];
  const nodes = [];
  for (let i = 0; i < goodInstances; i++) nodes.push(instance(`Btn ${i}`, libComps[i % libComps.length]));
  for (let i = 0; i < localInstances; i++) nodes.push(instance(`Local ${i}`, `LOCAL:${i}`));
  for (let i = 0; i < styledText; i++) nodes.push(text(`Heading ${i}`, true));
  for (let i = 0; i < adhocText; i++) nodes.push(text(`Loose copy ${i}`, false));
  for (let i = 0; i < boundRects; i++) nodes.push(rect(`Token bg ${i}`, true));
  for (let i = 0; i < unboundRects; i++) nodes.push(rect(`Hardcoded bg ${i}`, false));
  for (let i = 0; i < detachedFrames; i++) nodes.push(frame(`Card`, [text(`x`, true)]));

  // Shuffle deterministically so each frame gets a mix of good/bad.
  for (let i = nodes.length - 1; i > 0; i--) {
    const j = (i * 1103515245 + 12345) % (i + 1);
    [nodes[i], nodes[j]] = [nodes[j], nodes[i]];
  }

  // Chunk into ≤9-node screen frames laid out in a row.
  const CHUNK = 9;
  const screens = [];
  for (let i = 0, s = 0; i < nodes.length; i += CHUNK, s++) {
    const chunk = nodes.slice(i, i + CHUNK);
    const fname = SCREEN_NAMES[s % SCREEN_NAMES.length] + (s >= SCREEN_NAMES.length ? ` ${Math.floor(s / SCREEN_NAMES.length) + 1}` : "");
    screens.push(layoutFrame(fname, chunk, 100 + (s % 4) * 560, 100 + Math.floor(s / 4) * 440));
  }

  const compsPage = [];
  const libNames = ["Button", "Card", "Input", "Badge"];
  for (let i = 0; i < dupComponents; i++) {
    compsPage.push({ id: id(), name: libNames[i % libNames.length], type: "COMPONENT", children: [text("label", true)] });
  }

  return {
    fileKey: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    file: {
      name,
      version,
      document: {
        id: id(), name: "Document", type: "DOCUMENT",
        children: [
          page("Screens", screens),
          ...(compsPage.length ? [page("Local Components", compsPage)] : []),
        ],
      },
    },
  };
}

const files = [
  makeFile("Design System — Core", "ds-1", { goodInstances: 64, localInstances: 2, styledText: 30, adhocText: 1, boundRects: 22, unboundRects: 1, dupComponents: 0, detachedFrames: 0 }),
  makeFile("Marketing Site", "mk-1", { goodInstances: 28, localInstances: 9, styledText: 12, adhocText: 14, boundRects: 8, unboundRects: 19, dupComponents: 3, detachedFrames: 4 }),
  makeFile("Mobile App", "mob-1", { goodInstances: 41, localInstances: 5, styledText: 22, adhocText: 6, boundRects: 18, unboundRects: 7, dupComponents: 1, detachedFrames: 2 }),
  makeFile("Checkout Flow", "co-1", { goodInstances: 33, localInstances: 3, styledText: 17, adhocText: 4, boundRects: 14, unboundRects: 5, dupComponents: 0, detachedFrames: 1 }),
  makeFile("Legacy Dashboard", "leg-1", { goodInstances: 9, localInstances: 17, styledText: 4, adhocText: 28, boundRects: 2, unboundRects: 31, dupComponents: 4, detachedFrames: 6 }),
  makeFile("Brand Microsite", "bm-1", { goodInstances: 18, localInstances: 4, styledText: 9, adhocText: 11, boundRects: 6, unboundRects: 13, dupComponents: 1, detachedFrames: 3 }),
  { fileKey: "restricted-file", error: "Figma API error 403: file not accessible to this token" },
];

const result = analyzeFiles(files, library);

// --- synthesize inlined frame thumbnails (no live /v1/images token) ---------
// Mirrors what buildFrameThumbnails produces at runtime, but the "rendered
// frame" is a generated SVG mock (token-free) so the committed sample shows the
// gallery + inline previews exactly as a real run would.
function mockScreenSvg(w, h, seed) {
  // A plausible UI screen: header bar, a few cards, a CTA. Deterministic palette.
  const tint = ["#1b2030", "#171a24", "#1a1d28"][seed % 3];
  const cards = [];
  const cols = 3, pad = 24, gap = 16;
  const cw = Math.floor((w - pad * 2 - gap * (cols - 1)) / cols);
  for (let i = 0; i < 9; i++) {
    const col = i % cols, row = Math.floor(i / cols);
    const x = pad + col * (cw + gap), y = pad + 40 + row * (64 + gap);
    const fill = i % 4 === 0 ? "#2a3350" : "#222634";
    cards.push(`<rect x="${x}" y="${y}" width="${cw}" height="56" rx="8" fill="${fill}"/>`);
    cards.push(`<rect x="${x + 12}" y="${y + 16}" width="${Math.floor(cw * 0.5)}" height="8" rx="4" fill="#3a4260"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">`
    + `<rect width="${w}" height="${h}" fill="${tint}"/>`
    + `<rect x="0" y="0" width="${w}" height="32" fill="#0f1118"/>`
    + `<circle cx="20" cy="16" r="6" fill="#6e7bff"/>`
    + `<rect x="36" y="12" width="120" height="8" rx="4" fill="#2c3142"/>`
    + cards.join("")
    + `</svg>`;
}

// Group findings by (fileKey, frameId).
const groups = new Map();
for (const f of result.findings) {
  if (!f.frameId || !f.frameBox) continue;
  const key = `${f.fileKey}::${f.frameId}`;
  let g = groups.get(key);
  if (!g) { g = { f0: f, findings: [] }; groups.set(key, g); }
  g.findings.push(f);
}

const RAWISH = new Set(["unbound-value", "adhoc-text", "local-component"]);
let seed = 0;
const frameThumbnails = [];
for (const g of groups.values()) {
  const f0 = g.f0;
  const scale = 1;
  const w = Math.round(f0.frameBox.width * scale);
  const h = Math.round(f0.frameBox.height * scale);
  const rawish = g.findings.filter((f) => RAWISH.has(f.rule)).length;
  const adoptionPct = Math.max(0, Math.min(100, Math.round((1 - rawish / g.findings.length) * 1000) / 10));
  const flagCounts = {};
  for (const f of g.findings) flagCounts[f.rule] = (flagCounts[f.rule] ?? 0) + 1;
  const overlays = g.findings
    .filter((f) => f.nodeBox)
    .map((f) => ({
      nodeId: f.nodeId, rule: f.rule, severity: f.severity, message: f.message,
      rect: normalizeRect(f.nodeBox, f0.frameBox, scale),
    }));
  frameThumbnails.push({
    fileKey: f0.fileKey, fileName: f0.fileName, page: f0.page,
    frameId: f0.frameId, frameName: f0.frameName, frameBox: f0.frameBox,
    image: { kind: "svg", markup: mockScreenSvg(w, h, seed++) },
    scale, adoptionPct, flagCounts, overlays,
  });
}
// Cap the gallery to a tasteful number for the sample.
result.frameThumbnails = frameThumbnails.slice(0, 24);

const html = renderHtmlReport(result, { thumbnails: true });

await mkdir(join(root, "examples"), { recursive: true });
const out = join(root, "examples/sample-audit-report.html");
await writeFile(out, html, "utf8");
console.log(
  `✓ Sample report → examples/sample-audit-report.html ` +
    `(${result.fileCount} files, ${result.adoptionPct}% adoption, ${result.findings.length} findings, ` +
    `${result.frameThumbnails.length} thumbnails)`,
);
