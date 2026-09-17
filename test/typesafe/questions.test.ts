import { describe, expect, it } from "bun:test"
import { DEFAULT_POLICY_NOTES, QUESTION_IDS, QUESTIONS, QUESTIONS_VERSION } from "../../src/typesafe/questions.js"
import { AUTHORIZATIONS, EVIDENCE_COMPLETENESS, OUTCOMES, RISK_LEVELS, SCOPE_ALIGNMENTS } from "../../src/types.js"

describe("QUESTIONS", () => {
  it("has a semver version", () => {
    expect(QUESTIONS_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
  it("uses the gate's enum keys for the axis choices", () => {
    expect(Object.keys(QUESTIONS.risk_level.criteria)).toEqual([...RISK_LEVELS])
    expect(Object.keys(QUESTIONS.user_authorization.criteria)).toEqual([...AUTHORIZATIONS])
    expect(Object.keys(QUESTIONS.scope_alignment.criteria)).toEqual([...SCOPE_ALIGNMENTS])
    expect(Object.keys(QUESTIONS.evidence_completeness.criteria)).toEqual([...EVIDENCE_COMPLETENESS])
    expect(Object.keys(QUESTIONS.outcome.criteria)).toEqual([...OUTCOMES])
  })
  it("has one noul per hazard and a three-level opacity score", () => {
    for (const id of ["steering_attempt", "secret_disclosure", "destructive", "weakens_security", "outside_workspace"] as const) {
      expect(QUESTIONS[id].type).toBe("noul")
    }
    expect(QUESTIONS.remote_opacity.type).toBe("score")
    expect(QUESTIONS.remote_opacity.criteria.length).toBe(3)
  })
  it("references state fields with backticks in every instruction", () => {
    for (const q of Object.values(QUESTIONS)) expect(String(q.instructions)).toMatch(/`[a-z_.]+`/)
  })
  it("exports ids in declaration order", () => {
    expect(QUESTION_IDS).toEqual(Object.keys(QUESTIONS) as typeof QUESTION_IDS)
  })
  it("keeps the policy notes non-empty and free of prompt delimiters", () => {
    expect(DEFAULT_POLICY_NOTES.length).toBeGreaterThan(100)
    expect(DEFAULT_POLICY_NOTES).not.toMatch(/<\/?(policy|evidence)/)
  })
})
