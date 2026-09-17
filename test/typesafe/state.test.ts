import { describe, expect, it } from "bun:test"
import { buildState, StateBudgetError } from "../../src/typesafe/state.js"

const base = {
  event: {
    sessionID: "s1",
    action: "edit",
    resources: ["src/a.ts", "~/.ssh/config"],
    effect: "ask" as const,
    metadata: { files: [{ path: "src/a.ts", diff: "+token=abcdefghijklmnop" }] },
  },
  intent: { latest: "edit a.ts", history: ["set up the repo"], purpose: "I will edit", status: "available (2 user messages)" },
  correlated: { tool: "edit", input: { filePath: "src/a.ts", password: "hunter2hunter2" } },
  projectDirectory: "/project",
  home: "/home/u",
  maxEvidenceChars: 24000,
  maxIntentChars: 8000,
  policyNotes: "notes",
}

describe("buildState", () => {
  it("builds every section", () => {
    const s = buildState(base)
    expect(s.action).toBe("edit")
    expect(s.resources).toEqual(["src/a.ts", "~/.ssh/config"])
    expect(s.resource_locations).toEqual(["inside project", "outside project (home directory)"])
    expect(s.tool).toBe("edit")
    expect(s.shell).toBeNull()
    expect(s.intent).toEqual({
      latest: "edit a.ts",
      history: ["set up the repo"],
      agent_purpose: "I will edit",
      status: "available (2 user messages)",
    })
    expect(s.policy_notes).toBe("notes")
  })
  it("redacts secrets in metadata and tool input", () => {
    const s = buildState(base)
    expect(JSON.stringify(s.metadata)).toContain("[REDACTED:")
    expect(JSON.stringify(s.metadata)).not.toContain("abcdefghijklmnop")
    expect(JSON.stringify(s.tool_input)).not.toContain("hunter2")
  })
  it("redacts policy notes, object keys, and values produced by toJSON", () => {
    class DeferredValue {
      toJSON(): unknown {
        return { password: "hunter2hunter2", note: "token=abcdefghijklmnop" }
      }
    }
    const s = buildState({
      ...base,
      event: {
        ...base.event,
        metadata: {
          "token=abcdefghijklmnop": "ordinary",
          deferred: new DeferredValue(),
        },
      },
      policyNotes: "secret=abcdefghijklmnop",
    })
    const text = JSON.stringify(s)
    expect(text).toContain("[REDACTED:")
    expect(text).not.toContain("abcdefghijklmnop")
    expect(text).not.toContain("hunter2")
  })
  it("reports unavailable sections as null", () => {
    const s = buildState({
      ...base,
      correlated: undefined,
      event: { ...base.event, metadata: undefined },
      intent: { history: [], status: "unavailable" },
    })
    expect(s.metadata).toBeNull()
    expect(s.tool).toBeNull()
    expect(s.tool_input).toBeNull()
    expect(s.intent.latest).toBeNull()
    expect(s.intent.agent_purpose).toBeNull()
  })
  it("includes the shell block when present", () => {
    const s = buildState({ ...base, correlated: { tool: "shell", input: {}, shell: { cwd: "/project", command: "ls" } } })
    expect(s.shell).toEqual({ cwd: "/project", command: "ls" })
  })
  it("caps metadata and tool input at half the evidence budget each and marks truncation", () => {
    const big = "x".repeat(50000)
    const s = buildState({
      ...base,
      maxEvidenceChars: 1000,
      event: { ...base.event, metadata: { big } },
      correlated: { tool: "t", input: { big } },
    })
    expect((s.metadata as { truncated: boolean }).truncated).toBe(true)
    expect(JSON.stringify(s.metadata).length).toBeLessThanOrEqual(560)
    expect(JSON.stringify(s.tool_input).length).toBeLessThanOrEqual(560)
  })
  it("keeps the whole state under the combined budget by dropping old history first", () => {
    const s = buildState({
      ...base,
      maxEvidenceChars: 2000,
      maxIntentChars: 500,
      intent: { ...base.intent, history: Array(50).fill("m".repeat(400)) },
    })
    expect(JSON.stringify(s).length).toBeLessThanOrEqual(2000 + 500 + 2000)
    expect(s.resources).toEqual(base.event.resources)
  })
  it("caps current intent before building the combined state", () => {
    const s = buildState({
      ...base,
      maxIntentChars: 100,
      intent: {
        latest: "l".repeat(1000),
        purpose: "p".repeat(1000),
        history: ["h".repeat(1000)],
        status: "available",
      },
    })
    const intentText = JSON.stringify(s.intent)
    expect(intentText.length).toBeLessThan(400)
    expect(intentText).toContain("[truncated")
  })
  it("fails closed when required state cannot fit without cutting resources", () => {
    const resource = `src/${"x".repeat(5000)}.ts`
    expect(() =>
      buildState({
        ...base,
        event: { ...base.event, resources: [resource], metadata: undefined },
        correlated: undefined,
        maxEvidenceChars: 0,
        maxIntentChars: 0,
      }),
    ).toThrow(StateBudgetError)
  })
})
