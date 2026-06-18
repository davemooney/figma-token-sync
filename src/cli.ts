#!/usr/bin/env node
/**
 * figma-token-sync CLI
 *
 *   figma-token-sync pull    Fetch Figma Variables → tokens.json + tokens.css
 *   figma-token-sync diff    Compare committed tokens against live Figma (CI)
 *   figma-token-sync report  Print drift table + optional Slack notification
 *
 * Config via env: FIGMA_TOKEN (personal access token), FILE_KEY (Figma file).
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";

import { FigmaClient } from "./figma-client.js";
import { parseVariables, type TokenMap } from "./parser.js";
import { toCSS, toStyleDictionaryJSON } from "./emit.js";
import {
  detectDrift,
  tokenMapFromStyleDictionary,
} from "./validator.js";
import { postToSlack, renderConsole } from "./reporter.js";
import { bulkFetchFiles, listTeamFileKeys } from "./audit/figma-bulk.js";
import { buildLibraryIndex, emptyIndex } from "./audit/library-index.js";
import { analyzeFiles } from "./audit/analyze.js";
import { renderHtmlReport } from "./audit/report-html.js";
import { renderJsonReport, renderAuditConsole } from "./audit/report-json.js";
import type { AuditConfig } from "./audit/rules.js";

interface CommonOpts {
  token?: string;
  file?: string;
  json: string;
  css: string;
  rpm: string;
}

function getToken(opts: CommonOpts): string {
  const token = opts.token ?? process.env.FIGMA_TOKEN;
  if (!token) {
    throw new Error(
      "Missing Figma token. Set FIGMA_TOKEN or pass --token. " +
        "Create one at figma.com → Settings → Personal access tokens.",
    );
  }
  return token;
}

function getFileKey(opts: CommonOpts): string {
  const file = opts.file ?? process.env.FILE_KEY;
  if (!file) {
    throw new Error("Missing Figma file key. Set FILE_KEY or pass --file.");
  }
  return file;
}

async function pullLiveTokens(opts: CommonOpts): Promise<TokenMap> {
  const client = new FigmaClient({
    token: getToken(opts),
    requestsPerMinute: Number(opts.rpm) || 60,
  });
  const payload = await client.getLocalVariables(getFileKey(opts));
  return parseVariables(payload);
}

async function loadCommittedTokens(jsonPath: string): Promise<TokenMap> {
  const abs = resolve(jsonPath);
  if (!existsSync(abs)) {
    throw new Error(
      `No committed tokens at ${jsonPath}. Run "figma-token-sync pull" first.`,
    );
  }
  const tree = JSON.parse(await readFile(abs, "utf8"));
  return tokenMapFromStyleDictionary(tree);
}

const program = new Command();

program
  .name("figma-token-sync")
  .description(
    "Sync Figma Variables → design tokens (Style Dictionary / CSS) + drift detection.",
  )
  .version("0.1.0");

const withCommon = (cmd: Command): Command =>
  cmd
    .option("-t, --token <token>", "Figma personal access token (or FIGMA_TOKEN)")
    .option("-f, --file <key>", "Figma file key (or FILE_KEY)")
    .option("--json <path>", "Style Dictionary JSON output path", "tokens.json")
    .option("--css <path>", "CSS custom-properties output path", "tokens.css")
    .option("--rpm <n>", "Figma API requests per minute", "60");

withCommon(program.command("pull"))
  .description("Fetch Figma Variables and write tokens.json + tokens.css")
  .action(async (opts: CommonOpts) => {
    const tokens = await pullLiveTokens(opts);
    await writeFile(resolve(opts.json), toStyleDictionaryJSON(tokens), "utf8");
    await writeFile(resolve(opts.css), toCSS(tokens), "utf8");
    const count = Object.keys(tokens).length;
    console.log(`✓ Pulled ${count} token(s) → ${opts.json}, ${opts.css}`);
  });

withCommon(program.command("diff"))
  .description("Compare committed tokens against live Figma; non-zero exit on drift")
  .action(async (opts: CommonOpts) => {
    const [committed, live] = await Promise.all([
      loadCommittedTokens(opts.json),
      pullLiveTokens(opts),
    ]);
    const report = detectDrift(committed, live);
    console.log(renderConsole(report));
    if (report.hasDrift) process.exitCode = 1;
  });

withCommon(program.command("report"))
  .description("Print drift table and optionally POST to a Slack webhook")
  .option(
    "--slack <url>",
    "Slack incoming webhook URL (or SLACK_WEBHOOK_URL)",
  )
  .action(async (opts: CommonOpts & { slack?: string }) => {
    const [committed, live] = await Promise.all([
      loadCommittedTokens(opts.json),
      pullLiveTokens(opts),
    ]);
    const report = detectDrift(committed, live);
    console.log(renderConsole(report));

    const webhook = opts.slack ?? process.env.SLACK_WEBHOOK_URL;
    if (webhook) {
      await postToSlack(report, { webhookUrl: webhook });
      console.log("✓ Posted summary to Slack.");
    }
    if (report.hasDrift) process.exitCode = 1;
  });

interface AuditOpts {
  token?: string;
  files?: string;
  team?: string;
  library?: string;
  out: string;
  format: "html" | "json";
  config?: string;
  rpm: string;
  concurrency: string;
  cacheDir: string;
  noCache?: boolean;
  failUnder?: string;
  maxUnbound?: string;
  thumbnails?: boolean;
}

async function readFileKeys(opts: AuditOpts, client: FigmaClient): Promise<string[]> {
  const keys: string[] = [];
  if (opts.files) {
    const raw = await readFile(resolve(opts.files), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const k = line.trim();
      if (k && !k.startsWith("#")) keys.push(k);
    }
  }
  if (opts.team) {
    keys.push(...(await listTeamFileKeys(client, opts.team)));
  }
  // De-dupe, preserve order.
  return [...new Set(keys)];
}

program
  .command("audit")
  .description(
    "Scan many Figma files for component-adoption issues → self-contained HTML report",
  )
  .option("-t, --token <token>", "Figma personal access token (or FIGMA_TOKEN)")
  .option("--files <path>", "Text file of Figma file keys (one per line)")
  .option("--team <id>", "Figma team id to enumerate files from")
  .option(
    "--library <keys>",
    "Comma-separated file keys that publish the component library (for the index)",
  )
  .option("-o, --out <path>", "Report output path", "audit-report.html")
  .option("--format <fmt>", "Output format: html | json", "html")
  .option("--config <path>", "Audit config JSON (rule toggles, severities, ignore)")
  .option("--rpm <n>", "Figma API requests per minute", "60")
  .option("--concurrency <n>", "Parallel file fetches", "4")
  .option("--cache-dir <path>", "On-disk response cache dir", ".figma-audit-cache")
  .option("--no-cache", "Disable the version-keyed response cache")
  .option("--fail-under <pct>", "Exit non-zero if portfolio adoption % is below this")
  .option("--max-unbound <n>", "Exit non-zero if unbound-value findings exceed this")
  .option("--thumbnails", "(stub) embed frame thumbnails — not yet implemented")
  .action(async (opts: AuditOpts) => {
    const token = opts.token ?? process.env.FIGMA_TOKEN;
    if (!token) {
      throw new Error(
        "Missing Figma token. Set FIGMA_TOKEN or pass --token.",
      );
    }
    if (!opts.files && !opts.team) {
      throw new Error("Provide --files <file-keys.txt> and/or --team <id>.");
    }
    if (opts.format !== "html" && opts.format !== "json") {
      throw new Error(`Unknown --format "${opts.format}" (use html | json).`);
    }
    if (opts.thumbnails) {
      console.warn(
        "⚠ --thumbnails is not yet implemented (stubbed); continuing without thumbnails.",
      );
    }

    const client = new FigmaClient({
      token,
      requestsPerMinute: Number(opts.rpm) || 60,
    });

    let config: Partial<AuditConfig> | undefined;
    if (opts.config) {
      config = JSON.parse(await readFile(resolve(opts.config), "utf8"));
    }

    const fileKeys = await readFileKeys(opts, client);
    if (fileKeys.length === 0) throw new Error("No file keys to audit.");
    console.log(`Auditing ${fileKeys.length} file(s)…`);

    // Library index: explicit --library keys, else treat all audited files as
    // potential library sources (still cheap; components endpoints are small).
    const libraryKeys = opts.library
      ? opts.library.split(",").map((s) => s.trim()).filter(Boolean)
      : fileKeys;
    let library = emptyIndex();
    try {
      library = await buildLibraryIndex(client, libraryKeys, {
        cacheDir: opts.cacheDir,
        noCache: opts.noCache,
      });
    } catch (err) {
      console.warn(
        `⚠ Library index build failed (${
          err instanceof Error ? err.message : String(err)
        }); continuing with empty index.`,
      );
    }

    const fetched = await bulkFetchFiles(client, fileKeys, {
      concurrency: Number(opts.concurrency) || 4,
      cacheDir: opts.cacheDir,
      noCache: opts.noCache,
      onProgress: (done, total) => {
        if (done === total || done % 10 === 0) {
          process.stdout.write(`\r  fetched ${done}/${total}`);
        }
      },
    });
    process.stdout.write("\n");

    const result = analyzeFiles(fetched, library, config);
    console.log(renderAuditConsole(result));

    const output =
      opts.format === "json"
        ? renderJsonReport(result)
        : renderHtmlReport(result);
    await writeFile(resolve(opts.out), output, "utf8");
    console.log(`✓ Wrote ${opts.format.toUpperCase()} report → ${opts.out}`);

    // CI gates.
    let gateFailed = false;
    if (opts.failUnder !== undefined) {
      const threshold = Number(opts.failUnder);
      if (result.adoptionPct < threshold) {
        console.error(
          `✗ Adoption ${result.adoptionPct}% is below --fail-under ${threshold}%.`,
        );
        gateFailed = true;
      }
    }
    if (opts.maxUnbound !== undefined) {
      const max = Number(opts.maxUnbound);
      const unbound = result.countsByRule["unbound-value"];
      if (unbound > max) {
        console.error(
          `✗ ${unbound} unbound value(s) exceeds --max-unbound ${max}.`,
        );
        gateFailed = true;
      }
    }
    if (gateFailed) process.exitCode = 1;
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
