import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, validUpdate, secretEqual } from '../supabase/functions/telegram-webhook/core.ts';
test('normalize Indonesian phone and reject bulk requests',()=>{
 assert.deepEqual(parse('/cek 081234567890').args,{phone:'6281234567890'});
 assert.throws(()=>parse('/cek 081234567890 081234567891'));
 assert.throws(()=>parse('/cek +1-555-123'));
});
test('topup validates integers, limits and injection',()=>{
 assert.equal(parse('/topup 100').args.credits,100);
 for(const x of ['-1','0','1.5','1000001','1e3','1;DROP']) assert.throws(()=>parse(`/topup ${x}`));
});
test('secret comparison',async()=>{
 assert.equal(await secretEqual('correct','correct'),true);
 assert.equal(await secretEqual('correct','wrong'),false);
});
test('accept only safe private message identities',()=>{
 const u={update_id:12,message:{from:{id:123,is_bot:false},chat:{id:123,type:'private'},text:'/saldo'}};
 assert.equal(validUpdate(u),true);
 assert.equal(validUpdate({...u,update_id:1.5}),false);
 assert.equal(validUpdate({...u,message:{...u.message,chat:{id:-1,type:'group'}}}),false);
});
