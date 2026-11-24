export type CardStatus = 'PENDING_ACTIVATION' | 'ACTIVE' | 'PARTIALUSED' | 'CLOSED' | 'FROZEN' | 'EXPIRED' | 'VOIDED' | 'LOST_REPLACED';

export interface Tag {
  id: number;
  name: string;
  color: string;
  card_count?: number;
}

export interface CustomerRef {
  id: number;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  erased: boolean;
}

export interface Card {
  id: number;
  card_number: string;
  status: CardStatus;
  balance_cents: number;
  face_value_cents: number;
  currency: string;
  label: string | null;
  color_tag: string | null;
  issue_channel: string;
  activation_date: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  frozen_at: string | null;
  freeze_reason: string | null;
  voided_at: string | null;
  void_reason: string | null;
  replaced_by_card_id: number | null;
  notes: string | null;
  has_pin: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  customer: CustomerRef | null;
  tags: Tag[];
}

export interface Txn {
  id: number;
  card_id: number;
  txn_type: string;
  amount_cents: number;
  balance_after_cents: number;
  memo: string | null;
  external_ref: string | null;
  related_card_id: number | null;
  reverses_txn_id: number | null;
  actor_type: string;
  actor_id: number | null;
  actor_name: string | null;
  approved_by: number | null;
  terminal_id: number | null;
  created_at: string;
  reversed: boolean;
}

export interface MutationResult {
  card: Card;
  transaction?: Txn;
  tip_transaction?: Txn;
  balance_cents: number;
  status: CardStatus;
  outstanding_total_cents: number;
}

export interface CardList {
  data: Card[];
  meta: { page: number; per_page: number; total: number; outstanding_total_cents: number; outstanding_card_count: number };
}

export interface HistoryRow {
  id: string;
  kind: 'TXN' | 'AUDIT';
  occurred_at: string;
  actor_type: string;
  actor_id: number | null;
  actor_name: string | null;
  card_id: number | null;
  card_number: string | null;
  action: string;
  amount_cents: number | null;
  balance_after_cents: number | null;
  reference: string | null;
  terminal_code: string | null;
  ip: string | null;
  note: string | null;
}

export interface Receipt {
  title: string;
  header: string[];
  lines: { left: string; right?: string; bold?: boolean }[];
  /** Card number, printed as a Code 128 barcode */
  barcode: string | null;
  footer: string[];
  paper_width_mm: 58 | 80;
}

export interface Me {
  user: { id: number; name: string; username: string; role: string; permissions: string[] };
  terminal: { id: number; code: string; name: string; kind: string } | null;
  settings: {
    general: { business_name: string; timezone: string; currency: string; address: string; phone: string; logo_url: string; tax_rate_bps: number };
    security: { session_timeout_min: number; activity_lock_min: number; approval_threshold_cents: number; undo_window_sec: number; offline_max_redeem_cents: number; dual_control_voids: boolean; dual_control_refunds: boolean };
    printer: { mode: 'browser' | 'network' | 'disabled'; paper_width_mm: 58 | 80; auto_print: { issue: boolean; redeem: boolean; reload: boolean; refund: boolean } };
    receipt: { show_barcode: boolean };
    loyalty: { enabled: boolean; points_per_dollar: number };
  };
}
