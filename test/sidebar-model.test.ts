import { afterEach, describe, expect, test } from "bun:test"
import { createModel, toOptions } from "../sessions-sidebar.tsx"
import { createFakeApi, createFakeClock, flush } from "./fake-api.ts"
import type { Session } from "@opencode-ai/sdk/v2"

// createModel()'s own logic (derive, sync, upsert, remove) is not exposed
// directly; it is reached the same way the real TUI reaches it, through the
// event stream a fake TuiPluginApi captures, now that start() can be called
// with a fake clock instead of the network and real timers.

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
  const model = createModel(fake.api, toOptions(undefined))
  const { clock } = createFakeClock()
  model.start(clock)
  disposers.push(model.dispose)
  // Lets the initial resync() finish (list/status/permission/question all
  // resolve on microtasks) before the test starts firing events of its own,
  // so it never races resync()'s pending.clear().
  await flush()
  return model
}

describe("derive, via the event stream", () => {
  test("a pending request outranks busy and retry", async () => {
    const fake = createFakeApi()
    const model = await start(fake)

    fake.emit({
      id: "e1",
      type: "session.created",
      properties: { sessionID: "a", info: session("a") },
    })
    fake.emit({
      id: "e2",
      type: "session.status",
      properties: { sessionID: "a", status: { type: "retry", attempt: 1, message: "", next: 0 } },
    })
    expect(model.stateOf("a")).toBe("retry")

    fake.emit({
      id: "e3",
      type: "permission.asked",
      properties: { id: "req1", sessionID: "a", permission: "bash", patterns: [], metadata: {}, always: [] },
    })
    // Still reported as retry underneath, but waiting on you takes priority.
    expect(model.stateOf("a")).toBe("waiting")
  })
})

describe("sync, via the event stream", () => {
  test("stamps since only on an actual state change", async () => {
    const fake = createFakeApi()
    const model = await start(fake)

    fake.emit({
      id: "e1",
      type: "session.created",
      properties: { sessionID: "a", info: session("a", { time: { created: 0, updated: 12_345 } }) },
    })
    // Met for the first time already idle, so dated from time.updated rather
    // than from the moment the plugin noticed it.
    expect(model.stateOf("a")).toBe("idle")
    expect(model.sinceOf("a", -1)).toBe(12_345)

    // An update that does not change the derived state must not restamp it.
    fake.emit({
      id: "e2",
      type: "session.updated",
      properties: { sessionID: "a", info: session("a", { title: "renamed", time: { created: 0, updated: 99_999 } }) },
    })
    expect(model.stateOf("a")).toBe("idle")
    expect(model.sinceOf("a", -1)).toBe(12_345)

    // A real state change does restamp it, off the wall clock rather than
    // session.time.updated.
    fake.emit({
      id: "e3",
      type: "session.status",
      properties: { sessionID: "a", status: { type: "busy" } },
    })
    expect(model.stateOf("a")).toBe("working")
    expect(model.sinceOf("a", -1)).not.toBe(12_345)
  })
})

describe("upsert, via the event stream", () => {
  test("rejects a session from another project once the project id is known", async () => {
    const fake = createFakeApi()
    fake.responses.sessionList = [session("known", { projectID: "prj_1" })]
    const model = await start(fake)
    expect(model.sessions().map((s) => s.id)).toEqual(["known"])

    fake.emit({
      id: "e1",
      type: "session.created",
      properties: { sessionID: "foreign", info: session("foreign", { projectID: "prj_2" }) },
    })
    expect(model.sessions().map((s) => s.id)).toEqual(["known"])

    fake.emit({
      id: "e2",
      type: "session.created",
      properties: { sessionID: "local", info: session("local", { projectID: "prj_1" }) },
    })
    expect(model.sessions().map((s) => s.id).sort()).toEqual(["known", "local"])
  })
})

describe("remove, via the event stream", () => {
  test("clears status, pending and tracking together", async () => {
    const fake = createFakeApi()
    const model = await start(fake)

    fake.emit({
      id: "e1",
      type: "session.created",
      properties: { sessionID: "a", info: session("a") },
    })
    fake.emit({
      id: "e2",
      type: "permission.asked",
      properties: { id: "req1", sessionID: "a", permission: "bash", patterns: [], metadata: {}, always: [] },
    })
    expect(model.stateOf("a")).toBe("waiting")

    fake.emit({
      id: "e3",
      type: "session.deleted",
      properties: { sessionID: "a", info: session("a") },
    })
    expect(model.sessions().map((s) => s.id)).toEqual([])
    // No tracked entry left, so stateOf falls back to idle rather than
    // remembering "waiting".
    expect(model.stateOf("a")).toBe("idle")

    // Replying to the permission after the session is gone must not resurrect
    // it via the pending map.
    fake.emit({
      id: "e4",
      type: "permission.replied",
      properties: { sessionID: "a", requestID: "req1", reply: "once" },
    })
    expect(model.stateOf("a")).toBe("idle")
  })
})
