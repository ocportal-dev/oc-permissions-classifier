import { parseDecision } from "../decision.js"
import { buildEvidence } from "../evidence.js"
import { formatModelRef } from "../model-ref.js"
import { buildPrompt, DEFAULT_POLICY, JSON_ONLY_RETRY_NOTE, PROMPT_VERSION } from "../policy.js"
import { capText, redactSecrets } from "../redact.js"
import type { ReviewInput, ReviewOutcome, Reviewer } from "../reviewer.js"
import type { Decision } from "../types.js"

const ERROR_LIMIT = 300

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Rejects when `ms` passes. The host call cannot be cancelled, so the losing promise keeps
 * running: its rejection is swallowed here, otherwise a late failure would be unhandled.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  promise.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms`)), ms)
  })
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer))
}

export interface LlmReviewerDeps {
  generate: (prompt: string) => Promise<string>
}

/** Reviews with a prompt to an OpenCode provider and parses the JSON answer. */
export function createLlmReviewer(deps: LlmReviewerDeps): Reviewer {
  return {
    backend: "llm",
    version: PROMPT_VERSION,
    async review(input: ReviewInput): Promise<ReviewOutcome> {
      const { config, correlated, event, intent, projectDirectory } = input
      const warnings: string[] = []

      if (!config.model) {
        return {
          failure: {
            reason: "options.model is missing or invalid; no model review was performed",
            decisionSource: "config-missing",
          },
          attempts: 0,
          warnings,
        }
      }

      const evidence = buildEvidence({
        event,
        intent,
        correlated,
        projectDirectory,
        maxEvidenceChars: config.maxEvidenceChars,
        maxIntentChars: config.maxIntentChars,
      })
      const policy = config.policy ?? DEFAULT_POLICY
      const model = formatModelRef(config.model)

      let attempts = 0
      let decision: Decision | undefined
      // The second attempt only repeats the request with a stricter output note.
      for (const retryNote of [undefined, JSON_ONLY_RETRY_NOTE]) {
        attempts += 1
        let text: string
        try {
          text = await withTimeout(deps.generate(buildPrompt(policy, evidence, retryNote)), config.timeoutMs)
        } catch (error) {
          return callFailure(error, config.timeoutMs, attempts, model, warnings)
        }
        decision = parseDecision(text)
        if (decision) break
      }

      if (!decision) {
        return {
          failure: {
            reason: `classifier returned an unparseable decision after ${attempts} attempts`,
            decisionSource: "parse-failure",
          },
          attempts,
          model,
          warnings,
        }
      }

      return { decision, attempts, model, warnings }
    },
  }
}

function callFailure(
  error: unknown,
  timeoutMs: number,
  attempts: number,
  model: string,
  warnings: string[],
): ReviewOutcome {
  const message = describe(error)
  if (message.startsWith("timeout")) {
    return {
      failure: { reason: `classifier model timed out after ${timeoutMs} ms`, decisionSource: "timeout" },
      attempts,
      model,
      warnings,
    }
  }
  return {
    failure: {
      reason: `classifier model call failed: ${capText(redactSecrets(message), ERROR_LIMIT)}`,
      decisionSource: "model-error",
    },
    attempts,
    model,
    warnings,
  }
}
