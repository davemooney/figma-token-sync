/**
 * Minimal, rate-limited client for the Figma REST API.
 *
 * Only the `variables/local` endpoint is needed to pull design tokens.
 * The Figma REST API is generous but not unlimited; a small token-bucket
 * keeps bursty CI runs from tripping 429s.
 */

const FIGMA_API_BASE = "https://api.figma.com/v1";

export interface FigmaVariable {
  id: string;
  name: string;
  resolvedType: "BOOLEAN" | "FLOAT" | "STRING" | "COLOR";
  variableCollectionId: string;
  valuesByMode: Record<string, FigmaVariableValue>;
}

export type FigmaVariableValue =
  | boolean
  | number
  | string
  | { r: number; g: number; b: number; a: number }
  | { type: "VARIABLE_ALIAS"; id: string };

export interface FigmaVariableCollection {
  id: string;
  name: string;
  modes: { modeId: string; name: string }[];
  defaultModeId: string;
}

export interface FigmaVariablesResponse {
  meta: {
    variables: Record<string, FigmaVariable>;
    variableCollections: Record<string, FigmaVariableCollection>;
  };
}

/** Simple token-bucket rate limiter. */
class RateLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private last: number;

  constructor(requestsPerMinute = 60) {
    this.capacity = requestsPerMinute;
    this.tokens = requestsPerMinute;
    this.refillPerMs = requestsPerMinute / 60000;
    this.last = Date.now();
  }

  async take(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
    await new Promise((r) => setTimeout(r, waitMs));
    return this.take();
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (now - this.last) * this.refillPerMs,
    );
    this.last = now;
  }
}

export interface FigmaClientOptions {
  token: string;
  requestsPerMinute?: number;
  fetchImpl?: typeof fetch;
}

export class FigmaClient {
  private readonly token: string;
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FigmaClientOptions) {
    if (!opts.token) {
      throw new Error("A Figma personal access token is required.");
    }
    this.token = opts.token;
    this.limiter = new RateLimiter(opts.requestsPerMinute ?? 60);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Fetch the local Variables for a Figma file. */
  async getLocalVariables(fileKey: string): Promise<FigmaVariablesResponse> {
    if (!fileKey) throw new Error("A Figma file key is required.");
    await this.limiter.take();

    const res = await this.fetchImpl(
      `${FIGMA_API_BASE}/files/${encodeURIComponent(fileKey)}/variables/local`,
      { headers: { "X-Figma-Token": this.token } },
    );

    if (res.status === 403) {
      throw new Error(
        "Figma returned 403. Variables REST access requires an Enterprise plan token with the file_variables:read scope.",
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Figma API error ${res.status}: ${body || res.statusText}`);
    }

    return (await res.json()) as FigmaVariablesResponse;
  }
}
