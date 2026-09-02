import { expect, it } from "bun:test"
import { createCorrelationStore } from "../src/correlation.js"

it("returns the entry that was stored", () => {
  const store = createCorrelationStore()
  store.set("call-1", { tool: "edit", input: { file: "a.ts" }, sessionID: "s1" })
  expect(store.take("call-1")).toEqual({ tool: "edit", input: { file: "a.ts" } })
})

it("returns the entry only once", () => {
  const store = createCorrelationStore()
  store.set("call-1", { tool: "edit", input: {}, sessionID: "s1" })
  store.take("call-1")
  expect(store.take("call-1")).toBeUndefined()
  expect(store.size()).toBe(0)
})

it("returns undefined for an unknown or missing id", () => {
  const store = createCorrelationStore()
  expect(store.take("call-1")).toBeUndefined()
  expect(store.take(undefined)).toBeUndefined()
})

it("keeps only the newest entries", () => {
  const store = createCorrelationStore({ max: 2 })
  store.set("call-1", { tool: "read", input: 1, sessionID: "s1" })
  store.set("call-2", { tool: "read", input: 2, sessionID: "s1" })
  store.set("call-3", { tool: "read", input: 3, sessionID: "s1" })
  expect(store.size()).toBe(2)
  expect(store.take("call-1")).toBeUndefined()
  expect(store.take("call-3")).toEqual({ tool: "read", input: 3 })
})

it("drops an entry after the time to live", () => {
  let now = 1000
  const store = createCorrelationStore({ ttlMs: 500, now: () => now })
  store.set("call-1", { tool: "read", input: 1, sessionID: "s1" })
  now = 1400
  expect(store.take("call-1")).toEqual({ tool: "read", input: 1 })

  store.set("call-2", { tool: "read", input: 2, sessionID: "s1" })
  now = 2000
  expect(store.take("call-2")).toBeUndefined()
})

it("drops expired entries when a new one is stored", () => {
  let now = 1000
  const store = createCorrelationStore({ ttlMs: 500, now: () => now })
  store.set("call-1", { tool: "read", input: 1, sessionID: "s1" })
  now = 2000
  store.set("call-2", { tool: "read", input: 2, sessionID: "s1" })
  expect(store.size()).toBe(1)
})

it("attaches the shell command to the oldest pending shell entry", () => {
  const store = createCorrelationStore()
  store.set("call-1", { tool: "shell", input: 1, sessionID: "s1" })
  store.set("call-2", { tool: "shell", input: 2, sessionID: "s1" })
  store.attachShell("s1", { command: "ls", cwd: "/work" })
  expect(store.take("call-1")).toEqual({ tool: "shell", input: 1, shell: { command: "ls", cwd: "/work" } })
  expect(store.take("call-2")).toEqual({ tool: "shell", input: 2 })
})

it("attaches two parallel shell commands in call order", () => {
  const store = createCorrelationStore()
  store.set("call-a", { tool: "shell", input: "a", sessionID: "s1" })
  store.set("call-b", { tool: "shell", input: "b", sessionID: "s1" })
  store.attachShell("s1", { command: "first", cwd: "/work" })
  store.attachShell("s1", { command: "second", cwd: "/work" })
  expect(store.take("call-a")).toEqual({ tool: "shell", input: "a", shell: { command: "first", cwd: "/work" } })
  expect(store.take("call-b")).toEqual({ tool: "shell", input: "b", shell: { command: "second", cwd: "/work" } })
})

it("skips an entry that already has a shell command", () => {
  const store = createCorrelationStore()
  store.set("call-1", { tool: "shell", input: 1, sessionID: "s1" })
  store.attachShell("s1", { command: "first", cwd: "/work" })
  store.attachShell("s1", { command: "second", cwd: "/work" })
  expect(store.take("call-1")).toEqual({ tool: "shell", input: 1, shell: { command: "first", cwd: "/work" } })
})

it("ignores entries from another session", () => {
  const store = createCorrelationStore()
  store.set("call-1", { tool: "shell", input: 1, sessionID: "s1" })
  store.set("call-2", { tool: "shell", input: 2, sessionID: "s2" })
  store.attachShell("s1", { command: "ls", cwd: "/work" })
  expect(store.take("call-2")).toEqual({ tool: "shell", input: 2 })
  expect(store.take("call-1")).toEqual({ tool: "shell", input: 1, shell: { command: "ls", cwd: "/work" } })
})

it("ignores entries from another tool", () => {
  const store = createCorrelationStore()
  store.set("call-1", { tool: "edit", input: 1, sessionID: "s1" })
  store.attachShell("s1", { command: "ls", cwd: "/work" })
  expect(store.take("call-1")).toEqual({ tool: "edit", input: 1 })
})

it("does nothing when no shell entry is pending", () => {
  const store = createCorrelationStore()
  expect(() => store.attachShell("s1", { command: "ls", cwd: "/work" })).not.toThrow()
  expect(store.size()).toBe(0)
})

it("attaches to the oldest pending shell entry in any session when no session is given", () => {
  const store = createCorrelationStore()
  store.set("call-1", { tool: "shell", input: 1, sessionID: "s1" })
  store.set("call-2", { tool: "shell", input: 2, sessionID: "s2" })
  store.attachShell(undefined, { command: "ls", cwd: "/work" })
  expect(store.take("call-1")).toEqual({ tool: "shell", input: 1, shell: { command: "ls", cwd: "/work" } })
  expect(store.take("call-2")).toEqual({ tool: "shell", input: 2 })
})
