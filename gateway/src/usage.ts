import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

/** One row per request. Metadata only — never prompts, replies, transcripts or audio. */
export interface UsageRecord {
  ts: number;
  request_id: string;
  /** Tenant = product that owns the key. */
  product: string;
  /** Business id (x-kq-subtenant) or `system`. */
  subtenant: string;
  task: string;
  model: string;
  priority: string;
  status: number;
  error_code: string | null;
  queue_ms: number;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  audio_seconds: number;
  chars: number;
  stream: number;
  /** hit | miss | off | '' (not cacheable) */
  cache: string;
}

export interface TaskUsage {
  calls: number;
  errors: number;
  busy: number;
  tokens: number;
  tokens_in: number;
  tokens_out: number;
  audio_sec: number;
  chars: number;
  avg_latency_ms: number;
  cache_hits: number;
}

export interface SubtenantSettings {
  retention_days: number;
  allow_cache: boolean;
}

export const DEFAULT_SETTINGS: SubtenantSettings = { retention_days: 0, allow_cache: true };

export class UsageStore {
  readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly touchStmt: Database.Statement;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    this.insertStmt = this.db.prepare(`
      INSERT INTO usage (ts, request_id, product, subtenant, task, model, priority, status, error_code,
                         queue_ms, latency_ms, tokens_in, tokens_out, audio_seconds, chars, stream, cache)
      VALUES (@ts, @request_id, @product, @subtenant, @task, @model, @priority, @status, @error_code,
              @queue_ms, @latency_ms, @tokens_in, @tokens_out, @audio_seconds, @chars, @stream, @cache)`);
    this.touchStmt = this.db.prepare(
      `INSERT OR IGNORE INTO subtenants (product, subtenant, retention_days, allow_cache, created_at, updated_at)
       VALUES (?, ?, 0, 1, ?, ?)`,
    );
  }

  private migrate(): void {
    const cols = this.db.prepare(`PRAGMA table_info(usage)`).all() as Array<{ name: string }>;
    // v0 (Sep 2026) called the business column `tenant`.
    if (cols.some((c) => c.name === 'tenant') && !cols.some((c) => c.name === 'subtenant')) {
      this.db.exec(`ALTER TABLE usage RENAME COLUMN tenant TO subtenant; DROP INDEX IF EXISTS usage_tenant_ts;`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ts            INTEGER NOT NULL,
        request_id    TEXT    NOT NULL,
        product       TEXT    NOT NULL,
        subtenant     TEXT    NOT NULL,
        task          TEXT    NOT NULL,
        model         TEXT    NOT NULL,
        priority      TEXT    NOT NULL,
        status        INTEGER NOT NULL,
        error_code    TEXT,
        queue_ms      INTEGER NOT NULL DEFAULT 0,
        latency_ms    INTEGER NOT NULL DEFAULT 0,
        tokens_in     INTEGER NOT NULL DEFAULT 0,
        tokens_out    INTEGER NOT NULL DEFAULT 0,
        audio_seconds REAL    NOT NULL DEFAULT 0,
        chars         INTEGER NOT NULL DEFAULT 0,
        stream        INTEGER NOT NULL DEFAULT 0,
        cache         TEXT    NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS usage_product_ts ON usage (product, ts);
      CREATE INDEX IF NOT EXISTS usage_subtenant_ts ON usage (product, subtenant, ts);
      CREATE TABLE IF NOT EXISTS subtenants (
        product        TEXT    NOT NULL,
        subtenant      TEXT    NOT NULL,
        retention_days INTEGER NOT NULL DEFAULT 0,
        allow_cache    INTEGER NOT NULL DEFAULT 1,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        PRIMARY KEY (product, subtenant)
      );
    `);
    const after = this.db.prepare(`PRAGMA table_info(usage)`).all() as Array<{ name: string }>;
    if (!after.some((c) => c.name === 'cache')) this.db.exec(`ALTER TABLE usage ADD COLUMN cache TEXT NOT NULL DEFAULT ''`);
  }

  record(r: UsageRecord): void {
    this.insertStmt.run(r);
  }

  /** Subtenants are created automatically on first use (master spec §11.1). */
  touchSubtenant(product: string, subtenant: string): void {
    const t = Date.now();
    this.touchStmt.run(product, subtenant, t, t);
  }

  /** Totals per task between [from, to) (epoch ms). `subtenant` omitted → whole tenant. */
  byTask(product: string, from: number, to: number, subtenant?: string): Record<string, TaskUsage> {
    const where = `product = ? AND ts >= ? AND ts < ?${subtenant ? ' AND subtenant = ?' : ''}`;
    const args: Array<string | number> = subtenant ? [product, from, to, subtenant] : [product, from, to];
    const rows = this.db
      .prepare(
        `SELECT task, COUNT(*) AS calls, SUM(status >= 400) AS errors, SUM(status = 503) AS busy,
                SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
                ROUND(SUM(audio_seconds), 1) AS audio_sec, SUM(chars) AS chars,
                CAST(AVG(latency_ms) AS INTEGER) AS avg_latency_ms, SUM(cache = 'hit') AS cache_hits
         FROM usage WHERE ${where} GROUP BY task ORDER BY task`,
      )
      .all(...args) as Array<Omit<TaskUsage, 'tokens'> & { task: string }>;
    const out: Record<string, TaskUsage> = {};
    for (const { task, ...r } of rows) out[task] = { ...r, tokens: r.tokens_in + r.tokens_out };
    return out;
  }

  getSettings(product: string, subtenant: string): SubtenantSettings & { exists: boolean } {
    const row = this.db
      .prepare(`SELECT retention_days, allow_cache FROM subtenants WHERE product = ? AND subtenant = ?`)
      .get(product, subtenant) as { retention_days: number; allow_cache: number } | undefined;
    if (!row) return { ...DEFAULT_SETTINGS, exists: false };
    return { retention_days: row.retention_days, allow_cache: row.allow_cache === 1, exists: true };
  }

  putSettings(product: string, subtenant: string, s: SubtenantSettings): void {
    const t = Date.now();
    this.db
      .prepare(
        `INSERT INTO subtenants (product, subtenant, retention_days, allow_cache, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (product, subtenant) DO UPDATE SET
           retention_days = excluded.retention_days, allow_cache = excluded.allow_cache, updated_at = excluded.updated_at`,
      )
      .run(product, subtenant, s.retention_days, s.allow_cache ? 1 : 0, t, t);
  }

  /** Removes everything the gateway holds for one business (ledger rows + settings). */
  deleteSubtenant(product: string, subtenant: string): { usage_rows: number } {
    const del = this.db.transaction(() => {
      const u = this.db.prepare(`DELETE FROM usage WHERE product = ? AND subtenant = ?`).run(product, subtenant).changes;
      this.db.prepare(`DELETE FROM subtenants WHERE product = ? AND subtenant = ?`).run(product, subtenant);
      return u;
    });
    return { usage_rows: del() };
  }

  /** Deletes rows older than `days` (run daily). */
  prune(days: number): number {
    return this.db.prepare('DELETE FROM usage WHERE ts < ?').run(Date.now() - days * 86_400_000).changes;
  }

  close(): void {
    this.db.close();
  }
}
