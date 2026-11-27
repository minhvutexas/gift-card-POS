import { Gift } from 'lucide-react';

/** Product mark: a plain gift icon on a solid square. Replaces the 🎁 emoji. */
export function Logo({ size = 'md', className = '' }: { size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const box = { sm: 'h-9 w-9', md: 'h-11 w-11', lg: 'h-12 w-12' }[size];
  const icon = { sm: 'h-5 w-5', md: 'h-6 w-6', lg: 'h-6 w-6' }[size];
  return (
    <span className={`inline-flex ${box} items-center justify-center rounded-lg bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 ${className}`} aria-hidden>
      <Gift className={icon} strokeWidth={2} />
    </span>
  );
}
