import { brakeReason } from "./brake.js"
import type { ClassifierConfig } from "./config.js"
import { enforceDecision } from "./decision.js"
import { extractIntent } from "./evidence.js"
import { capText, redactSecrets } from "./redact.js"
import type { Reviewer, ReviewOutcome } from "./reviewer.js"
import type { ClassifierResult, CorrelatedCall, PermissionEvent } from "./types.js"

export interface ClassifierDeps {
  reviewer: Reviewer
  transcript: (sessionID: string) => Promise<readonly unknown[]>
}

export interface ClassifyInput {
  event: PermissionEvent
  correlated?: CorrelatedCall
  config: ClassifierConfig
  projectDirectory: string
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function safeReviewerError(error: unknown, config: ClassifierConfig): string {
  const key = config.typesafe.apiKey
  const message = key ? describe(error).split(key).join("[REDACTED:api-key]") : describe(error)
  return capText(redactSecrets(message), 300)
}

/**
 * Turns one permission request into an outcome. Never throws and never allows on an error
 * path: a brake, a missing model, a timeout, a model error, and unparseable output all
 * produce a deterministic result.
 */
export async function classify(input: ClassifyInput, deps: ClassifierDeps): Promise<ClassifierResult> {
  const { config, correlated, event, projectDirectory } = input
  const { reviewer } = deps
  const base = { backend: reviewer.backend, promptVersion: reviewer.version }
  const warnings: string[] = []

  const brake = brakeReason(event.action, event.resources)
  if (brake) {
    return { ...base, outcome: "deny", reason: brake, decisionSource: "brake", attempts: 0, warnings }
  }

  let messages: readonly unknown[] = []
  try {
    messages = await deps.transcript(event.sessionID)
  } catch (error) {
    warnings.push(`transcript unavailable: ${safeReviewerError(error, config)}`)
  }

  const intent = extractIntent(messages, {
    intentMessages: config.intentMessages,
    maxIntentChars: config.maxIntentChars,
  })

  let review: ReviewOutcome
  try {
    review = await reviewer.review({ event, correlated, intent, config, projectDirectory })
  } catch (error) {
    return {
      ...base,
      outcome: "escalate",
      reason: `reviewer failed: ${safeReviewerError(error, config)}`,
      decisionSource: "model-error",
      attempts: 0,
      warnings,
    }
  }
  warnings.push(...review.warnings.map((warning) => safeReviewerError(warning, config)))

  if (review.failure || !review.decision) {
    const failure = review.failure ?? {
      reason: "the reviewer returned neither a decision nor a failure",
      decisionSource: "model-error" as const,
    }
    return {
      ...base,
      outcome: "escalate",
      reason: safeReviewerError(failure.reason, config),
      decisionSource: failure.decisionSource,
      attempts: review.attempts,
      model: review.model,
      answers: review.answers,
      warnings,
    }
  }

  const gate = enforceDecision(review.decision, {
    confidenceThreshold: config.confidenceThreshold,
    riskPolicy: config.riskPolicy,
  })
  return {
    ...base,
    outcome: gate.outcome,
    reason: gate.reason,
    decisionSource: gate.changed ? "gate" : "model",
    decision: review.decision,
    attempts: review.attempts,
    model: review.model,
    answers: review.answers,
    warnings,
  }
}
