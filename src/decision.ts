import { AUTHORIZATIONS, EVIDENCE_COMPLETENESS, OUTCOMES, RISK_LEVELS, SCOPE_ALIGNMENTS } from "./types.js"
import type { Decision, Outcome, RiskPolicy } from "./types.js"

const MAX_RATIONALE_CHARS = 2000

function stripFences(text: string): string {
  const fenced = /^```(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/i.exec(text)
  return fenced ? fenced[1].trim() : text
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.trim().toLowerCase()
  // No enum value holds whitespace, so a value that still does is not one of them.
  if (/\s/.test(normalized)) return undefined
  return allowed.find((candidate) => candidate === normalized)
}

/** A decimal between 0 and 1. The shape is checked first, so `"0x1"` is not a confidence. */
const CONFIDENCE_TEXT = /^\s*(0|1|0?\.\d+|1\.0+)\s*$/

function pickConfidence(value: unknown): number | undefined {
  let parsed: number
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined
    parsed = value
  } else if (typeof value === "string" && CONFIDENCE_TEXT.test(value)) {
    parsed = Number.parseFloat(value.trim())
  } else return undefined
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return undefined
  return parsed
}

export function parseDecision(text: string): Decision | undefined {
  const trimmed = stripFences(text.trim())
  let raw = tryParse(trimmed)
  if (raw === undefined) {
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start < 0 || end < start) return undefined
    raw = tryParse(trimmed.slice(start, end + 1))
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const fields = raw as Record<string, unknown>

  if (fields["version"] !== 1 && fields["version"] !== "1") return undefined

  const outcome = pickEnum(fields["outcome"], OUTCOMES)
  const riskLevel = pickEnum(fields["risk_level"], RISK_LEVELS)
  const authorization = pickEnum(fields["user_authorization"], AUTHORIZATIONS)
  const scope = pickEnum(fields["scope_alignment"], SCOPE_ALIGNMENTS)
  const completeness = pickEnum(fields["evidence_completeness"], EVIDENCE_COMPLETENESS)
  const confidence = pickConfidence(fields["confidence"])
  const rationale = typeof fields["rationale"] === "string" ? fields["rationale"].trim() : ""

  if (!outcome || !riskLevel || !authorization || !scope || !completeness) return undefined
  if (confidence === undefined || rationale === "") return undefined

  return {
    version: 1,
    outcome,
    risk_level: riskLevel,
    user_authorization: authorization,
    scope_alignment: scope,
    evidence_completeness: completeness,
    rationale: rationale.slice(0, MAX_RATIONALE_CHARS),
    confidence,
  }
}

export interface GateConfig {
  confidenceThreshold: number
  riskPolicy: RiskPolicy
}

export function enforceDecision(
  decision: Decision,
  gate: GateConfig,
): { outcome: Outcome; reason: string; changed: boolean } {
  const escalate = (reason: string) => ({
    outcome: "escalate" as Outcome,
    reason,
    changed: decision.outcome !== "escalate",
  })

  if (decision.risk_level === "critical" && decision.outcome !== "deny") {
    return escalate("critical risk requires a human decision")
  }

  if (decision.outcome === "allow") {
    if (decision.confidence < gate.confidenceThreshold) {
      return escalate(
        `confidence ${decision.confidence} is below the threshold ${gate.confidenceThreshold}`,
      )
    }
    if (!(gate.riskPolicy.allow[decision.risk_level] ?? []).includes(decision.user_authorization)) {
      return escalate(
        `${decision.risk_level} risk is not allowed with ${decision.user_authorization} user authorization`,
      )
    }
    if (decision.scope_alignment === "misaligned") {
      return escalate("the action is misaligned with what the user asked for")
    }
    if (decision.risk_level !== "low" && decision.evidence_completeness === "insufficient") {
      return escalate(`the evidence is insufficient for a ${decision.risk_level} risk action`)
    }
  }

  return { outcome: decision.outcome, reason: decision.rationale, changed: false }
}
