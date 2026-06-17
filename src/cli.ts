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

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
