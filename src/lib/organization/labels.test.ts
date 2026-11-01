import { describe, expect, test } from 'bun:test'

import { CONVERSATION_STATES } from '#/db/schema.ts'

import {
  customStateMeanings,
  defaultStateLabels,
  normaliseStateLabels,
  resolveStateLabels,
  stateLabelOverrides,
} from './labels.ts'

function submission(labels: ReturnType<typeof defaultStateLabels>) {
  return CONVERSATION_STATES.map((state) => ({ state, ...labels[state] }))
}

describe('state labels', () => {
  test('resolve to the app’s own words until an override exists', () => {
    const defaults = defaultStateLabels()
    const edited = resolveStateLabels({
      informational: { name: 'FYI', description: 'Read and move on.' },
    })

    expect(edited.informational).toEqual({
      name: 'FYI',
      description: 'Read and move on.',
    })
    expect(edited['needs-action']).toEqual(defaults['needs-action'])
  })

  test('only changed labels are worth storing', () => {
    const labels = defaultStateLabels()
    labels['needs-action'].name = 'Do this now'

    expect(stateLabelOverrides(labels)).toEqual([
      {
        state: 'needs-action',
        name: 'Do this now',
        description: labels['needs-action'].description,
      },
    ])
    expect(stateLabelOverrides(defaultStateLabels())).toEqual([])
  })

  test('only a meaning the user rewrote reaches the decision prompt', () => {
    const labels = defaultStateLabels()
    expect(customStateMeanings(labels)).toEqual({})

    labels['needs-action'].description =
      '  Only a client waiting on a decision from me.  '
    expect(customStateMeanings(labels)).toEqual({
      'needs-action': 'Only a client waiting on a decision from me.',
    })

    // A renamed label carrying the app's own meaning is not a new definition:
    // sending it would spend tokens restating the default.
    labels['needs-action'] = {
      name: 'Do this now',
      description: defaultStateLabels()['needs-action'].description,
    }
    expect(customStateMeanings(labels)).toEqual({})
  })

  test('normalises a full set of labels', () => {
    const labels = defaultStateLabels()
    labels['low-priority'] = {
      name: '  Someday  ',
      description: '  Nothing here needs you yet.  ',
    }

    expect(normaliseStateLabels(submission(labels))).toEqual(
      submission(labels).map((label) =>
        label.state === 'low-priority'
          ? {
              state: label.state,
              name: 'Someday',
              description: 'Nothing here needs you yet.',
            }
          : label,
      ),
    )
  })

  test('rejects a missing, duplicated, unnamed or over-long label', () => {
    const complete = submission(defaultStateLabels())

    expect(normaliseStateLabels(complete.slice(0, 3))).toBeNull()
    expect(normaliseStateLabels([...complete, complete[0]])).toBeNull()
    expect(
      normaliseStateLabels(
        complete.map((label) =>
          label.state === 'informational' ? { ...label, name: '  ' } : label,
        ),
      ),
    ).toBeNull()
    expect(
      normaliseStateLabels(
        complete.map((label) =>
          label.state === 'informational'
            ? { ...label, description: 'x'.repeat(301) }
            : label,
        ),
      ),
    ).toBeNull()
  })
})
