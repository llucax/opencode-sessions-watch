import { afterEach, describe, expect, test } from "bun:test"
import { createWatcher, toOptions } from "../sessions-toast.tsx"
import { createFakeApi, createFakeClock, flush } from "./fake-api.ts"
import type { Session } from "@opencode-ai/sdk/v2"

// The queue (show/purge/advance/attend/expire) is not exposed directly; it is
// driven the same way the real TUI drives it, through the event stream, and
// through time via the fake clock start() accepts. Bun's setSystemTime moves
// Date.now() but does not drive setTimeout, so every timing case here goes
// through clock.advance() rather than a real sleep.

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    slug: id,
    projectID: "prj_1",
    directory: "/tmp/project",
    title: id,
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
  const { clock, advance } = createFakeClock()
  watcher.start(clock)
  disposers.push(watcher.dispose)
  await flush()
  return { watcher, advance }
}

function askPermission(fake: ReturnType<typeof createFakeApi>, sessionID: string, requestID: string) {
  fake.emit({
    id: "e",
    type: "permission.asked",
    properties: { id: requestID, sessionID, permission: "bash", patterns: [], metadata: {}, always: [] },
  })
}

describe("error suppressing the idle that follows it", () => {
  test("a session that errors and then goes idle is not also announced as finished", async () => {
    const fake = createFakeApi()
    fake.sessions.set("a", session("a"))
    const { watcher } = await start(fake)

    fake.emit({ id: "e1", type: "session.status", properties: { sessionID: "a", status: { type: "busy" } } })
    fake.emit({
      id: "e2",
      type: "session.error",
      properties: { sessionID: "a", error: { name: "UnknownError" } as never },
    })
    fake.emit({ id: "e3", type: "session.idle", properties: { sessionID: "a" } })

    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]!.variant).toBe("error")
  })
})

describe("hygiene: one entry per session", () => {
  test("a second arrival for a still-queued session replaces it in place", async () => {
    const fake = createFakeApi()
    fake.sessions.set("a", session("a"))
    fake.sessions.set("b", session("b"))
    fake.sessions.set("c", session("c"))
    const { watcher, advance } = await start(fake)

    askPermission(fake, "a", "a1") // shown immediately
    askPermission(fake, "b", "b1") // queued
    askPermission(fake, "c", "c1") // queued behind b
    expect(fake.toasts).toHaveLength(1)

    // b asks again under a new request id before its first is answered; the
    // stale request id must no longer control the queued entry.
    askPermission(fake, "b", "b2")
    fake.emit({ id: "e", type: "permission.replied", properties: { sessionID: "b", requestID: "b1", reply: "once" } })

    advance(5_000) // a's full-duration timer expires
    // b, not c, is next: replacing in place did not move it to the back.
    expect(fake.toasts).toHaveLength(2)
    expect(fake.toasts[1]!.title).toBe("b")

    // The live request id still controls it.
    fake.emit({ id: "e", type: "permission.replied", properties: { sessionID: "b", requestID: "b2", reply: "once" } })
    advance(2_500) // b's half-duration timer expires
    expect(fake.toasts).toHaveLength(3)
    expect(fake.toasts[2]!.title).toBe("c")
  })
})

describe("hygiene: dropped entries", () => {
  test("a queued entry is dropped once its permission is replied to", async () => {
    const fake = createFakeApi()
    fake.sessions.set("a", session("a"))
    fake.sessions.set("b", session("b"))
    const { watcher, advance } = await start(fake)

    askPermission(fake, "a", "a1")
    askPermission(fake, "b", "b1")
    fake.emit({ id: "e", type: "permission.replied", properties: { sessionID: "b", requestID: "b1", reply: "once" } })

    advance(5_000) // a's timer expires; the queue should already be empty
    expect(fake.toasts).toHaveLength(1)
  })

  test("a queued entry is dropped once its session is navigated to", async () => {
    const fake = createFakeApi()
    fake.sessions.set("a", session("a"))
    fake.sessions.set("b", session("b"))
    const { watcher, advance } = await start(fake)

    askPermission(fake, "a", "a1")
    askPermission(fake, "b", "b1")
    fake.setRoute({ name: "session", params: { sessionID: "b" } })

    advance(5_000) // purge() runs as part of advancing past a's toast
    expect(fake.toasts).toHaveLength(1)
  })
})

describe("aggregation at maxToasts", () => {
  test("three simultaneous events still give three named toasts", async () => {
    const fake = createFakeApi()
    for (const id of ["a", "b", "c"]) fake.sessions.set(id, session(id))
    const { watcher, advance } = await start(fake)

    askPermission(fake, "a", "a1")
    askPermission(fake, "b", "b1")
    askPermission(fake, "c", "c1")

    advance(5_000) // a's full duration
    advance(2_500) // b's half duration

    expect(fake.toasts.map((t) => t.title)).toEqual(["a", "b", "c"])
    expect(fake.toasts.every((t) => t.message !== undefined && !t.message.includes("sessions need attention"))).toBe(true)
  })

  test("four give two named toasts and an aggregate of two, at the default maxToasts of 2", async () => {
    const fake = createFakeApi()
    for (const id of ["a", "b", "c", "d"]) fake.sessions.set(id, session(id))
    const { watcher, advance } = await start(fake)

    askPermission(fake, "a", "a1")
    askPermission(fake, "b", "b1")
    askPermission(fake, "c", "c1")
    askPermission(fake, "d", "d1")

    advance(5_000) // a's full duration
    advance(2_500) // b's half duration: shown === maxToasts and 2 remain, so c+d aggregate

    expect(fake.toasts).toHaveLength(3)
    expect(fake.toasts.map((t) => t.title)).toEqual(["a", "b", "2 sessions need attention"])
    expect(fake.toasts[2]!.message).toContain("c")
    expect(fake.toasts[2]!.message).toContain("d")
  })
})

describe("durations", () => {
  test("the first toast of a run gets the full duration, queued ones get half", async () => {
    const fake = createFakeApi()
    fake.sessions.set("a", session("a"))
    fake.sessions.set("b", session("b"))
    const { watcher, advance } = await start(fake)

    askPermission(fake, "a", "a1")
    askPermission(fake, "b", "b1")
    expect(fake.toasts[0]!.duration).toBe(5_000)

    advance(5_000)
    expect(fake.toasts[1]!.duration).toBe(2_500)
  })
})

describe("retry", () => {
  test("toasts only after retryAfter, attributing it to the session", async () => {
    const fake = createFakeApi()
    fake.sessions.set("a", session("a"))
    fake.statuses.set("a", { type: "retry", attempt: 1, message: "", next: 0 })
    const { watcher, advance } = await start(fake)

    fake.emit({
      id: "e1",
      type: "session.status",
      properties: { sessionID: "a", status: { type: "retry", attempt: 1, message: "", next: 0 } },
    })

    advance(29_999)
    expect(fake.toasts).toEqual([])

    advance(1)
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]!.message).toBe("Still retrying")
  })

  test("never toasts if the session recovers before retryAfter", async () => {
    const fake = createFakeApi()
    fake.sessions.set("a", session("a"))
    const { watcher, advance } = await start(fake)

    fake.emit({
      id: "e1",
      type: "session.status",
      properties: { sessionID: "a", status: { type: "retry", attempt: 1, message: "", next: 0 } },
    })
    // Recovers back to busy, not idle, so this is purely about the retry
    // timer being cancelled rather than about the idle-after-error rule.
    fake.emit({ id: "e2", type: "session.status", properties: { sessionID: "a", status: { type: "busy" } } })

    advance(30_000)
    expect(fake.toasts).toEqual([])
  })
})
