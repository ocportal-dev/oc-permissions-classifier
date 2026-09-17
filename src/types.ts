export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const
export const AUTHORIZATIONS = ["high", "medium", "low", "unknown"] as const
export const SCOPE_ALIGNMENTS = ["aligned", "partial", "misaligned", "unknown"] as const
export const EVIDENCE_COMPLETENESS = ["sufficient", "partial", "insufficient", "unknown"] as const
export const OUTCOMES = ["allow", "deny", "escalate"] as const

/** The effect the host applies to a permission request. */
export type Effect = "allow" | "deny" | "ask"
/** What the classifier concluded. `escalate` hands the request back to the user. */
export type Outcome = (typeof OUTCOMES)[number]
export type RiskLevel = (typeof RISK_LEVELS)[number]
export type Authorization = (typeof AUTHORIZATIONS)[number]
export type ScopeAlignment = (typeof SCOPE_ALIGNMENTS)[number]
export type EvidenceCompleteness = (typeof EVIDENCE_COMPLETENESS)[number]

/** An explicit model, so the host never falls back to its own default. */
export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

/** Which authorization levels may be allowed at each risk level. */
export interface RiskPolicy {
  allow: Record<RiskLevel, Authorization[]>
}

/** The structured answer the reviewer produces. `version` is 1 for the LLM backend and 2 for the TypeSafe backend. */
export interface Decision {
  version: number
  outcome: Outcome
  risk_level: RiskLevel
  user_authorization: Authorization
  scope_alignment: ScopeAlignment
  evidence_completeness: EvidenceCompleteness
  rationale: string
  confidence: number
}

/** Where the final outcome came from. Every value except `model` is deterministic. */
export type DecisionSource =
  | "brake"
  | "config-missing"
  | "timeout"
  | "model-error"
  | "parse-failure"
  | "model"
  | "gate"
  | "cache"
  | "error"

/** The permission evaluation event. `effect` and `message` are mutated in place. */
export interface PermissionEvent {
  readonly sessionID: string
  readonly agent?: string
  readonly action: string
  readonly resources: readonly string[]
  readonly metadata?: Record<string, unknown>
  readonly source?: { readonly type: "tool"; readonly messageID: string; readonly id: string }
  effect: Effect
  message?: string
}

/** The tool call that produced the permission request. */
export interface CorrelatedCall {
  tool: string
  input: unknown
  shell?: { command: string; cwd: string }
}

export interface ClassifierResult {
  outcome: Outcome
  reason: string
  decisionSource: DecisionSource
  decision?: Decision
  backend: "llm" | "typesafe"
  promptVersion: string
  model?: string
  answers?: Record<string, unknown>
  attempts: number
  warnings: string[]
}

/** One line of the audit log. */
export interface AuditRecord {
  schemaVersion: 1
  backend: "llm" | "typesafe"
  promptVersion: string
  timestamp: string
  durationMs: number
  sessionID: string
  agent?: string
  action: string
  resources: readonly string[]
  source?: PermissionEvent["source"]
  tool?: string
  inputEffect: "ask"
  outcome: Outcome
  appliedEffect: Effect
  escalation: "ask" | "deny"
  decisionSource: DecisionSource
  reason: string
  decision?: Decision
  model?: string
  /** Raw backend answers. TypeSafe only. */
  answers?: Record<string, unknown>
  attempts: number
  warnings: string[]
}
