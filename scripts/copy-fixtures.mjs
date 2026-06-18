/**
 * tsc doesn't copy non-TS assets. The audit tests read JSON fixtures relative
 * to the compiled test file, so mirror them into dist/ before `node --test`.
 */
import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "src/audit/__fixtures__");
const to = join(root, "dist/audit/__fixtures__");

await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });
console.log("✓ copied audit fixtures → dist/audit/__fixtures__");
