import { PGlite } from '@electric-sql/pglite';
import { mkdir, chmod } from 'node:fs/promises';
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { acquireDirectoryLock } from '@sanxing/local-storage';
import { DomainError } from '@sanxing/learning-domain';
import type { Usage, AccountIdentity, AdminUser, ManagedUserUpdate, ActivityModule, PlatformAiSettings, AdminActivity, AdminCall, AdminAudit } from '@sanxing/contracts';

const derive = promisify(scrypt);
export type Account = AccountIdentity;
type AccountRow = Account & { salt: string; password_hash: string; role: 'user' | 'admin'; status: 'active' | 'disabled'; auth_version: number; created_at: Date; last_login_at: Date | null; last_active_at: Date | null; last_logout_at: Date | null; last_module: string | null; daily_limit: number | null; platform_access: boolean };
export type PlatformRecord = { revision: number; settings: PlatformAiSettings; encryptedKey: string | null };

/** Cloud storage contains identity and call accounting only, never learning payloads. */
export async function openAccounts(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const release = await acquireDirectoryLock(directory);
  let db!: PGlite;
  try {
    db = new PGlite(directory);
    await db.exec(`CREATE TABLE IF NOT EXISTS accounts (
      id text PRIMARY KEY, username text NOT NULL UNIQUE, salt text NOT NULL, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    ); CREATE TABLE IF NOT EXISTS gateway_calls (
      account_id text NOT NULL REFERENCES accounts(id), request_id text NOT NULL, request_hash text NOT NULL,
      day text NOT NULL, status text NOT NULL, provider text NOT NULL, model text NOT NULL,
      reserved_usd double precision NOT NULL, cost_usd double precision, input_tokens integer, output_tokens integer,
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(account_id, request_id)
    );
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS auth_version integer NOT NULL DEFAULT 0;
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_active_at timestamptz;
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_logout_at timestamptz;
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_module text;
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS daily_limit integer;
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS platform_access boolean NOT NULL DEFAULT true;
    ALTER TABLE gateway_calls ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'personal';
    ALTER TABLE gateway_calls ADD COLUMN IF NOT EXISTS finished_at timestamptz;
    CREATE INDEX IF NOT EXISTS gateway_day ON gateway_calls(day, source);
    CREATE TABLE IF NOT EXISTS activity_events (id text PRIMARY KEY, account_id text NOT NULL REFERENCES accounts(id), type text NOT NULL, module text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS activity_created ON activity_events(created_at DESC);
    CREATE TABLE IF NOT EXISTS admin_audits (id text PRIMARY KEY, actor_id text NOT NULL REFERENCES accounts(id), target_id text REFERENCES accounts(id), action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS platform_ai (id integer PRIMARY KEY CHECK(id=1), revision integer NOT NULL, settings jsonb NOT NULL, encrypted_key text);
    `);
  } catch (error) { try { await db?.close(); } finally { await release(); } throw error; }
  let tail: Promise<unknown> = Promise.resolve();
  let nextPrune = Date.now() + 3600000;
  const queue = <T>(action: () => Promise<T>) => { const result = tail.then(action); tail = result.catch(() => undefined); return result; };
  const publicAccount = (row: Account): Account => ({ id: row.id, username: row.username, ...(row.role === 'admin' ? { role: 'admin' as const } : {}) });
  const get = async (id: string) => (await db.query<AccountRow>('SELECT * FROM accounts WHERE id=$1', [id])).rows[0];
  const stamp = (date: Date | null) => date ? new Date(date).toISOString() : null;
  const userView = (row: AccountRow & { calls_today?: number }): AdminUser => ({ id: row.id, username: row.username, role: row.role, status: row.status, version: row.auth_version,
    createdAt: stamp(row.created_at)!, lastLoginAt: stamp(row.last_login_at), lastActiveAt: stamp(row.last_active_at), lastModule: row.last_module,
    dailyLimit: row.daily_limit, platformAccess: row.platform_access, callsToday: row.calls_today ?? 0, online: row.status === 'active' && !!row.last_active_at && (!row.last_logout_at || new Date(row.last_active_at) > new Date(row.last_logout_at)) && Date.now() - new Date(row.last_active_at).getTime() < 120000 });
  const requireAdmin = async (id: string) => { const actor = await get(id); if (actor?.role !== 'admin' || actor.status !== 'active') throw new DomainError('ADMIN_REQUIRED', '此操作仅对管理员开放。', 403); };
  const verify = (username: string, password: string) => queue(async () => {
    const row = (await db.query<AccountRow>('SELECT * FROM accounts WHERE username=$1', [username])).rows[0];
    const hash = (await derive(password, row?.salt ?? 'sanxing-unregistered-account', 32)) as Buffer;
    if (!row || !timingSafeEqual(hash, Buffer.from(row.password_hash, 'hex'))) throw new DomainError('INVALID_CREDENTIALS', '用户名或密码不正确。', 401);
    if (row.status !== 'active') throw new DomainError('ACCOUNT_DISABLED', '此账号已停用，请联系管理员。', 403);
    return { user: publicAccount(row), version: row.auth_version };
  });
  const event = async (accountId: string, type: string, module: string | null = null) => { await db.query('INSERT INTO activity_events(id,account_id,type,module) VALUES($1,$2,$3,$4)', [randomUUID(), accountId, type, module]); };
  return {
    /** Bootstrap only an existing named account, and only before an administrator exists. Never promote future registrants. */
    bootstrapAdmins(usernames: string[]) { return queue(() => db.transaction(async tx => {
      if ((await tx.query("SELECT 1 FROM accounts WHERE role='admin' AND status='active' LIMIT 1")).rows.length) return;
      for (const username of usernames) {
        const result = await tx.query<{ id: string }>("UPDATE accounts SET role='admin', auth_version=auth_version+1 WHERE username=$1 AND status='active' RETURNING id", [username]);
        if (result.rows[0]) await tx.query('INSERT INTO admin_audits(id,actor_id,target_id,action) VALUES($1,$2,$2,$3)', [randomUUID(), result.rows[0].id, 'bootstrap_admin']);
      }
    })); },
    sessionAccount(id: string) { return queue(async () => { const row = await get(id); return row ? { user: publicAccount(row), status: row.status, version: row.auth_version, dailyLimit: row.daily_limit, platformAccess: row.platform_access } : null; }); },
    async register(username: string, password: string): Promise<Account> {
      const salt = randomBytes(32).toString('hex'); const hash = (await derive(password, salt, 32)) as Buffer;
      return queue(async () => {
        const row = { id: randomUUID(), username };
        const result = await db.query<Account>('INSERT INTO accounts(id, username, salt, password_hash) VALUES ($1, $2, $3, $4) ON CONFLICT(username) DO NOTHING RETURNING id, username', [row.id, username, salt, hash.toString('hex')]);
        if (!result.rows[0]) throw new DomainError('ACCOUNT_EXISTS', '该用户名已被使用，请登录或选择其他用户名。', 409);
        return publicAccount(result.rows[0]);
      });
    },
    async authenticate(username: string, password: string): Promise<Account> { return (await verify(username, password)).user; },
    verifyCredentials: verify,
    activity(accountId: string, type: 'login' | 'register' | 'logout' | 'page_view', module?: ActivityModule) { return queue(async () => {
      if (Date.now() >= nextPrune) { await db.exec("DELETE FROM activity_events WHERE created_at<now()-interval '90 days'; DELETE FROM admin_audits WHERE created_at<now()-interval '365 days'"); nextPrune = Date.now() + 3600000; }
      const row = await get(accountId); if (!row) return;
      if (type !== 'page_view' || row.last_module !== module || !row.last_active_at || Date.now() - new Date(row.last_active_at).getTime() > 300000) await event(accountId, type, module ?? null);
      await db.query(`UPDATE accounts SET last_active_at=CASE WHEN $2='logout' THEN last_active_at ELSE now() END,
        last_logout_at=CASE WHEN $2='logout' THEN now() ELSE last_logout_at END,
        last_login_at=CASE WHEN $2 IN ('login','register') THEN now() ELSE last_login_at END,
        last_module=COALESCE($3,last_module) WHERE id=$1`, [accountId, type, module ?? null]);
    }); },
    listUsers(input: { search: string; status: string; page: number; pageSize: number; day: string }) { return queue(async () => {
      const params = [input.search, input.status];
      const where = "WHERE (strpos(username,$1)>0) AND ($2='' OR status=$2)";
      const total = (await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM accounts ${where}`, params)).rows[0]!.total;
      const rows = (await db.query<AccountRow & { calls_today: number }>(`SELECT a.*,(SELECT count(*)::int FROM gateway_calls c WHERE c.account_id=a.id AND day=$3) AS calls_today FROM accounts a ${where} ORDER BY created_at DESC,id LIMIT $4 OFFSET $5`, [...params, input.day, input.pageSize, (input.page - 1) * input.pageSize])).rows;
      return { items: rows.map(userView), total, page: input.page, pageSize: input.pageSize };
    }); },
    createManaged(actor: string, username: string, password: string) { return queue(async () => {
      await requireAdmin(actor);
      const salt = randomBytes(32).toString('hex'); const hash = (await derive(password, salt, 32)) as Buffer;
      return db.transaction(async tx => {
        const result = await tx.query<AccountRow>('INSERT INTO accounts(id,username,salt,password_hash) VALUES($1,$2,$3,$4) ON CONFLICT(username) DO NOTHING RETURNING *', [randomUUID(), username, salt, hash.toString('hex')]);
        if (!result.rows[0]) throw new DomainError('ACCOUNT_EXISTS', '该用户名已被使用。', 409);
        await tx.query('INSERT INTO admin_audits(id,actor_id,target_id,action) VALUES($1,$2,$3,$4)', [randomUUID(), actor, result.rows[0].id, 'create_user']);
        return userView(result.rows[0]);
      });
    }); },
    updateUser(actor: string, id: string, input: ManagedUserUpdate) { return queue(async () => {
      await requireAdmin(actor);
      const row = await get(id); if (!row) throw new DomainError('ACCOUNT_NOT_FOUND', '账号不存在。', 404);
      if (row.auth_version !== input.expectedVersion) throw new DomainError('REVISION_CONFLICT', '账号已被修改，请刷新后重试。', 409);
      if (actor === id && (input.status !== 'active' || input.role !== 'admin')) throw new DomainError('ADMIN_SELF_PROTECTED', '不能停用或降级当前管理员账号。', 409);
      if (row.role === 'admin' && row.status === 'active' && (input.role !== 'admin' || input.status !== 'active')) {
        const admins = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM accounts WHERE role='admin' AND status='active'");
        if (admins.rows[0]!.count <= 1) throw new DomainError('LAST_ADMIN', '必须保留至少一名启用的管理员。', 409);
      }
      const salt = input.newPassword ? randomBytes(32).toString('hex') : row.salt;
      const hash = input.newPassword ? ((await derive(input.newPassword, salt, 32)) as Buffer).toString('hex') : row.password_hash;
      return db.transaction(async tx => {
        const result = await tx.query<AccountRow>(`UPDATE accounts SET role=$2,status=$3,daily_limit=$4,platform_access=$5,salt=$6,password_hash=$7,auth_version=auth_version+1 WHERE id=$1 RETURNING *`, [id, input.role, input.status, input.dailyLimit, input.platformAccess, salt, hash]);
        await tx.query('INSERT INTO admin_audits(id,actor_id,target_id,action) VALUES($1,$2,$3,$4)', [randomUUID(), actor, id, input.newPassword ? 'reset_password' : 'update_user']);
        return userView(result.rows[0]!);
      });
    }); },
    platform() { return queue(async () => {
      const row = (await db.query<{ revision: number; settings: PlatformAiSettings; encrypted_key: string | null }>('SELECT revision,settings,encrypted_key FROM platform_ai WHERE id=1')).rows[0];
      return row ? { revision: row.revision, settings: row.settings, encryptedKey: row.encrypted_key } satisfies PlatformRecord : null;
    }); },
    savePlatform(actor: string, record: PlatformRecord, expected: number) { return queue(async () => { await requireAdmin(actor); return db.transaction(async tx => {
      const previous = (await tx.query<{ revision: number }>('SELECT revision FROM platform_ai WHERE id=1')).rows[0];
      if ((previous?.revision ?? 0) !== expected) throw new DomainError('REVISION_CONFLICT', '平台 AI 配置已更新，请刷新后重新保存。', 409);
      await tx.query('INSERT INTO platform_ai(id,revision,settings,encrypted_key) VALUES(1,$1,$2,$3) ON CONFLICT(id) DO UPDATE SET revision=$1,settings=$2,encrypted_key=$3', [expected + 1, JSON.stringify(record.settings), record.encryptedKey]);
      await tx.query('INSERT INTO admin_audits(id,actor_id,action) VALUES($1,$2,$3)', [randomUUID(), actor, 'configure_platform_ai']);
    }); }); },
    overview(day: string, timezone: string) { return queue(async () => {
      const users = (await db.query<{ users: number; disabledUsers: number; onlineUsers: number; activeToday: number; registrationsToday: number }>(`SELECT count(*)::int AS users,
        count(*) FILTER(WHERE status='disabled')::int AS "disabledUsers", count(*) FILTER(WHERE status='active' AND last_active_at>now()-interval '2 minutes' AND (last_logout_at IS NULL OR last_active_at>last_logout_at))::int AS "onlineUsers",
        count(*) FILTER(WHERE to_char(last_active_at AT TIME ZONE $2,'YYYY-MM-DD')=$1)::int AS "activeToday", count(*) FILTER(WHERE to_char(created_at AT TIME ZONE $2,'YYYY-MM-DD')=$1)::int AS "registrationsToday" FROM accounts`, [day, timezone])).rows[0]!;
      // Logged-out users remain part of daily activity through their event records.
      users.activeToday = (await db.query<{ count: number }>("SELECT count(DISTINCT account_id)::int AS count FROM activity_events WHERE to_char(created_at AT TIME ZONE $2,'YYYY-MM-DD')=$1", [day, timezone])).rows[0]!.count;
      const calls = (await db.query<{ callsToday: number; failedToday: number; platformCallsToday: number; inputTokens: number; outputTokens: number; knownUsageCalls: number; costUsd: number; knownCostCalls: number }>(`SELECT count(*)::int AS "callsToday",count(*) FILTER(WHERE status='failed')::int AS "failedToday",count(*) FILTER(WHERE source='platform')::int AS "platformCallsToday",
        COALESCE(sum(input_tokens),0)::float8 AS "inputTokens",COALESCE(sum(output_tokens),0)::float8 AS "outputTokens",count(input_tokens)::int AS "knownUsageCalls",COALESCE(sum(cost_usd),0)::float8 AS "costUsd",count(cost_usd)::int AS "knownCostCalls" FROM gateway_calls WHERE day=$1`, [day])).rows[0]!;
      const runningCalls = (await db.query<{ count: number }>("SELECT count(*)::int AS count FROM gateway_calls WHERE status='running'")).rows[0]!.count;
      const series = (await db.query<{ date: string; calls: number; failed: number; activeUsers: number }>(`SELECT to_char(d,'YYYY-MM-DD') AS date,
        (SELECT count(*)::int FROM gateway_calls WHERE day=to_char(d,'YYYY-MM-DD')) AS calls,
        (SELECT count(*)::int FROM gateway_calls WHERE day=to_char(d,'YYYY-MM-DD') AND status='failed') AS failed,
        (SELECT count(DISTINCT account_id)::int FROM activity_events WHERE (created_at AT TIME ZONE $2)::date=d::date) AS "activeUsers"
        FROM generate_series($1::date-13,$1::date,'1 day'::interval) d ORDER BY d`, [day, timezone])).rows;
      const recent = (await db.query<AdminActivity>(`SELECT e.id,a.username,e.type,e.module,e.created_at AS "createdAt" FROM activity_events e JOIN accounts a ON a.id=e.account_id ORDER BY e.created_at DESC LIMIT 8`)).rows;
      return { ...users, ...calls, runningCalls, series, recent };
    }); },
    activities(input: { page: number; pageSize: number; search: string }) { return queue(async () => {
      const total = (await db.query<{ count: number }>('SELECT count(*)::int AS count FROM activity_events e JOIN accounts a ON a.id=e.account_id WHERE strpos(a.username,$1)>0', [input.search])).rows[0]!.count;
      const items = (await db.query<AdminActivity>(`SELECT e.id,a.username,e.type,e.module,e.created_at AS "createdAt" FROM activity_events e JOIN accounts a ON a.id=e.account_id WHERE strpos(a.username,$1)>0 ORDER BY e.created_at DESC,e.id LIMIT $2 OFFSET $3`, [input.search, input.pageSize, (input.page - 1) * input.pageSize])).rows;
      const calls = (await db.query<AdminCall>(`SELECT a.username,c.source,c.status,c.provider,c.model,c.created_at AS "createdAt",EXTRACT(epoch FROM (c.finished_at-c.created_at))*1000 AS "durationMs",c.input_tokens AS "inputTokens",c.output_tokens AS "outputTokens",c.cost_usd AS "costUsd" FROM gateway_calls c JOIN accounts a ON a.id=c.account_id WHERE strpos(a.username,$1)>0 ORDER BY c.created_at DESC LIMIT 30`, [input.search])).rows;
      const audits = (await db.query<AdminAudit>(`SELECT e.id,a.username AS actor,t.username AS target,e.action,e.created_at AS "createdAt" FROM admin_audits e JOIN accounts a ON a.id=e.actor_id LEFT JOIN accounts t ON t.id=e.target_id ORDER BY e.created_at DESC LIMIT 30`)).rows;
      return { items, calls, audits, total, page: input.page, pageSize: input.pageSize };
    }); },
    begin(input: { accountId: string; authVersion?: number; requestId: string; hash: string; day: string; provider: string; model: string; maxDailyCalls: number; dailyBudget: number | null; reservation: number;
      platform?: { perUserDailyCalls: number; globalDailyCalls: number; maxConcurrent: number } }) {
      return queue(() => db.transaction(async tx => {
        const account = (await tx.query<AccountRow>('SELECT * FROM accounts WHERE id=$1', [input.accountId])).rows[0];
        if (!account || account.status !== 'active') throw new DomainError('ACCOUNT_DISABLED', '此账号已停用。', 403);
        if (input.authVersion !== undefined && account.auth_version !== input.authVersion) throw new DomainError('UNAUTHENTICATED', '账号信息已变更，请重新登录。', 401);
        if ((await tx.query('SELECT 1 FROM gateway_calls WHERE account_id=$1 AND request_id=$2', [input.accountId, input.requestId])).rows.length) throw new DomainError('GATEWAY_ALREADY_STARTED', '该请求已提交过，不会重复调用模型。请核对本地任务结果，必要时明确重试。', 409);
        const result = await tx.query<{ count: number; reserved: number; active: number }>(`SELECT count(*)::integer AS count,
          COALESCE(sum(COALESCE(cost_usd, reserved_usd)),0)::float8 AS reserved,
          (SELECT count(*)::integer FROM gateway_calls WHERE account_id=$1 AND status='running') AS active FROM gateway_calls WHERE account_id=$1 AND day=$2`, [input.accountId, input.day]);
        const value = result.rows[0]!;
        if (value.active >= 1) throw new DomainError('GATEWAY_BUSY', '此账号已有模型请求执行中，请等待完成。', 429);
        if (value.count >= (account.daily_limit ?? input.maxDailyCalls)) throw new DomainError('REQUEST_LIMIT', '此账号今日已达到网关调用上限。', 429);
        if (input.platform) {
          if (!account.platform_access) throw new DomainError('PLATFORM_ACCESS_DISABLED', '此账号未开通平台 AI。', 403);
          const limits = (await tx.query<{ total: number; own: number; active: number }>(`SELECT count(*) FILTER(WHERE day=$1)::int AS total,count(*) FILTER(WHERE day=$1 AND account_id=$2)::int AS own,count(*) FILTER(WHERE status='running')::int AS active FROM gateway_calls WHERE source='platform'`, [input.day, input.accountId])).rows[0]!;
          if (limits.total >= input.platform.globalDailyCalls || limits.own >= input.platform.perUserDailyCalls) throw new DomainError('PLATFORM_DAILY_LIMIT', '平台 AI 今日调用额度已用完，请明日再试或使用个人 AI。', 429);
          if (limits.active >= input.platform.maxConcurrent) throw new DomainError('PLATFORM_BUSY', '平台 AI 正忙，请稍后重试。', 429);
        }
        if (input.dailyBudget !== null && value.reserved + input.reservation > input.dailyBudget) throw new DomainError('BUDGET_EXCEEDED', '此账号今日网关预算不足。', 429);
        await tx.query(`INSERT INTO gateway_calls(account_id,request_id,request_hash,day,status,provider,model,reserved_usd,source)
          VALUES($1,$2,$3,$4,'running',$5,$6,$7,$8)`, [input.accountId, input.requestId, input.hash, input.day, input.provider, input.model, input.reservation, input.platform ? 'platform' : 'personal']);
      }));
    },
    finish(accountId: string, requestId: string, status: 'succeeded' | 'failed', usage: Usage | null) {
      return queue(async () => { await db.query(`UPDATE gateway_calls SET status=$3, cost_usd=$4, input_tokens=$5, output_tokens=$6, finished_at=now()
        WHERE account_id=$1 AND request_id=$2`, [accountId, requestId, status, usage?.cost ?? null, usage?.inputTokens ?? null, usage?.outputTokens ?? null]); });
    },
    recordUsage(accountId: string, requestId: string, usage: Usage) {
      return queue(async () => { await db.query('UPDATE gateway_calls SET cost_usd=$3, input_tokens=$4, output_tokens=$5 WHERE account_id=$1 AND request_id=$2',
        [accountId, requestId, usage.cost, usage.inputTokens, usage.outputTokens]); });
    },
    async recover() { await db.exec("UPDATE gateway_calls SET status='failed',finished_at=NULL WHERE status='running'; DELETE FROM activity_events WHERE created_at<now()-interval '90 days'; DELETE FROM admin_audits WHERE created_at<now()-interval '365 days';"); },
    async inspect() { return queue(async () => ({ accounts: (await db.query<Account>('SELECT id, username FROM accounts ORDER BY username')).rows,
      calls: (await db.query('SELECT * FROM gateway_calls ORDER BY created_at')).rows })); },
    async close() { await tail; try { await db.close(); } finally { await release(); } },
  };
}
export type Accounts = Awaited<ReturnType<typeof openAccounts>>;
