import { describe, expect, it } from "bun:test"
import { capText, redactSecrets, redactValue } from "../src/redact.js"

const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"

it("redacts a bearer token", () => {
  expect(redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwx")).toBe(
    "Authorization: [REDACTED:bearer]",
  )
})

it("keeps a short bearer value", () => {
  const text = "Authorization: Bearer short"
  expect(redactSecrets(text)).toBe(text)
})

it.each([
  ["sk-abcdefghijklmnopqrstuvwx"],
  ["sk-ant-api03-abcdefghijklmnopqrst"],
  ["ghp_abcdefghijklmnopqrstuvwxyz0123"],
  ["gho_abcdefghijklmnopqrstuvwxyz0123"],
  ["ghu_abcdefghijklmnopqrstuvwxyz0123"],
  ["github_pat_11ABCDEFG0abcdefghijklmnop"],
  ["xoxb-1234567890-abcdefghij"],
  ["xoxp-1234567890-abcdefghij"],
  ["xoxa-1234567890-abcdefghij"],
  ["AKIAIOSFODNN7EXAMPLE"],
  [`AIza${"b".repeat(35)}`],
])("redacts the api key %p", (secret) => {
  expect(redactSecrets(`value ${secret} end`)).toBe("value [REDACTED:api-key] end")
})

it.each([["sk-"], ["ghp_short"], ["AKIA123"], ["a normal sentence about a secret garden"]])(
  "keeps %p",
  (text) => {
    expect(redactSecrets(text)).toBe(text)
  },
)

it("redacts a json web token", () => {
  expect(redactSecrets(`token is ${JWT} ok`)).toBe("token is [REDACTED:jwt] ok")
})

it("redacts a private key block", () => {
  const text = ["prefix", "-----BEGIN RSA PRIVATE KEY-----", "AAAA", "BBBB", "-----END RSA PRIVATE KEY-----", "suffix"].join("\n")
  expect(redactSecrets(text)).toBe("prefix\n[REDACTED:private-key]\nsuffix")
})

it("redacts credentials inside a url", () => {
  expect(redactSecrets("clone https://alice:hunter2secret@git.example.com/repo.git")).toBe(
    "clone https://[REDACTED:url-credentials]@git.example.com/repo.git",
  )
})

it("keeps a url without credentials", () => {
  expect(redactSecrets("http://host/path")).toBe("http://host/path")
})

it.each([
  ["API_KEY=abcdefghijkl", "API_KEY=[REDACTED:assignment]"],
  ["api-key: abcdefghijkl", "api-key: [REDACTED:assignment]"],
  ['password = "hunter2"', "password = [REDACTED:assignment]"],
  ["token: 'abc'", "token: [REDACTED:assignment]"],
  ["Secret=abcdefghijkl", "Secret=[REDACTED:assignment]"],
  ["pwd=abcdefghijkl", "pwd=[REDACTED:assignment]"],
])("redacts the assignment %p", (input, expected) => {
  expect(redactSecrets(input)).toBe(expected)
})

it("keeps a short unquoted assignment value", () => {
  expect(redactSecrets("token=abc")).toBe("token=abc")
})

it("keeps a word that only contains an option name", () => {
  expect(redactSecrets("Authorization header is required")).toBe("Authorization header is required")
})

it.each([
  ["Cookie: session=abc123; other=def", "Cookie: [REDACTED:cookie]"],
  ["Set-Cookie: sid=xyz; Path=/", "Set-Cookie: [REDACTED:cookie]"],
])("redacts the header %p", (input, expected) => {
  expect(redactSecrets(input)).toBe(expected)
})

it("is idempotent", () => {
  const text = [
    "Authorization: Bearer abcdefghijklmnopqrstuvwx",
    "key sk-abcdefghijklmnopqrstuvwx",
    `jwt ${JWT}`,
    "https://alice:hunter2secret@git.example.com/repo.git",
    "password = 'hunter2'",
    "Cookie: session=abc123",
    "-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----",
  ].join("\n")
  const once = redactSecrets(text)
  expect(redactSecrets(once)).toBe(once)
})

it("leaves an existing marker alone", () => {
  expect(redactSecrets("token: [REDACTED:assignment]")).toBe("token: [REDACTED:assignment]")
})

it("keeps text at the cap", () => {
  expect(capText("abcde", 5)).toBe("abcde")
})

it("truncates text over the cap", () => {
  expect(capText("abcdef", 5)).toBe("abcde…[truncated 1 chars]")
})

it("reports the number of dropped characters", () => {
  expect(capText("a".repeat(20), 4)).toBe("aaaa…[truncated 16 chars]")
})

it("redacts a secret inside JSON-shaped text", () => {
  expect(redactSecrets('{"password":"hunter2000-plaintext"}')).toBe(
    '{"password":[REDACTED:assignment]}',
  )
})

it("redacts a secret inside double-encoded JSON text", () => {
  const text = '{"files":{"/p/.env":"+ {\\"password\\":\\"x\\"}"}}'
  const redacted = redactSecrets(text)
  expect(redacted).not.toContain('\\"x\\"')
  expect(redacted).toContain("[REDACTED:assignment]")
})

it.each([
  ['{"aws_secret_access_key":"abcdefghijklmnop"}'],
  ['{"client_secret":"abcdefghijklmnop"}'],
  ['{"private_key":"abcdefghijklmnop"}'],
  ['{"credential":"abcdefghijklmnop"}'],
  ['{"session_key":"abcdefghijklmnop"}'],
  ['{"authorization":"abcdefghijklmnop"}'],
])("redacts the JSON assignment %p", (text) => {
  expect(redactSecrets(text)).toContain("[REDACTED:assignment]")
  expect(redactSecrets(text)).not.toContain("abcdefghijklmnop")
})

it.each([
  ["auth: required"],
  ["auth = optional"],
  ['{"auth":"bearer"}'],
  ['{"auth":"basic"}'],
  ['{"token":"none"}'],
  ['{"secret":"null"}'],
  ['{"password":"true"}'],
  ['{"password":"false"}'],
])("keeps the plain word in %p", (text) => {
  expect(redactSecrets(text)).toBe(text)
})

it.each([
  ["sk_live_abcdefghij012345"],
  ["sk_test_abcdefghij012345"],
  ["rk_live_abcdefghij012345"],
  ["glpat-abcdefghij012345"],
  [`npm_${"a".repeat(30)}`],
  [`pypi-${"a".repeat(30)}`],
  ["SG.abcdefghij012345.abcdefghij012345"],
  ["https://hooks.slack.com/services/T00000000/B00000000/abcdefghijkl"],
])("redacts the api key %p", (secret) => {
  expect(redactSecrets(`value ${secret} end`)).toBe("value [REDACTED:api-key] end")
})

it("redacts a private key block that has no end marker", () => {
  const text = "prefix\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB"
  expect(redactSecrets(text)).toBe("prefix\n[REDACTED:private-key]")
})

it("stays linear on a long run of one character", () => {
  const started = performance.now()
  redactSecrets("a".repeat(200000))
  expect(performance.now() - started).toBeLessThan(100)
})

it("stays linear on a long run of spaces after a keyword", () => {
  const started = performance.now()
  redactSecrets(`token:${" ".repeat(200000)}`)
  expect(performance.now() - started).toBeLessThan(100)
})

it("still redacts credentials in a url after the bound", () => {
  expect(redactSecrets("https://user:pw@host/x")).toBe("https://[REDACTED:url-credentials]@host/x")
})

it("is idempotent over the added rules", () => {
  const text = [
    '{"password":"hunter2000-plaintext"}',
    "sk_live_abcdefghij012345",
    "glpat-abcdefghij012345",
    "SG.abcdefghij012345.abcdefghij012345",
    "https://hooks.slack.com/services/T00000000/B00000000/abcdefghijkl",
    "https://user:pw@host/x",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA",
  ].join("\n")
  const once = redactSecrets(text)
  expect(redactSecrets(once)).toBe(once)
})

it("redacts a secret object key whatever the value looks like", () => {
  expect(redactValue({ password: "hunter2000-plaintext" })).toEqual({ password: "[REDACTED:key]" })
  expect(redactValue({ apiKey: "short" })).toEqual({ apiKey: "[REDACTED:key]" })
  expect(redactValue({ stripeSecret: 1 })).toEqual({ stripeSecret: "[REDACTED:key]" })
  expect(redactValue({ accessToken: ["a"] })).toEqual({ accessToken: "[REDACTED:key]" })
})

it("redacts a nested secret key", () => {
  expect(redactValue({ outer: { inner: { apiKey: "x" } } })).toEqual({
    outer: { inner: { apiKey: "[REDACTED:key]" } },
  })
})

it("leaves a key that is not a secret alone", () => {
  const value = { title: "push", files: ["a.ts"], count: 3, ok: true, nothing: null }
  expect(redactValue(value)).toEqual(value)
})

it("redacts secrets inside every string value", () => {
  expect(redactValue({ note: "key sk-abcdefghijklmnopqrstuvwx" })).toEqual({
    note: "key [REDACTED:api-key]",
  })
})

it("stops at the depth limit", () => {
  let nested: Record<string, unknown> = { apiKey: "x" }
  for (let index = 0; index < 40; index++) nested = { down: nested }
  expect(JSON.stringify(redactValue(nested))).toContain("[REDACTED:depth]")
})

it("survives a cycle", () => {
  const value: Record<string, unknown> = { name: "root" }
  value.self = value
  expect(redactValue(value)).toEqual({ name: "root", self: "[REDACTED:cycle]" })
})

describe("redactValue key matching", () => {
  it("compares key words whole, so author is not auth", () => {
    expect(redactValue({ author: "D", authorName: "x", keyboard: "kb", monkey: "m" })).toEqual({
      author: "D",
      authorName: "x",
      keyboard: "kb",
      monkey: "m",
    })
  })

  it("still redacts qualified key names", () => {
    expect(redactValue({ apiKey: "a", session_key: "b", accessToken: "c", stripeSecret: "d" })).toEqual({
      apiKey: "[REDACTED:key]",
      session_key: "[REDACTED:key]",
      accessToken: "[REDACTED:key]",
      stripeSecret: "[REDACTED:key]",
    })
  })
})
