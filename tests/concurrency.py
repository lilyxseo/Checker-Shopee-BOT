"""Disposable local DB only; run after bot.sql. Uses real concurrent psql sessions."""
import concurrent.futures
import os
import subprocess
from urllib.parse import urlparse

url = os.environ.get('BOT_TEST_DB', 'postgresql://postgres:postgres@127.0.0.1:54322/postgres')
if urlparse(url).hostname not in ('127.0.0.1', 'localhost'):
    raise SystemExit('Concurrency tests require a disposable localhost database')

def sql(query):
    r = subprocess.run(['psql', url, '-XAt', '-v', 'ON_ERROR_STOP=1', '-c', query], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError('Database test command failed (details suppressed to protect connection secrets)')
    return r.stdout.strip()

sql("""
insert into bot_users(telegram_id,credits,free_used,quota_day) values
(88001,1,3,(now() at time zone 'Asia/Jakarta')::date),(88002,0,0,null),(88003,0,0,null);
insert into bot_consents values(88001,'6281234567890','test-only',88002,now()+interval '1 hour');
""")
try:
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(lambda _: sql("select bot_command(88001,88001,'check','{\"phone\":\"6281234567890\"}')"), range(12)))
    assert sql('select credits from bot_users where telegram_id=88001') == '0'
    assert sql('select count(*) from bot_ledger where check_id=88001') == '1'
    assert sum('"duplicate": true' in x for x in results) == 11
    sql("update bot_users set last_request=null where telegram_id=88001; select bot_command(88002,88001,'topup','{\"credits\":10}');")
    topup = sql('select id from bot_topups where update_id=88002')
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda admin: sql(f"select bot_command({admin+10},{admin},'approve','{{\"id\":{topup}}}',true)"), [88002,88003]))
    assert sql('select credits from bot_users where telegram_id=88001') == '10'
    assert sql(f'select count(*) from bot_ledger where topup_id={topup}') == '1'
    print('Concurrent duplicate debit and topup approval passed')
finally:
    sql('''delete from bot_ledger where telegram_id in (88001,88002,88003);
    delete from bot_topups where telegram_id in (88001,88002,88003);
    delete from bot_checks where telegram_id in (88001,88002,88003);
    delete from bot_consents where telegram_id in (88001,88002,88003);
    delete from bot_updates where telegram_id in (88001,88002,88003);
    delete from bot_users where telegram_id in (88001,88002,88003);''')
