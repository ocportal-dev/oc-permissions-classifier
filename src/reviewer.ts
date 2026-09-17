import type { Backend, ClassifierConfig } from "./config.js"
import type { Intent } from "./evidence.js"
import type { CorrelatedCall, Decision, DecisionSource, PermissionEvent } from "./types.js"

export interface ReviewInput {
  event: PermissionEvent
  correlated?: CorrelatedCall
  intent: Intent
  config: ClassifierConfig
  projectDirectory: string
}

export type ReviewFailureSource = Extract<
  DecisionSource,
  "config-missing" | "timeout" | "model-error" | "parse-failure"
>

/** What a backend returns before the gate runs. `decision` is absent on every failure path. */
export interface ReviewOutcome {
  decision?: Decision
  /** Set only when `decision` is absent. */
  failure?: { reason: string; decisionSource: ReviewFailureSource }
  attempts: number
  /** The model the backend actually used, for the audit log. */
  model?: string
  /** Raw backend answers, for the audit log. TypeSafe only. */
  answers?: Record<string, unknown>
  warnings: string[]
}

export interface Reviewer {
  readonly backend: Backend
  /** The version string written to `AuditRecord.promptVersion`. */
  readonly version: string
  review(input: ReviewInput): Promise<ReviewOutcome>
}
