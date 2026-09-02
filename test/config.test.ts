import { expect, it } from "bun:test"
import { mkdir, mkdtemp, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_RISK_POLICY, defaultAuditPath, resolveConfig, type ConfigEnv } from "../src/config.js"

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
  })
})

it("reports no warning for a valid option set", () => {
  expect(resolveConfig({ model: "acme/model" }, env).warnings).toEqual([])
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
