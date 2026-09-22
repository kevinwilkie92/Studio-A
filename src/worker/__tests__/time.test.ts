import { describe, expect, it } from 'vitest'
import { dateKey, dayBounds, formatLocal, parseDateKey, toZonedParts, zonedToEpoch } from '../lib/time'

const NY = 'America/New_York'

describe('zonedToEpoch', () => {
  it('resolves a winter wall-clock time at UTC-5', () => {
    // 2026-01-15 09:00 EST == 14:00 UTC
    expect(zonedToEpoch(2026, 1, 15, 9 * 60, NY)).toBe(Date.UTC(2026, 0, 15, 14, 0) / 1000)
  })

  it('resolves a summer wall-clock time at UTC-4', () => {
    // 2026-07-15 09:00 EDT == 13:00 UTC
    expect(zonedToEpoch(2026, 7, 15, 9 * 60, NY)).toBe(Date.UTC(2026, 6, 15, 13, 0) / 1000)
  })

  it('keeps 9am at 9am across the spring-forward boundary', () => {
    // The Sunday clocks jump forward, and the Monday after. Both must read 9am
    // locally even though the UTC offset changed between them.
    const before = zonedToEpoch(2026, 3, 7, 9 * 60, NY)
    const after = zonedToEpoch(2026, 3, 9, 9 * 60, NY)
    expect(toZonedParts(before, NY).hour).toBe(9)
    expect(toZonedParts(after, NY).hour).toBe(9)
    // 2 days apart on the clock, but only 47 hours of real time.
    expect(after - before).toBe(47 * 3600)
  })

  it('keeps 9am at 9am across the fall-back boundary', () => {
    const before = zonedToEpoch(2026, 10, 31, 9 * 60, NY)
    const after = zonedToEpoch(2026, 11, 2, 9 * 60, NY)
    expect(toZonedParts(after, NY).hour).toBe(9)
    expect(after - before).toBe(49 * 3600)
  })

  it('round-trips through toZonedParts', () => {
    const epoch = zonedToEpoch(2026, 6, 4, 14 * 60 + 30, NY)
    const parts = toZonedParts(epoch, NY)
    expect(parts).toMatchObject({ year: 2026, month: 6, day: 4, hour: 14, minute: 30 })
  })

  it('handles zones that are ahead of UTC', () => {
    expect(zonedToEpoch(2026, 1, 15, 9 * 60, 'Asia/Tokyo')).toBe(Date.UTC(2026, 0, 15, 0, 0) / 1000)
  })
})

describe('dayBounds', () => {
  it('spans exactly 24 hours on an ordinary day', () => {
    const b = dayBounds('2026-06-10', NY)!
    expect(b.end - b.start).toBe(24 * 3600)
  })

  it('spans 23 hours on the spring-forward day', () => {
    const b = dayBounds('2026-03-08', NY)!
    expect(b.end - b.start).toBe(23 * 3600)
  })

  it('spans 25 hours on the fall-back day', () => {
    const b = dayBounds('2026-11-01', NY)!
    expect(b.end - b.start).toBe(25 * 3600)
  })

  it('rejects a malformed date', () => {
    expect(dayBounds('not-a-date', NY)).toBeNull()
  })
})

describe('parseDateKey', () => {
  it('accepts a well-formed key', () => {
    expect(parseDateKey('2026-02-09')).toEqual({ year: 2026, month: 2, day: 9 })
  })

  it.each(['2026-2-9', '26-02-09', '2026-13-01', '2026-02-32', ''])('rejects %s', (bad) => {
    expect(parseDateKey(bad)).toBeNull()
  })
})

describe('dateKey', () => {
  it('uses the salon timezone, not UTC', () => {
    // 2026-01-16 02:00 UTC is still the 15th in New York.
    const epoch = Date.UTC(2026, 0, 16, 2, 0) / 1000
    expect(dateKey(epoch, NY)).toBe('2026-01-15')
    expect(dateKey(epoch, 'UTC')).toBe('2026-01-16')
  })
})

describe('formatLocal', () => {
  it('renders a human-readable local time', () => {
    const epoch = zonedToEpoch(2026, 3, 4, 14 * 60 + 30, NY)
    expect(formatLocal(epoch, NY)).toBe('Wed, Mar 4 at 2:30 PM')
  })
})
