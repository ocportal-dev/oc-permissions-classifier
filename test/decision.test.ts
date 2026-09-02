import { describe, expect, it } from "bun:test"
import { enforceDecision, parseDecision, type GateConfig } from "../src/decision.js"
import {
  AUTHORIZATIONS,
  EVIDENCE_COMPLETENESS,
  RISK_LEVELS,
  SCOPE_ALIGNMENTS,
} from "../src/types.js"
import type { Decision, Outcome, RiskPolicy } from "../src/types.js"

const BODY = {
  version: 1,
  outcome: "allow",
  risk_level: "low",
  user_authorization: "high",
  scope_alignment: "aligned",
  evidence_completeness: "sufficient",
  rationale: "Reads one project file.",
  confidence: 0.9,
}

describe("parseDecision", () => {
  it("parses clean JSON", () => {
    const decision = parseDecision(JSON.stringify(BODY))
    expect(decision?.outcome).toBe("allow")
    expect(decision?.confidence).toBe(0.9)
    expect(decision?.version).toBe(1)
  })

  it("parses a fenced JSON block", () => {
    const decision = parseDecision("```json\n" + JSON.stringify(BODY) + "\n```")
    expect(decision?.outcome).toBe("allow")
  })

  it("parses a fenced block with no language tag", () => {
    const decision = parseDecision("```\n" + JSON.stringify(BODY) + "\n```")
    expect(decision?.outcome).toBe("allow")
  })

  it("parses JSON surrounded by prose", () => {
    const decision = parseDecision(
      "Here is my review.\n" + JSON.stringify(BODY) + "\nI hope that helps.",
    )
    expect(decision?.outcome).toBe("allow")
  })

  it("accepts a string version", () => {
    const decision = parseDecision(JSON.stringify({ ...BODY, version: "1" }))
    expect(decision?.version).toBe(1)
  })

  it("normalizes uppercase and padded enum values", () => {
    const decision = parseDecision(
      JSON.stringify({ ...BODY, outcome: " ESCALATE ", risk_level: "High", scope_alignment: "PARTIAL" }),
    )
    expect(decision?.outcome).toBe("escalate")
    expect(decision?.risk_level).toBe("high")
    expect(decision?.scope_alignment).toBe("partial")
  })

  it("accepts a numeric string confidence", () => {
    expect(parseDecision(JSON.stringify({ ...BODY, confidence: "0.42" }))?.confidence).toBe(0.42)
  })

  it("ignores unknown extra keys", () => {
    const decision = parseDecision(JSON.stringify({ ...BODY, notes: "extra", severity: 3 }))
    expect(decision?.outcome).toBe("allow")
    expect(Object.keys(decision ?? {}).sort()).toEqual(Object.keys(BODY).sort())
  })

  it("caps a long rationale at 2000 characters", () => {
    const decision = parseDecision(JSON.stringify({ ...BODY, rationale: "x".repeat(5000) }))
    expect(decision?.rationale.length).toBe(2000)
  })

  it("rejects a missing field", () => {
    const { risk_level: _dropped, ...rest } = BODY
    expect(parseDecision(JSON.stringify(rest))).toBeUndefined()
  })

  it("rejects an unknown enum value", () => {
    expect(parseDecision(JSON.stringify({ ...BODY, outcome: "maybe" }))).toBeUndefined()
  })

  it("rejects a confidence outside 0..1", () => {
    expect(parseDecision(JSON.stringify({ ...BODY, confidence: 1.5 }))).toBeUndefined()
    expect(parseDecision(JSON.stringify({ ...BODY, confidence: -0.1 }))).toBeUndefined()
    expect(parseDecision(JSON.stringify({ ...BODY, confidence: "high" }))).toBeUndefined()
  })

  it("rejects a wrong version", () => {
    expect(parseDecision(JSON.stringify({ ...BODY, version: 2 }))).toBeUndefined()
  })

  it("rejects an empty rationale", () => {
    expect(parseDecision(JSON.stringify({ ...BODY, rationale: "   " }))).toBeUndefined()
  })

  it("rejects garbage, empty text, and non-objects", () => {
    expect(parseDecision("I cannot answer that.")).toBeUndefined()
    expect(parseDecision("")).toBeUndefined()
    expect(parseDecision("   ")).toBeUndefined()
    expect(parseDecision("[]")).toBeUndefined()
    expect(parseDecision("null")).toBeUndefined()
    expect(parseDecision("{ broken")).toBeUndefined()
  })
})

const RISK_POLICY: RiskPolicy = {
  allow: {
    low: ["high", "medium", "low", "unknown"],
    medium: ["high", "medium", "low"],
    high: ["high", "medium"],
    critical: [],
  },
}

const GATE: GateConfig = { confidenceThreshold: 0.7, riskPolicy: RISK_POLICY }

function decision(overrides: Partial<Decision> = {}): Decision {
  return { ...(BODY as Decision), ...overrides }
}

describe("enforceDecision", () => {
  it("escalates critical risk that is not a deny", () => {
    const result = enforceDecision(decision({ risk_level: "critical" }), GATE)
    expect(result.outcome).toBe("escalate")
    expect(result.reason).toBe("critical risk requires a human decision")
    expect(result.changed).toBe(true)
  })

  it("keeps a critical deny", () => {
    const result = enforceDecision(decision({ risk_level: "critical", outcome: "deny" }), GATE)
    expect(result.outcome).toBe("deny")
    expect(result.changed).toBe(false)
  })

  it("escalates an allow below the confidence threshold", () => {
    const result = enforceDecision(decision({ confidence: 0.5 }), GATE)
    expect(result.outcome).toBe("escalate")
    expect(result.reason).toContain("0.5")
    expect(result.reason).toContain("0.7")
    expect(result.changed).toBe(true)
  })

  it("escalates an allow the risk policy does not permit", () => {
    const result = enforceDecision(
      decision({ risk_level: "high", user_authorization: "low" }),
      GATE,
    )
    expect(result.outcome).toBe("escalate")
    expect(result.reason).toContain("high")
    expect(result.reason).toContain("low")
  })

  it("escalates a misaligned allow", () => {
    const result = enforceDecision(decision({ scope_alignment: "misaligned" }), GATE)
    expect(result.outcome).toBe("escalate")
    expect(result.reason).toContain("misaligned")
  })

  it("escalates a medium or higher allow with insufficient evidence", () => {
    const result = enforceDecision(
      decision({ risk_level: "medium", evidence_completeness: "insufficient" }),
      GATE,
    )
    expect(result.outcome).toBe("escalate")
    expect(result.reason).toContain("insufficient")
  })

  it("keeps a low risk allow with insufficient evidence", () => {
    const result = enforceDecision(decision({ evidence_completeness: "insufficient" }), GATE)
    expect(result.outcome).toBe("allow")
    expect(result.changed).toBe(false)
  })

  it("passes an allow that clears every rule and reports its own rationale", () => {
    const result = enforceDecision(decision(), GATE)
    expect(result).toEqual({ outcome: "allow", reason: "Reads one project file.", changed: false })
  })

  it("never turns a deny or an escalate into an allow", () => {
    const outcomes: Outcome[] = ["deny", "escalate"]
    let checked = 0
    for (const outcome of outcomes) {
      for (const risk of RISK_LEVELS) {
        for (const authorization of AUTHORIZATIONS) {
          for (const scope of SCOPE_ALIGNMENTS) {
            for (const completeness of EVIDENCE_COMPLETENESS) {
              const result = enforceDecision(
                decision({
                  outcome,
                  risk_level: risk,
                  user_authorization: authorization,
                  scope_alignment: scope,
                  evidence_completeness: completeness,
                  confidence: 1,
                }),
                GATE,
              )
              expect(result.outcome).not.toBe("allow")
              checked += 1
            }
          }
        }
      }
    }
    expect(checked).toBe(2 * 4 * 4 * 4 * 4)
  })

  it("allows only when every gate condition passes", () => {
    for (const risk of RISK_LEVELS) {
      for (const authorization of AUTHORIZATIONS) {
        for (const scope of SCOPE_ALIGNMENTS) {
          for (const completeness of EVIDENCE_COMPLETENESS) {
            for (const confidence of [0.6, 0.8]) {
              const candidate = decision({
                outcome: "allow",
                risk_level: risk,
                user_authorization: authorization,
                scope_alignment: scope,
                evidence_completeness: completeness,
                confidence,
              })
              const expected =
                risk !== "critical" &&
                confidence >= GATE.confidenceThreshold &&
                RISK_POLICY.allow[risk].includes(authorization) &&
                scope !== "misaligned" &&
                !(risk !== "low" && completeness === "insufficient")
              const result = enforceDecision(candidate, GATE)
              expect(result.outcome === "allow").toBe(expected)
              expect(result.changed).toBe(!expected)
            }
          }
        }
      }
    }
  })
})

describe("input hardening", () => {
  it.each([["0x1"], ["1e0"], ["  "], ["0.5abc"], ["+0.5"], ["Infinity"]])(
    "rejects the confidence string %p",
    (confidence) => {
      expect(parseDecision(JSON.stringify({ ...BODY, confidence }))).toBeUndefined()
    },
  )

  it.each([["0"], ["1"], ["1.0"], [".5"], ["0.42"], [" 0.42 "]])(
    "accepts the confidence string %p",
    (confidence) => {
      expect(parseDecision(JSON.stringify({ ...BODY, confidence }))?.confidence).toBeGreaterThanOrEqual(0)
    },
  )

  it("rejects an enum value that holds whitespace", () => {
    expect(parseDecision(JSON.stringify({ ...BODY, outcome: "al low" }))).toBeUndefined()
    expect(parseDecision(JSON.stringify({ ...BODY, risk_level: "lo w" }))).toBeUndefined()
  })

  it("escalates an allow when the risk policy has no list for the level", () => {
    const gate: GateConfig = { confidenceThreshold: 0.7, riskPolicy: { allow: {} } as RiskPolicy }
    const result = enforceDecision(decision({ risk_level: "medium" }), gate)
    expect(result.outcome).toBe("escalate")
    expect(result.changed).toBe(true)
  })
})
