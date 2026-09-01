/** @jsxImportSource @opentui/solid */
import { createMemo, createRoot, createSignal, For, Show } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2"

// Lists the sessions of the current project in the sidebar, grouped by whether
// they are waiting on you, freshly idle, retrying, working, or idle for longer,
// with how long each has been that way.
//
// This file must keep the .tsx extension. opencode transforms plugin sources
// with babel-preset-solid through a Bun loader whose filter is
//
//     ^(?!.*[/\\]node_modules[/\\]).*\.[cm]?[jt]sx(?:[?#].*)?$
//
// so a .ts file would be loaded with no Solid transform at all. That failure is
// silent: JSX would still render, once, and then never update again.

const ID = "sessions-sidebar"

// Where this panel sits relative to other sidebar plugins.
const SLOT_ORDER = 200

// Safety net. Everything is kept current from the event stream; this only
// repairs state lost to a missed or malformed event.
const RESYNC_INTERVAL = 30_000

// How often the elapsed column is redrawn.
const TICK_INTERVAL = 1_000

/* -------------------------------------------------------------------------- */
/* options                                                                     */
/* -------------------------------------------------------------------------- */

// The groups a row can be displayed in. Note that this is one more than the
// model tracks: `idleFresh` is not a state a session enters, it is how long a
// row has been idle, decided afresh on every tick. See `toRow`.
type State = "waiting" | "idleFresh" | "retry" | "working" | "idle"

// The states the model actually tracks and stamps a timestamp for. Keeping
// `idleFresh` out of them is the whole point; see the warning on `toRow`.
type TrackedState = Exclude<State, "idleFresh">

// Display order, which is also priority order: waiting blocks on you, a session
// that has just stopped most likely wants you now, retry is quietly stalling,
// working is fine, older idle is history.
//
// Fresh outranks retry because a session that stopped needs a human and a retry
// is recovering on its own.
const STATES: readonly State[] = ["waiting", "idleFresh", "retry", "working", "idle"]

const ICONS: Record<State, string> = {
  waiting: "\u2753", // ❓
  // Emoji-presentation by default, like ❓ 🔄 💤, so it is two columns
  // everywhere and ⚙️ stays the only glyph carrying a variation selector, and
  // so the only one terminals disagree about the width of.
  idleFresh: "\u2705", // ✅
  retry: "\u{1F504}", // 🔄
  working: "\u2699\uFE0F", // ⚙️
  idle: "\u{1F4A4}", // 💤
}

type SubagentMode = "hidden" | "section" | "tree" | "all-tree"

type Options = {
  idleFreshAge: number
  idleMaxAge: number
  alwaysShowIdle: number
  maxTotal: number
  maxPerState: Record<State, number>
  showCurrent: boolean
  subagents: SubagentMode
}

const DEFAULTS: Options = {
  // A guess, and the one number here with no evidence behind it: long enough to
  // survive a coffee break, short enough that a session you have already dealt
  // with drops out of the attention group.
  idleFreshAge: 15 * 60 * 1000,
  idleMaxAge: 60 * 60 * 1000,
  alwaysShowIdle: 1,
  maxTotal: Number.POSITIVE_INFINITY,
  maxPerState: {
    waiting: Number.POSITIVE_INFINITY,
    idleFresh: Number.POSITIVE_INFINITY,
    retry: Number.POSITIVE_INFINITY,
    working: Number.POSITIVE_INFINITY,
    idle: Number.POSITIVE_INFINITY,
  },
  showCurrent: false,
  subagents: "section",
}

const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/
const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

function toDuration(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string") return fallback
  const match = DURATION.exec(value.trim())
  if (!match) return fallback
  return Number(match[1]) * UNITS[match[2]!]!
}

function toCount(value: unknown, fallback: number): number {
  if (value === null) return Number.POSITIVE_INFINITY
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback
  return Math.floor(value)
}

function toOptions(raw: Record<string, unknown> | undefined): Options {
  if (!raw) return DEFAULTS

  const caps = (raw.maxPerState ?? {}) as Record<string, unknown>
  const maxPerState = { ...DEFAULTS.maxPerState }
  for (const state of STATES) {
    maxPerState[state] = toCount(caps[state], DEFAULTS.maxPerState[state])
  }

  const subagents = raw.subagents
  return {
    // Deliberately not clamped against idleMaxAge. They answer different
    // questions: idleFreshAge picks the group, idleMaxAge decides whether the
    // row is shown at all. Clamping would hide a typo rather than show it.
    idleFreshAge: toDuration(raw.idleFreshAge, DEFAULTS.idleFreshAge),
    idleMaxAge: toDuration(raw.idleMaxAge, DEFAULTS.idleMaxAge),
    alwaysShowIdle: toCount(raw.alwaysShowIdle, DEFAULTS.alwaysShowIdle),
    maxTotal: toCount(raw.maxTotal, DEFAULTS.maxTotal),
    maxPerState,
    showCurrent: typeof raw.showCurrent === "boolean" ? raw.showCurrent : DEFAULTS.showCurrent,
    subagents:
      subagents === "hidden" || subagents === "section" || subagents === "tree" || subagents === "all-tree"
        ? subagents
        : DEFAULTS.subagents,
  }
}

/* -------------------------------------------------------------------------- */
/* model                                                                       */
/* -------------------------------------------------------------------------- */

type Tracked = { state: TrackedState; since: number }

type Model = ReturnType<typeof createModel>

type Level = "debug" | "info" | "warn" | "error"

function log(api: TuiPluginApi, level: Level, message: string, extra?: Record<string, unknown>) {
  // Guarded rather than merely awaited: this is called during plugin init, and
  // a plugin has no business taking the TUI down over a log line.
  try {
    void api.client.app.log({ service: ID, level, message, extra }).catch(() => {})
  } catch {
    // ignored
  }
}

// Unwraps a hey-api response, turning any failure into undefined. A plugin must
// never take the TUI down with it.
async function data<T>(request: Promise<{ data?: T }>, api: TuiPluginApi, what: string): Promise<T | undefined> {
  try {
    return (await request).data
  } catch (error) {
    log(api, "warn", `failed to fetch ${what}`, { error: String(error) })
    return undefined
  }
}

function createModel(api: TuiPluginApi, options: Options) {
  // Read on each use rather than captured: TuiState carries a `ready` flag, so
  // the path is not necessarily populated when plugins are initialised. The
  // periodic resync repairs anything the first attempt got wrong.
  const directory = () => api.state.path?.directory
  // Learned from the first listing. Sessions arriving on the event stream are
  // vetted against it, since events are not scoped to a project.
  let projectID: string | undefined

  const [sessions, setSessions] = createSignal<Session[]>([])
  const [now, setNow] = createSignal(Date.now())
  // Bumped whenever the plain Maps below change, since they are not reactive.
  const [revision, setRevision] = createSignal(0)

  const statuses = new Map<string, SessionStatus>()
  // sessionID -> ids of the permission and question requests it is blocked on.
  // A set rather than a flag, so replying to one of two pending requests does
  // not wrongly unblock the session.
  const pending = new Map<string, Set<string>>()
  // sessionID -> state and when it entered it. Nothing in the API carries this:
  // SessionStatus, PermissionRequest and QuestionRequest are all timeless, so
  // the only way to know how long a session has been in a state is to have
  // watched it arrive there.
  const tracked = new Map<string, Tracked>()

  function block(sessionID: string, requestID: string) {
    let set = pending.get(sessionID)
    if (!set) pending.set(sessionID, (set = new Set()))
    set.add(requestID)
    sync()
  }

  function unblock(sessionID: string, requestID: string) {
    const set = pending.get(sessionID)
    if (!set) return
    set.delete(requestID)
    if (set.size === 0) pending.delete(sessionID)
    sync()
  }

  function derive(sessionID: string): TrackedState {
    // Waiting is not a SessionStatus; a session blocked on a permission is
    // still "busy" underneath, so pending requests have to win.
    if ((pending.get(sessionID)?.size ?? 0) > 0) return "waiting"
    const status = statuses.get(sessionID)
    if (status?.type === "retry") return "retry"
    if (status?.type === "busy") return "working"
    return "idle"
  }

  function sync() {
    const at = Date.now()
    for (const session of sessions()) {
      const state = derive(session.id)
      const previous = tracked.get(session.id)
      if (previous?.state === state) continue
      tracked.set(session.id, {
        state,
        // A session met for the first time already idle has been idle since it
        // was last touched, not since this plugin happened to notice it.
        since: previous === undefined && state === "idle" ? session.time.updated : at,
      })
    }
    setRevision((n) => n + 1)
  }

  function upsert(session: Session) {
    if (projectID !== undefined && session.projectID !== projectID) return
    setSessions((current) => {
      const next = current.filter((existing) => existing.id !== session.id)
      next.push(session)
      return next
    })
    sync()
  }

  function remove(sessionID: string) {
    setSessions((current) => current.filter((existing) => existing.id !== sessionID))
    statuses.delete(sessionID)
    pending.delete(sessionID)
    tracked.delete(sessionID)
    setRevision((n) => n + 1)
  }

  async function resync() {
    const where = directory()
    if (!where) return

    const [list, status, permissions, questions] = await Promise.all([
      data(api.client.session.list({ directory: where }), api, "sessions"),
      data(api.client.session.status({ directory: where }), api, "session status"),
      data(api.client.permission.list({ directory: where }), api, "permissions"),
      data(api.client.question.list({ directory: where }), api, "questions"),
    ])

    if (list) {
      // The server has already scoped the list to this project, so take its
      // word for what belongs and remember the id to vet incoming events with.
      projectID ??= list[0]?.projectID
      setSessions(list)
    }

    if (status) {
      statuses.clear()
      for (const [sessionID, value] of Object.entries(status)) statuses.set(sessionID, value)
    }

    if (permissions && questions) {
      pending.clear()
      for (const request of permissions) {
        if (!pending.has(request.sessionID)) pending.set(request.sessionID, new Set())
        pending.get(request.sessionID)!.add(`p:${request.id}`)
      }
      for (const request of questions) {
        if (!pending.has(request.sessionID)) pending.set(request.sessionID, new Set())
        pending.get(request.sessionID)!.add(`q:${request.id}`)
      }
    }

    sync()

    const counts: Record<string, number> = {}
    for (const session of sessions()) {
      const state = tracked.get(session.id)?.state ?? "idle"
      counts[state] = (counts[state] ?? 0) + 1
    }
    log(api, "info", "resynced", { directory: where, sessions: sessions().length, ...counts })
  }

  const unsubscribe = [
    api.event.on("session.status", (event) => {
      statuses.set(event.properties.sessionID, event.properties.status)
      sync()
    }),
    api.event.on("session.idle", (event) => {
      statuses.set(event.properties.sessionID, { type: "idle" })
      sync()
    }),
    api.event.on("permission.asked", (event) => block(event.properties.sessionID, `p:${event.properties.id}`)),
    api.event.on("permission.replied", (event) => unblock(event.properties.sessionID, `p:${event.properties.requestID}`)),
    api.event.on("question.asked", (event) => block(event.properties.sessionID, `q:${event.properties.id}`)),
    api.event.on("question.replied", (event) => unblock(event.properties.sessionID, `q:${event.properties.requestID}`)),
    api.event.on("question.rejected", (event) => unblock(event.properties.sessionID, `q:${event.properties.requestID}`)),
    api.event.on("session.created", (event) => upsert(event.properties.info)),
    api.event.on("session.updated", (event) => upsert(event.properties.info)),
    api.event.on("session.deleted", (event) => remove(event.properties.sessionID)),
  ]

  const ticker = setInterval(() => setNow(Date.now()), TICK_INTERVAL)
  const resyncer = setInterval(() => void resync(), RESYNC_INTERVAL)

  void resync()

  function dispose() {
    clearInterval(ticker)
    clearInterval(resyncer)
    for (const off of unsubscribe) off()
  }

  return {
    options,
    sessions,
    now,
    revision,
    dispose,
    stateOf: (sessionID: string): TrackedState => tracked.get(sessionID)?.state ?? "idle",
    sinceOf: (sessionID: string, fallback: number): number => tracked.get(sessionID)?.since ?? fallback,
  }
}

/* -------------------------------------------------------------------------- */
/* selection                                                                   */
/* -------------------------------------------------------------------------- */

// `state` here is the display group, which is one wider than what the model
// tracks: an idle session lands in `idleFresh` or `idle` depending on its age.
type Row = {
  id: string
  title: string
  state: State
  since: number
  current: boolean
  depth: number
}

// `at` is the timestamp the whole pass is classified against, so every row in
// one render agrees on what counts as fresh.
//
// The fresh/history split has to be made here rather than in the model's
// `derive()`. `Tracked.since` is restamped whenever `derive()` returns a state
// it did not return last time, so if ageing out of fresh were a state change, a
// row that had been idle for an hour would restamp and suddenly read `<1m`,
// which is the very number the split exists to make readable. Classifying from
// `now - since` instead is idempotent, and costs only a re-sort of a handful of
// rows a second, which `select()` gets for free by already reading
// `model.now()`.
function toRow(model: Model, session: Session, at: number, current: boolean, depth: number): Row {
  const state = model.stateOf(session.id)
  const since = model.sinceOf(session.id, session.time.updated)
  return {
    id: session.id,
    title: session.title || session.slug || session.id,
    state: state === "idle" && at - since <= model.options.idleFreshAge ? "idleFresh" : state,
    since,
    current,
    depth,
  }
}

// Waiting, retry and working sort by longest in the current state first; both
// idle groups sort by most recently stopped first.
//
// The idle groups sort on `since` rather than `session.time.updated`. The two
// almost always agree and come apart when a session is touched without changing
// state, a rename bumping `updated` while `since` stays at the moment it
// stopped. `since` is what the elapsed column shows and what decided which of
// the two idle groups the row landed in, so sorting on it makes each group read
// monotonically down the screen and agree with itself.
function order(state: State, rows: Row[]): Row[] {
  return state === "idleFresh" || state === "idle"
    ? rows.sort((a, b) => b.since - a.since)
    : rows.sort((a, b) => a.since - b.since)
}

// Groups a mixed list into the display order and sorts within each group.
function grouped(rows: Row[]): Row[] {
  const byState = new Map<State, Row[]>(STATES.map((state) => [state, []]))
  for (const row of rows) byState.get(row.state)!.push(row)
  return STATES.flatMap((state) => order(state, byState.get(state)!))
}

function select(model: Model, currentID: string): Row[] {
  const options = model.options
  const at = model.now()
  const showTree = options.subagents === "tree" || options.subagents === "all-tree"
  const showCurrent = options.showCurrent || options.subagents === "tree"

  const roots: Row[] = []
  const children = new Map<string, Row[]>()
  // Kept aside rather than pushed into `roots`: the session being viewed is not
  // one of the sessions competing for your attention, it is the one already
  // holding it, so it does not belong to any group. See below.
  let current: Row | undefined

  for (const session of model.sessions()) {
    if (session.parentID) {
      if (!showTree) continue
      if (options.subagents === "tree" && session.parentID !== currentID) continue
      const row = toRow(model, session, at, false, 1)
      if (!children.has(session.parentID)) children.set(session.parentID, [])
      children.get(session.parentID)!.push(row)
      continue
    }
    if (session.id === currentID) {
      if (showCurrent) current = toRow(model, session, at, true, 0)
      continue
    }
    roots.push(toRow(model, session, at, false, 0))
  }

  const byState = new Map<State, Row[]>(STATES.map((state) => [state, []]))
  for (const row of roots) byState.get(row.state)!.push(row)

  const picked: Row[] = []

  // Pinned above every group, and exempt from the age filters and the
  // maxPerState caps below. Asking for the current session is asking for a fixed
  // point to read the rest of the list against, so it must not move as its own
  // state changes, must not vanish once it has been idle past idleMaxAge, and
  // must not spend a group's cap. Its icon still reports its state; what marks
  // it out is the accent colour and the bold, which no group uses.
  if (current) {
    picked.push(current)
    for (const child of grouped(children.get(current.id) ?? [])) picked.push(child)
  }

  for (const state of STATES) {
    let rows = order(state, byState.get(state)!)

    // Age filter first, then the per-group cap. The two thresholds answer
    // different questions and are not clamped against each other, so an
    // idleFreshAge above idleMaxAge is not an error: the fresh group is simply
    // bounded by visibility and history holds nothing but the forced rows.
    if (state === "idleFresh") {
      rows = rows.filter((row) => at - row.since <= options.idleMaxAge)
    } else if (state === "idle") {
      // Eligible when young enough, or among the most recent few that are shown
      // regardless of age. Sorting already put the most recent first.
      //
      // alwaysShowIdle floors this group rather than idle as a whole. Flooring
      // the whole of idle spent the slot on the newest idle row, which
      // idleMaxAge nearly always admits on its own, so the default of 1 forced
      // nothing and history was usually empty. Applied here it does what it
      // reads as: one line of history under whatever is fresh.
      rows = rows.filter((row, index) => index < options.alwaysShowIdle || at - row.since <= options.idleMaxAge)
    }

    for (const row of rows.slice(0, options.maxPerState[state])) {
      picked.push(row)
      for (const child of grouped(children.get(row.id) ?? [])) picked.push(child)
    }
  }

  // Truncating from the end can only ever drop the least urgent rows, because
  // the groups are already concatenated in priority order: history goes first,
  // then working, then retry, and the current session is at the very top. A
  // forced idle session therefore can never displace one that needs attention,
  // and nothing can displace the current session.
  return picked.slice(0, options.maxTotal)
}

function tasksOf(model: Model, currentID: string): Row[] {
  if (model.options.subagents !== "section") return []
  const at = model.now()
  const rows: Row[] = []
  for (const session of model.sessions()) {
    if (session.parentID !== currentID) continue
    rows.push(toRow(model, session, at, false, 0))
  }
  return grouped(rows)
}

/* -------------------------------------------------------------------------- */
/* rendering                                                                   */
/* -------------------------------------------------------------------------- */

// Padded to a fixed three columns. The rows are a plain list rather than a
// table, but they are grouped by state, so within a group the icon in front is
// always the same glyph and the padded times line up exactly. Only the seams
// between groups drift, by however much the two emoji differ in width, which is
// a fair price for alignment everywhere else.
function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return "<1m"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`.padStart(3)
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`.padStart(3)
  return `${Math.floor(hours / 24)}d`.padStart(3)
}

function SessionRow(props: { api: TuiPluginApi; row: Row; at: number }) {
  // TuiTheme carries its own `ready` flag, so treat `current` as possibly
  // absent. Returning undefined for a colour just leaves the text unstyled,
  // which is a far better outcome than throwing mid-render.
  const theme = () => props.api.theme.current as Partial<TuiThemeCurrent> | undefined
  const colour = () => {
    const t = theme()
    if (!t) return undefined
    // Ahead of the groups on purpose, and `accent` is a key none of them use,
    // so the session being viewed reads as its own thing whatever it is doing.
    // `select()` pins it to the top to match.
    if (props.row.current) return t.accent
    switch (props.row.state) {
      case "waiting":
        return t.warning
      // Fresh must not stay muted: colour is what makes the group readable
      // without depending on the emoji, and muted is what makes a row look
      // dead. `success` matches ✅.
      case "idleFresh":
        return t.success
      case "retry":
        return t.error
      case "working":
        return t.text
      default:
        return t.textMuted
    }
  }

  const line = () =>
    `${" ".repeat(props.row.depth * 2)}${ICONS[props.row.state]} (${elapsed(props.at - props.row.since)}) ${props.row.title}`

  // Deliberately one <text> for the whole row rather than an aligned row of
  // separate elements. Siblings in a flex row wrap independently once the
  // sidebar is narrower than the row, which broke the elapsed column across two
  // lines and made it read as part of the title:
  //
  //     💤 (   Find the retry logic
  //         2m)
  //
  // A single text cannot come apart like that, and wrapMode="none" clips the
  // tail of a long title instead of reflowing it. Colour goes on the whole line,
  // since <span> carries no style options, which also makes the state readable
  // at a glance without relying on the emoji.
  return (
    <text fg={colour()} wrapMode="none">
      <Show when={props.row.current} fallback={line()}>
        <b>{line()}</b>
      </Show>
    </text>
  )
}

function Panel(props: { api: TuiPluginApi; model: Model; sessionID: string }) {
  const rows = createMemo(() => {
    props.model.revision()
    return select(props.model, props.sessionID)
  })
  const tasks = createMemo(() => {
    props.model.revision()
    return tasksOf(props.model, props.sessionID)
  })

  return (
    <Show when={rows().length > 0 || tasks().length > 0}>
      <box gap={0}>
        <Show when={rows().length > 0}>
          <text fg={props.api.theme.current?.text}>
            <b>Active Sessions</b>
          </text>
          <For each={rows()}>
            {(row) => <SessionRow api={props.api} row={row} at={props.model.now()} />}
          </For>
        </Show>
        <Show when={tasks().length > 0}>
          <text> </text>
          <text fg={props.api.theme.current?.text}>
            <b>Current Session Tasks</b>
          </text>
          <For each={tasks()}>
            {(row) => <SessionRow api={props.api} row={row} at={props.model.now()} />}
          </For>
        </Show>
      </box>
    </Show>
  )
}

/* -------------------------------------------------------------------------- */
/* entry point                                                                 */
/* -------------------------------------------------------------------------- */

const tui: TuiPlugin = async (api, options) => {
  const parsed = toOptions(options)
  log(api, "info", "loaded", { directory: api.state.path?.directory, subagents: parsed.subagents })

  // Owned by a root of its own so the tracking starts with the TUI rather than
  // with the first time the sidebar is opened. Durations would otherwise all
  // begin at the moment you first looked at them.
  const [model, disposeRoot] = createRoot((dispose) => [createModel(api, parsed), dispose] as const)

  api.lifecycle.onDispose(() => {
    model.dispose()
    disposeRoot()
  })

  api.slots.register({
    order: SLOT_ORDER,
    slots: {
      sidebar_content(_context, slotProps: { session_id: string }) {
        return <Panel api={api} model={model} sessionID={slotProps.session_id} />
      },
    },
  })

  log(api, "info", "sidebar_content registered")
}

const plugin: TuiPluginModule & { id: string } = { id: ID, tui }

export default plugin
