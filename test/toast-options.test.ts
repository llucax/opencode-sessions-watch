import { describe, expect, test } from "bun:test"
import { errorMessage, titleOf, toCount, toDuration, toJumpKey, toOptions, toTriggers, truncate } from "../sessions-toast.tsx"
import type { Session } from "@opencode-ai/sdk/v2"

// Copied from the sidebar rather than shared, per the plugin file's own
// comment: the distribution convention is "symlink the plugin file", so the
// two duplicate a handful of lines instead of importing from each other.
// These tests duplicate the sidebar's toDuration cases for the same reason.
describe("toDuration", () => {
  test("passes a finite number through unchanged", () => {
    expect(toDuration(1234, 0)).toBe(1234)
  })

  test.each([
    ["500ms", 500],
    ["30s", 30_000],
    ["15m", 15 * 60_000],
    ["2h", 2 * 3_600_000],
    ["1d", 86_400_000],
  ])("parses %s as %d ms", (value, expected) => {
    expect(toDuration(value, 0)).toBe(expected)
  })

  test("falls back on an unparsable value", () => {
    expect(toDuration("soon", 42)).toBe(42)
    expect(toDuration(undefined, 42)).toBe(42)
  })
})

describe("toCount", () => {
  // Pinned intentionally, and deliberately the opposite of the sidebar's
  // toCount: here null falls back rather than meaning infinity, and zero is
  // rejected rather than accepted, because maxToasts: 0 would otherwise mean
  // "queue forever and show nothing", not "no cap".
  test("falls back on null rather than treating it as infinity", () => {
    expect(toCount(null, 2)).toBe(2)
  })

  test("rejects zero", () => {
    expect(toCount(0, 2)).toBe(2)
  })

  test("floors a fractional count", () => {
    expect(toCount(3.9, 2)).toBe(3)
  })

  test("falls back on a negative, non-finite or non-number value", () => {
    expect(toCount(-1, 2)).toBe(2)
    expect(toCount(Number.NaN, 2)).toBe(2)
    expect(toCount("3", 2)).toBe(2)
  })
})

describe("toTriggers", () => {
  test("falls back when raw is not an array", () => {
    const fallback = new Set(["idle"] as const)
    expect(toTriggers("permission", fallback)).toBe(fallback)
    expect(toTriggers(undefined, fallback)).toBe(fallback)
  })

  test("keeps only recognised triggers", () => {
    const result = toTriggers(["permission", "bogus", "retry", "retry"], new Set())
    expect([...result].sort()).toEqual(["permission", "retry"])
  })
})

describe("toJumpKey", () => {
  test("keeps false as-is", () => {
    expect(toJumpKey(false, "<leader>space")).toBe(false)
  })

  test("falls back on a non-string", () => {
    expect(toJumpKey(42, "<leader>space")).toBe("<leader>space")
  })

  test("trims and keeps a non-empty string", () => {
    expect(toJumpKey("  <leader>x  ", "<leader>space")).toBe("<leader>x")
  })

  test("treats a blank string as false", () => {
    expect(toJumpKey("   ", "<leader>space")).toBe(false)
  })
})

describe("toOptions", () => {
  test("returns the defaults when raw is undefined", () => {
    const options = toOptions(undefined)
    expect(options.retryAfter).toBe(30_000)
    expect(options.maxToasts).toBe(2)
    expect(options.duration).toBe(5_000)
    expect(options.jumpKey).toBe("<leader>space")
    expect([...options.triggers].sort()).toEqual(["error", "idle", "permission", "question", "retry"])
  })

  test("parses every field from raw", () => {
    const options = toOptions({
      triggers: ["idle", "error"],
      retryAfter: "1m",
      maxToasts: 4,
      duration: "2s",
      jumpKey: false,
    })
    expect([...options.triggers].sort()).toEqual(["error", "idle"])
    expect(options.retryAfter).toBe(60_000)
    expect(options.maxToasts).toBe(4)
    expect(options.duration).toBe(2_000)
    expect(options.jumpKey).toBe(false)
  })
})

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_1",
    slug: "slug-1",
    projectID: "prj_1",
    directory: "/tmp/project",
    title: "",
    version: "1",
    time: { created: 0, updated: 0 },
    ...overrides,
  }
}

describe("titleOf", () => {
  test("prefers the title", () => {
    expect(titleOf(session({ title: "Fix the bug", slug: "fix-bug" }))).toBe("Fix the bug")
  })

  test("falls back to the slug when there is no title", () => {
    expect(titleOf(session({ title: "", slug: "fix-bug" }))).toBe("fix-bug")
  })

  test("falls back to the id when there is neither", () => {
    expect(titleOf(session({ title: "", slug: "" }))).toBe("ses_1")
  })
})

describe("truncate", () => {
  test("leaves a short string alone", () => {
    expect(truncate("short", 10)).toBe("short")
  })

  test("truncates a long string and adds an ellipsis", () => {
    expect(truncate("a very long line of text", 10)).toBe("a very lo\u2026")
  })
})

describe("errorMessage", () => {
  test("reads aborted sessions specially", () => {
    expect(errorMessage({ name: "MessageAbortedError" })).toBe("Session aborted")
  })

  test("rewords a stalled stream", () => {
    expect(errorMessage({ data: { message: "SSE read timed out" } })).toBe("Model stopped responding")
  })

  test("passes through any other message", () => {
    expect(errorMessage({ data: { message: "rate limited" } })).toBe("rate limited")
  })

  test("falls back when there is no message at all", () => {
    expect(errorMessage({})).toBe("Session error")
    expect(errorMessage(undefined)).toBe("Session error")
  })
})
