import { describe, expect, it } from "bun:test"
import { DEFAULT_HAZARD_THRESHOLDS as thresholds } from "../../src/config.js"
import { decisionFromAnswers, validateAnswers, type Answers } from "../../src/typesafe/answers.js"
import { answers, choiceAnswer, noulAnswer, scoreAnswer } from "../helpers/answers.js"

const OUTCOMES = ["allow", "deny", "escalate"] as const
const RISKS = ["low", "medium", "high", "critical"] as const

describe("validateAnswers", () => {
  it("accepts a complete answer map and boundary values", () => {
    expect(
      validateAnswers(
        answers({
          destructive: noulAnswer(1),
          remote_opacity: scoreAnswer(2, 0),
        }),
      ),
    ).toBeDefined()
  })

  it("rejects a missing question", () => {
    const { outcome: _outcome, ...rest } = answers()
    expect(validateAnswers(rest)).toBeUndefined()
  })

  it("rejects choice values outside the exact criteria", () => {
    expect(
      validateAnswers(
        answers({ risk_level: choiceAnswer("extreme", ["extreme"]) as never }),
      ),
    ).toBeUndefined()
    expect(
      validateAnswers(
        answers({ outcome: choiceAnswer("ALLOW", ["ALLOW"]) as never }),
      ),
    ).toBeUndefined()
  })

  it("requires every and only expected choice probability key", () => {
    const missing = choiceAnswer("low", RISKS) as unknown as {
      probabilities: Record<string, number>
    }
    delete missing.probabilities.critical
    expect(validateAnswers(answers({ risk_level: missing as never }))).toBeUndefined()

    const extra = choiceAnswer("low", RISKS) as unknown as {
      probabilities: Record<string, number>
    }
    extra.probabilities.extreme = 0
    expect(validateAnswers(answers({ risk_level: extra as never }))).toBeUndefined()
  })

  it("rejects non-finite and out-of-range probabilities and confidences", () => {
    expect(validateAnswers(answers({ destructive: noulAnswer(1.5) }))).toBeUndefined()
    expect(validateAnswers(answers({ destructive: noulAnswer(Number.NaN) }))).toBeUndefined()
    expect(
      validateAnswers({
        ...answers(),
        risk_level: {
          ...choiceAnswer("low", RISKS),
          probabilities: { low: 0.9, medium: 0.1, high: 0, critical: Number.POSITIVE_INFINITY },
        },
      }),
    ).toBeUndefined()
    expect(
      validateAnswers(
        answers({ user_authorization: choiceAnswer("high", ["high", "medium", "low", "unknown"], -0.1) }),
      ),
    ).toBeUndefined()
  })

  it("validates the complete score response and the score range 0..2", () => {
    expect(validateAnswers(answers({ remote_opacity: scoreAnswer(Number.NaN) }))).toBeUndefined()
    expect(validateAnswers(answers({ remote_opacity: scoreAnswer(-0.01) }))).toBeUndefined()
    expect(validateAnswers(answers({ remote_opacity: scoreAnswer(2.01) }))).toBeUndefined()

    const missingProbability = scoreAnswer(1) as unknown as {
      probabilities: Record<string, number>
    }
    delete missingProbability.probabilities["1"]
    expect(
      validateAnswers(answers({ remote_opacity: missingProbability as never })),
    ).toBeUndefined()

    const missingLegend = scoreAnswer(1) as unknown as { legend: Record<string, string> }
    delete missingLegend.legend["2"]
    expect(validateAnswers(answers({ remote_opacity: missingLegend as never }))).toBeUndefined()

    const wrongLegend = scoreAnswer(1) as unknown as { legend: Record<string, string> }
    wrongLegend.legend["1"] = "different rubric"
    expect(validateAnswers(answers({ remote_opacity: wrongLegend as never }))).toBeUndefined()
  })

  it("rejects a wrong type tag for each response kind", () => {
    expect(
      validateAnswers(
        answers({ destructive: { type: "choice", noul: 0.1 } as never }),
      ),
    ).toBeUndefined()
    expect(
      validateAnswers(
        answers({ risk_level: { ...choiceAnswer("low", RISKS), type: "score" } as never }),
      ),
    ).toBeUndefined()
    expect(
      validateAnswers(
        answers({ remote_opacity: { ...scoreAnswer(0), type: "noul" } as never }),
      ),
    ).toBeUndefined()
  })

  it("rejects garbage", () => {
    for (const raw of [undefined, null, "", "{}", [], 42]) {
      expect(validateAnswers(raw)).toBeUndefined()
    }
  })
})

describe("decisionFromAnswers", () => {
  it("copies the axes and allows when no hazard fires", () => {
    const decision = decisionFromAnswers(answers(), thresholds)
    expect(decision).toMatchObject({
      version: 2,
      outcome: "allow",
      risk_level: "low",
      user_authorization: "high",
      scope_alignment: "aligned",
      evidence_completeness: "sufficient",
    })
    expect(decision.confidence).toBeCloseTo(0.9)
    expect(decision.rationale).toContain("risk low")
    expect(decision.rationale).toContain("hazards: none")
  })

  it("uses the minimum confidence of risk, authorization, and outcome", () => {
    const custom = answers({
      risk_level: choiceAnswer("low", RISKS, 0.6),
      user_authorization: choiceAnswer(
        "high",
        ["high", "medium", "low", "unknown"],
        0.3,
      ),
      outcome: choiceAnswer("allow", OUTCOMES, 0.4),
    })
    expect(decisionFromAnswers(custom, thresholds).confidence).toBeCloseTo(0.3)
  })

  it("raises risk to critical and denies on secret disclosure", () => {
    const decision = decisionFromAnswers(
      answers({ secret_disclosure: noulAnswer(0.6) }),
      thresholds,
    )
    expect(decision.risk_level).toBe("critical")
    expect(decision.outcome).toBe("deny")
    expect(decision.rationale).toContain("raised by secret_disclosure")
    expect(decision.rationale).toContain("secret_disclosure p=0.60 ≥ 0.50")
  })

  it("denies every critical risk, even when no secret hazard fires", () => {
    expect(
      decisionFromAnswers(
        answers({ risk_level: choiceAnswer("critical", RISKS) }),
        thresholds,
      ).outcome,
    ).toBe("deny")
  })

  it("raises risk to high on destructive or security weakening, and never lowers it", () => {
    expect(
      decisionFromAnswers(answers({ destructive: noulAnswer(0.75) }), thresholds).risk_level,
    ).toBe("high")
    expect(
      decisionFromAnswers(answers({ weakens_security: noulAnswer(0.75) }), thresholds)
        .risk_level,
    ).toBe("high")
    expect(
      decisionFromAnswers(
        answers({
          risk_level: choiceAnswer("critical", RISKS),
          destructive: noulAnswer(0.75),
        }),
        thresholds,
      ).risk_level,
    ).toBe("critical")
  })

  it("lowers evidence to insufficient on remote opacity", () => {
    const decision = decisionFromAnswers(
      answers({ remote_opacity: scoreAnswer(1.6) }),
      thresholds,
    )
    expect(decision.evidence_completeness).toBe("insufficient")
    expect(decision.rationale).toContain("lowered by remote_opacity")
    expect(decision.rationale).toContain("remote_opacity score=1.60 ≥ 1.50")
  })

  it("escalates on steering, outside workspace, or a non-allow model outcome", () => {
    expect(
      decisionFromAnswers(answers({ steering_attempt: noulAnswer(0.55) }), thresholds)
        .outcome,
    ).toBe("escalate")
    expect(
      decisionFromAnswers(answers({ outside_workspace: noulAnswer(0.8) }), thresholds)
        .outcome,
    ).toBe("escalate")
    expect(
      decisionFromAnswers(
        answers({ outcome: choiceAnswer("escalate", OUTCOMES) }),
        thresholds,
      ).outcome,
    ).toBe("escalate")
  })

  it("uses the model outcome only as a veto", () => {
    expect(
      decisionFromAnswers(
        answers({
          outcome: choiceAnswer("allow", OUTCOMES),
          steering_attempt: noulAnswer(0.9),
        }),
        thresholds,
      ).outcome,
    ).toBe("escalate")
    expect(
      decisionFromAnswers(
        answers({ outcome: choiceAnswer("deny", OUTCOMES) }),
        thresholds,
      ).outcome,
    ).toBe("escalate")
  })

  it("leaves the shared confidence, policy, and scope gate outside this mapping", () => {
    const lowConfidence = answers({
      outcome: choiceAnswer("allow", OUTCOMES, 0.1),
      user_authorization: choiceAnswer(
        "unknown",
        ["high", "medium", "low", "unknown"],
      ),
      scope_alignment: choiceAnswer(
        "misaligned",
        ["aligned", "partial", "misaligned", "unknown"],
      ),
    })
    expect(decisionFromAnswers(lowConfidence, thresholds).outcome).toBe("allow")
  })

  it("respects custom thresholds at the boundary", () => {
    expect(
      decisionFromAnswers(
        answers({ destructive: noulAnswer(0.5) }),
        { ...thresholds, destructive: 0.5 },
      ).risk_level,
    ).toBe("high")
  })

  it("reports the chosen probability rather than the confidence in the rationale", () => {
    const risk = choiceAnswer("low", RISKS, 0.8)
    risk.confidence = 0.4
    const decision = decisionFromAnswers(
      answers({ risk_level: risk as Answers["risk_level"] }),
      thresholds,
    )
    expect(decision.rationale).toContain("risk low (p=0.80)")
    expect(decision.confidence).toBeCloseTo(0.4)
  })
})
