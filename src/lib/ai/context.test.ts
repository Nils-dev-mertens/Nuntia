import { describe, expect, test } from 'bun:test'

import { parseContextUpdate } from './context.ts'

describe('parseContextUpdate', () => {
  test('reads the three fields out of one JSON answer', () => {
    expect(
      parseContextUpdate(
        JSON.stringify({
          topic: '"Launch schedule."',
          goal: 'Confirm the Tuesday launch date.',
          contact: {
            roleCompany: 'Northwind, PM',
            relationship: 'Colleague',
            topics: 'Launch planning',
            currentWork: 'Coordinating the Q3 release',
          },
        }),
      ),
    ).toEqual({
      topic: 'Launch schedule',
      goal: 'Confirm the Tuesday launch date.',
      contact: {
        roleCompany: 'Northwind, PM',
        relationship: 'Colleague',
        topics: 'Launch planning',
        currentWork: 'Coordinating the Q3 release',
      },
      labelId: null,
    })
  })

  test('keeps the tags a refresh proposed, and an empty list as an answer', () => {
    const withTags = parseContextUpdate(
      JSON.stringify({
        topic: 'Launch',
        contact: { tags: [' investor ', 'Acme', 'acme'] },
      }),
    )
    // Cleaned and de-duplicated on the way in, so the writer only ever sees
    // tags it can store.
    expect(withTags?.contact?.tags).toEqual(['investor', 'Acme'])

    // A missing key means the prompt said nothing about tags, so the writer must
    // leave the stored ones alone; an empty array is the model's "none fit".
    const withoutTags = parseContextUpdate(
      JSON.stringify({
        topic: 'Launch',
        contact: { relationship: 'Colleague' },
      }),
    )
    expect(withoutTags?.contact).not.toHaveProperty('tags')

    const cleared = parseContextUpdate(
      JSON.stringify({ topic: 'Launch', contact: { tags: [] } }),
    )
    expect(cleared?.contact?.tags).toEqual([])
  })

  test('tolerates a fenced block and surrounding prose', () => {
    const parsed = parseContextUpdate(
      'Here you go:\n```json\n{"topic":"Launch date","goal":"","contact":null}\n```',
    )
    expect(parsed).toEqual({
      topic: 'Launch date',
      goal: null,
      contact: null,
      labelId: null,
    })
  })

  test('an empty field means “nothing to say”, never “clear it”', () => {
    // The writer only ever writes non-empty values, so an empty field has to
    // arrive as null rather than as an empty string it would copy over.
    const parsed = parseContextUpdate(
      JSON.stringify({
        topic: '',
        goal: '',
        contact: {
          roleCompany: '',
          relationship: '',
          topics: '',
          currentWork: '',
        },
      }),
    )
    expect(parsed).toBeNull()
  })

  test('takes a label only when it was one of the offered ones', () => {
    const offered = [{ id: 'label-to-pay' }, { id: 'label-clients' }]

    expect(
      parseContextUpdate(
        JSON.stringify({ topic: 'Invoice 4021', label: 'label-to-pay' }),
        offered,
      )?.labelId,
    ).toBe('label-to-pay')

    // An id the caller never sent is a hallucination, not a choice.
    expect(
      parseContextUpdate(
        JSON.stringify({ topic: 'Invoice 4021', label: 'made-up' }),
        offered,
      )?.labelId,
    ).toBeNull()
  })

  test('a label alone is a usable answer even with no topic', () => {
    // The label question is asked on threads where nothing else has anything to
    // say, so an answer that names only a label must not be thrown away.
    expect(
      parseContextUpdate(
        JSON.stringify({ topic: '', label: 'label-clients' }),
        [{ id: 'label-clients' }],
      ),
    ).toEqual({
      topic: null,
      goal: null,
      contact: null,
      labelId: 'label-clients',
    })
  })

  test('an answer with nothing usable in it is null', () => {
    expect(parseContextUpdate('')).toBeNull()
    expect(parseContextUpdate('I could not do that.')).toBeNull()
    expect(parseContextUpdate('{"topic": 42}')).toBeNull()
    expect(parseContextUpdate('{ not json')).toBeNull()
  })

  test('caps a runaway goal and drops an over-long profile field', () => {
    const parsed = parseContextUpdate(
      JSON.stringify({
        topic: 'Launch',
        goal: 'x'.repeat(600),
        contact: { relationship: 'y'.repeat(900) },
      }),
    )

    expect(parsed?.goal).toHaveLength(500)
    // `normaliseContactContextTextFields` refuses the whole contact object
    // rather than silently truncating a field the user would then have to
    // correct, so the profile is simply not offered this time.
    expect(parsed?.contact).toBeNull()
  })
})
