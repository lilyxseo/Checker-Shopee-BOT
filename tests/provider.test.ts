import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkShopeePay } from '../supabase/functions/telegram-webhook/provider.ts';
const config = { enabled: 'true', apiKey: 'test-only-key&=+' };
const phone = '6281234567890';
const success = { data: { status: 'ditemukan', product: 'spay', username: 'AXXXXXXXXXXI', sisa_saldo: 962 } };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

test('GET matches supplied contract, normalizes phone, escapes key, and omits undocumented balance', async () => {
  let calls = 0;
  const result = await checkShopeePay(phone, config, async (url, init) => {
    calls++;
    assert.equal(url.origin, 'https://v1.cekapi.com');
    assert.equal(url.pathname, '/cekewallet');
    assert.equal(url.searchParams.get('customer_no'), '081234567890');
    assert.equal(url.searchParams.get('ewallet'), 'spay');
    assert.equal(url.searchParams.get('apikey'), config.apiKey);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    return json(success);
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'success');
  assert.match(result.message, /AXXXXXXXXXXI/);
  assert.doesNotMatch(result.message, /962|saldo|test-only-key|6281234567890/);
});

test('disabled, invalid key/phone/endpoint configurations never make a request and refund', async () => {
  for (const bad of [
    {}, { apiKey: 'x' }, { ...config, enabled: 'false' }, { ...config, apiKey: ' ' },
    { ...config, baseUrl: 'https://attacker.example' },
    { ...config, baseUrl: 'http://v1.cekapi.com' },
    { ...config, baseUrl: 'https://v1.cekapi.com/other' },
    { ...config, baseUrl: 'https://user:password@v1.cekapi.com' },
    { ...config, baseUrl: 'https://v1.cekapi.com?apikey=other' },
  ]) {
    let calls = 0;
    const result = await checkShopeePay(phone, bad, async () => { calls++; return json(success); });
    assert.equal(calls, 0); assert.equal(result.status, 'failed');
  }
  const result = await checkShopeePay('invalid', config, async () => { throw new Error('must not call'); });
  assert.equal(result.status, 'failed');
});

test('documented endpoint path is accepted', async () => {
  const result = await checkShopeePay(phone, { ...config, baseUrl: 'https://v1.cekapi.com/cekewallet' }, async () => json(success));
  assert.equal(result.status, 'success');
});

test('unknown provider statuses and malformed success never refund or expose remote messages', async () => {
  for (const body of [null, {}, { data: null }, { data: { status: 'tidak ditemukan' } },
    { data: { ...success.data, product: 'dana' } },
    { data: { ...success.data, username: '' } },
    { data: { ...success.data, username: 'x'.repeat(201) } },
    { data: { ...success.data, username: 123 } },
    { error: `private error ${config.apiKey}` }]) {
    const result = await checkShopeePay(phone, config, async () => json(body));
    assert.equal(result.status, 'unknown');
    assert.ok(!result.message.includes(config.apiKey));
  }
});

test('non-2xx, invalid JSON, oversized responses and timeout are unknown with no retry', async () => {
  const cases = [
    async () => new Response('error', { status: 429 }),
    async () => new Response('error', { status: 500 }),
    async () => new Response('', { status: 302, headers: { Location: 'https://attacker.example' } }),
    async () => new Response('invalid JSON'),
    async () => new Response('x'.repeat(32769)),
    async () => { throw new DOMException('timeout', 'TimeoutError'); },
    async () => { throw new Error(`GET secret ${config.apiKey}`); },
  ];
  for (const respond of cases) {
    let calls = 0;
    const result = await checkShopeePay(phone, config, async () => { calls++; return await respond(); });
    assert.equal(calls, 1); assert.equal(result.status, 'unknown');
    assert.ok(!result.message.includes(config.apiKey));
  }
});

test('username cannot inject newlines or bidi controls into the Telegram result', async () => {
  const result = await checkShopeePay(phone, config, async () => json({ data: { ...success.data, username: 'AX\n\r\u202eXI' } }));
  assert.equal(result.message, 'ShopeePay ditemukan.\nNama: AXXI');
});
