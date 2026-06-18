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

// Build a file with tunable mix of good/bad signals.
function makeFile(name, version, { goodInstances, localInstances, styledText, adhocText, boundRects, unboundRects, dupComponents, detachedFrames }) {
  const libComps = ["L:1", "L:2", "L:3", "L:4", "L:5", "L:6"];
  const screen = [];
  for (let i = 0; i < goodInstances; i++) screen.push(instance(`Btn ${i}`, libComps[i % libComps.length]));
  for (let i = 0; i < localInstances; i++) screen.push(instance(`Local ${i}`, `LOCAL:${i}`));
  for (let i = 0; i < styledText; i++) screen.push(text(`Heading ${i}`, true));
  for (let i = 0; i < adhocText; i++) screen.push(text(`Loose copy ${i}`, false));
  for (let i = 0; i < boundRects; i++) screen.push(rect(`Token bg ${i}`, true));
  for (let i = 0; i < unboundRects; i++) screen.push(rect(`Hardcoded bg ${i}`, false));
  for (let i = 0; i < detachedFrames; i++) screen.push(frame(`Card`, [text(`x`, true)]));

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
          page("Screens", [frame("Main", screen)]),
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
const html = renderHtmlReport(result);

await mkdir(join(root, "examples"), { recursive: true });
const out = join(root, "examples/sample-audit-report.html");
await writeFile(out, html, "utf8");
console.log(
  `✓ Sample report → examples/sample-audit-report.html ` +
    `(${result.fileCount} files, ${result.adoptionPct}% adoption, ${result.findings.length} findings)`,
);
