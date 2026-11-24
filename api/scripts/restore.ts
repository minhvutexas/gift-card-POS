/**
 * Restore a JSON backup into an EMPTY database.
 *
 *   createdb giftcard_restore
 *   DATABASE_URL=postgres://…/giftcard_restore SKIP_DEMO_SEED=true npm run db:migrate
 *   DATABASE_URL=postgres://…/giftcard_restore npm run db:restore -- backups/backup-2026-….json [sha256]
 *
 * Then point the API's DATABASE_URL at the restored database.
 */
import { readFileSync } from 'node:fs';
import { restoreBackup } from '../src/services/backup.js';
import { pool } from '../src/db.js';

const [file, sha] = process.argv.slice(2);
if (!file) {
  console.error('usage: npm run db:restore -- <backup.json> [expected-sha256]');
  process.exit(2);
}
const raw = readFileSync(file, 'utf8');
if (sha) {
  const { createHash } = await import('node:crypto');
  const actual = createHash('sha256').update(raw).digest('hex');
  if (actual !== sha) {
    console.error(`✗ checksum mismatch: expected ${sha}, got ${actual}`);
    process.exit(1);
  }
}
try {
  const out = await restoreBackup({ actorType: 'SYSTEM', actorId: null, terminalId: null, ip: null, ua: 'cli-restore' }, JSON.parse(raw));
  console.log('✓ restored', out.restored);
} catch (e: any) {
  console.error('✗ restore failed:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
