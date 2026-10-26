/**
 * The log's two safety properties: a credential never reaches the file, and a
 * write failure never reaches the caller.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appLogPath,
  flushLog,
  isQuietPath,
  log,
  redactPath,
} from './log.ts'

const dir = mkdtempSync(join(tmpdir(), 'nuntia-log-test-'))
process.env.APP_LOG_DIR = dir

afterAll(() => {
  delete process.env.APP_LOG_DIR
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

describe('redactPath', () => {
  test('collapses an invite code, in a link or a bare path', () => {
    expect(redactPath('/join/ABCD-EFGH-JKMN')).toBe('/join/[code]')
    expect(redactPath('/join/abcd')).toBe('/join/[code]')
    expect(redactPath('/join')).toBe('/join')
  })

  test('drops the query string entirely', () => {
    // It can carry a code, an email, or a thread id, and the next route to put
    // something sensitive in one will not remember this rule.
    expect(redactPath('/request-access?email=ada@example.com')).toBe(
      '/request-access',
    )
    expect(redactPath('/auth/google/callback?code=abc&state=def')).toBe(
      '/auth/google/callback',
    )
  })

  test('leaves ordinary paths alone', () => {
    expect(redactPath('/admin')).toBe('/admin')
    expect(redactPath('/conversations/18f3')).toBe('/conversations/18f3')
  })
})

describe('isQuietPath', () => {
  test('skips assets and tooling, keeps real pages', () => {
    expect(isQuietPath('/assets/index-abc.js')).toBe(true)
    expect(isQuietPath('/@vite/client')).toBe(true)
    expect(isQuietPath('/favicon.ico')).toBe(true)
    expect(isQuietPath('/admin')).toBe(false)
    expect(isQuietPath('/join/ABCD-EFGH-JKMN')).toBe(false)
  })
})

describe('log', () => {
  test('appends one JSON line with the redacted path', async () => {
    log('info', 'request', {
      method: 'GET',
      path: redactPath('/join/ABCD-EFGH-JKMN'),
      status: 200,
      ms: 12,
    })
    await flushLog()

    const line = readFileSync(appLogPath(), 'utf8').trim()
    const record = JSON.parse(line) as Record<string, unknown>

    expect(record.event).toBe('request')
    expect(record.path).toBe('/join/[code]')
    expect(line).not.toContain('ABCD')
  })
})
