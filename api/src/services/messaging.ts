import { config } from '../config.js';
import { one, query } from '../db.js';
import { ApiError } from '../errors.js';
import { formatCents } from '../money.js';
import { getAllSettings } from '../settings.js';
import type { Card, Txn } from './cards.js';
import { kioskUrl, maskNumber } from './qr.js';
import { currentBusinessId } from '../db.js';
import { businessById } from '../tenant.js';

export type MsgChannel = 'EMAIL' | 'SMS';
export const TEMPLATE_KEYS = ['card_delivered', 'low_balance', 'reload_thanks', 'expiry_warning'] as const;

export function render(tpl: string, vars: Record<string, string>) {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? '');
}

async function vars(card: Card, extra: Record<string, string> = {}) {
  const s = await getAllSettings();
  return {
    business_name: s.general.business_name,
    first_name: card.customer?.first_name ?? 'there',
    card_masked: maskNumber(card.card_number),
    balance: formatCents(card.balance_cents, card.currency),
    kiosk_url: kioskUrl(card.id, (await businessById(currentBusinessId()!))?.slug ?? ''),
    expires_on: card.expires_at ? new Date(card.expires_at).toLocaleDateString('en-US', { timeZone: s.general.timezone }) : '',
    ...extra,
  };
}

async function deliver(channel: MsgChannel, to: string, subject: string | null, body: string): Promise<'SENT' | 'SIMULATED'> {
  const s = (await getAllSettings()).messaging;
  if (channel === 'SMS' && s.sms_provider === 'twilio') {
    if (!config.twilio.sid || !config.twilio.token || !s.from_sms) throw new Error('Twilio is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / from number)');
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.twilio.sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${config.twilio.sid}:${config.twilio.token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: s.from_sms, Body: body }),
    });
    if (!r.ok) throw new Error(`Twilio ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return 'SENT';
  }
  if (channel === 'EMAIL' && s.email_provider === 'sendgrid') {
    if (!config.sendgridKey || !s.from_email) throw new Error('SendGrid is not configured (SENDGRID_API_KEY / from email)');
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.sendgridKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: s.from_email },
        subject: subject ?? '',
        content: [{ type: 'text/plain', value: body }],
      }),
    });
    if (!r.ok) throw new Error(`SendGrid ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return 'SENT';
  }
  if (config.env !== 'test') console.info(`[message:${channel}] → ${to}\n${subject ? subject + '\n' : ''}${body}`);
  return 'SIMULATED';
}

export async function sendTemplate(card: Card, key: string, channel: MsgChannel, opts: { to?: string; extra?: Record<string, string> } = {}) {
  const tpl = await one<{ subject: string | null; body: string }>('SELECT subject, body FROM message_templates WHERE key = $1 AND channel = $2 AND active', [key, channel]);
  if (!tpl) throw new ApiError(404, 'TEMPLATE_NOT_FOUND', `No active ${channel} template "${key}"`);
  const to = opts.to ?? (channel === 'EMAIL' ? card.customer?.email : card.customer?.phone);
  if (!to) throw new ApiError(400, 'VALIDATION', `No ${channel === 'EMAIL' ? 'email' : 'phone'} on file — enter a recipient`, 'to');
  const v = await vars(card, opts.extra);
  const subject = tpl.subject ? render(tpl.subject, v) : null;
  const body = render(tpl.body, v);
  let status: string;
  let error: string | null = null;
  try {
    status = await deliver(channel, to, subject, body);
  } catch (e: any) {
    status = 'FAILED';
    error = e.message;
  }
  const log = await one<{ id: number }>(
    'INSERT INTO message_log (template_key, card_id, customer_id, channel, recipient, status, error) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [key, card.id, card.customer?.id ?? null, channel, to, status, error],
  );
  return { id: log!.id, status, error, subject, body, to };
}

/** Automatic messages after money movements (best-effort, never blocks the sale). */
export async function notifyAfterTxn(card: Card, txn: Txn) {
  if (!card.customer || card.customer.erased) return;
  const s = (await getAllSettings()).messaging;
  const channel: MsgChannel | null = card.customer.email ? 'EMAIL' : card.customer.phone ? 'SMS' : null;
  if (!channel) return;
  if (txn.txn_type === 'RELOAD' && s.send_reload_thanks) {
    await sendTemplate(card, 'reload_thanks', channel, { extra: { amount: formatCents(txn.amount_cents, card.currency) } });
  }
  if ((txn.txn_type === 'REDEEM' || txn.txn_type === 'TIP_FROM_CARD') && s.send_low_balance) {
    const before = txn.balance_after_cents - txn.amount_cents;
    const t = s.low_balance_threshold_cents;
    if (txn.balance_after_cents > 0 && txn.balance_after_cents < t && before >= t) await sendTemplate(card, 'low_balance', channel);
  }
}

/** Nightly: expiry warnings N days before (deduped per card/day via message_log). */
export async function sendExpiryWarnings(getCard: (id: number) => Promise<Card>) {
  const s = (await getAllSettings()).messaging;
  let sent = 0;
  for (const days of s.expiry_warning_days) {
    const { rows } = await query<{ id: number }>(
      `SELECT c.id FROM gift_cards c JOIN customers cu ON cu.id = c.customer_id
       WHERE c.status IN ('ACTIVE','PARTIALUSED') AND c.deleted_at IS NULL AND cu.erased_at IS NULL
         AND (cu.email IS NOT NULL OR cu.phone IS NOT NULL)
         AND c.expires_at >= now() + make_interval(days => $1 - 1) AND c.expires_at < now() + make_interval(days => $1)
         AND NOT EXISTS (SELECT 1 FROM message_log m WHERE m.card_id = c.id AND m.template_key = 'expiry_warning'
                         AND m.sent_at > now() - interval '20 hours')`,
      [days],
    );
    for (const r of rows) {
      const card = await getCard(r.id);
      const ch: MsgChannel = card.customer?.email ? 'EMAIL' : 'SMS';
      await sendTemplate(card, 'expiry_warning', ch, { extra: { days_left: String(days) } }).catch(() => {});
      sent++;
    }
  }
  return sent;
}
