import type { ModelRef } from "./types.js"

/**
 * Reads a model reference from a plugin option.
 *
 * Accepts `"provider/model"`, `"provider/model#variant"`, or the object form.
 * Returns undefined for anything else, so the caller can fail closed.
 */
export function parseModelRef(value: unknown): ModelRef | undefined {
  if (typeof value === "string") return parseString(value)
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return parseObject(value as Record<string, unknown>)
  }
  return undefined
}

/** Renders a reference back into the `provider/model#variant` string form. */
export function formatModelRef(ref: ModelRef): string {
  return ref.variant ? `${ref.providerID}/${ref.id}#${ref.variant}` : `${ref.providerID}/${ref.id}`
}

function parseString(value: string): ModelRef | undefined {
  const text = value.trim()
  // Model ids may contain slashes, so only the first slash separates the provider.
  const slash = text.indexOf("/")
  if (slash <= 0) return undefined
  const providerID = text.slice(0, slash).trim()
  const rest = text.slice(slash + 1).trim()
  if (!providerID || !rest) return undefined

  const hash = rest.indexOf("#")
  if (hash < 0) return { providerID, id: rest }
  const id = rest.slice(0, hash).trim()
  if (!id) return undefined
  const variant = rest.slice(hash + 1).trim()
  return variant ? { providerID, id, variant } : { providerID, id }
}

function parseObject(value: Record<string, unknown>): ModelRef | undefined {
  const providerID = text(value.providerID)
  const id = text(value.id)
  if (!providerID || !id) return undefined
  const variant = text(value.variant)
  return variant ? { providerID, id, variant } : { providerID, id }
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}
