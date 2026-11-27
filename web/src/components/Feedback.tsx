import { useState } from 'react';
import { Check, Copy, Mail, Phone } from 'lucide-react';
import { Button, Modal } from './ui';

/** Where feedback and support questions go. */
export const SUPPORT = {
  email: 'jimmyvu@unijv.com',
  phone: '3466729523',
  phoneDisplay: '(346) 672-9523',
};

export function ContactRow({ icon, label, value, href, actionLabel }: { icon: React.ReactNode; label: string; value: string; href: string; actionLabel: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-600 dark:text-zinc-300">
        {icon}
        {label}
      </div>
      {/* Shown as plain text too: mail/phone links don't open on every device. */}
      <p className="mt-1 select-all break-all text-lg font-semibold tabular-nums">{value}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <a href={href} className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-zinc-900 px-4 text-sm font-semibold text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200">
          {actionLabel}
        </a>
        <Button
          variant="secondary"
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            } catch {
              /* clipboard blocked: the text above is selectable */
            }
          }}
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

export const PLAN_NAME: Record<string, string> = { FREE: 'Free', EXTRA: 'Extra', PREMIER: 'Premier' };

/** Shown when a salon has used every gift card its plan allows. */
export function LimitReachedPanel({ tier, limit, used }: { tier?: string; limit?: number; used?: number }) {
  const full = used === undefined || used >= (limit ?? 50);
  return (
    <div className="space-y-3">
      <p className="text-zinc-700 dark:text-zinc-200">
        Your <strong>{PLAN_NAME[tier ?? 'FREE'] ?? tier} plan</strong> includes <strong>{(limit ?? 50).toLocaleString()} gift cards</strong>{full ? ', and they are all in use' : ` (${(used ?? 0).toLocaleString()} used)`}. To manage more cards, contact us to upgrade:
      </p>
      <ul className="text-sm text-zinc-600 dark:text-zinc-300">
        <li>Extra: up to 1,000 gift cards</li>
        <li>Premier: up to 10,000 gift cards</li>
      </ul>
      <ContactRow icon={<Mail className="h-4 w-4" aria-hidden />} label="Email" value={SUPPORT.email} href={`mailto:${SUPPORT.email}?subject=${encodeURIComponent('Gift Card POS: more gift cards')}`} actionLabel="Send email" />
      <ContactRow icon={<Phone className="h-4 w-4" aria-hidden />} label="Hotline" value={SUPPORT.phoneDisplay} href={`tel:+1${SUPPORT.phone}`} actionLabel="Call" />
      <p className="text-sm text-zinc-600 dark:text-zinc-300">Existing cards keep working: you can still redeem, reload and look them up.</p>
    </div>
  );
}

export function FeedbackDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Feedback & support" size="sm">
      <div className="space-y-3">
        <p className="text-zinc-600 dark:text-zinc-300">Questions, problems or ideas? Email or call us.</p>
        <ContactRow icon={<Mail className="h-4 w-4" aria-hidden />} label="Email" value={SUPPORT.email} href={`mailto:${SUPPORT.email}?subject=${encodeURIComponent('Gift Card POS feedback')}`} actionLabel="Send email" />
        <ContactRow icon={<Phone className="h-4 w-4" aria-hidden />} label="Hotline" value={SUPPORT.phoneDisplay} href={`tel:+1${SUPPORT.phone}`} actionLabel="Call" />
      </div>
    </Modal>
  );
}
