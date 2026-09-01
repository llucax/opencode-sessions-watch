import { describe, expect, test } from "bun:test"
import { toCount, toDuration, toOptions } from "../sessions-sidebar.tsx"

describe("toDuration", () => {
  test("passes a finite number through unchanged", () => {
    expect(toDuration(1234, 0)).toBe(1234)
  })

  test("falls back on a non-finite number", () => {
    expect(toDuration(Number.NaN, 99)).toBe(99)
    expect(toDuration(Number.POSITIVE_INFINITY, 99)).toBe(99)
  })

  test.each([
    ["500ms", 500],
    ["500 ms", 500],
    ["30s", 30_000],
    ["15m", 15 * 60_000],
    ["2h", 2 * 3_600_000],
    ["1d", 86_400_000],
    ["1.5s", 1_500],
  ])("parses %s as %d ms", (value, expected) => {
    expect(toDuration(value, 0)).toBe(expected)
  })

  test("falls back on an unparsable string", () => {
    expect(toDuration("soon", 42)).toBe(42)
    expect(toDuration("15 weeks", 42)).toBe(42)
  })

  test("falls back on a value that is neither a number nor a string", () => {
    expect(toDuration(undefined, 42)).toBe(42)
    expect(toDuration(null, 42)).toBe(42)
    expect(toDuration({}, 42)).toBe(42)
  })
})

describe("toCount", () => {
  // Pinned intentionally: the sidebar treats null as infinity (no cap) and
  // accepts zero (a valid, if unusual, cap). See the toast's toCount test for
  // the deliberately different behaviour.
  test("treats null as infinity", () => {
    expect(toCount(null, 5)).toBe(Number.POSITIVE_INFINITY)
  })

  test("accepts zero", () => {
    expect(toCount(0, 5)).toBe(0)
  })

  test("floors a fractional count", () => {
    expect(toCount(3.9, 5)).toBe(3)
  })

  test("falls back on a negative, non-finite or non-number value", () => {
    expect(toCount(-1, 5)).toBe(5)
    expect(toCount(Number.NaN, 5)).toBe(5)
    expect(toCount("3", 5)).toBe(5)
    expect(toCount(undefined, 5)).toBe(5)
  })
})

describe("toOptions", () => {
  test("returns the defaults when raw is undefined", () => {
    const options = toOptions(undefined)
    expect(options.idleFreshAge).toBe(15 * 60 * 1000)
    expect(options.idleMaxAge).toBe(60 * 60 * 1000)
    expect(options.alwaysShowIdle).toBe(1)
    expect(options.maxTotal).toBe(Number.POSITIVE_INFINITY)
    expect(options.showCurrent).toBe(false)
    expect(options.subagents).toBe("section")
    expect(options.maxPerState).toEqual({
      waiting: Number.POSITIVE_INFINITY,
      idleFresh: Number.POSITIVE_INFINITY,
      retry: Number.POSITIVE_INFINITY,
      working: Number.POSITIVE_INFINITY,
      idle: Number.POSITIVE_INFINITY,
    })
  })

  test("parses every field from raw", () => {
    const options = toOptions({
      idleFreshAge: "5m",
      idleMaxAge: "2h",
      alwaysShowIdle: 3,
      maxTotal: 20,
      showCurrent: true,
      subagents: "tree",
      maxPerState: { waiting: 1, working: 0 },
    })
    expect(options.idleFreshAge).toBe(5 * 60_000)
    expect(options.idleMaxAge).toBe(2 * 3_600_000)
    expect(options.alwaysShowIdle).toBe(3)
    expect(options.maxTotal).toBe(20)
    expect(options.showCurrent).toBe(true)
    expect(options.subagents).toBe("tree")
    // Only waiting and working were named; the rest keep the default.
    expect(options.maxPerState).toEqual({
      waiting: 1,
      idleFresh: Number.POSITIVE_INFINITY,
      retry: Number.POSITIVE_INFINITY,
      working: 0,
      idle: Number.POSITIVE_INFINITY,
    })
  })

  test("falls back to the default subagents mode on an unknown value", () => {
    expect(toOptions({ subagents: "everywhere" }).subagents).toBe("section")
  })

  test("ignores a non-boolean showCurrent", () => {
    expect(toOptions({ showCurrent: "yes" }).showCurrent).toBe(false)
  })

  describe("icons", () => {
    const defaults = {
      waiting: "\u003F",
      idleFresh: "\u2713",
      retry: "\u21BB",
      working: "\u23F5",
      idle: "\u2504",
    }

    test("defaults to the width-one glyphs when absent", () => {
      expect(toOptions(undefined).icons).toEqual(defaults)
      expect(toOptions({}).icons).toEqual(defaults)
    })

    test("merges a partial override over the defaults", () => {
      expect(toOptions({ icons: { waiting: "!" } }).icons).toEqual({ ...defaults, waiting: "!" })
    })

    test("ignores unknown state keys", () => {
      expect(toOptions({ icons: { bogus: "!" } }).icons).toEqual(defaults)
    })

    test("ignores a non-string value for a known state", () => {
      expect(toOptions({ icons: { waiting: 42 } }).icons).toEqual(defaults)
    })

    test("rejects a non-object icons wholesale, keeping every default", () => {
      expect(toOptions({ icons: "nope" }).icons).toEqual(defaults)
    })

    test("accepts an explicit emoji override, unvalidated", () => {
      expect(toOptions({ icons: { working: "\u2699\uFE0F" } }).icons.working).toBe("\u2699\uFE0F")
    })
  })
})
