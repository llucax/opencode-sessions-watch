import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2"

// Raises a toast when a session you are not looking at starts wanting
// something: a permission, an answer, a finish, an error, or a retry that will
// not end.
//
// This does no sound and no OS notification on purpose. opencode's built-in
// `internal:notifications` already does both, and with the terminal focused it
// deliberately suppresses the notification, so every one of these events gives
// you a beep and nothing else. Naming the session is the hole this fills; the
// two are complementary, so leave that plugin enabled.
//
// This file carries no JSX and needs no reactive transform, but it keeps the
// .tsx extension anyway to sit beside sessions-sidebar.tsx, which does need it.

const ID = "sessions-toast"

// The toast provider keeps a single `currentToast`: `show()` overwrites it and
// resets its timer, whether the toast it erases came from this plugin, another
// plugin or opencode itself. `api.ui.toast` is a setter only, so there is no
// way to read whether something is on screen. Everything about the queue below
// follows from that: firing one toast per event would silently lose all but
// the last.
const AGGREGATE_MAX_LINES = 5

// Rendering constants, mirrored from the toast provider so the aggregate can
// budget its lines: the box is `maxWidth: min(60, terminalWidth - 6)` with a
// left and right border and two columns of padding on either side.
const TOAST_MAX_WIDTH = 60
const TOAST_TERMINAL_MARGIN = 6
const TOAST_CHROME = 6

// How often to retry learning the project id, until it is known. See `inScope`.
const PROJECT_INTERVAL = 30_000

// A parentID cycle would hang the TUI, and no legitimate Task nesting comes
// anywhere near this, so the ancestor walk is bounded rather than trusting the
// data.
const MAX_DEPTH = 32

/* -------------------------------------------------------------------------- */
/* options                                                                     */
/* -------------------------------------------------------------------------- */

type Trigger = "permission" | "question" | "idle" | "error" | "retry"

const TRIGGERS: readonly Trigger[] = ["permission", "question", "idle", "error", "retry"]

// Only the ones a session asks for outright get `warning`; a finish is good
// news and an error is an error.
const VARIANTS: Record<Trigger, "success" | "warning" | "error"> = {
  permission: "warning",
  question: "warning",
  idle: "success",
  error: "error",
  retry: "warning",
}

type Options = {
  triggers: ReadonlySet<Trigger>
  retryAfter: number
  maxToasts: number
  duration: number
  jumpKey: string | false
}

const DEFAULTS: Options = {
  triggers: new Set(TRIGGERS),
  // Long enough that an ordinary provider hiccup, which recovers in seconds,
  // never reaches you.
  retryAfter: 30_000,
  // Two, not three, so a burst of four collapses. Three simultaneous events
  // still give three named toasts, because aggregating needs two entries left
  // and the third arrival leaves only one; four give two named toasts and
  // "2 sessions need attention". See `advance`.
  maxToasts: 2,
  duration: 5_000,
  jumpKey: "<leader>space",
}

const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/
const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

// Copied from the sidebar rather than shared. The distribution convention is
// "symlink the plugin file", so an import between the two would break it, and
// this is nearly all there is to share.
function toDuration(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string") return fallback
  const match = DURATION.exec(value.trim())
  if (!match) return fallback
  return Number(match[1]) * UNITS[match[2]!]!
}

function toCount(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback
  return Math.floor(value)
}

function toTriggers(value: unknown, fallback: ReadonlySet<Trigger>): ReadonlySet<Trigger> {
  if (!Array.isArray(value)) return fallback
  const picked = new Set<Trigger>()
  for (const entry of value) {
    const trigger = TRIGGERS.find((known) => known === entry)
    if (trigger) picked.add(trigger)
  }
  return picked
}

function toJumpKey(value: unknown, fallback: string | false): string | false {
  if (value === false) return false
  if (typeof value !== "string") return fallback
  const key = value.trim()
  return key ? key : false
}

function toOptions(raw: Record<string, unknown> | undefined): Options {
  if (!raw) return DEFAULTS
  return {
    triggers: toTriggers(raw.triggers, DEFAULTS.triggers),
    retryAfter: toDuration(raw.retryAfter, DEFAULTS.retryAfter),
    maxToasts: toCount(raw.maxToasts, DEFAULTS.maxToasts),
    duration: toDuration(raw.duration, DEFAULTS.duration),
    jumpKey: toJumpKey(raw.jumpKey, DEFAULTS.jumpKey),
  }
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

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

function titleOf(session: Session): string {
  return session.title || session.slug || session.id
}

function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}\u2026`
}

// Mirrors what internal:notifications reports, since the two are read together:
// an abort and a stalled stream are reworded because their raw messages say
// nothing useful, and anything else is shown as it came.
function errorMessage(error: unknown): string {
  const shape = error as { name?: unknown; data?: { message?: unknown } } | undefined
  if (shape?.name === "MessageAbortedError") return "Session aborted"
  const message = typeof shape?.data?.message === "string" ? shape.data.message.trim() : ""
  if (message === "SSE read timed out") return "Model stopped responding"
  return message || "Session error"
}

/* -------------------------------------------------------------------------- */
/* the watcher                                                                 */
/* -------------------------------------------------------------------------- */

// One queued announcement. `message` is the reason, and the toast shows it
// under the session title in bold, which is the same split
// internal:notifications uses for its OS notifications.
type Entry = {
  sessionID: string
  trigger: Trigger
  title: string
  message: string
  // Set for permission and question, so the entry can be dropped when the
  // request it announces is answered. See hygiene rule 2.
  requestID?: string
}

function createWatcher(api: TuiPluginApi, options: Options) {
  /* ---------------------------------------------------------------------- */
  /* scope                                                                   */
  /* ---------------------------------------------------------------------- */

  // The TUI's session store is hydrated from a project-scoped listing, but the
  // event stream behind it is server-wide and `session.updated` is applied to
  // the store unfiltered, so a session from another project lands in it as soon
  // as it is touched. The event envelope carries a directory, but that is the
  // originating instance's, not the project's, so it would drop a session
  // running in another directory of the same project, which is exactly the case
  // worth catching. Learn the project id the way the sidebar does instead.
  let projectID: string | undefined
  let projectTimer: ReturnType<typeof setInterval> | undefined

  function learnProject() {
    const directory = api.state.path?.directory
    if (!directory) return
    // The server has already scoped the listing, so take its word for what
    // belongs to this project.
    void api.client.session
      .list({ directory })
      .then((response) => {
        projectID ??= response.data?.[0]?.projectID
        if (projectID === undefined || projectTimer === undefined) return
        clearInterval(projectTimer)
        projectTimer = undefined
        log(api, "info", "project scope learned", { projectID })
      })
      .catch((error: unknown) => log(api, "warn", "failed to list sessions", { error: String(error) }))
  }

  // Until the project id is known, everything the TUI knows about is accepted.
  // A brand new project has no session to learn it from, and refusing to say
  // anything until one exists would be worse than the occasional stray toast.
  function inScope(session: Session): boolean {
    return projectID === undefined || session.projectID === projectID
  }

  // The session and every ancestor up to the root, nearest first. Undefined
  // when the chain breaks on a session the TUI does not know: there is no title
  // to show for it, and it is almost certainly from another project.
  function chainOf(sessionID: string): Session[] | undefined {
    const chain: Session[] = []
    let id: string | undefined = sessionID
    while (id !== undefined && chain.length < MAX_DEPTH) {
      const session = api.state.session.get(id)
      if (!session) return undefined
      chain.push(session)
      id = session.parentID
    }
    return id === undefined ? chain : undefined
  }

  // Read whatever the route carries: `session` names it directly, and a plugin
  // route such as the diff viewer passes through the session it was opened
  // from. `home` names nothing, and that is right — nothing is being watched,
  // so everything is eligible.
  function currentSessionID(): string | undefined {
    const route = api.route.current
    if (!("params" in route)) return undefined
    const sessionID = route.params?.sessionID
    return typeof sessionID === "string" ? sessionID : undefined
  }

  // True when either session is the other, or an ancestor of it. Suppression
  // has to hold in both directions: an event propagated up to a root must be
  // dropped while you are watching the blocked subagent, and an entry queued
  // for a root must go when you navigate into its subtree.
  function related(a: string, b: string): boolean {
    if (a === b) return true
    return (chainOf(a)?.some((session) => session.id === b) ?? false) ||
      (chainOf(b)?.some((session) => session.id === a) ?? false)
  }

  /* ---------------------------------------------------------------------- */
  /* the queue                                                              */
  /* ---------------------------------------------------------------------- */

  const queue: Entry[] = []
  // A run begins when an entry arrives with nothing showing and ends when the
  // queue drains and the last toast expires. `shown` counts the individual
  // toasts of the current run, so zero also means no run is in progress, which
  // is what makes the next toast a full-duration one.
  let shown = 0
  let showing = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastAttention: string | undefined

  function show(toast: { variant: "info" | "success" | "warning" | "error"; title: string; message: string }, duration: number) {
    showing = true
    api.ui.toast({ ...toast, duration })
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      advance()
    }, duration)
  }

  // Hygiene rules 2 and 3, applied to the queue only. A toast already on screen
  // runs out its timer whatever happens; the queue is a promise about the
  // present, and these are the ways a queued promise goes stale. Checking them
  // here rather than on navigation is deliberate: there is no route-change
  // event on the plugin API, and just before showing is the only moment the
  // answer matters.
  function purge() {
    const current = currentSessionID()
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const entry = queue[index]!
      const gone = api.state.session.get(entry.sessionID) === undefined
      if (gone || (current !== undefined && related(entry.sessionID, current))) queue.splice(index, 1)
    }
  }

  function advance() {
    purge()
    if (queue.length === 0) {
      showing = false
      shown = 0
      return
    }

    // Aggregating needs two entries left, because "1 session needs attention"
    // is strictly worse than naming it. The aggregate gets the full duration
    // because it has more to read, and it ends the run.
    if (shown >= options.maxToasts && queue.length >= 2) {
      const entries = queue.splice(0, queue.length)
      shown = 0
      showAggregate(entries)
      return
    }

    const entry = queue.shift()!
    // Half duration for the queued ones keeps a burst from owning the only
    // toast slot for twenty seconds while opencode is trying to report an
    // error in it.
    const duration = shown === 0 ? options.duration : options.duration / 2
    shown += 1
    lastAttention = entry.sessionID
    const session = api.state.session.get(entry.sessionID)
    show({ variant: VARIANTS[entry.trigger], title: session ? titleOf(session) : entry.title, message: entry.message }, duration)
  }

  function showAggregate(entries: Entry[]) {
    // A width of 80 if the renderer will not say, which only costs a line that
    // the toast wraps for itself.
    const terminal = api.renderer?.terminalWidth ?? 80
    const width = Math.max(20, Math.min(TOAST_MAX_WIDTH, terminal - TOAST_TERMINAL_MARGIN) - TOAST_CHROME)
    const listed = entries.slice(0, AGGREGATE_MAX_LINES)
    const lines = listed.map((entry) => {
      const session = api.state.session.get(entry.sessionID)
      return truncate(`${entry.message}: ${session ? titleOf(session) : entry.title}`, width)
    })
    const rest = entries.length - listed.length
    if (rest > 0) lines.push(`and ${rest} more`)
    // The most recent arrival is the one worth jumping to, whether or not the
    // truncated list still had room to name it.
    lastAttention = entries[entries.length - 1]!.sessionID
    show({ variant: "warning", title: `${entries.length} sessions need attention`, message: lines.join("\n") }, options.duration)
  }

  function attend(entry: Entry) {
    if (!options.triggers.has(entry.trigger)) return
    // Hygiene rule 1: one entry per session, replaced in place so it keeps its
    // queue position. A session that asked for permission and then errored must
    // not still be announced as wanting permission.
    const index = queue.findIndex((queued) => queued.sessionID === entry.sessionID)
    if (index >= 0) queue[index] = entry
    else queue.push(entry)
    if (!showing) advance()
  }

  // Hygiene rule 2: the permission was replied to, or the question answered or
  // rejected. Matching on the request id rather than the session is what makes
  // this right when a newer event has already replaced the entry.
  function expire(requestID: string) {
    const index = queue.findIndex((entry) => entry.requestID === requestID)
    if (index >= 0) queue.splice(index, 1)
  }

  /* ---------------------------------------------------------------------- */
  /* triggers                                                               */
  /* ---------------------------------------------------------------------- */

  // Permission and question, attributed to the root of the chain they came
  // from. The event carries the subagent's id, but a parent goes on reporting
  // busy the whole time it waits on a child, so a session blocked on a
  // subagent's permission is invisible in every other channel. Dropping it
  // would leave the plugin silent in exactly the situation it exists for.
  //
  // Two subagents of one parent blocking at once collapse into a single entry,
  // because the queue holds at most one entry per session and these key on the
  // root.
  function raiseBlocked(sessionID: string, trigger: "permission" | "question", requestID: string) {
    const chain = chainOf(sessionID)
    if (!chain) return
    const root = chain[chain.length - 1]!
    if (!inScope(root)) return
    // Compared against the whole chain, not just the root: watching the parent
    // and watching the blocked subagent are both "you can already see this",
    // and a permission on the session you are looking at renders inline anyway.
    const current = currentSessionID()
    if (current !== undefined && chain.some((session) => session.id === current)) return
    const subagent = chain.length > 1
    attend({
      sessionID: root.id,
      trigger,
      title: titleOf(root),
      message:
        trigger === "permission"
          ? subagent
            ? "A subagent needs permission"
            : "Needs permission"
          : subagent
            ? "A subagent needs an answer"
            : "Needs an answer",
      requestID,
    })
  }

  // Idle, error and retry. A Task finishing, erroring or retrying is its
  // parent's business and resolves into the parent's own lifecycle, which is
  // already watched, so subagents are dropped outright here.
  function raiseOwn(sessionID: string, trigger: "idle" | "error" | "retry", message: string) {
    const session = api.state.session.get(sessionID)
    if (!session || session.parentID !== undefined) return
    if (!inScope(session)) return
    const current = currentSessionID()
    if (current !== undefined && related(sessionID, current)) return
    attend({ sessionID, trigger, title: titleOf(session), message })
  }

  // Sessions seen busy or retrying. Only one of those can be said to have
  // finished; the rest are sessions the TUI merely heard about.
  const busy = new Set<string>()
  // Consumed by the idle handler. A failed session goes idle immediately
  // afterwards, and "Finished" after "Session error" is a lie.
  const errored = new Set<string>()
  // Sessions counting down to a retry toast. A null value means the toast has
  // already been raised, so the countdown is not re-armed until the session
  // leaves retry.
  const retrying = new Map<string, ReturnType<typeof setTimeout> | null>()
  const permissions = new Set<string>()
  const questions = new Set<string>()

  // Retry is a SessionStatus, distinct from session.error, and most retries
  // recover in seconds, so toasting on entry would mean a toast every time a
  // provider hiccups on a session that was never in trouble. Waiting turns it
  // into a signal for the case that matters: a rate limit that has stalled a
  // session for a long time.
  function startRetry(sessionID: string) {
    if (retrying.has(sessionID)) return
    retrying.set(
      sessionID,
      setTimeout(() => {
        retrying.set(sessionID, null)
        if (api.state.session.status(sessionID)?.type !== "retry") return
        raiseOwn(sessionID, "retry", "Still retrying")
      }, options.retryAfter),
    )
  }

  function stopRetry(sessionID: string) {
    const pending = retrying.get(sessionID)
    if (pending) clearTimeout(pending)
    retrying.delete(sessionID)
  }

  function onStatus(sessionID: string, status: SessionStatus) {
    if (status.type === "busy" || status.type === "retry") {
      busy.add(sessionID)
      errored.delete(sessionID)
      if (status.type === "retry") startRetry(sessionID)
      else stopRetry(sessionID)
      return
    }
    stopRetry(sessionID)
    if (!busy.delete(sessionID)) return
    if (errored.delete(sessionID)) return
    raiseOwn(sessionID, "idle", "Finished")
  }

  function forget(sessionID: string) {
    busy.delete(sessionID)
    errored.delete(sessionID)
    stopRetry(sessionID)
    const index = queue.findIndex((entry) => entry.sessionID === sessionID)
    if (index >= 0) queue.splice(index, 1)
    if (lastAttention === sessionID) lastAttention = undefined
  }

  const unsubscribe = [
    api.event.on("permission.asked", (event) => {
      const { id, sessionID } = event.properties
      if (permissions.has(id)) return
      permissions.add(id)
      raiseBlocked(sessionID, "permission", id)
    }),
    api.event.on("permission.replied", (event) => {
      permissions.delete(event.properties.requestID)
      expire(event.properties.requestID)
    }),
    api.event.on("question.asked", (event) => {
      const { id, sessionID } = event.properties
      if (questions.has(id)) return
      questions.add(id)
      raiseBlocked(sessionID, "question", id)
    }),
    api.event.on("question.replied", (event) => {
      questions.delete(event.properties.requestID)
      expire(event.properties.requestID)
    }),
    api.event.on("question.rejected", (event) => {
      questions.delete(event.properties.requestID)
      expire(event.properties.requestID)
    }),
    api.event.on("session.status", (event) => onStatus(event.properties.sessionID, event.properties.status)),
    // Belt and braces: session.idle carries no status, and handling it is
    // idempotent because the busy set lets the transition fire only once.
    api.event.on("session.idle", (event) => onStatus(event.properties.sessionID, { type: "idle" })),
    api.event.on("session.error", (event) => {
      const sessionID = event.properties.sessionID
      if (sessionID === undefined || !busy.has(sessionID)) return
      errored.add(sessionID)
      raiseOwn(sessionID, "error", errorMessage(event.properties.error))
    }),
    api.event.on("session.deleted", (event) => forget(event.properties.sessionID)),
  ]

  projectTimer = setInterval(learnProject, PROJECT_INTERVAL)
  learnProject()

  /* ---------------------------------------------------------------------- */
  /* jumping                                                                */
  /* ---------------------------------------------------------------------- */

  function goto() {
    // Invoked from the palette as well as from the key sequence, and the
    // palette does not close itself.
    api.ui.dialog.clear()
    if (lastAttention === undefined) {
      api.ui.toast({ variant: "info", message: "No session has needed attention yet" })
      return
    }
    const session = api.state.session.get(lastAttention)
    if (!session) {
      api.ui.toast({ variant: "info", message: "That session is gone" })
      return
    }
    if (currentSessionID() === session.id) {
      api.ui.toast({ variant: "info", message: `Already in ${titleOf(session)}` })
      return
    }
    api.route.navigate("session", { sessionID: session.id })
  }

  function dispose() {
    for (const off of unsubscribe) off()
    if (projectTimer !== undefined) clearInterval(projectTimer)
    if (timer !== undefined) clearTimeout(timer)
    for (const pending of retrying.values()) if (pending) clearTimeout(pending)
    retrying.clear()
  }

  return { goto, dispose }
}

/* -------------------------------------------------------------------------- */
/* entry point                                                                 */
/* -------------------------------------------------------------------------- */

const COMMAND = "sessions-toast.goto"

const tui: TuiPlugin = async (api, options) => {
  const parsed = toOptions(options)
  const watcher = createWatcher(api, parsed)

  // Default-bound rather than opt-in, because a plugin's command cannot be
  // bound from config at all: the keybinds schema is a closed set built from
  // opencode's own command definitions, so there is no entry a user could add.
  // Opt-in would mean the palette and nothing else until someone read the
  // README. A bound sequence also advertises itself in the which-key panel
  // under the leader key.
  const bindings = parsed.jumpKey
    ? [{ key: parsed.jumpKey, cmd: COMMAND, desc: "Session needing attention", group: "Session" }]
    : []

  const unregister = api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: COMMAND,
        title: "Go to the session that last needed attention",
        category: "Session",
        run: () => watcher.goto(),
      },
    ],
    bindings,
  })

  api.lifecycle.onDispose(() => {
    unregister()
    watcher.dispose()
  })

  log(api, "info", "loaded", {
    directory: api.state.path?.directory,
    triggers: [...parsed.triggers].join(","),
    jumpKey: parsed.jumpKey === false ? "disabled" : parsed.jumpKey,
  })
}

const plugin: TuiPluginModule & { id: string } = { id: ID, tui }

export default plugin
