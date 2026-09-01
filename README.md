# opencode sessions watch

Two TUI plugins for [opencode](https://opencode.ai) that tell you what your
other sessions are doing: one passively, as a panel in the sidebar, and one by
interrupting you with a toast when a session you are not looking at starts
wanting something.

| Plugin                                  | File                   | What it does                                             |
|-----------------------------------------|------------------------|----------------------------------------------------------|
| [sessions-sidebar](#sessions-sidebar)   | `sessions-sidebar.tsx` | lists the project's sessions in the sidebar, by state    |
| [sessions-toast](#sessions-toast)       | `sessions-toast.tsx`   | toasts a session that needs you while you are elsewhere  |

They share no code and are installed separately, so take either or both.

Developed against opencode 1.18.25. They need a version carrying the TUI plugin
API, and the sidebar additionally needs its `sidebar_content` slot. There is
nothing to install beyond the files themselves: `@opentui/solid` and `solid-js`
come from opencode's own runtime, and the `@opencode-ai` imports are types,
erased before the files run.

## Installing

Clone this repository wherever you keep plugin checkouts:

    git clone https://github.com/llucax/opencode-sessions-watch

Symlink the plugins you want into your opencode plugin directory:

    mkdir -p ~/.config/opencode/plugins
    ln -s "$PWD/opencode-sessions-watch/sessions-sidebar.tsx" \
          "$PWD/opencode-sessions-watch/sessions-toast.tsx" \
          ~/.config/opencode/plugins/

Then register them in `~/.config/opencode/tui.jsonc`, creating the file if you
do not have one:

    {
      "$schema": "https://opencode.ai/tui.json",
      "plugin": [
        "./plugins/sessions-sidebar.tsx",
        "./plugins/sessions-toast.tsx"
      ]
    }

Paths in `plugin` are resolved against the directory holding `tui.jsonc`, so
`./plugins/sessions-sidebar.tsx` finds the symlink you just made.

The symlinks are a convenience, not a requirement: pointing `plugin` straight at
the files in the checkout works too. They buy you a `tui.jsonc` that does not
mention where your checkouts live.

Restart opencode.

> [!IMPORTANT]
> The `tui.jsonc` entry is not optional. opencode scans
> `~/.config/opencode/plugins/` for *server* plugins only, and the glob it uses
> is `{plugin,plugins}/*.{ts,js}`, which does not match `.tsx` at all. A TUI
> plugin left in that directory without a `tui.jsonc` entry is simply never
> loaded, silently.

Give an entry as a two-element array to pass options. A bare string gets the
defaults.

    "plugin": [
      ["./plugins/sessions-sidebar.tsx", { "idleMaxAge": "2h", "showCurrent": true }],
      ["./plugins/sessions-toast.tsx", { "retryAfter": "1m" }]
    ]

Durations are written throughout as a string pairing a number with a unit, one
of `ms`, `s`, `m`, `h` or `d`; a bare number is read as milliseconds.

## `sessions-sidebar`

Adds a panel to the sidebar listing the sessions of the current project, grouped
by whether they are waiting on you, freshly idle, retrying, working, or idle for
longer, each with how long it has been that way.

    Active Sessions
    ? (<1m) Fix the flaky reconnect test
    ? ( 5m) Draft the release notes
    ✓ ( 2m) Review PR 412
    ✓ (11m) Add the --json flag
    ↻ (47m) Port the parser to nom 8
    ⏵ ( 2h) Rewrite the config loader
    ┄ ( 1d) Look into the CI cache

    Current Session Tasks
    ⏵ ( 8m) explore: find the retry logic

| Icon | Group       | Meaning                                           |
|------|-------------|---------------------------------------------------|
| ?    | `waiting`   | a permission or question is awaiting a reply      |
| ✓    | `idleFresh` | stopped within `idleFreshAge`; probably wants you |
| ↻    | `retry`     | a provider call failed and is being retried       |
| ⏵    | `working`   | the agent is running                              |
| ┄    | `idle`      | stopped longer ago; history                       |

The defaults are deliberately one column wide, against two separate ways a
glyph can go wrong there. opencode's session switcher dims the sidebar
behind it, but OpenTUI's compositor only blends a cell it itself measures as
one column; a cell it measures as two loses its glyph outright rather than
dimming ([opentui#837](https://github.com/anomalyco/opentui/issues/837),
`eawToWidth()` in OpenTUI's `packages/native/src/utf8.zig`). A codepoint a
terminal draws wider than that regardless, without OpenTUI agreeing, merely
shifts the row instead. `idle`'s `┄` is a deliberate exception: it is
Ambiguous width, so a terminal that draws Ambiguous wide can shift that one
row, but it composites correctly behind a dialog regardless, and the
legibility was worth that risk. If your terminal disagrees about any of
these, or you would rather have emoji back and never look at a dimmed
sidebar, override it with the `icons` option below.

Groups are listed in that order: waiting blocks on you, a session that has just
stopped most likely wants you now, retry is quietly stalling, working is fine,
older idle is history. Fresh outranks retry because a session that stopped needs
a human and a retry is recovering on its own.

A session also counts as `waiting` when one of its subagents does: the server
reports a parent blocked on a child's prompt as merely busy, but it is still you
the child is waiting on.

The panel covers one project, the one the TUI is running in; sessions belonging
to any other project are not listed. It renders nothing at all when no session
qualifies.

Durations are measured by the plugin while it runs, because nothing in the
opencode API records when a session entered its current state. A session first
seen already idle is dated from when it was last updated, rather than from when
the plugin noticed it.

### Options

| Option           | Default     | Meaning                                                           |
|------------------|-------------|-------------------------------------------------------------------|
| `idleFreshAge`   | `"15m"`     | idle for less than this counts as fresh rather than history       |
| `idleMaxAge`     | `"1h"`      | hide idle sessions older than this                                |
| `alwaysShowIdle` | `1`         | show this many most recent `idle` rows regardless of age          |
| `maxTotal`       | unlimited   | cap on rows in the main list                                      |
| `maxPerState`    | unlimited   | per-group caps: `{ waiting, idleFresh, retry, working, idle }`    |
| `showCurrent`    | `false`     | pin the session being viewed at the top, bold and accent-coloured |
| `subagents`      | `"section"` | how Task-tool child sessions appear, see below                    |
| `icons`          | see above   | per-group icon overrides, e.g. `{ "waiting": "!" }`                |

A count given as `null` means unlimited. `icons` is a partial map: name only the
states you want to change, the rest keep their default.

#### Nerd Font icons

If you use a [Nerd Font](https://www.nerdfonts.com/), we recommend using these
icons instead:

    {
      "icons": {
        "waiting": "\uf059",
        "idleFresh": "\uf058",
        "retry": "\uf021",
        "working": "\uf04b",
        "idle": "\uf186"
      }
    }

| State       | Codepoint | Name                    |
|-------------|-----------|-------------------------|
| `waiting`   | `U+F059`  | `nf-fa-question_circle` |
| `idleFresh` | `U+F058`  | `nf-fa-check_circle`    |
| `retry`     | `U+F021`  | `nf-fa-refresh`         |
| `working`   | `U+F04B`  | `nf-fa-play`            |
| `idle`      | `U+F186`  | `nf-fa-moon_o`          |

Check whether your terminal font is patched with `printf '\uf059 \uf058 \uf021
\uf04b \uf186\n'`; five icons means it is, boxes mean it is not.

The two idle thresholds answer different questions and are not clamped against
each other: `idleMaxAge` decides whether a row is shown at all, `idleFreshAge`
decides which of the two idle groups it lands in. Setting `idleFreshAge` above
`idleMaxAge` is not an error, it just leaves the `idle` group holding nothing
but the rows `alwaysShowIdle` forces.

The default `idleFreshAge` of `15m` is a guess: long enough to survive a coffee
break, short enough that a session you have already dealt with drops out of the
attention group. Adjust it after living with it.

`subagents` takes one of:

- `"hidden"` — child sessions are not shown.
- `"section"` — children of the current session appear in a separate
  `Current Session Tasks` list below the main one.
- `"tree"` — children of the current session are nested under it in the main
  list. Implies `showCurrent`.
- `"all-tree"` — children of every listed session are nested under their parent.

A parent waiting on a subagent shows as `waiting` in every one of those modes,
including `"hidden"`, where you get the signal that something needs you without
the noise of the child sessions themselves.

Within a group, waiting, retry and working sort by longest in the current state
first, and both idle groups sort by most recently stopped first.

Rows are selected by taking each group in display order up to its `maxPerState`
cap, then truncating the result to `maxTotal`. Truncation drops from the end,
and the groups are ordered by urgency, so an idle session held by
`alwaysShowIdle` can never displace one that needs attention.

The session being viewed, when `showCurrent` puts it in the list, sits outside
all of that. It is pinned above every group, in the accent colour and bold, and
is exempt from the age filters and the `maxPerState` caps. It is the fixed point
you read the rest of the list against, so it stays put as its own state changes,
does not disappear once it has been idle past `idleMaxAge`, and does not spend a
group's cap. Its icon still reports what it is doing.

The fresh/history split is made when the list is drawn, from how long the
session has been idle, not by treating "no longer fresh" as something the
session does. A row crossing `idleFreshAge` therefore changes icon, colour and
position while its elapsed time carries on counting from when it stopped.

## `sessions-toast`

Raises a toast, titled with the session and reading the reason, when a session
of the current project that you are **not** looking at starts wanting something.

| Trigger      | Fires when                                          | Message              |
|--------------|-----------------------------------------------------|----------------------|
| `permission` | a permission is asked                               | Needs permission     |
| `question`   | a question is asked                                 | Needs an answer      |
| `idle`       | a session that was working or retrying stops        | Finished             |
| `error`      | a session that was working fails                    | the error            |
| `retry`      | a session is still retrying after `retryAfter`      | Still retrying       |

This does no sound and no OS notification, on purpose. opencode ships
`internal:notifications`, a built-in TUI plugin that already calls
`attention.notify` on all of these, with the OS notification suppressed while
the terminal is focused and the sound always played. So today, sitting in front
of the terminal, every one of these events gives you a beep and nothing else:
you know something happened somewhere and cannot tell what or where. Naming the
session is the hole this fills, so the two are complementary. Leave
`internal:notifications` alone and enabled.

### What it stays quiet about

The session you are looking at, since a permission on it already renders inline
and a toast about it would be noise. The whole ancestor chain counts, so
watching a parent silences its subagents and watching a subagent silences its
parent.

Subagents finishing, erroring or retrying, because a Task's lifecycle resolves
into its parent's, which is already watched.

Sessions belonging to another project, or that the TUI does not know at all.

An error suppresses the finish that follows it, because a failed session goes
idle immediately afterwards and "Finished" after "Session error" is a lie.

Retries that recover. Most do, in seconds, so a toast on entering retry would
fire every time a provider hiccups. The countdown makes it a signal for the case
that actually matters: a rate limit that has stalled a session for a long time.

### Subagents asking for something

A subagent asking for a permission or a question is the opposite case, and the
one this plugin most needs to catch. The event carries the subagent's id, but
the parent goes on reporting `busy` while it waits, so a session blocked on a
child's permission is invisible in every other channel.

Those two events therefore propagate to the root of the chain: the toast names
the root session and says a subagent is asking. Two subagents of one parent
blocking at once collapse into one toast, and jumping takes you to the root,
from where the blocked child is one keystroke away.

### Bursts

The TUI keeps a single toast on screen: showing one overwrites whatever was
there, whether it came from a plugin or from opencode itself. So this plugin
queues, rather than firing a toast per event and losing all but the last.

The first toast of a burst gets the full `duration`, and each queued one that
follows gets half of it, which keeps four sessions from owning the only toast
slot for twenty seconds while opencode is trying to report an error in it. Once
`maxToasts` have been named and two or more are still waiting, the rest collapse
into a single `N sessions need attention` toast listing them, at full duration.
Two entries are required because "1 session needs attention" is strictly worse
than naming it: with the defaults, three sessions at once give three named
toasts, and four give two named plus an aggregate of the other two.

A queued toast is dropped if it goes stale before its turn: the permission was
replied to, the question answered, the session deleted, or you navigated to the
session it was about. A toast already on screen always runs out its timer.

### Jumping to the session

`<leader>space`, which is `ctrl+x` `space` with the default leader, goes to the
session the most recent toast named. It is also in the command palette, under
`Session`, as *Go to the session that last needed attention*. If that session is
gone or you are already in it, it says so rather than doing nothing.

The sequence is bound by default rather than left opt-in because a plugin's
command cannot be bound from config at all: opencode's `keybinds` schema is a
closed set built from its own command definitions, so there is no entry you
could add. Set `jumpKey` to rebind it, or to `false` to leave the palette entry
as the only way in.

### Options

| Option       | Default            | Meaning                                                         |
|--------------|--------------------|-----------------------------------------------------------------|
| `triggers`   | all five           | subset of `permission`, `question`, `idle`, `error`, `retry`    |
| `retryAfter` | `"30s"`            | how long a retry must last before it is worth a toast           |
| `maxToasts`  | `2`                | sessions named individually in a burst before aggregating       |
| `duration`   | `"5s"`             | full duration; queued toasts get half of it                     |
| `jumpKey`    | `"<leader>space"`  | sequence for the jump command, `false` to disable               |

## Updating

    git -C /path/to/opencode-sessions-watch pull

and restart opencode. The symlinks point into the checkout, so nothing else
changes.

This repository used to be called `opencode-sessions-sidebar`. GitHub keeps
redirecting the old name, so an existing clone goes on working, but you may want
to update its remote:

    git -C /path/to/checkout remote set-url origin \
        https://github.com/llucax/opencode-sessions-watch.git

## Uninstalling

Remove the symlink and the `tui.jsonc` entry, then restart opencode.

## Hacking on it

> [!WARNING]
> Keep the `.tsx` extension. opencode runs `babel-preset-solid` over plugin
> sources through a Bun loader filtered on
> `^(?!.*[/\\]node_modules[/\\]).*\.[cm]?[jt]sx(?:[?#].*)?$`, so a `.ts` file is
> loaded with no reactive transform. That failure is silent: the JSX still
> renders, once, and then never updates again.

Each plugin file is self-contained, with no shared module between them, because
the convention above is "symlink the plugin file" and a shared import would
break it. The duplication is a duration parser and a handful of `api.event.on`
lines; a module to save them would cost more than it returns.

Do not install `solid-js` or `@opentui/solid` next to a plugin when it runs
inside opencode. opencode rewrites those specifiers to its own already-loaded
instances, and a second copy risks a second reactive graph. The repository's
own `devDependencies`, used for type-checking and testing, are unaffected:
see [Development](#development).

Each sidebar row is deliberately a single `<text>` element. Siblings in a flex
row wrap independently once the sidebar is narrower than the row, which splits
the elapsed column across two lines and makes it read as part of the title.
Colour goes on the whole row because `<span>` carries no style options.

## Development

    bun install
    bun run typecheck
    bun test

`tsconfig.json` type-checks both plugins against the real `@opencode-ai/plugin`
and `@opentui/solid` types, pinned to the versions opencode itself loads.
`bunfig.toml` preloads `@opentui/solid/preload` for `bun test`, which gives
tests the same Solid transform opencode runs plugin sources through; a
top-level `preload` key is not enough, only the one under `[test]` is read.

`toDuration`, `toCount`, `select` and the other pure functions are exported
alongside the plugin's own `default`, purely so tests can reach them; opencode
only ever reads `module.default`; the extra names are otherwise inert.
`test/fake-api.ts` builds a narrow `TuiPluginApi` fake and a fake clock so the
stateful cores (`createModel`, `createWatcher`) can be driven through the
event stream and through time without a live TUI or a real sleep.

## License

MIT, see [LICENSE](LICENSE).
