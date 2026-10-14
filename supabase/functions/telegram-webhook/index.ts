import { parse, validUpdate, secretEqual, adminActions } from './core.ts';
const required = (key: string) => { const v=Deno.env.get(key); if(!v) throw new Error(`Missing ${key}`); return v; };
const secret=required('TELEGRAM_WEBHOOK_SECRET');
const token=required('TELEGRAM_BOT_TOKEN');
const db=required('SUPABASE_URL');
const service=required('SUPABASE_SERVICE_ROLE_KEY');
const admins=new Set(required('TELEGRAM_ADMIN_IDS').split(',').map(x=>x.trim()));
async function rpc(name: string, args: unknown) {
  const r=await fetch(`${db}/rest/v1/rpc/${name}`,{ method:'POST',headers:{apikey:service,Authorization:`Bearer ${service}`,'Content-Type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(10000)});
  if(!r.ok) throw new Error('database_error');
  return await r.json();
}
async function send(chat: number, text: string) {
  const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chat,text:text.slice(0,4000),protect_content:true}),signal:AbortSignal.timeout(10000)});
  if(!r.ok || !(await r.json()).ok) throw new Error('telegram_error');
}
// Intentionally disabled until the authorized provider contract is supplied and implemented.
// Do not guess cekapi endpoint, authentication, payload, or success semantics.
async function providerCheck(_phone: string, _id: number): Promise<{status:'success'|'failed'|'unknown';message:string}> {
  return {status:'failed',message:'Integrasi cekapi belum dikonfigurasi; kuota/kredit dikembalikan.'};
}
Deno.serve(async req=>{
  if(req.method!=='POST') return new Response('Method not allowed',{status:405});
  if(!await secretEqual(req.headers.get('X-Telegram-Bot-Api-Secret-Token')??'',secret)) return new Response('Unauthorized',{status:401});
  let update: any;
  try {
    // Stream limit also protects bodies without Content-Length.
    const reader=req.body?.getReader(); let size=0; const chunks:Uint8Array[]=[];
    if(!reader) return new Response('Bad request',{status:400});
    while(true){ const {done,value}=await reader.read(); if(done) break; size+=value.length; if(size>16384){await reader.cancel();return new Response('Too large',{status:413});} chunks.push(value); }
    const bytes=new Uint8Array(size); let offset=0; for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
    update=JSON.parse(new TextDecoder().decode(bytes));
  } catch { return new Response('Bad request',{status:400}); }
  if(!validUpdate(update)) return new Response('Ignored');
  const user=update.message.from.id;
  let command;
  try {command=parse(update.message.text);} catch(e) {
    // Invalid commands still go through DB deduplication and rate limiting.
    command={action:'invalid',args:{}};
  }
  const admin=admins.has(String(user));
  if(adminActions.has(command.action)&&!admin) command={action:'denied',args:{}};
  try {
    const result=await rpc('bot_command',{p_update:update.update_id,p_user:user,p_action:command.action,p_args:command.args,p_admin:admin});
    if(result.duplicate) return new Response('OK');
    if(result.check){
      const outcome=await providerCheck((command.args as {phone:string}).phone,update.update_id);
      await rpc('bot_finish',{p_update:update.update_id,p_status:outcome.status});
      await send(user,outcome.message);
    } else await send(user,result.reply);
    return new Response('OK');
  } catch {
    // Do not log tokens, phone numbers, provider payloads, or Telegram bodies.
    console.error('webhook_processing_failed',{update_id:update.update_id});
    return new Response('Temporary failure',{status:503});
  }
});
