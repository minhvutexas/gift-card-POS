import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
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

function Staff() {
  const { me, loading, locked } = useSession();
  if (loading)
    return (
      <div className="flex min-h-screen items-center justify-center" role="status">
        <span className="h-10 w-10 animate-spin rounded-full border-4 border-brand-600 border-r-transparent" />
        <span className="sr-only">Loading</span>
      </div>
    );
  if (!me) return <LoginPage />;
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
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed bottom-20 right-3 z-10 select-none text-sm font-semibold tracking-wide text-slate-900/25 dark:text-white/25 md:bottom-3"
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
        <Route path="/platform" element={<PlatformPage />} />
        <Route path="/*" element={<Staff />} />
      </Routes>
      <Watermark />
    </>
  );
}
