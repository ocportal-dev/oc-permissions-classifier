import type { ChoiceResponse, NoulResponse, ScoreResponse } from "@typesafe-ai/sdk"
import type { HazardThresholds } from "../config.js"
import {
  AUTHORIZATIONS,
  EVIDENCE_COMPLETENESS,
  OUTCOMES,
  RISK_LEVELS,
  SCOPE_ALIGNMENTS,
  type Decision,
  type EvidenceCompleteness,
  type Outcome,
  type RiskLevel,
} from "../types.js"
import { QUESTION_IDS, QUESTIONS } from "./questions.js"

export interface Answers {
  risk_level: ChoiceResponse<typeof QUESTIONS.risk_level.criteria>
  user_authorization: ChoiceResponse<typeof QUESTIONS.user_authorization.criteria>
  scope_alignment: ChoiceResponse<typeof QUESTIONS.scope_alignment.criteria>
  evidence_completeness: ChoiceResponse<typeof QUESTIONS.evidence_completeness.criteria>
  outcome: ChoiceResponse<typeof QUESTIONS.outcome.criteria>
  steering_attempt: NoulResponse
  secret_disclosure: NoulResponse
  destructive: NoulResponse
  weakens_security: NoulResponse
  outside_workspace: NoulResponse
  remote_opacity: ScoreResponse<typeof QUESTIONS.remote_opacity.criteria>
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function finiteRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
}

function exactKeys(value: unknown, expected: readonly string[]): Record<string, unknown> | undefined {
  const fields = record(value)
  if (!fields) return undefined
  const actual = Object.keys(fields)
  if (actual.length !== expected.length || expected.some((key) => !Object.hasOwn(fields, key))) {
    return undefined
  }
  return fields
}

function probabilityMap(value: unknown, keys: readonly string[]): boolean {
  const probabilities = exactKeys(value, keys)
  return !!probabilities && keys.every((key) => finiteRange(probabilities[key], 0, 1))
}

function choiceAnswer(value: unknown, keys: readonly string[]): boolean {
  const fields = record(value)
  return (
    fields?.type === "choice" &&
    typeof fields.choice === "string" &&
    keys.includes(fields.choice) &&
    finiteRange(fields.confidence, 0, 1) &&
    probabilityMap(fields.probabilities, keys)
  )
}

function noulAnswer(value: unknown): boolean {
  const fields = record(value)
  return fields?.type === "noul" && finiteRange(fields.noul, 0, 1)
}

function scoreAnswer(value: unknown, criteria: readonly string[]): boolean {
  const fields = record(value)
  const keys = criteria.map((_, index) => String(index))
  const legend = exactKeys(fields?.legend, keys)
  return (
    fields?.type === "score" &&
    finiteRange(fields.score, 0, keys.length - 1) &&
    finiteRange(fields.confidence, 0, 1) &&
    !!legend &&
    keys.every((key, index) => legend[key] === criteria[index]) &&
    probabilityMap(fields.probabilities, keys)
  )
}

/** Validate the untrusted API response before its answers affect a permission decision. */
export function validateAnswers(raw: unknown): Answers | undefined {
  const fields = record(raw)
  if (!fields || QUESTION_IDS.some((id) => !Object.hasOwn(fields, id))) return undefined

  if (!choiceAnswer(fields.risk_level, RISK_LEVELS)) return undefined
  if (!choiceAnswer(fields.user_authorization, AUTHORIZATIONS)) return undefined
  if (!choiceAnswer(fields.scope_alignment, SCOPE_ALIGNMENTS)) return undefined
  if (!choiceAnswer(fields.evidence_completeness, EVIDENCE_COMPLETENESS)) return undefined
  if (!choiceAnswer(fields.outcome, OUTCOMES)) return undefined
  if (!noulAnswer(fields.steering_attempt)) return undefined
  if (!noulAnswer(fields.secret_disclosure)) return undefined
  if (!noulAnswer(fields.destructive)) return undefined
  if (!noulAnswer(fields.weakens_security)) return undefined
  if (!noulAnswer(fields.outside_workspace)) return undefined

  if (!scoreAnswer(fields.remote_opacity, QUESTIONS.remote_opacity.criteria)) return undefined

  return fields as unknown as Answers
}

function probability(value: number): string {
  return value.toFixed(2)
}

function raiseRisk(current: RiskLevel, target: RiskLevel): RiskLevel {
  return RISK_LEVELS.indexOf(current) >= RISK_LEVELS.indexOf(target) ? current : target
}

/**
 * Convert validated System One answers into the backend decision.
 *
 * This mapping applies only the TypeSafe hazard rules. The shared deterministic gate runs later.
 */
export function decisionFromAnswers(answers: Answers, thresholds: HazardThresholds): Decision {
  const initialRisk = answers.risk_level.choice
  let riskLevel: RiskLevel = initialRisk
  const riskCauses: string[] = []

  if (answers.secret_disclosure.noul >= thresholds.secret) {
    const raised = raiseRisk(riskLevel, "critical")
    if (raised !== riskLevel) riskCauses.push("secret_disclosure")
    riskLevel = raised
  }
  if (answers.destructive.noul >= thresholds.destructive) {
    const raised = raiseRisk(riskLevel, "high")
    if (raised !== riskLevel) riskCauses.push("destructive")
    riskLevel = raised
  }
  if (answers.weakens_security.noul >= thresholds.weakensSecurity) {
    const raised = raiseRisk(riskLevel, "high")
    if (raised !== riskLevel) riskCauses.push("weakens_security")
    riskLevel = raised
  }

  let evidenceCompleteness: EvidenceCompleteness = answers.evidence_completeness.choice
  const opacityFired = answers.remote_opacity.score >= thresholds.remoteOpacity
  const evidenceLowered = opacityFired && evidenceCompleteness !== "insufficient"
  if (opacityFired) evidenceCompleteness = "insufficient"

  const steeringFired = answers.steering_attempt.noul >= thresholds.steering
  const outsideWorkspaceFired =
    answers.outside_workspace.noul >= thresholds.outsideWorkspace

  let outcome: Outcome
  if (riskLevel === "critical") outcome = "deny"
  else if (steeringFired || outsideWorkspaceFired || answers.outcome.choice !== "allow") {
    outcome = "escalate"
  } else outcome = "allow"

  const hazards: string[] = []
  if (steeringFired) {
    hazards.push(
      `steering_attempt p=${probability(answers.steering_attempt.noul)} ≥ ${probability(thresholds.steering)}`,
    )
  }
  if (answers.secret_disclosure.noul >= thresholds.secret) {
    hazards.push(
      `secret_disclosure p=${probability(answers.secret_disclosure.noul)} ≥ ${probability(thresholds.secret)}`,
    )
  }
  if (answers.destructive.noul >= thresholds.destructive) {
    hazards.push(
      `destructive p=${probability(answers.destructive.noul)} ≥ ${probability(thresholds.destructive)}`,
    )
  }
  if (answers.weakens_security.noul >= thresholds.weakensSecurity) {
    hazards.push(
      `weakens_security p=${probability(answers.weakens_security.noul)} ≥ ${probability(thresholds.weakensSecurity)}`,
    )
  }
  if (outsideWorkspaceFired) {
    hazards.push(
      `outside_workspace p=${probability(answers.outside_workspace.noul)} ≥ ${probability(thresholds.outsideWorkspace)}`,
    )
  }
  if (opacityFired) {
    hazards.push(
      `remote_opacity score=${probability(answers.remote_opacity.score)} ≥ ${probability(thresholds.remoteOpacity)}`,
    )
  }

  const riskNote = riskCauses.length > 0 ? ` (raised by ${riskCauses.join(", ")})` : ""
  const evidenceNote = evidenceLowered ? " (lowered by remote_opacity)" : ""
  const rationale =
    `risk ${riskLevel}${riskNote} (p=${probability(answers.risk_level.probabilities[initialRisk])}), ` +
    `authorization ${answers.user_authorization.choice} (p=${probability(answers.user_authorization.probabilities[answers.user_authorization.choice])}), ` +
    `scope ${answers.scope_alignment.choice}, evidence ${evidenceCompleteness}${evidenceNote}; ` +
    `model outcome ${answers.outcome.choice} (p=${probability(answers.outcome.probabilities[answers.outcome.choice])}); ` +
    `hazards: ${hazards.length > 0 ? hazards.join(", ") : "none"}`

  return {
    version: 2,
    outcome,
    risk_level: riskLevel,
    user_authorization: answers.user_authorization.choice,
    scope_alignment: answers.scope_alignment.choice,
    evidence_completeness: evidenceCompleteness,
    rationale,
    confidence: Math.min(
      answers.risk_level.confidence,
      answers.user_authorization.confidence,
      answers.outcome.confidence,
    ),
  }
}
