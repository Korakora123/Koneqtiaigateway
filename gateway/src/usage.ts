import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

/** One row per request. Metadata only — never prompts, replies, transcripts or audio. */
export interface UsageRecord {
  ts: number;
  request_id: string;
  product: string;
  tenant: string;
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
}

export interface UsageSummaryRow {
  task: string;
  model: string;
  requests: number;
  errors: number;
  busy: number;
  tokens_in: number;
  tokens_out: number;
  audio_seconds: number;
  chars: number;
  avg_latency_ms: number;
  avg_queue_ms: number;
}

export class UsageStore {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ts            INTEGER NOT NULL,
        request_id    TEXT    NOT NULL,
        product       TEXT    NOT NULL,
        tenant        TEXT    NOT NULL,
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
        stream        INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS usage_product_ts ON usage (product, ts);
      CREATE INDEX IF NOT EXISTS usage_tenant_ts ON usage (product, tenant, ts);
    `);
    this.insertStmt = this.db.prepare(`
      INSERT INTO usage (ts, request_id, product, tenant, task, model, priority, status, error_code,
                         queue_ms, latency_ms, tokens_in, tokens_out, audio_seconds, chars, stream)
      VALUES (@ts, @request_id, @product, @tenant, @task, @model, @priority, @status, @error_code,
              @queue_ms, @latency_ms, @tokens_in, @tokens_out, @audio_seconds, @chars, @stream)`);
  }

  record(r: UsageRecord): void {
    this.insertStmt.run(r);
  }

  summary(product: string, sinceMs: number, tenant?: string): UsageSummaryRow[] {
    const where = tenant ? 'product = ? AND ts >= ? AND tenant = ?' : 'product = ? AND ts >= ?';
    const args = tenant ? [product, sinceMs, tenant] : [product, sinceMs];
    return this.db
      .prepare(
        `SELECT task, model, COUNT(*) AS requests,
                SUM(status >= 400) AS errors, SUM(status = 503) AS busy,
                SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
                ROUND(SUM(audio_seconds), 1) AS audio_seconds, SUM(chars) AS chars,
                CAST(AVG(latency_ms) AS INTEGER) AS avg_latency_ms, CAST(AVG(queue_ms) AS INTEGER) AS avg_queue_ms
         FROM usage WHERE ${where} GROUP BY task, model ORDER BY task`,
      )
      .all(...args) as UsageSummaryRow[];
  }

  /** Deletes rows older than `days` (run daily). */
  prune(days: number): number {
    return this.db.prepare('DELETE FROM usage WHERE ts < ?').run(Date.now() - days * 86_400_000).changes;
  }

  close(): void {
    this.db.close();
  }
}
