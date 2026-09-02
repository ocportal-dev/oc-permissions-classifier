import { expect, it } from "bun:test"
import {
  AUTHORIZATIONS,
  EVIDENCE_COMPLETENESS,
  OUTCOMES,
  RISK_LEVELS,
  SCOPE_ALIGNMENTS,
  type Decision,
} from "../src/types.js"

it("lists every risk level", () => {
  expect(RISK_LEVELS).toEqual(["low", "medium", "high", "critical"])
})

it("lists every authorization level", () => {
  expect(AUTHORIZATIONS).toEqual(["high", "medium", "low", "unknown"])
})

it("lists every scope alignment", () => {
  expect(SCOPE_ALIGNMENTS).toEqual(["aligned", "partial", "misaligned", "unknown"])
})

it("lists every evidence completeness level", () => {
  expect(EVIDENCE_COMPLETENESS).toEqual(["sufficient", "partial", "insufficient", "unknown"])
})

it("lists every outcome", () => {
  expect(OUTCOMES).toEqual(["allow", "deny", "escalate"])
})

it("accepts a decision built from the listed values", () => {
  const decision: Decision = {
    version: 1,
    outcome: OUTCOMES[0],
    risk_level: RISK_LEVELS[0],
    user_authorization: AUTHORIZATIONS[0],
    scope_alignment: SCOPE_ALIGNMENTS[0],
    evidence_completeness: EVIDENCE_COMPLETENESS[0],
    rationale: "the request matches the stated intent",
    confidence: 0.9,
  }
  expect(decision.outcome).toBe("allow")
})
