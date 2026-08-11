import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPinnedLookup, parseSseResponse, TransportError } from '../src/executor/normal-transport.js'
import { isBlockedAddress } from '../src/executor/ssrf.js'

test('SSRF address policy blocks private, metadata, loopback, and documentation ranges', () => {
  for (const address of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '192.168.1.1', '203.0.113.8']) {
    assert.equal(isBlockedAddress(address), true, address)
  }
  assert.equal(isBlockedAddress('8.8.8.8'), false)
  assert.equal(isBlockedAddress('::1'), true)
  assert.equal(isBlockedAddress('2001:4860:4860::8888'), false)
})

test('pinned DNS lookup supports Node single-address and all-address calls', () => {
  const lookup = createPinnedLookup({ address: '8.8.8.8', family: 4 })
  lookup('ignored.example', { all: false }, (error, address, family) => {
    assert.equal(error, null)
    assert.equal(address, '8.8.8.8')
    assert.equal(family, 4)
  })
  lookup('ignored.example', { all: true }, (error, addresses) => {
    assert.equal(error, null)
    assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }])
  })
})

test('Responses SSE parser requires a terminal event and extracts output', () => {
  const raw = [
    'data: {"type":"response.output_text.delta","delta":"4"}\n\n',
    'data: {"type":"response.output_text.delta","delta":"0"}\n\n',
    'data: {"type":"response.completed","response":{"output":[]}}\n\n',
  ].join('')
  const parsed = parseSseResponse(raw)
  assert.equal(parsed.response['output_text'], '40')
  assert.equal(parsed.eventCount, 3)
  assert.throws(() => parseSseResponse('data: {"type":"response.output_text.delta","delta":"4"}\n\n'))
})

test('Responses SSE parser rejects failed and incomplete terminal responses', () => {
  for (const type of ['response.failed', 'response.incomplete']) {
    const raw = `event: ${type}\ndata: ${JSON.stringify({ type, response: { status: type.split('.')[1] } })}\n\n`
    assert.throws(() => parseSseResponse(raw), TransportError)
  }
})
