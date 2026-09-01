import type { TuiPluginApi, TuiRouteCurrent, TuiToast } from "@opencode-ai/plugin/tui"
import type { Event, PermissionRequest, QuestionRequest, Session, SessionStatus } from "@opencode-ai/sdk/v2"

// The narrow slice of TuiPluginApi the two plugin cores actually touch once
// construction is split from starting: event.on, client.app.log,
// client.session.list/status, client.permission.list, client.question.list,
// state.path.directory, state.session.get/status, route.current/navigate,
// ui.toast, ui.dialog.clear and renderer.terminalWidth. theme.current is only
// read by the components, which are out of scope (see the README's Tier 3
// note), and slots/keymap/lifecycle only matter inside the tui() entry
// points, which the tests never call directly.
//
// Building an honest TuiPluginApi under strict mode is unreasonable: most of
// its surface (dialogs, keymap, plugin management, the theme, ...) has
// nothing to do with either plugin's logic. So this builds the narrow shape
// below and casts it once, here, rather than scattering `as any` through
// every test.
type Narrow = {
  event: TuiPluginApi["event"]
  client: {
    app: { log: TuiPluginApi["client"]["app"]["log"] }
    session: {
      list: TuiPluginApi["client"]["session"]["list"]
      status: TuiPluginApi["client"]["session"]["status"]
    }
    permission: { list: TuiPluginApi["client"]["permission"]["list"] }
    question: { list: TuiPluginApi["client"]["question"]["list"] }
  }
  state: {
    path: { directory: string | undefined }
    session: {
      get: (sessionID: string) => Session | undefined
      status: (sessionID: string) => SessionStatus | undefined
    }
  }
  route: {
    current: TuiRouteCurrent
    navigate: (name: string, params?: Record<string, unknown>) => void
  }
  ui: {
    toast: (input: TuiToast) => void
    dialog: { clear: () => void }
  }
  renderer: { terminalWidth: number } | undefined
}

type LogCall = { service?: string; level?: string; message?: string; extra?: Record<string, unknown> }

export function createFakeApi() {
  const logs: LogCall[] = []
  const toasts: TuiToast[] = []
  const navigations: Array<{ name: string; params?: Record<string, unknown> }> = []
  let dialogClears = 0

  // Handlers captured by event.on, keyed by event type, so a test can fire
  // an event by hand and see exactly what the plugin under test wired up.
  const handlers = new Map<string, Set<(event: Event) => void>>()

  function emit<Type extends Event["type"]>(event: Extract<Event, { type: Type }>): void {
    for (const handler of handlers.get(event.type) ?? []) handler(event)
  }

  const sessions = new Map<string, Session>()
  const statuses = new Map<string, SessionStatus>()

  // What client.session.list/status, client.permission.list and
  // client.question.list resolve with. A plain mutable holder rather than a
  // function a test overrides, since resync() reads all four on every call
  // and a test usually wants to change one between calls.
  const responses = {
    sessionList: [] as Session[],
    sessionStatus: {} as Record<string, SessionStatus>,
    permissions: [] as PermissionRequest[],
    questions: [] as QuestionRequest[],
  }

  let directory: string | undefined = "/tmp/project"
  let route: TuiRouteCurrent = { name: "home" }
  let terminalWidth: number | undefined

  const narrow: Narrow = {
    event: {
      on: ((type: string, handler: (event: Event) => void) => {
        let set = handlers.get(type)
        if (!set) handlers.set(type, (set = new Set()))
        set.add(handler)
        return () => {
          handlers.get(type)?.delete(handler)
        }
      }) as TuiPluginApi["event"]["on"],
    },
    client: {
      app: {
        log: (async (params?: LogCall) => {
          logs.push(params ?? {})
          return { data: undefined }
        }) as TuiPluginApi["client"]["app"]["log"],
      },
      session: {
        list: (async () => ({ data: responses.sessionList })) as TuiPluginApi["client"]["session"]["list"],
        status: (async () => ({ data: responses.sessionStatus })) as TuiPluginApi["client"]["session"]["status"],
      },
      permission: {
        list: (async () => ({ data: responses.permissions })) as TuiPluginApi["client"]["permission"]["list"],
      },
      question: {
        list: (async () => ({ data: responses.questions })) as TuiPluginApi["client"]["question"]["list"],
      },
    },
    state: {
      path: {
        get directory() {
          return directory
        },
      },
      session: {
        get: (sessionID: string) => sessions.get(sessionID),
        status: (sessionID: string) => statuses.get(sessionID),
      },
    },
    route: {
      get current() {
        return route
      },
      navigate: (name: string, params?: Record<string, unknown>) => {
        navigations.push({ name, params })
        route = { name, params: params ?? {} }
      },
    },
    ui: {
      toast: (input: TuiToast) => {
        toasts.push(input)
      },
      dialog: {
        clear: () => {
          dialogClears += 1
        },
      },
    },
    get renderer() {
      return terminalWidth === undefined ? undefined : { terminalWidth }
    },
  }

  // The one cast the brief calls for: the narrow shape above covers exactly
  // what the two cores read once start() is called directly rather than via
  // a tui() entry point (see the comment on Narrow), so treating it as a
  // full TuiPluginApi here, and nowhere else, is a deliberate boundary
  // rather than an escape hatch scattered through the tests.
  const api = narrow as unknown as TuiPluginApi

  return {
    api,
    emit,
    logs,
    toasts,
    navigations,
    dialogClears: () => dialogClears,
    sessions,
    statuses,
    responses,
    setDirectory: (value: string | undefined) => {
      directory = value
    },
    setRoute: (value: TuiRouteCurrent) => {
      route = value
    },
    setTerminalWidth: (value: number | undefined) => {
      terminalWidth = value
    },
  }
}

export type FakeApi = ReturnType<typeof createFakeApi>

// Waits out every pending microtask, including chains several hops deep such
// as resync()'s `await Promise.all([...])` followed by more awaited work. A
// real (zero-delay) timer only fires once the microtask queue is empty, so
// this is more robust than awaiting Promise.resolve() a guessed number of
// times, and it does not depend on the fake clock, which only intercepts
// setTimeout/setInterval calls made through it explicitly.
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// The clock seam both plugin cores accept from start(). Bun's setSystemTime
// moves Date.now() but does not drive setTimeout, so the interesting
// timer-driven cases (a retry outlasting retryAfter, a toast run reaching
// maxToasts, half-duration queued toasts, the sidebar's resync interval)
// need a scheduler a test can advance by hand instead.
export type Clock = {
  now: () => number
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
  setInterval: typeof setInterval
  clearInterval: typeof clearInterval
}

type Task = { id: number; at: number; interval: number | undefined; fn: () => void }

export function createFakeClock() {
  let time = 0
  let nextID = 1
  const tasks = new Map<number, Task>()

  function schedule(fn: () => void, delay: number | undefined, interval: number | undefined): number {
    const id = nextID++
    tasks.set(id, { id, at: time + Math.max(0, delay ?? 0), interval, fn })
    return id
  }

  // The real timer functions return a NodeJS.Timeout / number depending on
  // environment; nothing here reads the handle as anything but an opaque
  // value round-tripped to clear*, so casting the numeric id at the boundary
  // is enough.
  const clock: Clock = {
    now: () => time,
    setTimeout: ((fn: () => void, delay?: number) => schedule(fn, delay, undefined)) as unknown as typeof setTimeout,
    clearTimeout: ((id?: unknown) => {
      if (typeof id === "number") tasks.delete(id)
    }) as unknown as typeof clearTimeout,
    setInterval: ((fn: () => void, delay?: number) => schedule(fn, delay, delay ?? 0)) as unknown as typeof setInterval,
    clearInterval: ((id?: unknown) => {
      if (typeof id === "number") tasks.delete(id)
    }) as unknown as typeof clearInterval,
  }

  // Advances virtual time by ms, running every task whose turn has come, in
  // order, rescheduling intervals as it goes rather than firing once and
  // stopping.
  function advance(ms: number): void {
    const until = time + ms
    for (;;) {
      let next: Task | undefined
      for (const task of tasks.values()) {
        if (task.at > until) continue
        if (next === undefined || task.at < next.at) next = task
      }
      if (next === undefined) break
      time = next.at
      if (next.interval === undefined) tasks.delete(next.id)
      else next.at = time + next.interval
      next.fn()
    }
    time = until
  }

  return { clock, advance }
}
