import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api, ApiError, setApprovalHandler, type ApprovalRequest } from '../lib/api';
import { Modal } from './ui';
import { PinPad } from './Keypad';

const ACTION_TEXT: Record<string, string> = {
  void: 'void this card',
  bulk_void: 'void these cards',
  adjust: 'adjust the balance',
  archive: 'archive zero-balance cards',
  refund: 'refund to card',
  large_amount: 'process a large amount',
  reverse: 'reverse this transaction',
  erase: 'erase customer data',
  delete: 'delete this card',
  restore: 'restore data',
};

/**
 * Manager step-up. Registered globally with the API client: any request that
 * gets 403 APPROVAL_REQUIRED pauses here until a manager enters their PIN on
 * this device, then the original request is retried automatically.
 */
export function ApprovalProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<ApprovalRequest | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resolver = useRef<((t: string | null) => void) | null>(null);

  useEffect(() => {
    setApprovalHandler(
      (r) =>
        new Promise((resolve) => {
          resolver.current = resolve;
          setPin('');
          setError(null);
          setReq(r);
        }),
    );
    return () => setApprovalHandler(null);
  }, []);

  const close = (token: string | null) => {
    resolver.current?.(token);
    resolver.current = null;
    setReq(null);
  };

  const submit = async (p: string) => {
    if (!req) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ approval_token: string }>('/auth/approve', { body: { pin: p, action: req.action } });
      close(r.approval_token);
    } catch (e) {
      setPin('');
      setError(e instanceof ApiError ? (e.code === 'PIN_INVALID' ? 'Not a manager PIN' : e.message) : 'Approval failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {children}
      <Modal open={!!req} onClose={() => close(null)} title={<span className="flex items-center gap-2"><ShieldCheck className="h-6 w-6 text-brand-600" /> Manager approval</span>} size="sm">
        <p className="mb-1 text-center text-lg">
          A manager must approve to <strong>{ACTION_TEXT[req?.action ?? ''] ?? req?.action}</strong>.
        </p>
        {req?.dual_control && <p className="mb-3 text-center text-sm font-semibold text-amber-700 dark:text-amber-300">Dual control: a different manager than the one requesting.</p>}
        <p className="mb-4 text-center text-sm text-slate-500">Manager, enter your PIN</p>
        <PinPad value={pin} onChange={setPin} onSubmit={submit} error={error} disabled={busy} />
      </Modal>
    </>
  );
}
