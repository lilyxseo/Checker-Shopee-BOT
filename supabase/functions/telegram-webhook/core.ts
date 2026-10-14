export function parse(text: string) {
  const [raw, ...a] = text.trim().split(/\s+/);
  const command = raw.split('@')[0].toLowerCase();
  const positive = (s: string) => /^\d{1,15}$/.test(s ?? '') && Number(s) > 0 && Number.isSafeInteger(Number(s));
  if (command === '/cek') {
    const phone = a[0]?.replace(/^0/, '62');
    if (a.length !== 1 || !/^62\d{8,13}$/.test(phone ?? '')) throw new Error('Format: /cek 628xxx');
    return { action: 'check', args: { phone } };
  }
  if (command === '/topup') {
    if (a.length !== 1 || !positive(a[0]) || Number(a[0]) > 1000000) throw new Error('Format: /topup 100 (1–1000000 kredit)');
    return { action: 'topup', args: { credits: Number(a[0]) } };
  }
  if (command === '/user') {
    if (a.length !== 1 || !positive(a[0])) throw new Error('Format: /user USER_ID');
    return { action: 'user', args: { user: a[0] } };
  }
  if (['/approve', '/reject'].includes(command)) {
    if (a.length !== 1 || !positive(a[0])) throw new Error('Gunakan ID top up yang valid.');
    return { action: command.slice(1), args: { id: a[0] } };
  }
  if (['/grant', '/revoke'].includes(command)) {
    if (!positive(a[0]) || !/^62\d{8,13}$/.test(a[1] ?? '') ||
      (command === '/grant' ? a.length !== 3 || a[2].length < 3 : a.length !== 2)) throw new Error('Format: /grant USER_ID 628xxx REFERENSI_IZIN atau /revoke USER_ID 628xxx');
    return { action: command.slice(1), args: { user: a[0], phone: a[1], evidence: a[2] } };
  }
  return { action: ({ '/saldo': 'stats', '/stats': 'stats', '/history': 'history', '/admin': 'admin', '/pending': 'pending' } as Record<string,string>)[command] ?? 'help', args: {} };
}
export function validUpdate(x: any): boolean {
  return Number.isSafeInteger(x?.update_id) && x.update_id >= 0 &&
    Number.isSafeInteger(x?.message?.from?.id) && x.message.from.id > 0 &&
    x.message.from.is_bot === false && x.message.chat?.type === 'private' &&
    x.message.chat.id === x.message.from.id && typeof x.message.text === 'string' && x.message.text.length <= 4096;
}
export async function secretEqual(a: string, b: string) {
  const hash = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [x,y] = await Promise.all([hash(a),hash(b)]);
  let diff=0; for(let i=0;i<x.length;i++) diff |= x[i]^y[i]; return diff===0;
}
export const adminActions = new Set(['approve','reject','grant','revoke','admin','pending','user']);
