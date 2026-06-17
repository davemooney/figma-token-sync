/**
 * Reporter: render a drift report to the console and (optionally) POST a
 * summary to a Slack incoming webhook.
 */

import type { Drift, DriftReport } from "./validator.js";

function fmt(v: string | number | boolean | undefined): string {
  return v === undefined ? "∅" : String(v);
}

const KIND_LABEL: Record<Drift["kind"], string> = {
  added: "＋ added",
  removed: "－ removed",
  changed: "~ changed",
};

export function renderConsole(report: DriftReport): string {
  if (!report.hasDrift) {
    return "✓ No drift — committed tokens match Figma.";
  }

  const rows = report.drifts.map((d) => {
    const detail =
      d.kind === "changed"
        ? `${fmt(d.committed)} → ${fmt(d.live)}`
        : d.kind === "added"
          ? fmt(d.live)
          : fmt(d.committed);
    return { kind: KIND_LABEL[d.kind], name: d.name, detail };
  });

  const wKind = Math.max(4, ...rows.map((r) => r.kind.length));
  const wName = Math.max(5, ...rows.map((r) => r.name.length));

  const header =
    `  ${"KIND".padEnd(wKind)}  ${"TOKEN".padEnd(wName)}  VALUE`;
  const body = rows
    .map((r) => `  ${r.kind.padEnd(wKind)}  ${r.name.padEnd(wName)}  ${r.detail}`)
    .join("\n");

  return [
    `✗ Drift detected — ${report.drifts.length} token(s) out of sync:`,
    "",
    header,
    body,
  ].join("\n");
}

export interface SlackOptions {
  webhookUrl: string;
  fetchImpl?: typeof fetch;
}

export async function postToSlack(
  report: DriftReport,
  opts: SlackOptions,
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;

  const summary = report.hasDrift
    ? `:rotating_light: *figma-token-sync* found ${report.drifts.length} drifted token(s).`
    : ":white_check_mark: *figma-token-sync* — tokens match Figma.";

  const lines = report.drifts.slice(0, 25).map((d) => {
    if (d.kind === "changed") return `• \`${d.name}\`: ${fmt(d.committed)} → ${fmt(d.live)}`;
    if (d.kind === "added") return `• \`${d.name}\` added in Figma (${fmt(d.live)})`;
    return `• \`${d.name}\` removed from Figma`;
  });

  const text = [summary, ...lines].join("\n");

  const res = await fetchImpl(opts.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    throw new Error(`Slack webhook returned ${res.status}.`);
  }
}
