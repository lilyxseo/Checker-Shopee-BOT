export type Outcome = { status: 'success' | 'failed' | 'unknown'; message: string };
export type ProviderConfig = { enabled?: string; apiKey?: string; baseUrl?: string };
type Transport = (url: URL, init: RequestInit) => Promise<Response>;
const uncertain = (): Outcome => ({
  status: 'unknown',
  message: 'Hasil cek belum dapat dipastikan. Jangan ulangi cek ini; hubungi admin untuk rekonsiliasi kuota/kredit.',
});

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty_response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 32768) throw new Error('oversized_response');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Call only after bot_command atomically reserves quota/credit and verifies consent.
// The supplied docs define only success. All other remote outcomes need reconciliation.
export async function checkShopeePay(
  phone: string,
  config: ProviderConfig,
  transport: Transport = fetch,
): Promise<Outcome> {
  const disabled: Outcome = {
    status: 'failed',
    message: 'Integrasi cekapi belum aktif atau konfigurasi tidak valid; kuota/kredit dikembalikan.',
  };
  if (config.enabled !== 'true' || !config.apiKey?.trim() || !/^62\d{8,13}$/.test(phone)) return disabled;
  let url: URL;
  try {
    url = new URL(config.baseUrl || 'https://v1.cekapi.com');
    // Never send a query-string API key to a different host, path, or redirect.
    if (url.origin !== 'https://v1.cekapi.com' || !['/', '/cekewallet'].includes(url.pathname) ||
      url.username || url.password || url.search || url.hash) return disabled;
    url.pathname = '/cekewallet';
    url.searchParams.set('customer_no', `0${phone.slice(2)}`);
    url.searchParams.set('ewallet', 'spay');
    url.searchParams.set('apikey', config.apiKey);
  } catch { return disabled; }
  try {
    const response = await transport(url, {
      method: 'GET', headers: { Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(8000),
    });
    // Never retry: the provider may already have processed/billed a failed HTTP request.
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return uncertain(); }
    const payload = await readJson(response) as { data?: { status?: unknown; product?: unknown; username?: unknown } } | null;
    const data = payload?.data;
    if (data?.status !== 'ditemukan' || data.product !== 'spay' || typeof data.username !== 'string') return uncertain();
    const username = data.username.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim();
    if (!username || username.length > 200) return uncertain();
    // sisa_saldo has no documented meaning here. Never present it as an owner's wallet balance.
    return { status: 'success', message: `ShopeePay ditemukan.\nNama: ${username}` };
  } catch {
    // Transport exceptions can contain the full URL/API key. Never log or return them.
    return uncertain();
  }
}
