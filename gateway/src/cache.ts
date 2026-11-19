import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * Exact answer cache, per business (master spec §5, handover §1.6).
 * - Key = sha256 of the full model request; the prompt itself is never stored.
 * - Rows are scoped by (product, subtenant): one business never gets another's answer.
 * - Only the answer is stored, with an expiry; `DELETE /v1/subtenants/:id/data` removes them.
 */
export interface CachedAnswer {
  content: string;
  tokensIn: number;
  tokensOut: number;
}

export function cacheKey(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export class AnswerCache {
  private readonly getStmt: Database.Statement;
  private readonly putStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cache_entries (
        product     TEXT    NOT NULL,
        subtenant   TEXT    NOT NULL,
        key_hash    TEXT    NOT NULL,
        task        TEXT    NOT NULL,
        content     TEXT    NOT NULL,
        tokens_in   INTEGER NOT NULL DEFAULT 0,
        tokens_out  INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        hits        INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (product, subtenant, key_hash)
      );
      CREATE INDEX IF NOT EXISTS cache_expires ON cache_entries (expires_at);
    `);
    this.getStmt = db.prepare(
      `SELECT content, tokens_in AS tokensIn, tokens_out AS tokensOut FROM cache_entries
       WHERE product = ? AND subtenant = ? AND key_hash = ? AND expires_at > ?`,
    );
    this.putStmt = db.prepare(
      `INSERT INTO cache_entries (product, subtenant, key_hash, task, content, tokens_in, tokens_out, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (product, subtenant, key_hash) DO UPDATE SET
         content = excluded.content, tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out,
         created_at = excluded.created_at, expires_at = excluded.expires_at`,
    );
  }

  get(product: string, subtenant: string, key: string): CachedAnswer | null {
    const row = this.getStmt.get(product, subtenant, key, Date.now()) as CachedAnswer | undefined;
    if (!row) return null;
    this.db.prepare(`UPDATE cache_entries SET hits = hits + 1 WHERE product = ? AND subtenant = ? AND key_hash = ?`).run(product, subtenant, key);
    return row;
  }

  put(product: string, subtenant: string, key: string, task: string, a: CachedAnswer, ttlSec: number): void {
    const t = Date.now();
    this.putStmt.run(product, subtenant, key, task, a.content, a.tokensIn, a.tokensOut, t, t + ttlSec * 1000);
  }

  deleteSubtenant(product: string, subtenant: string): number {
    return this.db.prepare(`DELETE FROM cache_entries WHERE product = ? AND subtenant = ?`).run(product, subtenant).changes;
  }

  pruneExpired(): number {
    return this.db.prepare(`DELETE FROM cache_entries WHERE expires_at <= ?`).run(Date.now()).changes;
  }

  stats(): { entries: number; hits: number } {
    return this.db.prepare(`SELECT COUNT(*) AS entries, COALESCE(SUM(hits), 0) AS hits FROM cache_entries`).get() as {
      entries: number;
      hits: number;
    };
  }
}
