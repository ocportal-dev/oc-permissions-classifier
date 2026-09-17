import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_HAZARD_THRESHOLDS, DEFAULT_RISK_POLICY, defaultAuditPath, resolveConfig, type ConfigEnv } from "../src/config.js"

const env: ConfigEnv = { projectDirectory: "/Users/tester/work/app", home: "/Users/tester" }
const DEFAULT_PATH = "/Users/tester/.local/share/opencode/opencode-permissions-classifier/audit.jsonl"

function warned(warnings: string[], needle: string): boolean {
  return warnings.some((warning) => warning.includes(needle))
}

it("builds the default audit path under the xdg data home", () => {
  expect(defaultAuditPath({ ...env, xdgDataHome: "/data" })).toBe(
    "/data/opencode/opencode-permissions-classifier/audit.jsonl",
  )
})

it("falls back to the local share directory", () => {
  expect(defaultAuditPath(env)).toBe(DEFAULT_PATH)
})

it("applies every default", () => {
  const { config } = resolveConfig({ model: "acme/model" }, env)
  expect(config).toEqual({
    backend: "llm",
    model: { providerID: "acme", id: "model" },
    escalation: "ask",
    timeoutMs: 60000,
    confidenceThreshold: 0.7,
    intentMessages: 8,
    maxIntentChars: 8000,
    maxEvidenceChars: 24000,
    audit: true,
    auditPath: DEFAULT_PATH,
    policy: undefined,
    riskPolicy: DEFAULT_RISK_POLICY,
    ignoreActions: [],
    debug: false,
    showDecisions: true,
    showDecisionTiming: false,
    typesafe: {
      apiKey: undefined,
      model: "jev-latest",
      baseURL: "https://api.typesafe.ai",
      timeoutMs: 15000,
      maxRetries: 2,
      thresholds: DEFAULT_HAZARD_THRESHOLDS,
    },
  })
})

it("reports no warning for a valid option set", () => {
  expect(resolveConfig({ model: "acme/model" }, env).warnings).toEqual([])
})

it("can disable decision notices and enable their timing", () => {
  const { config, warnings } = resolveConfig({
    model: "acme/model",
    showDecisions: false,
    showDecisionTiming: true,
  }, env)
  expect(config.showDecisions).toBe(false)
  expect(config.showDecisionTiming).toBe(true)
  expect(warnings).toEqual([])
})

it("warns and uses defaults for invalid notice options", () => {
  const { config, warnings } = resolveConfig({
    model: "acme/model",
    showDecisions: "yes",
    showDecisionTiming: 1,
  }, env)
  expect(config.showDecisions).toBe(true)
  expect(config.showDecisionTiming).toBe(false)
  expect(warned(warnings, "options.showDecisions")).toBe(true)
  expect(warned(warnings, "options.showDecisionTiming")).toBe(true)
})

it("warns when the model is missing", () => {
  const { config, warnings } = resolveConfig({}, env)
  expect(config.model).toBeUndefined()
  expect(warned(warnings, "options.model")).toBe(true)
})

it("warns when the model is invalid", () => {
  const { config, warnings } = resolveConfig({ model: "nope" }, env)
  expect(config.model).toBeUndefined()
  expect(warned(warnings, "options.model")).toBe(true)
})

it.each([
  [{ timeoutMs: 10 }, 1000],
  [{ timeoutMs: 900000 }, 600000],
  [{ timeoutMs: 5000 }, 5000],
])("clamps the timeout %p", (options, expected) => {
  const { config } = resolveConfig({ model: "acme/model", ...options }, env)
  expect(config.timeoutMs).toBe(expected)
})

it("warns about a clamped timeout", () => {
  expect(warned(resolveConfig({ model: "acme/model", timeoutMs: 10 }, env).warnings, "options.timeoutMs")).toBe(true)
})

it.each([
  [{ confidenceThreshold: -1 }, 0],
  [{ confidenceThreshold: 4 }, 1],
  [{ confidenceThreshold: 0.5 }, 0.5],
])("clamps the confidence threshold %p", (options, expected) => {
  const { config } = resolveConfig({ model: "acme/model", ...options }, env)
  expect(config.confidenceThreshold).toBe(expected)
})

it("floors the intent message count", () => {
  expect(resolveConfig({ model: "acme/model", intentMessages: 3.7 }, env).config.intentMessages).toBe(3)
})

it("clamps a negative intent message count", () => {
  const { config, warnings } = resolveConfig({ model: "acme/model", intentMessages: -2 }, env)
  expect(config.intentMessages).toBe(0)
  expect(warned(warnings, "options.intentMessages")).toBe(true)
})

it("keeps a valid escalation", () => {
  expect(resolveConfig({ model: "acme/model", escalation: "deny" }, env).config.escalation).toBe("deny")
})

it("rejects an invalid escalation", () => {
  const { config, warnings } = resolveConfig({ model: "acme/model", escalation: "maybe" }, env)
  expect(config.escalation).toBe("ask")
  expect(warned(warnings, "options.escalation")).toBe(true)
})

it("expands a leading tilde in the audit path", () => {
  const { config, warnings } = resolveConfig({ model: "acme/model", auditPath: "~/logs/audit.jsonl" }, env)
  expect(config.auditPath).toBe("/Users/tester/logs/audit.jsonl")
  expect(warnings).toEqual([])
})

it("resolves a relative audit path against the home directory", () => {
  const { config } = resolveConfig({ model: "acme/model", auditPath: "logs/audit.jsonl" }, env)
  expect(config.auditPath).toBe("/Users/tester/logs/audit.jsonl")
})

it("rejects an audit path inside the project directory", () => {
  const { config, warnings } = resolveConfig(
    { model: "acme/model", auditPath: "/Users/tester/work/app/audit.jsonl" },
    env,
  )
  expect(config.auditPath).toBe(DEFAULT_PATH)
  expect(warned(warnings, "options.auditPath")).toBe(true)
})

it("rejects an audit path with an opencode config segment", () => {
  const { config, warnings } = resolveConfig(
    { model: "acme/model", auditPath: "/Users/tester/.opencode/audit.jsonl" },
    env,
  )
  expect(config.auditPath).toBe(DEFAULT_PATH)
  expect(warned(warnings, "options.auditPath")).toBe(true)
})

it("keeps an audit path beside the project directory", () => {
  const { config } = resolveConfig({ model: "acme/model", auditPath: "/Users/tester/work/app-logs/a.jsonl" }, env)
  expect(config.auditPath).toBe("/Users/tester/work/app-logs/a.jsonl")
})

it("merges a partial risk policy over the defaults", () => {
  const { config, warnings } = resolveConfig(
    { model: "acme/model", riskPolicy: { allow: { high: ["high"] } } },
    env,
  )
  expect(config.riskPolicy.allow.high).toEqual(["high"])
  expect(config.riskPolicy.allow.low).toEqual(["high", "medium", "low", "unknown"])
  expect(warnings).toEqual([])
})

it("does not change the default risk policy", () => {
  resolveConfig({ model: "acme/model", riskPolicy: { allow: { critical: ["high"] } } }, env)
  expect(DEFAULT_RISK_POLICY.allow.critical).toEqual([])
})

it("ignores an unknown risk level", () => {
  const { config, warnings } = resolveConfig(
    { model: "acme/model", riskPolicy: { allow: { extreme: ["high"] } } },
    env,
  )
  expect(config.riskPolicy).toEqual(DEFAULT_RISK_POLICY)
  expect(warned(warnings, "options.riskPolicy")).toBe(true)
})

it("ignores an invalid authorization list", () => {
  const { config, warnings } = resolveConfig(
    { model: "acme/model", riskPolicy: { allow: { high: ["nobody"] } } },
    env,
  )
  expect(config.riskPolicy.allow.high).toEqual(["high", "medium"])
  expect(warned(warnings, "options.riskPolicy")).toBe(true)
})

it("keeps a policy override", () => {
  expect(resolveConfig({ model: "acme/model", policy: "be careful" }, env).config.policy).toBe("be careful")
})

it("rejects an empty policy override", () => {
  const { config, warnings } = resolveConfig({ model: "acme/model", policy: "  " }, env)
  expect(config.policy).toBeUndefined()
  expect(warned(warnings, "options.policy")).toBe(true)
})

it("keeps an ignored action list", () => {
  expect(resolveConfig({ model: "acme/model", ignoreActions: ["read", "glob"] }, env).config.ignoreActions).toEqual([
    "read",
    "glob",
  ])
})

it("rejects an ignored action list that is not made of strings", () => {
  const { config, warnings } = resolveConfig({ model: "acme/model", ignoreActions: ["read", 7] }, env)
  expect(config.ignoreActions).toEqual([])
  expect(warned(warnings, "options.ignoreActions")).toBe(true)
})

it("reads the audit and debug switches", () => {
  const { config } = resolveConfig({ model: "acme/model", audit: false, debug: true }, env)
  expect(config.audit).toBe(false)
  expect(config.debug).toBe(true)
})

it.each([[null], [42], [[]], [undefined], ["text"]])("falls back to the defaults for %p", (options) => {
  const { config, warnings } = resolveConfig(options, env)
  expect(config.model).toBeUndefined()
  expect(config.escalation).toBe("ask")
  expect(config.timeoutMs).toBe(60000)
  expect(config.auditPath).toBe(DEFAULT_PATH)
  expect(warned(warnings, "options.model")).toBe(true)
})

it("rejects a differently cased opencode segment on darwin", () => {
  const { config, warnings } = resolveConfig(
    { model: "acme/model", auditPath: "/Users/tester/.OPENCODE/audit.jsonl" },
    { ...env, platform: "darwin", realpath: (path) => path },
  )
  expect(config.auditPath).toBe(DEFAULT_PATH)
  expect(warned(warnings, "options.auditPath")).toBe(true)
})

it("rejects a differently cased project prefix on win32", () => {
  const { config, warnings } = resolveConfig(
    { model: "acme/model", auditPath: "/Users/tester/WORK/App/audit.jsonl" },
    { ...env, platform: "win32", realpath: (path) => path },
  )
  expect(config.auditPath).toBe(DEFAULT_PATH)
  expect(warned(warnings, "options.auditPath")).toBe(true)
})

it("keeps a differently cased opencode segment on linux", () => {
  const { config, warnings } = resolveConfig(
    { model: "acme/model", auditPath: "/Users/tester/.OPENCODE/audit.jsonl" },
    { ...env, platform: "linux", realpath: (path) => path },
  )
  expect(config.auditPath).toBe("/Users/tester/.OPENCODE/audit.jsonl")
  expect(warnings).toEqual([])
})

it("rejects an audit path that reaches the project through a symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "permissions-classifier-config-"))
  const project = join(root, "project")
  await mkdir(project)
  await symlink(project, join(root, "link"))

  const symlinkEnv: ConfigEnv = { projectDirectory: project, home: root }
  const { config, warnings } = resolveConfig(
    { model: "acme/model", auditPath: join(root, "link", "audit.jsonl") },
    symlinkEnv,
  )
  expect(config.auditPath).toBe(defaultAuditPath(symlinkEnv))
  expect(warned(warnings, "options.auditPath")).toBe(true)
})

it("keeps an audit path that reaches a sibling through a symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "permissions-classifier-config-"))
  const project = join(root, "project")
  const logs = join(root, "logs")
  await mkdir(project)
  await mkdir(logs)
  await symlink(logs, join(root, "link"))

  const target = join(root, "link", "audit.jsonl")
  const { config, warnings } = resolveConfig(
    { model: "acme/model", auditPath: target },
    { projectDirectory: project, home: root },
  )
  expect(config.auditPath).toBe(target)
  expect(warnings).toEqual([])
})

describe("backend", () => {
  it("defaults to llm", () => {
    const { config } = resolveConfig({ model: "p/m" }, env)
    expect(config.backend).toBe("llm")
  })
  it("accepts typesafe", () => {
    const { config } = resolveConfig({ backend: "typesafe" }, env)
    expect(config.backend).toBe("typesafe")
  })
  it("warns on an unknown backend and uses llm", () => {
    const { config, warnings } = resolveConfig({ backend: "rlcd", model: "p/m" }, env)
    expect(config.backend).toBe("llm")
    expect(warnings.some((w) => w.includes("options.backend"))).toBe(true)
  })
  it("does not warn about a missing model when the backend is typesafe", () => {
    const { warnings } = resolveConfig({ backend: "typesafe", typesafe: { apiKey: "k" } }, env)
    expect(warnings.some((w) => w.includes("options.model"))).toBe(false)
  })
})

describe("typesafe options", () => {
  it("reads apiKey, model, and baseURL", () => {
    const { config, warnings } = resolveConfig(
      { backend: "typesafe", typesafe: { apiKey: "k", model: "jev-preview", baseURL: "http://localhost:9999/" } },
      env,
    )
    expect(config.typesafe.apiKey).toBe("k")
    expect(config.typesafe.model).toBe("jev-preview")
    expect(config.typesafe.baseURL).toBe("http://localhost:9999")
    expect(warnings).toEqual([])
  })
  it("falls back to TYPESAFE_API_KEY from the environment", () => {
    const { config } = resolveConfig({ backend: "typesafe" }, { ...env, typesafeApiKey: "from-env" })
    expect(config.typesafe.apiKey).toBe("from-env")
  })
  it("warns when the backend is typesafe and no key is available", () => {
    const { config, warnings } = resolveConfig({ backend: "typesafe" }, env)
    expect(config.typesafe.apiKey).toBeUndefined()
    expect(warnings.some((w) => w.includes("options.typesafe.apiKey"))).toBe(true)
  })
  it("does not warn about the key when the backend is llm", () => {
    const { warnings } = resolveConfig({ model: "p/m" }, env)
    expect(warnings.some((w) => w.includes("typesafe.apiKey"))).toBe(false)
  })
  it("applies defaults", () => {
    const { config } = resolveConfig({ backend: "typesafe", typesafe: { apiKey: "k" } }, env)
    expect(config.typesafe).toEqual({
      apiKey: "k", model: "jev-latest", baseURL: "https://api.typesafe.ai", timeoutMs: 15000, maxRetries: 2,
      thresholds: { steering: 0.5, secret: 0.5, destructive: 0.7, weakensSecurity: 0.7, outsideWorkspace: 0.7, remoteOpacity: 1.5 },
    })
  })
  it("rejects a provider-prefixed model and a non-http baseURL", () => {
    const { config, warnings } = resolveConfig({ backend: "typesafe", typesafe: { apiKey: "k", model: "openai/jev", baseURL: "ftp://x" } }, env)
    expect(config.typesafe.model).toBe("jev-latest")
    expect(config.typesafe.baseURL).toBe("https://api.typesafe.ai")
    expect(warnings.filter((w) => w.includes("options.typesafe.")).length).toBe(2)
  })
  it("clamps thresholds and warns per key", () => {
    const { config, warnings } = resolveConfig({ backend: "typesafe", typesafe: { apiKey: "k", thresholds: { secret: 3, remoteOpacity: -1, bogus: 1 } } }, env)
    expect(config.typesafe.thresholds.secret).toBe(1)
    expect(config.typesafe.thresholds.remoteOpacity).toBe(0)
    expect(warnings.some((w) => w.includes("thresholds.secret"))).toBe(true)
    expect(warnings.some((w) => w.includes("thresholds.bogus"))).toBe(true)
  })
  it("warns on malformed nested option blocks", () => {
    const malformedBlock = resolveConfig(
      { backend: "typesafe", typesafe: [] },
      { ...env, typesafeApiKey: "from-env" },
    )
    expect(malformedBlock.config.typesafe.model).toBe("jev-latest")
    expect(warned(malformedBlock.warnings, "options.typesafe must be an object")).toBe(true)

    const malformedThresholds = resolveConfig(
      { backend: "typesafe", typesafe: { apiKey: "k", thresholds: "strict" } },
      env,
    )
    expect(malformedThresholds.config.typesafe.thresholds).toEqual(DEFAULT_HAZARD_THRESHOLDS)
    expect(warned(malformedThresholds.warnings, "options.typesafe.thresholds")).toBe(true)
  })
  it("warns on unknown nested keys", () => {
    const { warnings } = resolveConfig(
      {
        backend: "typesafe",
        typesafe: { apiKey: "k", endpoint: "https://example.com", thresholds: { bogus: 1 } },
      },
      env,
    )
    expect(warned(warnings, "options.typesafe.endpoint")).toBe(true)
    expect(warned(warnings, "options.typesafe.thresholds.bogus")).toBe(true)
  })
  it("warns on an invalid configured apiKey and uses the environment key", () => {
    const { config, warnings } = resolveConfig(
      { backend: "typesafe", typesafe: { apiKey: " " } },
      { ...env, typesafeApiKey: "from-env" },
    )
    expect(config.typesafe.apiKey).toBe("from-env")
    expect(warned(warnings, "options.typesafe.apiKey")).toBe(true)
  })
  it.each([
    [10, 1000],
    [900000, 600000],
    [5000, 5000],
  ])("clamps the TypeSafe timeout %p", (timeoutMs, expected) => {
    const { config } = resolveConfig(
      { backend: "typesafe", typesafe: { apiKey: "k", timeoutMs } },
      env,
    )
    expect(config.typesafe.timeoutMs).toBe(expected)
  })
  it.each([
    [-2, 0],
    [8, 5],
    [3, 3],
  ])("clamps the TypeSafe retry count %p", (maxRetries, expected) => {
    const { config } = resolveConfig(
      { backend: "typesafe", typesafe: { apiKey: "k", maxRetries } },
      env,
    )
    expect(config.typesafe.maxRetries).toBe(expected)
  })
  it("requires the TypeSafe retry count to be an integer", () => {
    const { config, warnings } = resolveConfig(
      { backend: "typesafe", typesafe: { apiKey: "k", maxRetries: 3.5 } },
      env,
    )
    expect(config.typesafe.maxRetries).toBe(2)
    expect(warned(warnings, "options.typesafe.maxRetries must be an integer")).toBe(true)
  })
})
