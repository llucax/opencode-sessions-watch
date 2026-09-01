import { describe, expect, test } from "bun:test"
import { grouped, order, select, tasksOf, toOptions, toRow } from "../sessions-sidebar.tsx"
import type { Session } from "@opencode-ai/sdk/v2"

// select() takes plain data and a structural model, so it is tested directly
// against a fake shaped like createModel()'s return value, with no need to
// exercise the model's own event wiring (that is sidebar-model.test.ts).
type TrackedState = "waiting" | "retry" | "working" | "idle"

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

function makeModel(params: {
  sessions: Session[]
  states?: Record<string, TrackedState>
  since?: Record<string, number>
  now?: number
  options?: Record<string, unknown>
}) {
  const states = params.states ?? {}
  const since = params.since ?? {}
  return {
    options: toOptions(params.options),
    sessions: () => params.sessions,
    now: () => params.now ?? 0,
    revision: () => 0,
    dispose: () => {},
    stateOf: (sessionID: string): TrackedState => states[sessionID] ?? "idle",
    sinceOf: (sessionID: string, fallback: number): number => since[sessionID] ?? fallback,
  }
}

describe("toRow", () => {
  test("classifies a recently idle session as idleFresh", () => {
    const model = makeModel({
      sessions: [],
      states: { a: "idle" },
      since: { a: 1_000 },
      now: 1_000 + 60_000,
      options: { idleFreshAge: "15m" },
    })
    const row = toRow(model, session("a"), model.now(), false, 0)
    expect(row.state).toBe("idleFresh")
  })

  test("classifies a session idle past idleFreshAge as idle", () => {
    const model = makeModel({
      sessions: [],
      states: { a: "idle" },
      since: { a: 0 },
      now: 20 * 60_000,
      options: { idleFreshAge: "15m" },
    })
    const row = toRow(model, session("a"), model.now(), false, 0)
    expect(row.state).toBe("idle")
  })

  test.each(["waiting", "retry", "working"] as const)("leaves a %s row alone regardless of age", (state) => {
    const model = makeModel({
      sessions: [],
      states: { a: state },
      since: { a: 0 },
      now: 60 * 60_000,
    })
    const row = toRow(model, session("a"), model.now(), false, 0)
    expect(row.state).toBe(state)
  })
})

describe("order", () => {
  const rows = [
    { id: "a", title: "a", state: "idle" as const, since: 100, current: false, depth: 0 },
    { id: "b", title: "b", state: "idle" as const, since: 300, current: false, depth: 0 },
    { id: "c", title: "c", state: "idle" as const, since: 200, current: false, depth: 0 },
  ]

  test("idle groups sort most recently stopped first", () => {
    expect(order("idle", [...rows]).map((r) => r.id)).toEqual(["b", "c", "a"])
    const fresh = rows.map((r) => ({ ...r, state: "idleFresh" as const }))
    expect(order("idleFresh", fresh).map((r) => r.id)).toEqual(["b", "c", "a"])
  })

  test("other groups sort longest in state first", () => {
    const working = rows.map((r) => ({ ...r, state: "working" as const }))
    expect(order("working", working).map((r) => r.id)).toEqual(["a", "c", "b"])
  })
})

describe("grouped", () => {
  test("puts rows into display order regardless of input order", () => {
    const rows = [
      { id: "i", title: "i", state: "idle" as const, since: 0, current: false, depth: 0 },
      { id: "w", title: "w", state: "waiting" as const, since: 0, current: false, depth: 0 },
      { id: "r", title: "r", state: "retry" as const, since: 0, current: false, depth: 0 },
    ]
    expect(grouped(rows).map((r) => r.id)).toEqual(["w", "r", "i"])
  })
})

describe("select", () => {
  test("groups roots in waiting, idleFresh, retry, working, idle order", () => {
    const model = makeModel({
      sessions: [session("w"), session("r"), session("k"), session("i")],
      states: { w: "waiting", r: "retry", k: "working", i: "idle" },
      since: { w: 0, r: 0, k: 0, i: 0 },
      now: 24 * 60 * 60 * 1000, // long past idleFreshAge, so i is plain idle
    })
    expect(select(model, "none").map((row) => row.id)).toEqual(["w", "r", "k", "i"])
  })

  test("hides subagents by default", () => {
    const model = makeModel({
      sessions: [session("root"), session("child", { parentID: "root" })],
      states: { root: "working", child: "working" },
    })
    expect(select(model, "none").map((row) => row.id)).toEqual(["root"])
  })

  test("shows only the current session's children in tree mode", () => {
    const model = makeModel({
      sessions: [
        session("current"),
        session("child-of-current", { parentID: "current" }),
        session("other"),
        session("child-of-other", { parentID: "other" }),
      ],
      states: { current: "working", "child-of-current": "working", other: "working", "child-of-other": "working" },
      options: { subagents: "tree" },
    })
    const rows = select(model, "current")
    // showCurrent is forced on in tree mode, so "current" itself is pinned
    // first, followed by its own child; "other" is a root, and its child is
    // excluded because tree mode only follows the session being viewed.
    expect(rows.map((row) => row.id)).toEqual(["current", "child-of-current", "other"])
  })

  test("shows every session's children in all-tree mode", () => {
    const model = makeModel({
      sessions: [session("root"), session("child", { parentID: "root" })],
      states: { root: "working", child: "working" },
      options: { subagents: "all-tree" },
    })
    expect(select(model, "none").map((row) => row.id)).toEqual(["root", "child"])
  })

  test("excludes the current session by default", () => {
    const model = makeModel({
      sessions: [session("current"), session("other")],
      states: { current: "working", other: "working" },
    })
    expect(select(model, "current").map((row) => row.id)).toEqual(["other"])
  })

  test("pins the current session above every group when showCurrent is set", () => {
    const model = makeModel({
      sessions: [session("current"), session("waiting")],
      states: { current: "idle", waiting: "waiting" },
      since: { current: 0 },
      now: 24 * 60 * 60 * 1000, // current would otherwise be filtered by idleMaxAge
      options: { showCurrent: true },
    })
    const rows = select(model, "current")
    expect(rows[0]!.id).toBe("current")
    expect(rows[0]!.current).toBe(true)
    expect(rows.map((r) => r.id)).toEqual(["current", "waiting"])
  })

  test("filters idleFresh rows older than idleMaxAge", () => {
    const model = makeModel({
      sessions: [session("a")],
      states: { a: "idle" },
      since: { a: 0 },
      now: 30_000,
      options: { idleFreshAge: "1h", idleMaxAge: "10s" },
    })
    expect(select(model, "none")).toEqual([])
  })

  test("always shows the alwaysShowIdle most recent idle rows regardless of age", () => {
    const model = makeModel({
      sessions: [session("old")],
      states: { old: "idle" },
      since: { old: 0 },
      now: 10 * 60 * 60 * 1000,
      options: { idleFreshAge: "0ms", idleMaxAge: "1m", alwaysShowIdle: 1 },
    })
    expect(select(model, "none").map((row) => row.id)).toEqual(["old"])
  })

  test("drops idle rows past idleMaxAge once alwaysShowIdle is exhausted", () => {
    const model = makeModel({
      sessions: [session("recent"), session("old")],
      states: { recent: "idle", old: "idle" },
      since: { recent: 9 * 60 * 60 * 1000, old: 0 },
      now: 10 * 60 * 60 * 1000,
      options: { idleFreshAge: "0ms", idleMaxAge: "1m", alwaysShowIdle: 1 },
    })
    // "recent" is within idleMaxAge and fills the alwaysShowIdle slot by being
    // sorted first; "old" is neither recent enough nor within the floor.
    expect(select(model, "none").map((row) => row.id)).toEqual(["recent"])
  })

  test("caps each state at maxPerState", () => {
    const model = makeModel({
      sessions: [session("a"), session("b"), session("c")],
      states: { a: "working", b: "working", c: "working" },
      since: { a: 0, b: 1, c: 2 },
      options: { maxPerState: { working: 2 } },
    })
    expect(select(model, "none")).toHaveLength(2)
  })

  test("truncates the combined list at maxTotal without displacing higher-priority rows", () => {
    const model = makeModel({
      sessions: [session("w"), session("r"), session("k")],
      states: { w: "waiting", r: "retry", k: "working" },
      options: { maxTotal: 2 },
    })
    expect(select(model, "none").map((row) => row.id)).toEqual(["w", "r"])
  })
})

describe("tasksOf", () => {
  test("returns nothing when subagents is not section", () => {
    const model = makeModel({
      sessions: [session("child", { parentID: "current" })],
      states: { child: "working" },
      options: { subagents: "tree" },
    })
    expect(tasksOf(model, "current")).toEqual([])
  })

  test("returns only the current session's direct children, grouped", () => {
    const model = makeModel({
      sessions: [
        session("child-waiting", { parentID: "current" }),
        session("child-working", { parentID: "current" }),
        session("unrelated", { parentID: "someone-else" }),
      ],
      states: { "child-waiting": "waiting", "child-working": "working", unrelated: "working" },
    })
    expect(tasksOf(model, "current").map((row) => row.id)).toEqual(["child-waiting", "child-working"])
  })
})
