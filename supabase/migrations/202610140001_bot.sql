-- All mutations are service-role-only RPCs. No client can assign itself credits.
create table public.bot_users (
 telegram_id bigint primary key check (telegram_id > 0),
 credits bigint not null default 0 check (credits >= 0),
 quota_day date, free_used int not null default 0 check (free_used between 0 and 3),
 last_request timestamptz, created_at timestamptz not null default now()
);
create table public.bot_updates (
 update_id bigint primary key, telegram_id bigint not null references public.bot_users,
 reply text, created_at timestamptz not null default now()
);
create table public.bot_consents (
 telegram_id bigint references public.bot_users, phone text not null,
 evidence_ref text not null, granted_by bigint not null, expires_at timestamptz not null,
 primary key (telegram_id, phone)
);
create table public.bot_checks (
 update_id bigint primary key references public.bot_updates,
 telegram_id bigint not null references public.bot_users, phone text not null,
 charged_credit boolean not null, quota_day date not null,
 status text not null default 'pending' check (status in ('pending','success','failed','unknown')),
 created_at timestamptz not null default now()
);
create table public.bot_topups (
 id bigint generated always as identity primary key,
 update_id bigint unique not null references public.bot_updates,
 telegram_id bigint not null references public.bot_users,
 credits int not null check (credits between 1 and 1000000),
 amount_rupiah bigint generated always as (credits::bigint * 50) stored,
 status text not null default 'pending' check (status in ('pending','approved','rejected')),
 decided_by bigint, decided_at timestamptz, created_at timestamptz not null default now()
);
create table public.bot_ledger (
 id bigint generated always as identity primary key,
 telegram_id bigint not null references public.bot_users,
 delta bigint not null, reason text not null,
 check_id bigint references public.bot_checks, topup_id bigint references public.bot_topups,
 created_at timestamptz not null default now(),
 unique (check_id, reason), unique (topup_id, reason)
);
create index on public.bot_checks (telegram_id, created_at desc);
create index on public.bot_ledger (telegram_id, created_at desc);
create index on public.bot_topups (status, created_at);

create function public.bot_command(p_update bigint, p_user bigint, p_action text,
 p_args jsonb default '{}'::jsonb, p_admin boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
 u bot_users; t bot_topups; d date := (statement_timestamp() at time zone 'Asia/Jakarta')::date;
 reply_text text; n bigint; paid boolean; v_phone text;
begin
 insert into bot_users(telegram_id) values(p_user) on conflict do nothing;
 select * into u from bot_users where telegram_id=p_user for update;
 insert into bot_updates(update_id,telegram_id) values(p_update,p_user) on conflict do nothing;
 if not found then
   return jsonb_build_object('duplicate',true);
 end if;
 if u.last_request > statement_timestamp() - interval '2 seconds' then
   update bot_updates set reply='Terlalu cepat. Tunggu 2 detik.' where update_id=p_update;
   return jsonb_build_object('reply','Terlalu cepat. Tunggu 2 detik.');
 end if;
 update bot_users set last_request=statement_timestamp(), quota_day=d,
 free_used=case when quota_day=d then free_used else 0 end where telegram_id=p_user returning * into u;
 if p_action='check' then
   v_phone := p_args->>'phone';
   if v_phone is null or v_phone !~ '^62[0-9]{8,13}$' then raise exception 'invalid_phone'; end if;
   if not exists(select 1 from bot_consents where telegram_id=p_user and bot_consents.phone=v_phone and expires_at>now()) then
     reply_text := 'Izin pemilik belum diverifikasi admin atau sudah kedaluwarsa.';
   elsif u.free_used=3 and u.credits=0 then reply_text := 'Kuota habis. Silakan top up.';
   else
     paid := u.free_used=3;
     update bot_users set credits=credits-case when paid then 1 else 0 end,
       free_used=free_used+case when paid then 0 else 1 end where telegram_id=p_user;
     insert into bot_checks(update_id,telegram_id,phone,charged_credit,quota_day) values(p_update,p_user,v_phone,paid,d);
     if paid then insert into bot_ledger(telegram_id,delta,reason,check_id) values(p_user,-1,'check',p_update); end if;
     return jsonb_build_object('check',true);
   end if;
 elsif p_action='topup' then
   insert into bot_topups(update_id,telegram_id,credits) values(p_update,p_user,(p_args->>'credits')::int) returning id into n;
   reply_text := format('Top up #%s menunggu verifikasi pembayaran admin. Total Rp%s.',n,(p_args->>'credits')::bigint*50);
 elsif p_action in ('approve','reject') and p_admin then
   -- Lock recipient before topup to match the per-user command lock order.
   select telegram_id into n from bot_topups where id=(p_args->>'id')::bigint;
   if n is null then reply_text := 'Top up tidak ditemukan.';
   else
     perform 1 from bot_users where telegram_id=n for update;
     select * into t from bot_topups where id=(p_args->>'id')::bigint for update;
     if t.status <> 'pending' then reply_text := 'Top up sudah diproses.';
     else
       update bot_topups set status=case when p_action='approve' then 'approved' else 'rejected' end,
         decided_by=p_user,decided_at=now() where id=t.id;
       if p_action='approve' then
         update bot_users set credits=credits+t.credits where telegram_id=t.telegram_id;
         insert into bot_ledger(telegram_id,delta,reason,topup_id) values(t.telegram_id,t.credits,'topup',t.id);
       end if;
       reply_text := 'Keputusan top up tersimpan.';
     end if;
   end if;
 elsif p_action='grant' and p_admin then
   if p_args->>'phone' !~ '^62[0-9]{8,13}$' or length(p_args->>'evidence') < 3 then raise exception 'invalid_consent'; end if;
   insert into bot_consents values((p_args->>'user')::bigint,p_args->>'phone',p_args->>'evidence',p_user,now()+interval '24 hours')
   on conflict(telegram_id,phone) do update set evidence_ref=excluded.evidence_ref,granted_by=p_user,expires_at=excluded.expires_at;
   reply_text := 'Izin terverifikasi berlaku 24 jam.';
 elsif p_action='revoke' and p_admin then
   delete from bot_consents where telegram_id=(p_args->>'user')::bigint and bot_consents.phone=p_args->>'phone';
   reply_text := 'Izin dicabut.';
 elsif p_action='admin' and p_admin then
   select format('Pengguna: %s | Cek: %s | Pending cek: %s | Top up pending: %s | Kredit beredar: %s | Pemasukan disetujui: Rp%s',
    (select count(*) from bot_users),(select count(*) from bot_checks),
    (select count(*) from bot_checks where status='pending'),(select count(*) from bot_topups where status='pending'),
    (select coalesce(sum(credits),0) from bot_users),(select coalesce(sum(amount_rupiah),0) from bot_topups where status='approved')) into reply_text;
 elsif p_action='user' and p_admin then
   select format('User %s | Kredit %s | Gratis tersisa %s | Total cek %s | Berhasil %s | Top up pending %s',
    telegram_id,credits,case when quota_day=d then 3-free_used else 3 end,
    (select count(*) from bot_checks where telegram_id=b.telegram_id),
    (select count(*) from bot_checks where telegram_id=b.telegram_id and status='success'),
    (select count(*) from bot_topups where telegram_id=b.telegram_id and status='pending'))
   into reply_text from bot_users b where telegram_id=(p_args->>'user')::bigint;
   reply_text := coalesce(reply_text,'Pengguna tidak ditemukan.');
 elsif p_action='pending' and p_admin then
   select coalesce(string_agg(format('#%s user=%s kredit=%s Rp%s',id,telegram_id,credits,amount_rupiah),E'\n'),'Tidak ada top up pending.') into reply_text
   from (select * from bot_topups where status='pending' order by id limit 20) q;
 elsif p_action='history' then
   select coalesce(string_agg(line,E'\n'),'Belum ada riwayat.') into reply_text from (
    select line from (
     select created_at,format('%s | %s | %s kredit',created_at,reason,delta) line from bot_ledger where telegram_id=p_user
     union all
     select created_at,format('%s | cek gratis | %s',created_at,status) from bot_checks where telegram_id=p_user and not charged_credit
     union all
     select created_at,format('%s | top up #%s | Rp%s | %s',created_at,id,amount_rupiah,status) from bot_topups where telegram_id=p_user
    ) history_rows order by created_at desc limit 15
   ) q;
 elsif p_action='stats' then
   select format('Kredit: %s | Gratis tersisa hari ini: %s | Total cek: %s | Cek berhasil: %s',u.credits,3-u.free_used,count(*),count(*) filter(where status='success')) into reply_text from bot_checks where telegram_id=p_user;
 else reply_text := 'Perintah: /saldo /stats /history /topup JUMLAH_KREDIT /cek 628xxx. Harga Rp50/kredit. Cek memerlukan izin pemilik terverifikasi admin.';
 end if;
 update bot_updates set reply=reply_text where update_id=p_update;
 return jsonb_build_object('reply',reply_text);
end $$;

create function public.bot_finish(p_update bigint,p_status text) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare c bot_checks;
begin
 if p_status not in ('success','failed','unknown') then raise exception 'invalid_status'; end if;
 -- Same lock order as commands: user, then check.
 select * into c from bot_checks where update_id=p_update;
 if not found then raise exception 'check_missing'; end if;
 perform 1 from bot_users where telegram_id=c.telegram_id for update;
 select * into c from bot_checks where update_id=p_update for update;
 if c.status in ('success','failed') or (c.status='unknown' and p_status='unknown') then return; end if;
 update bot_checks set status=p_status where update_id=p_update;
 -- Unknown outcomes stay charged and require reconciliation; never blindly repeat provider calls.
 if p_status='failed' then
   if c.charged_credit then
     update bot_users set credits=credits+1 where telegram_id=c.telegram_id;
     insert into bot_ledger(telegram_id,delta,reason,check_id) values(c.telegram_id,1,'refund',p_update);
   else
     update bot_users set free_used=greatest(0,free_used-1) where telegram_id=c.telegram_id and quota_day=c.quota_day;
   end if;
 end if;
end $$;

alter table bot_users enable row level security;
alter table bot_updates enable row level security;
alter table bot_consents enable row level security;
alter table bot_checks enable row level security;
alter table bot_topups enable row level security;
alter table bot_ledger enable row level security;
revoke all on bot_users,bot_updates,bot_consents,bot_checks,bot_topups,bot_ledger from public,anon,authenticated;
revoke all on function bot_command(bigint,bigint,text,jsonb,boolean), bot_finish(bigint,text) from public,anon,authenticated;
grant execute on function bot_command(bigint,bigint,text,jsonb,boolean), bot_finish(bigint,text) to service_role;
