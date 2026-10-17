import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  aiLogPath,
  logAiEvent,
  readRecentAiEvents,
  reportAiFailure,
} from './ai-log.ts'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lumen-ai-log-'))
  // The module skips writes under test unless a directory is named explicitly,
  // which is also what keeps these tests off the app's own log.
  process.env.AI_LOG_DIR = dir
})

afterEach(() => {
  delete process.env.AI_LOG_DIR
  rmSync(dir, { recursive: true, force: true })
})

async function lines(): Promise<string[]> {
  const text = await readFile(aiLogPath(), 'utf-8').catch(() => '')
  return text.split('\n').filter(Boolean)
}

describe('logAiEvent', () => {
  test('appends one JSON line per event, with what was asked and what happened', async () => {
    await logAiEvent({
      service: 'llm:openai',
      model: 'o3',
      url: 'https://api.openai.com/v1/chat/completions',
      outcome: 'error',
      status: 400,
      durationMs: 42,
      attempt: 1,
      detail: 'unsupported parameter',
    })

    const [line] = await lines()
    const entry = JSON.parse(line)

    expect(entry.service).toBe('llm:openai')
    expect(entry.model).toBe('o3')
    expect(entry.outcome).toBe('error')
    expect(entry.status).toBe(400)
    expect(entry.attempt).toBe(1)
    expect(entry.detail).toBe('unsupported parameter')
    // An ISO timestamp, so a line can be placed against a terminal or a sync.
    expect(Number.isNaN(Date.parse(entry.at))).toBe(false)
  })

  test('appends rather than replaces, keeping the history in order', async () => {
    await logAiEvent({ service: 'jev', outcome: 'ok', status: 200 })
    await logAiEvent({ service: 'jev', outcome: 'error', status: 500 })

    const entries = (await lines()).map((line) => JSON.parse(line))
    expect(entries.map((entry) => entry.outcome)).toEqual(['ok', 'error'])
  })

  test('keeps one previous file instead of growing without bound', async () => {
    // One byte past the cap, so the next write has to rotate.
    await writeFile(aiLogPath(), 'x'.repeat(1_000_000), 'utf-8')

    await logAiEvent({ service: 'jev', outcome: 'ok', status: 200 })

    expect((await stat(`${aiLogPath()}.1`)).size).toBe(1_000_000)
    // The new file holds only the new event.
    expect((await lines()).length).toBe(1)
  })

  test('truncates a long detail rather than writing a whole response body', async () => {
    await logAiEvent({
      service: 'jev',
      outcome: 'error',
      status: 400,
      detail: 'y'.repeat(5_000),
    })

    const [line] = await lines()
    expect(line.length).toBeLessThan(1_000)
  })
})

describe('readRecentAiEvents', () => {
  test('is empty when nothing has been logged', async () => {
    expect(await readRecentAiEvents()).toEqual([])
  })

  test('returns the newest events last, and skips a malformed line', async () => {
    await writeFile(
      aiLogPath(),
      [
        JSON.stringify({
          at: '2026-01-01T00:00:00Z',
          service: 'jev',
          outcome: 'ok',
        }),
        '{ this line was half written',
        JSON.stringify({
          at: '2026-01-01T00:01:00Z',
          service: 'llm:openai',
          outcome: 'error',
          status: 400,
        }),
      ].join('\n'),
      'utf-8',
    )

    const events = await readRecentAiEvents()

    expect(events.map((event) => event.service)).toEqual(['jev', 'llm:openai'])
  })

  test('keeps only the requested number of most recent events', async () => {
    for (let i = 0; i < 5; i++) {
      await logAiEvent({ service: `s${i}`, outcome: 'ok' })
    }

    const events = await readRecentAiEvents(2)
    expect(events.map((event) => event.service)).toEqual(['s3', 's4'])
  })
})

describe('reportAiFailure', () => {
  test('records the thrown status and message', async () => {
    const error = Object.assign(
      new Error('The AI service returned an empty answer.'),
      {
        status: 200,
      },
    )

    await reportAiFailure('llm:gemini', error, 'failed; no topic')

    const [line] = await lines()
    const entry = JSON.parse(line)

    expect(entry.service).toBe('llm:gemini')
    expect(entry.outcome).toBe('error')
    expect(entry.status).toBe(200)
    expect(entry.detail).toBe('The AI service returned an empty answer.')
  })

  test('handles a thrown value that is not an Error', async () => {
    await reportAiFailure('jev', 'string failure')

    const [line] = await lines()
    expect(JSON.parse(line).detail).toBe('string failure')
  })
})
