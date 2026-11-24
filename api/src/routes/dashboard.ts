import { Router } from 'express';
import { requirePerm } from '../auth.js';
import { one, query } from '../db.js';
import { getAllSettings } from '../settings.js';

export const router = Router();

router.get('/dashboard/summary', requirePerm('dashboard.read'), async (_req, res) => {
  const tz = (await getAllSettings()).general.timezone;
  const today = `(date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)`;

  const [liab, todayStats, breakage30, expiring, alerts, series, statusCounts] = await Promise.all([
    one('SELECT total_cents, card_count FROM v_outstanding_liability'),
    one(
      `SELECT
         COUNT(*) FILTER (WHERE txn_type = 'ISSUE')::int                                            AS cards_sold,
         (COALESCE(SUM(amount) FILTER (WHERE txn_type IN ('ISSUE','ACTIVATE')), 0) * 100)::bigint  AS sold_cents,
         (COALESCE(SUM(-amount) FILTER (WHERE txn_type IN ('REDEEM','TIP_FROM_CARD')), 0) * 100)::bigint AS redeemed_cents,
         (COALESCE(SUM(amount) FILTER (WHERE txn_type = 'REVERSAL'
            AND (SELECT o.txn_type FROM gift_card_transactions o WHERE o.id = reverses_txn_id) IN ('REDEEM','TIP_FROM_CARD')), 0) * 100)::bigint AS reversed_cents,
         (COALESCE(SUM(amount) FILTER (WHERE txn_type = 'RELOAD'), 0) * 100)::bigint               AS reload_cents,
         COUNT(*) FILTER (WHERE txn_type = 'RELOAD')::int                                           AS reload_count,
         (COALESCE(SUM(-amount) FILTER (WHERE txn_type = 'EXPIRE'), 0) * 100)::bigint              AS breakage_cents,
         COUNT(*) FILTER (WHERE txn_type IN ('REDEEM','TIP_FROM_CARD'))::int                        AS redemptions
       FROM gift_card_transactions WHERE created_at >= ${today}`,
      [tz],
    ),
    one(`SELECT (COALESCE(SUM(-amount), 0) * 100)::bigint AS cents FROM gift_card_transactions WHERE txn_type = 'EXPIRE' AND created_at >= now() - interval '30 days'`),
    query(`SELECT e.id, e.card_number, e.status::text, (e.balance*100)::bigint AS balance_cents, e.expires_at, e.days_left FROM fn_expiring_soon(30) e LIMIT 10`),
    query(
      `SELECT a.id, a.action, a.card_id, c.card_number, a.payload->>'message' AS message, a.created_at, u.name AS actor_name
       FROM audit_log a LEFT JOIN gift_cards c ON c.id = a.card_id LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.action LIKE 'alert.%' AND a.created_at >= now() - interval '24 hours'
       ORDER BY a.id DESC LIMIT 20`,
    ),
    query(
      `WITH days AS (SELECT generate_series(${today} - interval '13 days', ${today}, interval '1 day') AS d)
       SELECT to_char(d AT TIME ZONE $1, 'YYYY-MM-DD') AS day,
              (COALESCE(SUM(t.amount) FILTER (WHERE t.txn_type IN ('ISSUE','ACTIVATE','RELOAD')), 0) * 100)::bigint AS sold_cents,
              (COALESCE(SUM(-t.amount) FILTER (WHERE t.txn_type IN ('REDEEM','TIP_FROM_CARD')), 0) * 100)::bigint AS redeemed_cents
       FROM days LEFT JOIN gift_card_transactions t ON t.created_at >= d AND t.created_at < d + interval '1 day'
       GROUP BY d ORDER BY d`,
      [tz],
    ),
    query(`SELECT status::text, COUNT(*)::int AS n FROM gift_cards WHERE deleted_at IS NULL AND archived_at IS NULL GROUP BY status`),
  ]);

  const t = todayStats!;
  // Reversals of redemptions (undo) give money back to the card: not revenue.
  const netRedeemed = Math.max(0, t.redeemed_cents - t.reversed_cents);
  res.json({
    as_of: new Date().toISOString(),
    timezone: tz,
    outstanding_total_cents: liab!.total_cents,
    outstanding_card_count: liab!.card_count,
    today: {
      cards_sold: t.cards_sold,
      sold_cents: t.sold_cents,
      redemptions: t.redemptions,
      redeemed_cents: netRedeemed,
      reload_count: t.reload_count,
      reload_cents: t.reload_cents,
      breakage_cents: t.breakage_cents,
      revenue_recognized_cents: netRedeemed + t.breakage_cents,
    },
    breakage_30d_cents: breakage30!.cents,
    expiring_soon: expiring.rows,
    alerts: alerts.rows,
    series: series.rows,
    status_counts: Object.fromEntries(statusCounts.rows.map((r) => [r.status, r.n])),
  });
});
