/**
 * Tree walk + rule application → portfolio audit result.
 *
 * For each file we recurse the document, tracking the current page (a top-level
 * CANVAS child) and an ancestor name path. We:
 *   - tally INSTANCE coverage vs. raw geometry for adoption %, and
 *   - run every enabled rule against each node, collecting findings with
 *     Figma deep-links.
 *
 * Adoption % = instances / (instances + raw geometry). A page/file with no
 * components at all reports 0% (correct: nothing is componentised).
 */

import {
  deepLink,
  type AuditResult,
  type FigmaFileResponse,
  type FigmaNode,
  type FileReport,
  type Finding,
  type PageReport,
  type RuleId,
  type Severity,
} from "./types.js";
import type { LibraryIndex } from "./library-index.js";
import { emptyIndex } from "./library-index.js";
import {
  adhocTextMessage,
  detachedCandidateMessage,
  duplicateComponentMessage,
  isIgnored,
  localComponentMessage,
  resolveConfig,
  unboundValueMessage,
  type AuditConfig,
} from "./rules.js";

interface Counters {
  instanceCount: number;
  rawCount: number;
}

function adoption(instanceCount: number, rawCount: number): number {
  const denom = instanceCount + rawCount;
  if (denom === 0) return 0;
  return Math.round((instanceCount / denom) * 1000) / 10; // 1 dp
}

/** Apply each enabled rule to one node; push any findings. */
function runRules(
  node: FigmaNode,
  ctx: {
    fileKey: string;
    fileName: string;
    page: string;
    nodePath: string;
    library: LibraryIndex;
    config: AuditConfig;
  },
  out: Finding[],
): void {
  const { config } = ctx;
  const emit = (rule: RuleId, message: string): void => {
    const cfg = config.rules[rule];
    if (!cfg?.enabled) return;
    out.push({
      fileKey: ctx.fileKey,
      fileName: ctx.fileName,
      page: ctx.page,
      nodePath: ctx.nodePath,
      nodeId: node.id,
      type: node.type,
      rule,
      severity: cfg.severity,
      message,
      figmaDeepLink: deepLink(ctx.fileKey, node.id),
    });
  };

  let msg: string | null;
  if (config.rules["unbound-value"].enabled) {
    msg = unboundValueMessage(node);
    if (msg) emit("unbound-value", msg);
  }
  if (config.rules["adhoc-text"].enabled) {
    msg = adhocTextMessage(node);
    if (msg) emit("adhoc-text", msg);
  }
  if (config.rules["local-component"].enabled) {
    msg = localComponentMessage(node, ctx.library);
    if (msg) emit("local-component", msg);
  }
  if (config.rules["duplicate-component"].enabled) {
    msg = duplicateComponentMessage(node, ctx.library);
    if (msg) emit("duplicate-component", msg);
  }
  if (config.rules["detached-candidate"].enabled) {
    msg = detachedCandidateMessage(node, ctx.library);
    if (msg) emit("detached-candidate", msg);
  }
}

/** Analyze a single fetched file. */
export function analyzeFile(
  fileKey: string,
  file: FigmaFileResponse,
  library: LibraryIndex,
  config: AuditConfig,
): FileReport {
  const fileName = file.name ?? fileKey;
  const findings: Finding[] = [];
  const pages: PageReport[] = [];
  const fileCounters: Counters = { instanceCount: 0, rawCount: 0 };

  const walk = (
    node: FigmaNode,
    page: string,
    ancestors: string[],
    pageCounters: Counters,
  ): void => {
    const nodePath = [...ancestors, node.name].filter(Boolean).join(" / ");

    if (!isIgnored(config, node, nodePath)) {
      // Adoption tally.
      if (node.type === "INSTANCE") {
        pageCounters.instanceCount += 1;
        fileCounters.instanceCount += 1;
      } else if (config.rawNodeTypes.includes(node.type)) {
        pageCounters.rawCount += 1;
        fileCounters.rawCount += 1;
      }
      runRules(
        node,
        { fileKey, fileName, page, nodePath, library, config },
        findings,
      );
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        walk(child, page, [...ancestors, node.name].filter(Boolean), pageCounters);
      }
    }
  };

  // Top-level children of the document are pages (CANVAS nodes).
  const topChildren = Array.isArray(file.document.children)
    ? file.document.children
    : [];
  for (const pageNode of topChildren) {
    const pageCounters: Counters = { instanceCount: 0, rawCount: 0 };
    for (const child of pageNode.children ?? []) {
      walk(child, pageNode.name, [], pageCounters);
    }
    pages.push({
      name: pageNode.name,
      nodeId: pageNode.id,
      instanceCount: pageCounters.instanceCount,
      rawCount: pageCounters.rawCount,
      adoptionPct: adoption(pageCounters.instanceCount, pageCounters.rawCount),
    });
  }

  return {
    fileKey,
    fileName,
    version: file.version ?? "",
    instanceCount: fileCounters.instanceCount,
    rawCount: fileCounters.rawCount,
    adoptionPct: adoption(fileCounters.instanceCount, fileCounters.rawCount),
    findings,
    pages,
  };
}

const ALL_RULES: RuleId[] = [
  "adoption",
  "unbound-value",
  "adhoc-text",
  "local-component",
  "duplicate-component",
  "detached-candidate",
];
const ALL_SEVERITIES: Severity[] = ["info", "warning", "error"];

/** Aggregate per-file reports into the portfolio-wide result. */
export function aggregate(
  reports: FileReport[],
  library: LibraryIndex,
): AuditResult {
  const findings = reports.flatMap((r) => r.findings);
  const instanceCount = reports.reduce((s, r) => s + r.instanceCount, 0);
  const rawCount = reports.reduce((s, r) => s + r.rawCount, 0);

  const countsByRule = Object.fromEntries(
    ALL_RULES.map((r) => [r, 0]),
  ) as Record<RuleId, number>;
  const countsBySeverity = Object.fromEntries(
    ALL_SEVERITIES.map((s) => [s, 0]),
  ) as Record<Severity, number>;
  for (const f of findings) {
    countsByRule[f.rule] += 1;
    countsBySeverity[f.severity] += 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    fileCount: reports.length,
    instanceCount,
    rawCount,
    adoptionPct: adoption(instanceCount, rawCount),
    files: reports,
    findings,
    countsByRule,
    countsBySeverity,
    libraryComponentCount: library.count,
  };
}

/**
 * Convenience: analyze a batch of already-fetched files end-to-end.
 * (CLI passes bulk-fetch results in; tests pass fixtures in.)
 */
export function analyzeFiles(
  files: { fileKey: string; file?: FigmaFileResponse; error?: string }[],
  library: LibraryIndex = emptyIndex(),
  partialConfig?: Partial<AuditConfig>,
): AuditResult {
  const config = resolveConfig(partialConfig);
  const reports: FileReport[] = files.map((entry) => {
    if (!entry.file) {
      return {
        fileKey: entry.fileKey,
        fileName: entry.fileKey,
        version: "",
        instanceCount: 0,
        rawCount: 0,
        adoptionPct: 0,
        findings: [],
        pages: [],
        error: entry.error ?? "No file payload.",
      };
    }
    return analyzeFile(entry.fileKey, entry.file, library, config);
  });
  return aggregate(reports, library);
}
