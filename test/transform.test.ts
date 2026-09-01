import { describe, expect, test } from "bun:test"

// Retires tmp/solid-probe/probe.mjs. That script ran the plugin files
// through opencode's exact babel invocation and printed the result for a
// human to squint at. This proves the same transform, through the same
// bunfig.toml [test] preload, by loading the modules for real: a transform
// that silently produced garbage fails an import or an assertion instead of
// scrolling past unread.
//
// sessions-toast.tsx carries no JSX, so it would load fine either way; it is
// asserted here anyway so a regression that added JSX to it would not go
// unnoticed.

describe("both plugins load through the Solid transform", () => {
  test("sessions-sidebar", async () => {
    const sidebar = await import("../sessions-sidebar.tsx")
    expect(sidebar.default.id).toBe("sessions-sidebar")
    expect(typeof sidebar.default.tui).toBe("function")
  })

  test("sessions-toast", async () => {
    const toast = await import("../sessions-toast.tsx")
    expect(toast.default.id).toBe("sessions-toast")
    expect(typeof toast.default.tui).toBe("function")
  })
})
