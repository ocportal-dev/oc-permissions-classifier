import { existsSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { parseModelRef } from "./model-ref.js"
import { AUTHORIZATIONS, RISK_LEVELS, type Authorization, type ModelRef, type RiskLevel, type RiskPolicy } from "./types.js"

export interface ClassifierConfig {
  model: ModelRef | undefined
  escalation: "ask" | "deny"
  timeoutMs: number
  confidenceThreshold: number
  intentMessages: number
  maxIntentChars: number
  maxEvidenceChars: number
  audit: boolean
  auditPath: string
  policy: string | undefined
  riskPolicy: RiskPolicy
  ignoreActions: string[]
  debug: boolean
}

/** The parts of the host environment the configuration depends on. */
export interface ConfigEnv {
  projectDirectory: string
  xdgDataHome?: string
  home: string
  /** Defaults to `process.platform`. Path comparison ignores case on darwin and win32. */
  platform?: string
  /** Defaults to a walk up to the nearest existing ancestor. Injected by the tests. */
  realpath?: (path: string) => string
}

/**
 * Resolves the symbolic links of the nearest existing ancestor, so a link cannot point
 * the audit log back into the project. Returns the input when nothing can be resolved.
 */
export function nearestRealPath(target: string): string {
  try {
    let current = target
    for (;;) {
      if (existsSync(current)) {
        const real = realpathSync(current)
        return current === target ? real : resolve(real, relative(current, target))
      }
      const parent = dirname(current)
      if (parent === current) return target
      current = parent
    }
  } catch {
    return target
  }
}

/** The authorization levels that may be allowed at each risk level. */
export const DEFAULT_RISK_POLICY: RiskPolicy = {
  allow: {
    low: ["high", "medium", "low", "unknown"],
    medium: ["high", "medium", "low"],
    high: ["high", "medium"],
    critical: [],
  },
}

/** The audit log lives outside the project, because a write inside it reloads the config. */
export function defaultAuditPath(env: ConfigEnv): string {
  const dataHome = env.xdgDataHome?.trim() || join(env.home, ".local", "share")
  return join(dataHome, "opencode", "opencode-permissions-classifier", "audit.jsonl")
}

/**
 * Reads the plugin options. Never throws: an invalid option becomes a warning and the
 * default value, so a typo cannot stop the plugin from failing closed.
 */
export function resolveConfig(
  options: unknown,
  env: ConfigEnv,
): { config: ClassifierConfig; warnings: string[] } {
  const warnings: string[] = []
  const raw = recordValue(options) ?? {}
  const fallbackAuditPath = defaultAuditPath(env)

  const model = parseModelRef(raw.model)
  if (!model) {
    warnings.push(
      "options.model is missing or invalid; set it to \"provider/model\" so the classifier can run",
    )
  }

  return {
    config: {
      model,
      escalation: enumOption(raw.escalation, ["ask", "deny"] as const, "ask", "options.escalation", warnings),
      timeoutMs: numberOption(raw.timeoutMs, 60000, 1000, 600000, false, "options.timeoutMs", warnings),
      confidenceThreshold: numberOption(
        raw.confidenceThreshold,
        0.7,
        0,
        1,
        false,
        "options.confidenceThreshold",
        warnings,
      ),
      intentMessages: numberOption(raw.intentMessages, 8, 0, 1000, true, "options.intentMessages", warnings),
      maxIntentChars: numberOption(raw.maxIntentChars, 8000, 0, 1000000, true, "options.maxIntentChars", warnings),
      maxEvidenceChars: numberOption(
        raw.maxEvidenceChars,
        24000,
        0,
        1000000,
        true,
        "options.maxEvidenceChars",
        warnings,
      ),
      audit: booleanOption(raw.audit, true, "options.audit", warnings),
      auditPath: auditPathOption(raw.auditPath, env, fallbackAuditPath, warnings),
      policy: policyOption(raw.policy, warnings),
      riskPolicy: riskPolicyOption(raw.riskPolicy, warnings),
      ignoreActions: ignoreActionsOption(raw.ignoreActions, warnings),
      debug: booleanOption(raw.debug, false, "options.debug", warnings),
    },
    warnings,
  }
}

function enumOption<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  name: string,
  warnings: string[],
): T {
  if (value === undefined) return fallback
  const text = stringValue(value)?.trim()
  if (text && (allowed as readonly string[]).includes(text)) return text as T
  warnings.push(`${name} must be one of ${allowed.join(", ")}; using ${fallback}`)
  return fallback
}

function numberOption(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  integer: boolean,
  name: string,
  warnings: string[],
): number {
  if (value === undefined) return fallback
  const parsed = numberValue(value)
  if (parsed === undefined) {
    warnings.push(`${name} must be a number; using ${fallback}`)
    return fallback
  }
  const rounded = integer ? Math.floor(parsed) : parsed
  const clamped = Math.min(Math.max(rounded, min), max)
  if (clamped !== rounded) warnings.push(`${name} must be between ${min} and ${max}; using ${clamped}`)
  return clamped
}

function booleanOption(value: unknown, fallback: boolean, name: string, warnings: string[]): boolean {
  if (value === undefined) return fallback
  const parsed = booleanValue(value)
  if (parsed === undefined) {
    warnings.push(`${name} must be true or false; using ${fallback}`)
    return fallback
  }
  return parsed
}

function policyOption(value: unknown, warnings: string[]): string | undefined {
  if (value === undefined) return undefined
  const text = stringValue(value)
  if (!text) {
    warnings.push("options.policy must be a non-empty string; using the built-in policy")
    return undefined
  }
  return text
}

function ignoreActionsOption(value: unknown, warnings: string[]): string[] {
  if (value === undefined) return []
  const actions = stringArrayValue(value)
  if (!actions) {
    warnings.push("options.ignoreActions must be an array of strings; using an empty list")
    return []
  }
  return actions
}

function auditPathOption(
  value: unknown,
  env: ConfigEnv,
  fallback: string,
  warnings: string[],
): string {
  if (value === undefined) return fallback
  const text = stringValue(value)?.trim()
  if (!text) {
    warnings.push("options.auditPath must be a non-empty string; using the default path")
    return fallback
  }

  const expanded = text === "~" ? env.home : text.startsWith("~/") ? join(env.home, text.slice(2)) : text
  const absolute = resolve(isAbsolute(expanded) ? expanded : join(env.home, expanded))

  // darwin and win32 treat `.OPENCODE` and `.opencode` as the same directory, so both
  // guards compare folded paths there.
  const platform = env.platform ?? process.platform
  const folded = (path: string): string =>
    platform === "darwin" || platform === "win32" ? path.toLowerCase() : path

  const realpath = env.realpath ?? nearestRealPath
  const target = folded(realpath(absolute))
  const project = folded(realpath(resolve(env.projectDirectory)))

  if (target === project || target.startsWith(project + sep)) {
    warnings.push("options.auditPath must be outside the project directory; using the default path")
    return fallback
  }
  if (target.split(sep).includes(".opencode")) {
    warnings.push("options.auditPath must not be inside a .opencode directory; using the default path")
    return fallback
  }
  return absolute
}

function riskPolicyOption(value: unknown, warnings: string[]): RiskPolicy {
  const merged: RiskPolicy = { allow: { ...DEFAULT_RISK_POLICY.allow } }
  for (const level of RISK_LEVELS) merged.allow[level] = [...DEFAULT_RISK_POLICY.allow[level]]
  if (value === undefined) return merged

  const policy = recordValue(value)
  const allow = policy ? recordValue(policy.allow) : undefined
  if (!allow) {
    warnings.push("options.riskPolicy must be an object with an allow map; using the default policy")
    return merged
  }

  for (const [level, list] of Object.entries(allow)) {
    if (!(RISK_LEVELS as readonly string[]).includes(level)) {
      warnings.push(`options.riskPolicy.allow.${level} is not a risk level; ignoring it`)
      continue
    }
    const names = stringArrayValue(list)
    const valid = names?.every((name) => (AUTHORIZATIONS as readonly string[]).includes(name))
    if (!names || !valid) {
      warnings.push(`options.riskPolicy.allow.${level} must list authorization levels; ignoring it`)
      continue
    }
    merged.allow[level as RiskLevel] = names as Authorization[]
  }
  return merged
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === "string")
  return strings.length === value.length ? strings : undefined
}
