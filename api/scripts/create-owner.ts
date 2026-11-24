/**
 * First-run setup for a real (non-demo) install.
 * Creates the OWNER login and one paired POS terminal, then prints the terminal key.
 *
 *   SKIP_DEMO_SEED=true npm run db:migrate
 *   npm run setup:owner
 *
 * Asks for values interactively. For scripts, set OWNER_USERNAME, OWNER_NAME,
 * OWNER_PASSWORD, OWNER_PIN (optional), TERMINAL_CODE, TERMINAL_NAME.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (load api/.env first).');
  process.exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });
async function ask(env: string, label: string, def = ''): Promise<string> {
  const v = process.env[env];
  if (v !== undefined && v !== '') return v.trim();
  const a = (await rl.question(def ? `${label} [${def}]: ` : `${label}: `)).trim();
  return a || def;
}

const username = await ask('OWNER_USERNAME', 'Owner username', 'owner');
const name = await ask('OWNER_NAME', 'Owner display name', 'Owner');
const password = await ask('OWNER_PASSWORD', 'Owner password (min 10 chars)');
const pin = await ask('OWNER_PIN', 'Owner PIN (4-8 digits, blank = none)');
const terminalCode = (await ask('TERMINAL_CODE', 'Terminal code', 'FRONT-DESK-1')).toUpperCase();
const terminalName = await ask('TERMINAL_NAME', 'Terminal name', 'Front desk');
rl.close();

const fail = (m: string): never => {
  console.error(`✗ ${m}`);
  process.exit(1);
};
if (!/^[A-Za-z0-9._-]{2,40}$/.test(username)) fail('Username: 2-40 letters, digits, . _ -');
if (password.length < 10) fail('Password must be at least 10 characters');
if (pin && !/^\d{4,8}$/.test(pin)) fail('PIN must be 4-8 digits');
if (!/^[A-Z0-9-]{2,40}$/.test(terminalCode)) fail('Terminal code: 2-40 of A-Z 0-9 -');

const key = `gct_${randomBytes(24).toString('base64url')}`;
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  const exists = await client.query('SELECT 1 FROM users WHERE lower(username) = lower($1)', [username]);
  if (exists.rowCount) throw new Error(`User "${username}" already exists — nothing changed.`);
  const demo = await client.query(`SELECT 1 FROM terminals WHERE code IN ('FRONT-DESK-1','KIOSK-1') AND api_key_hash = $1`, [
    createHash('sha256').update('dev-frontdesk-key').digest('hex'),
  ]);
  if (demo.rowCount) console.warn('⚠ Demo data found. For production, migrate a fresh DB with SKIP_DEMO_SEED=true.');

  await client.query(`INSERT INTO users (name, username, role, password_hash, pin_hash) VALUES ($1, $2, 'OWNER', $3, $4)`, [
    name,
    username,
    await bcrypt.hash(password, 10),
    pin ? await bcrypt.hash(pin, 10) : null,
  ]);
  await client.query(`INSERT INTO terminals (code, name, kind, api_key_hash) VALUES ($1, $2, 'POS', $3)`, [
    terminalCode,
    terminalName,
    createHash('sha256').update(key).digest('hex'),
  ]);
  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK');
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
} finally {
  await client.end();
}

console.log(`\n✓ Owner "${username}" created.`);
console.log(`✓ Terminal ${terminalCode} created. Its key (shown once — save it):\n\n    ${key}\n`);
console.log('Enter this key on the device in Settings › Terminal, then log in.');
