-- Run against a disposable local Supabase database after migrations. Always rolls back.
begin;
do $$
declare r jsonb; balance bigint; tid bigint; i int;
begin
 assert ('2026-10-14 16:59:59+00'::timestamptz at time zone 'Asia/Jakarta')::date='2026-10-14'::date,'before WIB midnight';
 assert ('2026-10-14 17:00:00+00'::timestamptz at time zone 'Asia/Jakarta')::date='2026-10-15'::date,'at WIB midnight';
 -- Registration and lazy WIB midnight reset.
 perform bot_command(10001,80001,'stats');
 update bot_users set free_used=3,quota_day=(now() at time zone 'Asia/Jakarta')::date-1,last_request=null where telegram_id=80001;
 perform bot_command(10002,80001,'stats');
 assert (select free_used=0 and quota_day=(now() at time zone 'Asia/Jakarta')::date from bot_users where telegram_id=80001),'WIB quota reset failed';
 insert into bot_consents values(80001,'6281234567890','verified-owner-evidence',90001,now()+interval '1 hour');
 -- Three free checks followed by one paid check.
 update bot_users set credits=1 where telegram_id=80001;
 for i in 1..4 loop
   update bot_users set last_request=null where telegram_id=80001;
   r:=bot_command(10100+i,80001,'check','{"phone":"6281234567890"}');
   assert (r->>'check')::boolean,'check not reserved';
   perform bot_finish(10100+i,'success');
 end loop;
 assert (select credits=0 and free_used=3 from bot_users where telegram_id=80001),'incorrect charge';
 update bot_users set last_request=null where telegram_id=80001;
 r:=bot_command(10104,80001,'check','{"phone":"6281234567890"}');
 assert (r->>'duplicate')::boolean,'duplicate not detected';
 assert (select count(*)=1 from bot_ledger where check_id=10104),'duplicate debit';
 r:=bot_command(10105,80001,'check','{"phone":"6281234567890"}');
 assert not (r ? 'check'),'overspend';
 -- Topup approval is idempotent even under a different Telegram update.
 update bot_users set last_request=null where telegram_id=80001;
 perform bot_command(10200,80001,'topup','{"credits":10}');
 select id into tid from bot_topups where update_id=10200;
 perform bot_command(10201,90001,'approve',jsonb_build_object('id',tid),true);
 update bot_users set last_request=null where telegram_id=90001;
 perform bot_command(10202,90001,'approve',jsonb_build_object('id',tid),true);
 assert (select credits=10 from bot_users where telegram_id=80001),'double credit';
 assert (select count(*)=1 from bot_ledger where topup_id=tid),'duplicate topup ledger';
 -- Failed check returns exactly one credit.
 update bot_users set last_request=null where telegram_id=80001;
 perform bot_command(10300,80001,'check','{"phone":"6281234567890"}');
 perform bot_finish(10300,'unknown');
 assert (select credits=9 from bot_users where telegram_id=80001),'unknown must stay charged';
 perform bot_finish(10300,'failed'); perform bot_finish(10300,'failed');
 assert (select credits=10 from bot_users where telegram_id=80001),'refund failed';
 -- A late free-check failure must not decrement the new day's quota.
 update bot_users set last_request=null,free_used=0 where telegram_id=80001;
 perform bot_command(10400,80001,'check','{"phone":"6281234567890"}');
 update bot_checks set quota_day=quota_day-1 where update_id=10400;
 perform bot_finish(10400,'failed');
 assert (select free_used=1 from bot_users where telegram_id=80001),'cross-day refund';
 -- No admin privilege, no consent, no credit change.
 update bot_users set last_request=null where telegram_id=80001;
 perform bot_command(10500,80001,'grant','{"user":80001,"phone":"6289999999999","evidence":"fake"}',false);
 assert not exists(select 1 from bot_consents where phone='6289999999999'),'unauthorized consent';
 update bot_users set last_request=null where telegram_id=80001;
 r:=bot_command(10501,80001,'check','{"phone":"6289999999999"}');
 assert not (r ? 'check'),'check without consent';
 -- Rejection never credits.
 update bot_users set last_request=null where telegram_id=80001;
 perform bot_command(10600,80001,'topup','{"credits":20}');
 select id into tid from bot_topups where update_id=10600;
 update bot_users set last_request=null where telegram_id=90001;
 perform bot_command(10601,90001,'reject',jsonb_build_object('id',tid),true);
 assert (select credits=10 from bot_users where telegram_id=80001),'rejected topup credited';
end $$;
rollback;
