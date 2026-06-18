/**
 * Machine-readable audit reporter (`--format json`).
 *
 * Mirrors the console/Slack reporter style in `reporter.ts`: a pure function
 * from result → string, deterministic, no I/O. Emits the full findings plus the
 * scorecard so CI / dashboards can consume the same data the HTML shows.
 */

import type { AuditResult } from "./types.js";

export function renderJsonReport(result: AuditResult): string {
  return JSON.stringify(result, null, 2) + "\n";
}

/** A compact console summary for terminal runs (HTML/JSON go to files). */
export function renderAuditConsole(result: AuditResult): string {
  const lines: string[] = [];
  lines.push(
    `Audited ${result.fileCount} file(s) — portfolio adoption ${result.adoptionPct}%`,
  );
  lines.push(
    `  instances ${result.instanceCount} · raw nodes ${result.rawCount} · library components ${result.libraryComponentCount}`,
  );
  lines.push(
    `  findings: ${result.findings.length} (` +
      `error ${result.countsBySeverity.error}, ` +
      `warning ${result.countsBySeverity.warning}, ` +
      `info ${result.countsBySeverity.info})`,
  );
  for (const [rule, count] of Object.entries(result.countsByRule)) {
    if (count > 0) lines.push(`    - ${rule}: ${count}`);
  }
  return lines.join("\n");
}
