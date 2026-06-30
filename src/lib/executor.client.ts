// Thin HTTP client for the code-execution executor (/execute shim).
//
// Compute only: the executor holds no DB and no secrets beyond the shared token.
// Auth is the shared secret in the X-Executor-Token header (see prof-executor).
// Config comes from env (matches the repo's direct-process.env convention).

import type { ExecuteRequest, ExecuteResponse } from "./executor.types.js";

const DEFAULT_TIMEOUT_MS = 20_000;

function getConfig() {
  const baseUrl = process.env.EXECUTOR_URL;
  const token = process.env.EXECUTOR_TOKEN;
  if (!baseUrl || !token) {
    throw new Error(
      "EXECUTOR_URL and EXECUTOR_TOKEN must be set to run/submit code"
    );
  }
  const timeoutMs =
    Number(process.env.EXECUTOR_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token, timeoutMs };
}

/**
 * Call the executor /execute endpoint. Throws on transport error, timeout, or a
 * non-2xx response (callers translate that into a judge ERROR verdict). A
 * SUCCESSFUL call may still carry a non-ACCEPTED executor verdict in the body.
 */
export async function execute(req: ExecuteRequest): Promise<ExecuteResponse> {
  const { baseUrl, token, timeoutMs } = getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Executor-Token": token,
      },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`executor responded ${res.status}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as ExecuteResponse;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`executor timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Liveness check against the executor's unauthenticated /health endpoint. */
export async function executorHealthy(): Promise<boolean> {
  try {
    const { baseUrl } = getConfig();
    const res = await fetch(`${baseUrl}/health`, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}
