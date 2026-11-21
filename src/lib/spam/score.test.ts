import { describe, expect, it } from 'bun:test'

import { judgeSpam, spamScore, spamSignals } from './score.ts'

function message(overrides: Partial<Parameters<typeof spamScore>[0]> = {}) {
  return {
    from: 'sarah@acme.com',
    fromName: 'Sarah Chen',
    subject: 'Tuesday launch',
    body: 'Can you confirm the launch on Tuesday?',
    ...overrides,
  }
}

describe('spamSignals', () => {
  it('raises nothing for ordinary correspondence', () => {
    expect(spamSignals(message())).toEqual([])
    expect(spamScore(message())).toBe(0)
  })

  it('does not treat one urgency phrase as spam on its own', () => {
    const verdict = judgeSpam(
      message({ subject: 'Final notice', body: 'Invoice attached.' }),
    )
    expect(verdict.spam).toBe(false)
  })

  it('catches a brand display name on the wrong domain beside a phishing ask', () => {
    const verdict = judgeSpam(
      message({
        from: 'billing@paypa1-support.com',
        fromName: 'PayPal Support',
        subject: 'Verify your account',
        body: 'Click here to verify your account within 24 hours.',
      }),
    )
    expect(verdict.spam).toBe(true)
    expect(verdict.reasons.length).toBeGreaterThanOrEqual(2)
  })

  it('flags a punycode domain with a prize promise', () => {
    const verdict = judgeSpam(
      message({
        from: 'winner@xn--exmple-cua.com',
        fromName: null,
        subject: 'You have won a prize',
        body: 'Claim your prize now.',
      }),
    )
    expect(verdict.spam).toBe(true)
  })
})

describe('judgeSpam', () => {
  it('treats a matching user rule as decisive', () => {
    const verdict = judgeSpam(message(), {
      ruleReasons: ['matches your spam rule "acme.com"'],
    })
    expect(verdict.spam).toBe(true)
  })

  it('treats a learned sender as decisive', () => {
    const verdict = judgeSpam(message(), { learnedSender: true })
    expect(verdict.spam).toBe(true)
  })
})
