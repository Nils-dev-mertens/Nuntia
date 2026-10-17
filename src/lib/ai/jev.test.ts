import { describe, expect, test } from 'bun:test'

import type { DecisionInput, RuleFacts } from '#/lib/conversation/index.ts'

import { JevDecisionModel } from './jev.ts'
import type { FetchLike } from './http.ts'

const INPUT: DecisionInput = {
  subject: 'Payouts failing',
  messages: [],
  ownerEmail: 'me@example.com',
  goal: null,
  decidedAt: null,
}

const RULES_ABSTAINED: RuleFacts = {
  state: null,
  awaitingReply: false,
  requiresReply: false,
  isAutomated: false,
  senderUnreplyable: false,
  placeholderImportance: 5,
  placeholderUrgency: 5,
  reasoning: 'Last message was informational.',
}

const RULES_DECIDED: RuleFacts = {
  ...RULES_ABSTAINED,
  state: 'waiting-for-reply',
  awaitingReply: true,
  placeholderImportance: 6,
  placeholderUrgency: 4,
}

function json(status: number, body: unknown) {
  return { status, text: async () => JSON.stringify(body) }
}

describe('JevDecisionModel', () => {
  test('maps score answers onto 1..10 and fills the state the rules could not', async () => {
    const fetchImpl: FetchLike = async (url, init) => {
      expect(url).toBe('https://api.typesafe.ai/v1/systemone')
      expect(init.headers.authorization).toBe('Bearer k')

      const body = JSON.parse(init.body) as {
        model: string
        questions: Record<string, unknown>
      }
      expect(body.model).toBe('jev-latest')
      // The rules abstained, so the state question is asked.
      expect(body.questions.state).toBeDefined()
      // A thread with a human on it is asked about replyability.
      expect(body.questions.replyable).toBeDefined()

      return json(200, {
        model: 'jev-1.13.0',
        answers: {
          importance: { type: 'score', score: 6.4 },
          urgency: { type: 'score', score: 8.2 },
          state: { type: 'choice', choice: 'needs-action' },
          replyable: { type: 'choice', choice: 'replyable' },
        },
        usage: { input_tokens: 296, output_tokens: 20 },
      })
    }

    const model = new JevDecisionModel({
      apiKey: 'k',
      model: 'jev-latest',
      fetchImpl,
    })
    const verdict = await model.decide(INPUT, RULES_ABSTAINED)

    expect(verdict.importance).toBe(7)
    expect(verdict.urgency).toBe(9)
    expect(verdict.state).toBe('needs-action')
    expect(verdict.replyable).toBe(true)
    expect(verdict.reasoning).toBeTruthy()
  })

  test('skips the replyability question for machine mail', async () => {
    let askedReplyable = true
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(init.body) as {
        questions: Record<string, unknown>
      }
      askedReplyable = 'replyable' in body.questions
      return json(200, { answers: {} })
    }

    const model = new JevDecisionModel({
      apiKey: 'k',
      model: 'jev-latest',
      fetchImpl,
    })
    const verdict = await model.decide(INPUT, {
      ...RULES_ABSTAINED,
      isAutomated: true,
    })

    expect(askedReplyable).toBe(false)
    // No opinion, so the rules' "machine mail is not replyable" stands.
    expect(verdict.replyable).toBeNull()
  })

  test('skips the replyability question for a sender the user marked', async () => {
    // The user's own answer about the sender is not a hint to be weighed against
    // the model's; it is the answer, so the question is never asked.
    let askedReplyable = true
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(init.body) as {
        questions: Record<string, unknown>
      }
      askedReplyable = 'replyable' in body.questions
      return json(200, { answers: {} })
    }

    const model = new JevDecisionModel({
      apiKey: 'k',
      model: 'jev-latest',
      fetchImpl,
    })
    const verdict = await model.decide(INPUT, {
      ...RULES_ABSTAINED,
      senderUnreplyable: true,
    })

    expect(askedReplyable).toBe(false)
    expect(verdict.replyable).toBeNull()
  })

  test('treats the no-reply choice as not replyable', async () => {
    const fetchImpl: FetchLike = async () =>
      json(200, {
        answers: { replyable: { type: 'choice', choice: 'no-reply' } },
      })

    const model = new JevDecisionModel({ apiKey: 'k', model: 'jev-latest', fetchImpl })
    const verdict = await model.decide(INPUT, RULES_ABSTAINED)

    expect(verdict.replyable).toBe(false)
  })

  test('asks about state when the rules claimed needs-action, and takes the answer', async () => {
    let askedState = false
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(init.body) as {
        questions: Record<string, unknown>
      }
      askedState = 'state' in body.questions
      return json(200, {
        answers: {
          importance: { type: 'score', score: 3 },
          urgency: { type: 'score', score: 2 },
          state: { type: 'choice', choice: 'informational' },
        },
      })
    }

    const model = new JevDecisionModel({
      apiKey: 'k',
      model: 'jev-latest',
      fetchImpl,
    })
    const verdict = await model.decide(INPUT, {
      ...RULES_ABSTAINED,
      state: 'needs-action',
      requiresReply: true,
    })

    // A rule claiming action is the claim most worth a second opinion...
    expect(askedState).toBe(true)
    // ...and the answer is what lets `foldState` drop it.
    expect(verdict.state).toBe('informational')
  })

  test('keeps the rule when the model does not answer the state question', async () => {
    const fetchImpl: FetchLike = async () => json(200, { answers: {} })
    const model = new JevDecisionModel({
      apiKey: 'k',
      model: 'jev-latest',
      fetchImpl,
    })
    const verdict = await model.decide(INPUT, {
      ...RULES_ABSTAINED,
      state: 'needs-action',
      requiresReply: true,
    })

    // `null` is "no opinion", so the fold keeps the rule's `needs-action`.
    expect(verdict.state).toBeNull()
  })

  test('does not ask for state when the rules decided, and keeps the placeholders on a sparse reply', async () => {
    let askedState = true
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(init.body) as {
        questions: Record<string, unknown>
      }
      askedState = 'state' in body.questions
      // No answers at all — a malformed or empty response.
      return json(200, { answers: {} })
    }

    const model = new JevDecisionModel({
      apiKey: 'k',
      model: 'jev-latest',
      fetchImpl,
    })
    const verdict = await model.decide(INPUT, RULES_DECIDED)

    expect(askedState).toBe(false)
    expect(verdict.state).toBeNull()
    // Falls back to the rule placeholders rather than inventing a value.
    expect(verdict.importance).toBe(6)
    expect(verdict.urgency).toBe(4)
    // Sparse reply: no replyability answer, so the rule outcome stands.
    expect(verdict.replyable).toBeNull()
  })

  test('clamps an out-of-range score into 1..10', async () => {
    const fetchImpl: FetchLike = async () =>
      json(200, {
        answers: {
          importance: { type: 'score', score: 99 },
          urgency: { type: 'score', score: -5 },
        },
      })

    const model = new JevDecisionModel({ apiKey: 'k', model: 'jev-latest', fetchImpl })
    const verdict = await model.decide(INPUT, RULES_ABSTAINED)

    expect(verdict.importance).toBe(10)
    expect(verdict.urgency).toBe(1)
  })
})
