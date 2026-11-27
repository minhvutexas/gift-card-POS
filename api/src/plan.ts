import { config } from './config.js';
import { currentBusinessId, one, runAsSystem } from './db.js';

export const PLANS = ['FREE', 'EXTRA', 'PREMIER'] as const;
export type Plan = (typeof PLANS)[number];
export const PLAN_LIMIT: Record<Plan, number> = { FREE: 50, EXTRA: 1000, PREMIER: 10000 };

/** The current salon's plan, card limit and cards counted against it. */
export async function planUsage() {
  const bid = currentBusinessId();
  const b = await runAsSystem(() => one<{ plan: Plan }>('SELECT plan FROM businesses WHERE id = $1', [bid]));
  const used = (await one<{ n: number }>('SELECT fn_card_usage() AS n'))!.n;
  const plan = b?.plan ?? 'FREE';
  return { tier: plan, limit: PLAN_LIMIT[plan], used, contact: config.support };
}
