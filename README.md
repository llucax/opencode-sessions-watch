# opencode sessions sidebar

A TUI plugin for [opencode](https://opencode.ai) that adds a panel to the
sidebar listing the sessions of the current project, grouped by whether they are
waiting on you, freshly idle, retrying, working, or idle for longer, each with
how long it has been that way.

    Active Sessions
    ❓ (<1m) Fix the flaky reconnect test
    ❓ ( 5m) Draft the release notes
    ✅ ( 2m) Review PR 412
    ✅ (11m) Add the --json flag
    🔄 (47m) Port the parser to nom 8
    ⚙️ ( 2h) Rewrite the config loader
    💤 ( 1d) Look into the CI cache

    Current Session Tasks
    ⚙️ ( 8m) explore: find the retry logic

| Icon | Group       | Meaning                                           |
|------|-------------|---------------------------------------------------|
| ❓   | `waiting`   | a permission or question is awaiting a reply      |
| ✅   | `idleFresh` | stopped within `idleFreshAge`; probably wants you |
| 🔄   | `retry`     | a provider call failed and is being retried       |
| ⚙️   | `working`   | the agent is running                              |
| 💤   | `idle`      | stopped longer ago; history                       |

Groups are listed in that order: waiting blocks on you, a session that has just
stopped most likely wants you now, retry is quietly stalling, working is fine,
older idle is history. Fresh outranks retry because a session that stopped needs
a human and a retry is recovering on its own.

The panel covers one project, the one the TUI is running in; sessions belonging
to any other project are not listed.

Durations are measured by the plugin while it runs, because nothing in the
opencode API records when a session entered its current state. A session first
seen already idle is dated from when it was last updated, rather than from when
the plugin noticed it.

Developed against opencode 1.18.25. It needs a version carrying the TUI plugin
API and its `sidebar_content` sidebar slot. There is nothing to install beyond
the file itself: `@opentui/solid` and `solid-js` come from opencode's own
runtime, and the `@opencode-ai` imports are types, erased before the file runs.

## Installing

Clone this repository wherever you keep plugin checkouts:

    git clone https://github.com/llucax/opencode-sessions-sidebar

Symlink the plugin into your opencode plugin directory:

    mkdir -p ~/.config/opencode/plugins
    ln -s "$PWD/opencode-sessions-sidebar/sessions-sidebar.tsx" \
          ~/.config/opencode/plugins/

Then register it in `~/.config/opencode/tui.jsonc`, creating the file if you do
not have one:

    {
      "$schema": "https://opencode.ai/tui.json",
      "plugin": [
        "./plugins/sessions-sidebar.tsx"
      ]
    }

Paths in `plugin` are resolved against the directory holding `tui.jsonc`, so
`./plugins/sessions-sidebar.tsx` finds the symlink you just made.

The symlink is a convenience, not a requirement: pointing `plugin` straight at
the file in the checkout works too. It buys you a `tui.jsonc` that does not
mention where your checkouts live.

Restart opencode. The panel appears in the sidebar once there is something to
list; it renders nothing at all when no session qualifies.

> [!IMPORTANT]
> The `tui.jsonc` entry is not optional. opencode scans
> `~/.config/opencode/plugins/` for *server* plugins only, and the glob it uses
> is `{plugin,plugins}/*.{ts,js}`, which does not match `.tsx` at all. A TUI
> plugin left in that directory without a `tui.jsonc` entry is simply never
> loaded, silently.

## Options

Give the entry as a two-element array to pass options. A bare string gets the
defaults.

    "plugin": [
      ["./plugins/sessions-sidebar.tsx", { "idleMaxAge": "2h", "showCurrent": true }]
    ]

| Option           | Default     | Meaning                                                           |
|------------------|-------------|-------------------------------------------------------------------|
| `idleFreshAge`   | `"15m"`     | idle for less than this counts as fresh rather than history       |
| `idleMaxAge`     | `"1h"`      | hide idle sessions older than this                                |
| `alwaysShowIdle` | `1`         | show this many most recent `idle` rows regardless of age          |
| `maxTotal`       | unlimited   | cap on rows in the main list                                      |
| `maxPerState`    | unlimited   | per-group caps: `{ waiting, idleFresh, retry, working, idle }`    |
| `showCurrent`    | `false`     | pin the session being viewed at the top, bold and accent-coloured |
| `subagents`      | `"section"` | how Task-tool child sessions appear, see below                    |

Durations are written as a string pairing a number with a unit, one of `ms`,
`s`, `m`, `h` or `d`; a bare number is read as milliseconds. A count given as
`null` means unlimited.

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

## Updating

    git -C /path/to/opencode-sessions-sidebar pull

and restart opencode. The symlink points into the checkout, so nothing else
changes.

## Uninstalling

Remove the symlink and the `tui.jsonc` entry, then restart opencode.

## Hacking on it

> [!WARNING]
> Keep the `.tsx` extension. opencode runs `babel-preset-solid` over plugin
> sources through a Bun loader filtered on
> `^(?!.*[/\\]node_modules[/\\]).*\.[cm]?[jt]sx(?:[?#].*)?$`, so a `.ts` file is
> loaded with no reactive transform. That failure is silent: the JSX still
> renders, once, and then never updates again.

Do not install `solid-js` or `@opentui/solid` next to the plugin. opencode
rewrites those specifiers to its own already-loaded instances, and a second copy
risks a second reactive graph. To type-check the file, put the dependencies in a
scratch directory and point `tsc` at the plugin from there.

Each row is deliberately a single `<text>` element. Siblings in a flex row wrap
independently once the sidebar is narrower than the row, which splits the
elapsed column across two lines and makes it read as part of the title. Colour
goes on the whole row because `<span>` carries no style options.

## License

MIT, see [LICENSE](LICENSE).
