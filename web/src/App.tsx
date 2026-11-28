import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useSession } from './lib/session';
import { Layout } from './components/Layout';
import { ApprovalProvider } from './components/Approval';
import { CardActionsProvider, useCardActions } from './features/cards/CardActions';
import { CardsPage } from './features/cards/CardsPage';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { HistoryPage } from './features/history/HistoryPage';
import { CustomersPage } from './features/customers/CustomersPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { KioskPage } from './features/kiosk/KioskPage';
import { LockScreen, LoginPage } from './features/auth/LoginPage';
import { SignupPage } from './features/signup/SignupPage';
import { PlatformPage } from './features/platform/PlatformPage';
import { LandingPage } from './features/landing/LandingPage';
import { store } from './lib/api';

/** Global keyboard shortcuts: Alt+N new card, Alt+R redeem. */
function Shortcuts() {
  const { open } = useCardActions();
  const { can } = useSession();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (e.key.toLowerCase() === 'n' && can('cards.issue')) open('issue');
      else if (e.key.toLowerCase() === 'r' && can('cards.redeem')) open('redeem');
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, can]);
  return null;
}

/** Has this device been used to sign in before (front desk or owner)? */
function knownDevice() {
  try {
    return !!store.terminalKey || !!localStorage.getItem('gc.cid');
  } catch {
    return !!store.terminalKey;
  }
}

function Staff() {
  const { me, loading, locked, authError } = useSession();
  const { pathname } = useLocation();
  if (loading)
    return (
      <div className="flex min-h-screen items-center justify-center" role="status">
        <span className="h-10 w-10 animate-spin rounded-full border-4 border-zinc-900 border-r-transparent dark:border-white dark:border-r-transparent" />
        <span className="sr-only">Loading</span>
      </div>
    );
  // New visitors at the home address see the intro page; everyone else signs in.
  if (!me) return pathname === '/' && !authError && !knownDevice() ? <LandingPage /> : <LoginPage />;
  return (
    <ApprovalProvider>
      <CardActionsProvider>
        <Shortcuts />
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<DashboardPage />} />
            <Route path="cards" element={<CardsPage />} />
            <Route path="history" element={<HistoryPage />} />
            <Route path="customers" element={<CustomersPage />} />
            <Route path="settings" element={<Navigate to="/settings/general" replace />} />
            <Route path="settings/:tab" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        {locked && <LockScreen />}
      </CardActionsProvider>
    </ApprovalProvider>
  );
}

/** Brand watermark — fixed lower-right, click-through, never printed (receipts print outside #root). */
function Watermark() {
  // Not on the public intro page: it has its own footer and the mark would sit over content.
  const { me } = useSession();
  const { pathname } = useLocation();
  if (pathname === '/welcome' || (pathname === '/' && !me)) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed bottom-3 right-3 z-10 hidden select-none text-xs font-medium tracking-wide text-zinc-900/30 dark:text-white/30 md:block"
    >
      UniJV Product
    </div>
  );
}

export function App() {
  return (
    <>
      <Routes>
        <Route path="/kiosk" element={<KioskPage />} />
        <Route path="/k/:slug" element={<KioskPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/welcome" element={<LandingPage />} />
        <Route path="/platform" element={<PlatformPage />} />
        <Route path="/*" element={<Staff />} />
      </Routes>
      <Watermark />
    </>
  );
}
