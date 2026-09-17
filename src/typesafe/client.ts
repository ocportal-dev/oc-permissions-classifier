import { TypeSafeClient, type Fetch, type SystemOneResult } from "@typesafe-ai/sdk"
import { QUESTIONS } from "./questions.js"

export type SystemOneAnswers = SystemOneResult<typeof QUESTIONS>

/** One System One call. The signal cancels the request and any pending retry. */
export type SystemOne = (state: unknown, model: string, signal: AbortSignal) => Promise<SystemOneAnswers>

export interface ClientOptions {
  apiKey: string
  baseURL: string
  timeoutMs: number
  maxRetries: number
  /** Replaces the global fetch. Used by the tests. */
  fetch?: Fetch
}

export function createSystemOne(options: ClientOptions): SystemOne {
  const client = new TypeSafeClient({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    timeout: options.timeoutMs,
    retry: { maxRetries: options.maxRetries },
    // The debug level logs request bodies, which hold user evidence.
    logLevel: "off",
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  // Awaited into a native promise: the SDK returns an APIPromise subclass, which some
  // promise consumers (including test matchers) do not treat as a promise.
  return async (state, model, signal) =>
    await client.systemOne({ state: state as never, model, questions: QUESTIONS }, { signal })
}
