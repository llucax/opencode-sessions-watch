import { afterEach, describe, expect, test } from "bun:test"
import { createWatcher, toOptions } from "../sessions-toast.tsx"
import { createFakeApi, createFakeClock, flush } from "./fake-api.ts"
import type { Session } from "@opencode-ai/sdk/v2"

// raiseBlocked, raiseOwn, related and chainOf are not exposed directly; they
// are reached through the event stream, the same way the real TUI reaches
// them, and observed through what lands in fake.toasts and fake.navigations.

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    slug: id,
    projectID: "prj_1",
    directory: "/tmp/project",
    title: `Session ${id}`,
    version: "1",
    time: { created: 0, updated: 0 },
    ...overrides,
  }
}

let disposers: Array<() => void> = []

afterEach(() => {
  for (const dispose of disposers) dispose()
  disposers = []
})

async function start(fake: ReturnType<typeof createFakeApi>) {
  const watcher = createWatcher(fake.api, toOptions(undefined))
  const { clock } = createFakeClock()
  watcher.start(clock)
  disposers.push(watcher.dispose)
  await flush()
  return watcher
}

function askPermission(fake: ReturnType<typeof createFakeApi>, sessionID: string, requestID = "req1") {
  fake.emit({
    id: "e",
    type: "permission.asked",
    properties: { id: requestID, sessionID, permission: "bash", patterns: [], metadata: {}, always: [] },
  })
}

describe("chainOf, via raiseBlocked", () => {
  test("stays quiet on a session the TUI does not know", async () => {
    const fake = createFakeApi()
    const watcher = await start(fake)
    askPermission(fake, "ghost")
    expect(fake.toasts).toEqual([])
  })

  test("stays quiet on a parentID cycle", async () => {
    const fake = createFakeApi()
    fake.sessions.set("a", session("a", { parentID: "b" }))
    fake.sessions.set("b", session("b", { parentID: "a" }))
    const watcher = await start(fake)
    askPermission(fake, "a")
    expect(fake.toasts).toEqual([])
  })
})

describe("raiseBlocked", () => {
  test("attributes a subagent's permission to its root", async () => {
    const fake = createFakeApi()
    fake.sessions.set("root", session("root", { title: "Root task" }))
    fake.sessions.set("child", session("child", { parentID: "root" }))
    const watcher = await start(fake)

    askPermission(fake, "child")
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]!.title).toBe("Root task")
    expect(fake.toasts[0]!.message).toBe("A subagent needs permission")

    // goto() jumps to the root, since that is what was actually queued.
    watcher.goto()
    expect(fake.navigations).toEqual([{ name: "session", params: { sessionID: "root" } }])
  })

  test("names it plainly when the session itself is not a subagent", async () => {
    const fake = createFakeApi()
    fake.sessions.set("solo", session("solo"))
    const watcher = await start(fake)

    askPermission(fake, "solo")
    expect(fake.toasts[0]!.message).toBe("Needs permission")
  })

  test("suppresses when the current route is anywhere in the chain", async () => {
    const fake = createFakeApi()
    fake.sessions.set("root", session("root"))
    fake.sessions.set("child", session("child", { parentID: "root" }))

    // Watching the root while the child asks.
    fake.setRoute({ name: "session", params: { sessionID: "root" } })
    const watcher = await start(fake)
    askPermission(fake, "child", "req1")
    expect(fake.toasts).toEqual([])

    // Watching the child itself while it asks again.
    fake.setRoute({ name: "session", params: { sessionID: "child" } })
    askPermission(fake, "child", "req2")
    expect(fake.toasts).toEqual([])

    // Watching neither: the toast gets through.
    fake.setRoute({ name: "home" })
    askPermission(fake, "child", "req3")
    expect(fake.toasts).toHaveLength(1)
  })
})

describe("raiseOwn", () => {
  test("drops a subagent's own idle/error/retry, which is its parent's business", async () => {
    const fake = createFakeApi()
    fake.sessions.set("child", session("child", { parentID: "root" }))
    const watcher = await start(fake)

    fake.emit({ id: "e1", type: "session.status", properties: { sessionID: "child", status: { type: "busy" } } })
    fake.emit({
      id: "e2",
      type: "session.error",
      properties: { sessionID: "child", error: { name: "UnknownError" } as never },
    })
    expect(fake.toasts).toEqual([])
  })

  test("suppresses a root session's own trigger while it, or its subtree, is being watched", async () => {
    const fake = createFakeApi()
    fake.sessions.set("root", session("root"))
    fake.setRoute({ name: "session", params: { sessionID: "root" } })
    const watcher = await start(fake)

    fake.emit({ id: "e1", type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } })
    fake.emit({
      id: "e2",
      type: "session.error",
      properties: { sessionID: "root", error: { name: "UnknownError" } as never },
    })
    expect(fake.toasts).toEqual([])
  })

  test("raises when nothing related is being watched", async () => {
    const fake = createFakeApi()
    fake.sessions.set("root", session("root"))
    fake.setRoute({ name: "home" })
    const watcher = await start(fake)

    fake.emit({ id: "e1", type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } })
    fake.emit({
      id: "e2",
      type: "session.error",
      properties: { sessionID: "root", error: { name: "UnknownError" } as never },
    })
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]!.variant).toBe("error")
  })
})
