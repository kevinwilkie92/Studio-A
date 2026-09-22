import { describe, expect, it } from 'vitest'
import { overlaps, slotsForWindow, workingWindows } from '../lib/availability'
import { zonedToEpoch } from '../lib/time'

const NY = 'America/New_York'
const HOUR = 3600
const MIN = 60

/** 2026-06-10 is a Wednesday (weekday 3). */
const DAY = '2026-06-10'
const at = (h: number, m = 0) => zonedToEpoch(2026, 6, 10, h * 60 + m, NY)

describe('overlaps', () => {
  it('is false for intervals that merely touch', () => {
    expect(overlaps({ start: 0, end: 100 }, { start: 100, end: 200 })).toBe(false)
  })

  it('is true for a partial overlap in either direction', () => {
    expect(overlaps({ start: 0, end: 150 }, { start: 100, end: 200 })).toBe(true)
    expect(overlaps({ start: 100, end: 200 }, { start: 0, end: 150 })).toBe(true)
  })

  it('is true when one interval contains the other', () => {
    expect(overlaps({ start: 0, end: 500 }, { start: 100, end: 200 })).toBe(true)
  })
})

describe('workingWindows', () => {
  const hours = [
    { weekday: 3, start_min: 9 * 60, end_min: 17 * 60 },   // Wednesday
    { weekday: 4, start_min: 10 * 60, end_min: 18 * 60 },  // Thursday
  ]

  it('picks only the shifts for that weekday', () => {
    const windows = workingWindows(hours, DAY, NY)
    expect(windows).toHaveLength(1)
    expect(windows[0]).toEqual({ start: at(9), end: at(17) })
  })

  it('returns nothing on a day with no shift', () => {
    expect(workingWindows(hours, '2026-06-14', NY)).toEqual([]) // Sunday
  })

  it('handles a split shift, sorted by start', () => {
    const split = [
      { weekday: 3, start_min: 14 * 60, end_min: 18 * 60 },
      { weekday: 3, start_min: 9 * 60, end_min: 12 * 60 },
    ]
    expect(workingWindows(split, DAY, NY).map((w) => w.start)).toEqual([at(9), at(14)])
  })
})

describe('slotsForWindow', () => {
  const window = [{ start: at(9), end: at(12) }]

  it('steps through the window at the slot interval', () => {
    const slots = slotsForWindow(window, [], 60 * MIN, 30 * MIN, 0, 0)
    expect(slots).toEqual([at(9), at(9, 30), at(10), at(10, 30), at(11)])
  })

  it('never returns a slot that would run past the window', () => {
    const slots = slotsForWindow(window, [], 90 * MIN, 30 * MIN, 0, 0)
    expect(slots.at(-1)! + 90 * MIN).toBeLessThanOrEqual(at(12))
  })

  it('skips slots that collide with an existing appointment', () => {
    const busy = [{ start: at(10), end: at(11) }]
    const slots = slotsForWindow(window, busy, 60 * MIN, 30 * MIN, 0, 0)
    expect(slots).toEqual([at(9), at(11)])
  })

  it('applies the buffer on both sides of a booking', () => {
    const busy = [{ start: at(10), end: at(11) }]
    const slots = slotsForWindow(window, busy, 30 * MIN, 30 * MIN, 15 * MIN, 0)
    // 9:30-10:00 now touches the 15-minute pre-buffer, and 11:00 the post one.
    expect(slots).toEqual([at(9), at(11, 30)])
  })

  it('honours the earliest bookable moment', () => {
    const slots = slotsForWindow(window, [], 60 * MIN, 30 * MIN, 0, at(10, 15))
    expect(slots[0]).toBe(at(10, 30))
  })

  it('returns nothing when the appointment is longer than the window', () => {
    expect(slotsForWindow(window, [], 4 * HOUR, 30 * MIN, 0, 0)).toEqual([])
  })

  it('treats an all-day block as fully busy', () => {
    const busy = [{ start: at(8), end: at(18) }]
    expect(slotsForWindow(window, busy, 30 * MIN, 30 * MIN, 0, 0)).toEqual([])
  })

  it('walks each window of a split shift independently', () => {
    const split = [{ start: at(9), end: at(10) }, { start: at(14), end: at(15) }]
    expect(slotsForWindow(split, [], 60 * MIN, 30 * MIN, 0, 0)).toEqual([at(9), at(14)])
  })
})
