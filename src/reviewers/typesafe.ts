import { DEFAULT_POLICY_NOTES, QUESTIONS_VERSION } from "../typesafe/questions.js"
import { decisionFromAnswers, validateAnswers } from "../typesafe/answers.js"
import { buildState } from "../typesafe/state.js"
import type { SystemOne } from "../typesafe/client.js"
import { capText, redactSecrets } from "../redact.js"
import type { ReviewInput, ReviewOutcome, Reviewer } from "../reviewer.js"

const ERROR_LIMIT = 280

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

class DeadlineError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`timeout after ${timeoutMs} ms`)
    this.name = "DeadlineError"
  }
}

/**
 * Enforces the reviewer deadline even when an injected or broken System One client
 * ignores AbortSignal. The losing call is observed so a late rejection is handled.
 */
async function withDeadline<T>(
  call: Promise<T>,
  controller: AbortController,
  timeoutMs: number,
): Promise<T> {
  call.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new DeadlineError(timeoutMs))
    }, timeoutMs)
  })
  return await Promise.race([call, expiry]).finally(() => clearTimeout(timer))
}

function safeErrorMessage(error: unknown, apiKey: string): string {
  const withoutConfiguredKey = describe(error).split(apiKey).join("[REDACTED:api-key]")
  return capText(redactSecrets(withoutConfiguredKey), ERROR_LIMIT)
}

function replaceConfiguredKey<T>(value: T, apiKey: string): T {
  const serialized = JSON.stringify(value, (_key, item) =>
    typeof item === "string"
      ? item.split(apiKey).join("[REDACTED:api-key]")
      : item,
  )
  if (serialized === undefined) return value
  return JSON.parse(serialized) as T
}

function sanitizeState<T>(value: T, apiKey: string): T {
  const serialized = JSON.stringify(value, (_key, item) =>
    typeof item === "string"
      ? redactSecrets(item).split(apiKey).join("[REDACTED:api-key]")
      : item,
  )
  if (serialized === undefined) return value
  return JSON.parse(serialized) as T
}

function isResult(value: unknown): value is {
  model: string
  answers: unknown
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  return typeof result.model === "string" && result.model.trim() !== "" && "answers" in result
}

export interface TypeSafeReviewerDeps {
  systemOne: SystemOne
}

/** Reviews a JSON evidence state with typed System One questions. */
export function createTypeSafeReviewer(deps: TypeSafeReviewerDeps): Reviewer {
  return {
    backend: "typesafe",
    version: QUESTIONS_VERSION,
    async review(input: ReviewInput): Promise<ReviewOutcome> {
      const { config, correlated, event, intent, projectDirectory } = input
      const warnings: string[] = []
      const options = config.typesafe

      if (!options.apiKey) {
        return {
          failure: {
            reason: "options.typesafe.apiKey is missing; no TypeSafe review was performed",
            decisionSource: "config-missing",
          },
          attempts: 0,
          warnings,
        }
      }

      let state: ReturnType<typeof buildState>
      try {
        state = buildState({
          event,
          intent,
          correlated,
          projectDirectory,
          maxEvidenceChars: config.maxEvidenceChars,
          maxIntentChars: config.maxIntentChars,
          policyNotes: config.policy ?? DEFAULT_POLICY_NOTES,
        })
      } catch (error) {
        return {
          failure: {
            reason: `TypeSafe state could not be built: ${safeErrorMessage(error, options.apiKey)}`,
            decisionSource: "model-error",
          },
          attempts: 0,
          model: options.model,
          warnings,
        }
      }
      state = sanitizeState(state, options.apiKey)
      const stateLimit = config.maxEvidenceChars + config.maxIntentChars + 2000
      const stateSize = JSON.stringify(state).length
      if (stateSize > stateLimit) {
        return {
          failure: {
            reason: `TypeSafe state needs ${stateSize} characters, but its limit is ${stateLimit}`,
            decisionSource: "model-error",
          },
          attempts: 0,
          model: options.model,
          warnings,
        }
      }
      const controller = new AbortController()
      let result: unknown
      const deadlineMs = options.timeoutMs * (options.maxRetries + 1)
      try {
        result = await withDeadline(
          deps.systemOne(state, options.model, controller.signal),
          controller,
          deadlineMs,
        )
      } catch (error) {
        const name = error instanceof Error ? error.name : ""
        const timedOut =
          error instanceof DeadlineError ||
          controller.signal.aborted ||
          name === "AbortError" ||
          name === "APITimeoutError" ||
          name === "APIUserAbortError"
        if (timedOut) {
          return {
            failure: {
              reason: `TypeSafe review timed out after ${deadlineMs} ms`,
              decisionSource: "timeout",
            },
            attempts: 1,
            model: options.model,
            warnings,
          }
        }
        return {
          failure: {
            reason: `TypeSafe review failed: ${safeErrorMessage(error, options.apiKey)}`,
            decisionSource: "model-error",
          },
          attempts: 1,
          model: options.model,
          warnings,
        }
      }

      if (!isResult(result)) {
        return {
          failure: {
            reason: "TypeSafe returned a malformed result",
            decisionSource: "parse-failure",
          },
          attempts: 1,
          model: options.model,
          warnings,
        }
      }
      const answers = validateAnswers(result.answers)
      if (!answers) {
        return {
          failure: {
            reason: "TypeSafe returned a malformed answer map",
            decisionSource: "parse-failure",
          },
          attempts: 1,
          model: result.model.split(options.apiKey).join("[REDACTED:api-key]"),
          warnings,
        }
      }

      return {
        decision: decisionFromAnswers(answers, options.thresholds),
        attempts: 1,
        model: result.model.split(options.apiKey).join("[REDACTED:api-key]"),
        answers: replaceConfiguredKey(
          result.answers as Record<string, unknown>,
          options.apiKey,
        ),
        warnings,
      }
    },
  }
}
