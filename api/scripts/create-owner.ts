/**
 * Creates a salon by hand: the salon (business), its default settings, the
 * OWNER login and one paired POS terminal, then prints the terminal key.
 * (Salons can also sign up from the web once the signup page ships.)
 *
 *   SKIP_DEMO_SEED=true npm run db:migrate
 *   npm run setup:owner
 *
 * Asks for values interactively. For scripts, set SALON_NAME, SALON_ID,
 * OWNER_EMAIL, OWNER_USERNAME, OWNER_NAME,
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

const salonName = await ask('SALON_NAME', 'Salon name');
const suggested = salonName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const slug = (await ask('SALON_ID', 'Salon ID (used to log in; a-z 0-9 -)', suggested)).toLowerCase();
const email = await ask('OWNER_EMAIL', 'Owner email (optional)');
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
if (!salonName || salonName.length > 80) fail('Salon name: 1-80 characters');
if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) fail('Salon ID: 3-40 of a-z 0-9 -, not starting/ending with -');
if (!/^[A-Za-z0-9._-]{2,40}$/.test(username)) fail('Username: 2-40 letters, digits, . _ -');
if (password.length < 10) fail('Password must be at least 10 characters');
if (pin && !/^\d{4,8}$/.test(pin)) fail('PIN must be 4-8 digits');
if (!/^[A-Z0-9-]{2,40}$/.test(terminalCode)) fail('Terminal code: 2-40 of A-Z 0-9 -');

const key = `gct_${randomBytes(24).toString('base64url')}`;
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  // Platform step: create the salon (SET LOCAL → ends with the transaction).
  await client.query(`SELECT set_config('app.system', 'on', true)`);
  if ((await client.query('SELECT 1 FROM businesses WHERE slug = $1', [slug])).rowCount) {
    throw new Error(`Salon ID "${slug}" is taken — nothing changed.`);
  }
  const { rows } = await client.query<{ id: number }>(
    'INSERT INTO businesses (slug, name, owner_email) VALUES ($1, $2, $3) RETURNING id',
    [slug, salonName, email || null],
  );
  const bid = rows[0].id;
  // Everything else happens inside the new salon only.
  await client.query(`SELECT set_config('app.system', '', true), set_config('app.business_id', $1, true)`, [String(bid)]);
  await client.query('SELECT fn_seed_business($1, $2)', [bid, salonName]);

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

console.log(`\n✓ Salon "${salonName}" created. Salon ID: ${slug}`);
console.log(`✓ Owner "${username}" created.`);
console.log(`✓ Terminal ${terminalCode} created. Its key (shown once — save it):\n\n    ${key}\n`);
console.log('Enter this key on the device in Settings › Terminal, then log in.');
