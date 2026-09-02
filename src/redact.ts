type Replacer = (match: string, ...groups: string[]) => string

interface Rule {
  pattern: RegExp
  /** The text that replaces the match. `$n` refers to a capture group. */
  replacement: string | Replacer
}

/** Words that look like a secret assignment but carry no value. */
const ASSIGNMENT_ALLOWLIST = /^(required|optional|true|false|none|null|bearer|basic)$/i

function assignmentReplacement(match: string, keyword: string, separator: string, value: string): string {
  const bare = value.replace(/[\\"']/g, "")
  if (ASSIGNMENT_ALLOWLIST.test(bare)) return match
  return `${keyword}${separator}[REDACTED:assignment]`
}

// Every rule refuses to match a value that already starts with a marker, so a second
// pass over redacted text returns the same text. Every quantifier that follows a
// character class overlapping its own prefix is bounded, so no rule can backtrack
// quadratically on a long run of one character.
const RULES: Rule[] = [
  {
    // A block with no END marker is redacted to the end of the text, because the
    // remainder is still key material.
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/g,
    replacement: "[REDACTED:private-key]",
  },
  {
    pattern: /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/)[^\s/@:]{1,256}:[^\s/@]{0,256}@/g,
    replacement: "$1[REDACTED:url-credentials]@",
  },
  {
    pattern: /\b(Set-Cookie|Cookie)(\s{0,8}:\s{0,8})(?!\s{0,8}\[REDACTED:)[^\r\n]+/gi,
    replacement: "$1$2[REDACTED:cookie]",
  },
  {
    // The optional `\"` covers a keyword that was already JSON-encoded, such as
    // `\"password\":\"x\"` inside a serialized diff.
    pattern:
      /\b(api[_-]?key|secret|token|password|passwd|pwd|auth|authorization|aws_secret_access_key|client_secret|private_key|credential|session_key)\b(\\?"?\s{0,8}[=:]\s{0,8})(?!\s{0,8}\\?"?\[REDACTED:)(\\?"[^"\r\n]*"|'[^'\r\n]*'|\S{8,})/gi,
    replacement: assignmentReplacement,
  },
  {
    pattern: /\bBearer\s{1,8}(?!\[REDACTED:)[A-Za-z0-9\-._~+/]{16,}=*/g,
    replacement: "[REDACTED:bearer]",
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: "[REDACTED:jwt]",
  },
  {
    pattern: new RegExp(
      [
        "\\bsk-[A-Za-z0-9_-]{16,}",
        "\\bgh[pou]_[A-Za-z0-9]{16,}",
        "\\bgithub_pat_[A-Za-z0-9_]{20,}",
        "\\bxox[bpa]-[A-Za-z0-9-]{10,}",
        "\\bAKIA[A-Z0-9]{16}\\b",
        "\\bAIza[A-Za-z0-9_-]{35}\\b",
        "\\b[sr]k_(live|test)_[A-Za-z0-9]{16,}",
        "\\bglpat-[A-Za-z0-9_-]{16,}",
        "\\bnpm_[A-Za-z0-9]{30,}",
        "\\bpypi-[A-Za-z0-9_-]{30,}",
        "\\bSG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}",
        "https:\\/\\/hooks\\.slack\\.com\\/services\\/[A-Za-z0-9/]+",
      ].join("|"),
      "g",
    ),
    replacement: "[REDACTED:api-key]",
  },
]

/** Replaces every secret this module knows about with a `[REDACTED:kind]` marker. */
export function redactSecrets(text: string): string {
  let result = text
  // The two branches are identical: `replace` has one overload per replacement kind, so
  // the union has to be narrowed before the call.
  for (const rule of RULES) {
    result =
      typeof rule.replacement === "string"
        ? result.replace(rule.pattern, rule.replacement)
        : result.replace(rule.pattern, rule.replacement)
  }
  return result
}

/** Words that mark an object key as holding a secret. */
const SECRET_WORDS = new Set([
  "secret",
  "token",
  "password",
  "passwd",
  "pwd",
  "auth",
  "authorization",
  "credential",
  "credentials",
])
/** A `key` word is only a secret next to one of these. */
const KEY_QUALIFIERS = new Set(["api", "private", "secret", "session", "access", "signing"])

/**
 * A key is secret when one of its words is a secret word, in any casing or separator
 * style. Words are compared whole, so `author` is not `auth`.
 */
function isSecretKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  if (words.some((word) => SECRET_WORDS.has(word))) return true
  return words.includes("key") && words.some((word) => KEY_QUALIFIERS.has(word))
}

const MAX_DEPTH = 16

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactSecrets(value)
  if (value === null || typeof value !== "object") return value
  if (!Array.isArray(value) && !isPlainObject(value)) return value
  if (depth >= MAX_DEPTH) return "[REDACTED:depth]"
  if (seen.has(value)) return "[REDACTED:cycle]"

  seen.add(value)
  const result = Array.isArray(value)
    ? value.map((item) => walk(item, depth + 1, seen))
    : Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          isSecretKey(key) ? "[REDACTED:key]" : walk(item, depth + 1, seen),
        ]),
      )
  seen.delete(value)
  return result
}

/**
 * Walks a structure and redacts it before it is serialized, because
 * `JSON.stringify` hides a secret behind its own quoting. The walk is depth limited
 * and cycle safe.
 */
export function redactValue(value: unknown): unknown {
  return walk(value, 0, new WeakSet())
}

/** Shortens text to `max` characters and reports how much was dropped. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…[truncated ${text.length - max} chars]`
}
