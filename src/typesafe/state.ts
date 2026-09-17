import { homedir } from "node:os"
import { resourceLocation, type Intent } from "../evidence.js"
import { capText, redactSecrets, redactValue } from "../redact.js"
import type { CorrelatedCall, PermissionEvent } from "../types.js"

/** A structured value that did not fit its budget. The state stays valid JSON. */
export interface Truncated {
  truncated: true
  text: string
}

export interface State {
  action: string
  agent: string
  project_directory: string
  resources: string[]
  /** Same index as `resources`. */
  resource_locations: string[]
  metadata: unknown | null
  tool: string | null
  tool_input: unknown | null
  shell: { cwd: string; command: string } | null
  intent: { latest: string | null; history: string[]; agent_purpose: string | null; status: string }
  policy_notes: string
}

export interface StateInput {
  event: PermissionEvent
  intent: Intent
  correlated?: CorrelatedCall
  projectDirectory: string
  maxEvidenceChars: number
  maxIntentChars: number
  policyNotes: string
  /** Defaults to `os.homedir()`. Injected by the tests. */
  home?: string
}

/** The required state cannot fit without cutting resources or hiding the failure. */
export class StateBudgetError extends Error {
  constructor(readonly size: number, readonly limit: number) {
    super(`TypeSafe state needs ${size} characters, but its limit is ${limit}`)
    this.name = "StateBudgetError"
  }
}

const SLACK_CHARS = 2000

const single = (text: string): string => redactSecrets(text)

function redactJsonStrings(value: unknown): unknown {
  if (typeof value === "string") return single(value)
  if (Array.isArray(value)) return value.map(redactJsonStrings)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      single(key),
      redactJsonStrings(item),
    ]),
  )
}

/**
 * Redacts before and after serialization. The second pass protects object keys and
 * values produced by a custom toJSON method.
 */
function safeStructuredText(value: unknown): string {
  const firstPass = JSON.stringify(redactValue(value))
  if (firstPass === undefined) return "null"
  const materialized = JSON.parse(firstPass) as unknown
  const safeValue = redactJsonStrings(redactValue(materialized))
  return redactSecrets(JSON.stringify(safeValue))
}

function jsonSize(value: unknown): number {
  return JSON.stringify(value).length
}

function truncated(text: string, max: number): Truncated {
  const empty: Truncated = { truncated: true, text: "" }
  if (jsonSize(empty) > max) return empty

  let low = 0
  let high = text.length
  let result = empty
  while (low <= high) {
    const length = Math.floor((low + high) / 2)
    const candidate: Truncated = { truncated: true, text: capText(text, length) }
    if (jsonSize(candidate) <= max) {
      result = candidate
      low = length + 1
    } else {
      high = length - 1
    }
  }
  return result
}

/** Redacts a structured value, then caps its JSON text. */
function structured(value: unknown, max: number): unknown {
  const text = safeStructuredText(value)
  if (text.length <= max) return JSON.parse(text) as unknown
  return truncated(text, max)
}

function cappedIntent(intent: Intent, max: number): State["intent"] {
  const latest = intent.latest === undefined ? null : single(intent.latest)
  const purpose = intent.purpose === undefined ? null : single(intent.purpose)
  const history = intent.history.map(single)
  let remaining = Math.max(0, max)

  const take = (text: string | null): string | null => {
    if (text === null || remaining === 0) return null
    const capped = capText(text, remaining)
    remaining = Math.max(0, remaining - capped.length)
    return capped
  }

  const cappedLatest = take(latest)
  const cappedPurpose = take(purpose)
  const cappedHistory: string[] = []
  for (let index = history.length - 1; index >= 0 && remaining > 0; index--) {
    const value = take(history[index])
    if (value !== null) cappedHistory.unshift(value)
  }

  return {
    latest: cappedLatest,
    history: cappedHistory,
    agent_purpose: cappedPurpose,
    status: single(intent.status),
  }
}

export function buildState(input: StateInput): State {
  const { correlated, event, intent } = input
  const share = Math.floor(Math.max(0, input.maxEvidenceChars) / 2)
  const home = input.home ?? homedir()
  const resources = event.resources.map(single)

  const state: State = {
    action: single(event.action),
    agent: event.agent ? single(event.agent) : "unknown",
    project_directory: single(input.projectDirectory),
    resources,
    resource_locations: event.resources.map((resource) =>
      resourceLocation(event.action, resource, input.projectDirectory, home),
    ),
    metadata: event.metadata ? structured(event.metadata, share) : null,
    tool: correlated ? single(correlated.tool) : null,
    tool_input: correlated ? structured(correlated.input, share) : null,
    shell: correlated?.shell ? { cwd: single(correlated.shell.cwd), command: single(correlated.shell.command) } : null,
    intent: cappedIntent(intent, input.maxIntentChars),
    policy_notes: single(input.policyNotes),
  }

  // Trim until the whole state fits: oldest history first, then metadata, then tool input.
  // Resources are never cut, because they are what the decision authorizes.
  const budget = Math.max(0, input.maxEvidenceChars) + Math.max(0, input.maxIntentChars) + SLACK_CHARS
  const size = (): number => JSON.stringify(state).length
  while (size() > budget && state.intent.history.length > 0) state.intent.history.shift()
  if (size() > budget && state.metadata !== null) state.metadata = { truncated: true, text: "" }
  if (size() > budget && state.tool_input !== null) state.tool_input = { truncated: true, text: "" }
  const finalSize = size()
  if (finalSize > budget) throw new StateBudgetError(finalSize, budget)
  return state
}
