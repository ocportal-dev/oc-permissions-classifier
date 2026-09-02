import { brakeReason } from "./brake.js"
import type { ClassifierConfig } from "./config.js"
import { enforceDecision, parseDecision } from "./decision.js"
import { buildEvidence, extractIntent } from "./evidence.js"
import { buildPrompt, DEFAULT_POLICY, JSON_ONLY_RETRY_NOTE } from "./policy.js"
import { capText, redactSecrets } from "./redact.js"
import type { ClassifierResult, CorrelatedCall, Decision, PermissionEvent } from "./types.js"

const ERROR_LIMIT = 300

export interface ClassifierDeps {
  generate: (prompt: string) => Promise<string>
  transcript: (sessionID: string) => Promise<readonly unknown[]>
}

export interface ClassifyInput {
  event: PermissionEvent
  correlated?: CorrelatedCall
  config: ClassifierConfig
  projectDirectory: string
}

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

/**
 * Turns one permission request into an outcome. Never throws and never allows on an error
 * path: a brake, a missing model, a timeout, a model error, and unparseable output all
 * produce a deterministic result.
 */
export async function classify(input: ClassifyInput, deps: ClassifierDeps): Promise<ClassifierResult> {
  const { config, correlated, event, projectDirectory } = input
  const warnings: string[] = []

  const brake = brakeReason(event.action, event.resources)
  if (brake) {
    return { outcome: "deny", reason: brake, decisionSource: "brake", attempts: 0, warnings }
  }

  if (!config.model) {
    return {
      outcome: "escalate",
      reason: "options.model is missing or invalid; no model review was performed",
      decisionSource: "config-missing",
      attempts: 0,
      warnings,
    }
  }

  let messages: readonly unknown[] = []
  try {
    messages = await deps.transcript(event.sessionID)
  } catch (error) {
    warnings.push(`transcript unavailable: ${describe(error)}`)
  }

  const intent = extractIntent(messages, {
    intentMessages: config.intentMessages,
    maxIntentChars: config.maxIntentChars,
  })
  const evidence = buildEvidence({
    event,
    intent,
    correlated,
    projectDirectory,
    maxEvidenceChars: config.maxEvidenceChars,
    maxIntentChars: config.maxIntentChars,
  })
  const policy = config.policy ?? DEFAULT_POLICY

  let attempts = 0
  let decision: Decision | undefined
  // The second attempt only repeats the request with a stricter output note.
  for (const retryNote of [undefined, JSON_ONLY_RETRY_NOTE]) {
    attempts += 1
    let text: string
    try {
      text = await withTimeout(deps.generate(buildPrompt(policy, evidence, retryNote)), config.timeoutMs)
    } catch (error) {
      return callFailure(error, config.timeoutMs, attempts, warnings)
    }
    decision = parseDecision(text)
    if (decision) break
  }

  if (!decision) {
    return {
      outcome: "escalate",
      reason: `classifier returned an unparseable decision after ${attempts} attempts`,
      decisionSource: "parse-failure",
      attempts,
      warnings,
    }
  }

  const gate = enforceDecision(decision, {
    confidenceThreshold: config.confidenceThreshold,
    riskPolicy: config.riskPolicy,
  })
  return {
    outcome: gate.outcome,
    reason: gate.reason,
    decisionSource: gate.changed ? "gate" : "model",
    decision,
    attempts,
    warnings,
  }
}

function callFailure(
  error: unknown,
  timeoutMs: number,
  attempts: number,
  warnings: string[],
): ClassifierResult {
  const message = describe(error)
  if (message.startsWith("timeout")) {
    return {
      outcome: "escalate",
      reason: `classifier model timed out after ${timeoutMs} ms`,
      decisionSource: "timeout",
      attempts,
      warnings,
    }
  }
  return {
    outcome: "escalate",
    reason: `classifier model call failed: ${capText(redactSecrets(message), ERROR_LIMIT)}`,
    decisionSource: "model-error",
    attempts,
    warnings,
  }
}
