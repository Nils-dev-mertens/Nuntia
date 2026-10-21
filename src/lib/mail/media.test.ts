import { describe, expect, test } from 'bun:test'

import { dedupeMediaByHash, sha256Hex } from './media.ts'

describe('dedupeMediaByHash', () => {
  test('deduplicates media with identical bytes despite different names and types', async () => {
    const items = [
      { filename: 'logo.png', mimeType: 'image/png', id: 'first' },
      { filename: 'renamed.jpg', mimeType: 'image/jpeg', id: 'same-bytes' },
      { filename: 'other.png', mimeType: 'image/png', id: 'different' },
    ]
    const hashes: Record<string, string> = {
      first: 'hash-a',
      'same-bytes': 'hash-a',
      different: 'hash-b',
    }

    const result = await dedupeMediaByHash(items, async (item) => {
      const hash = hashes[item.id]
      if (!hash) throw new Error('missing test hash')
      return hash
    })

    expect(result.items.map((item) => item.id)).toEqual(['first', 'different'])
    expect(result.failedCount).toBe(0)
  })

  test('does not hash or remove duplicate documents', async () => {
    const items = [
      { filename: 'report.pdf', mimeType: 'application/pdf', id: 'one' },
      { filename: 'report.pdf', mimeType: 'application/pdf', id: 'two' },
    ]
    let hashCalls = 0

    const result = await dedupeMediaByHash(items, async () => {
      hashCalls += 1
      return 'same-hash'
    })

    expect(result.items).toEqual(items)
    expect(hashCalls).toBe(0)
  })

  test('keeps media visible if hashing fails', async () => {
    const items = [
      { filename: 'logo.png', mimeType: 'image/png', id: 'one' },
      { filename: 'logo.png', mimeType: 'image/png', id: 'two' },
    ]

    const result = await dedupeMediaByHash(items, async () => {
      throw new Error('attachment unavailable')
    })

    expect(result.items).toEqual(items)
    expect(result.failedCount).toBe(2)
  })

  test('hashes media concurrently with a bounded worker pool', async () => {
    const items = Array.from({ length: 8 }, (_, index) => ({
      mimeType: 'image/png',
      id: String(index),
    }))
    let active = 0
    let maxActive = 0

    await dedupeMediaByHash(items, async (item) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active -= 1
      return item.id
    })

    expect(maxActive).toBe(3)
  })

  test('calculates the SHA-256 hex digest of the exact bytes', async () => {
    const bytes = new TextEncoder().encode('abc').buffer
    expect(await sha256Hex(bytes)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})
