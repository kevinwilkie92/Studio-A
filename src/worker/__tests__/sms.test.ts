import { describe, expect, it } from 'vitest'
import { classifyInbound, renderTemplate, segmentCount, verifyTwilioSignature } from '../lib/sms'
import { normalizePhone, formatPhone } from '../lib/phone'
import { appendFooter } from '../lib/messaging'

describe('normalizePhone', () => {
  it.each([
    ['(804) 555-1234', '+18045551234'],
    ['804-555-1234', '+18045551234'],
    ['8045551234', '+18045551234'],
    ['18045551234', '+18045551234'],
    ['+1 804 555 1234', '+18045551234'],
    ['+44 20 7946 0958', '+442079460958'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected)
  })

  it.each(['', '   ', 'not a phone', '12345', null, undefined])('rejects %s', (bad) => {
    expect(normalizePhone(bad)).toBeNull()
  })
})

describe('formatPhone', () => {
  it('formats US numbers and passes others through', () => {
    expect(formatPhone('+18045551234')).toBe('(804) 555-1234')
    expect(formatPhone('+442079460958')).toBe('+442079460958')
    expect(formatPhone(null)).toBe('')
  })
})

describe('classifyInbound', () => {
  it.each(['STOP', 'stop', ' Stop! ', 'UNSUBSCRIBE', 'quit'])('treats %s as an opt-out', (word) => {
    expect(classifyInbound(word)).toBe('stop')
  })

  it.each(['START', 'unstop', 'YES'])('treats %s as an opt-in', (word) => {
    expect(classifyInbound(word)).toBe('start')
  })

  it('does not mistake a sentence containing "stop" for an opt-out', () => {
    expect(classifyInbound('can you stop by earlier?')).toBe('other')
  })

  it('recognizes HELP', () => {
    expect(classifyInbound('help')).toBe('help')
  })
})

describe('segmentCount', () => {
  it('counts a short GSM message as one segment', () => {
    expect(segmentCount('See you Tuesday!')).toMatchObject({ segments: 1, encoding: 'GSM-7' })
  })

  it('switches to 153-char segments once GSM text spills over', () => {
    expect(segmentCount('a'.repeat(160)).segments).toBe(1)
    expect(segmentCount('a'.repeat(161)).segments).toBe(2)
    expect(segmentCount('a'.repeat(306)).segments).toBe(2)
    expect(segmentCount('a'.repeat(307)).segments).toBe(3)
  })

  it('drops to UCS-2 limits when an emoji appears', () => {
    const body = `${'a'.repeat(70)}💇`
    const result = segmentCount(body)
    expect(result.encoding).toBe('UCS-2')
    expect(result.segments).toBe(2)
  })

  it('counts an empty body as zero segments', () => {
    expect(segmentCount('').segments).toBe(0)
  })
})

describe('renderTemplate', () => {
  it('substitutes known placeholders and leaves unknown ones alone', () => {
    expect(renderTemplate('Hi {{first_name}}, from {{salon_name}}. {{mystery}}', {
      first_name: 'Dana', salon_name: 'Studio A',
    })).toBe('Hi Dana, from Studio A. {{mystery}}')
  })

  it('tolerates whitespace inside the braces', () => {
    expect(renderTemplate('Hi {{ first_name }}', { first_name: 'Dana' })).toBe('Hi Dana')
  })
})

describe('appendFooter', () => {
  it('adds the opt-out line', () => {
    expect(appendFooter('Openings Friday!', 'Reply STOP to opt out.'))
      .toBe('Openings Friday!\nReply STOP to opt out.')
  })

  it('does not double up when the copy already says STOP', () => {
    const body = 'Openings Friday! Reply STOP to opt out.'
    expect(appendFooter(body, 'Reply STOP to opt out.')).toBe(body)
  })

  it('is a no-op when no footer is configured', () => {
    expect(appendFooter('Hello', '  ')).toBe('Hello')
  })
})

describe('verifyTwilioSignature', () => {
  // Expected value computed by an independent HMAC-SHA1 implementation over
  // Twilio's documented string (full URL + params sorted by key, concatenated),
  // so this pins the algorithm rather than restating our own output.
  const token = '12345'
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2'
  const params = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' }

  it('accepts the signature Twilio would send', async () => {
    expect(await verifyTwilioSignature(token, url, params, '0/KCTR6DLpKmkAf8muzZqo1nDgQ=')).toBe(true)
  })

  it('rejects a tampered signature', async () => {
    expect(await verifyTwilioSignature(token, url, params, 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=')).toBe(false)
  })

  it('rejects when a parameter was changed', async () => {
    expect(await verifyTwilioSignature(
      token, url, { ...params, Digits: '9999' }, '0/KCTR6DLpKmkAf8muzZqo1nDgQ=',
    )).toBe(false)
  })
})
