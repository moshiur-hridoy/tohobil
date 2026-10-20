import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { MemberLayout } from './layouts/MemberLayout';
import { ADMIN_NAV, CashierLayout } from './layouts/CashierLayout';
import { HomePage } from './pages/member/HomePage';
import { PayPage } from './pages/member/PayPage';
import { VotesPage } from './pages/member/VotesPage';
import { AssetsPage } from './pages/member/AssetsPage';
import { MenuPage } from './pages/member/MenuPage';
import { LedgerPage } from './pages/member/LedgerPage';
import { MembersPage } from './pages/member/MembersPage';
import { ActivationPage } from './pages/auth/ActivationPage';
import { LoginPage } from './pages/auth/LoginPage';
import { TotpPage } from './pages/auth/TotpPage';
import { useAuth } from './lib/auth';
import { AdminDashboard } from './pages/admin/DashboardPage';
import { MatrixPage } from './pages/admin/MatrixPage';
import { PaymentsPage } from './pages/admin/PaymentsPage';
import { AdminLedgerPage } from './pages/admin/AdminLedgerPage';
import { AdminPlaceholderPage } from './pages/admin/AdminPlaceholderPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { UpdatePrompt } from './components/UpdatePrompt';

/** Everything except /activate and /login needs a session. */
function RequireAuth() {
  const { status, hasDevice } = useAuth();
  if (status === 'loading') return null;
  if (status === 'anonymous') return <Navigate to={hasDevice ? '/login' : '/activate'} replace />;
  return <Outlet />;
}

/** Cashier and auditor land on the admin dashboard on wide screens, everyone else on /home. */
function Landing() {
  const { me } = useAuth();
  const privileged = !!me?.roles.some((r) => r === 'cashier' || r === 'auditor');
  const wide = typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches;
  return <Navigate to={privileged && wide ? '/admin' : '/home'} replace />;
}

export function App() {
  return (
    <>
      <Routes>
        {/* Auth */}
        <Route path="/activate" element={<ActivationPage />} />
        <Route path="/login" element={<LoginPage />} />

        <Route element={<RequireAuth />}>
        <Route path="/totp" element={<TotpPage />} />

        {/* Member routes (mobile-first) */}
        <Route element={<MemberLayout />}>
          <Route path="/home" element={<HomePage />} />
          <Route path="/pay" element={<PayPage />} />
          <Route path="/votes" element={<VotesPage />} />
          <Route path="/votes/:id" element={<VotesPage />} />
          <Route path="/assets" element={<AssetsPage />} />
          <Route path="/assets/:id" element={<AssetsPage />} />
          <Route path="/menu" element={<MenuPage />} />
          <Route path="/menu/ledger" element={<LedgerPage />} />
          <Route path="/menu/members" element={<MembersPage />} />
        </Route>

        {/* Cashier/Admin routes (desktop-first, stacked below 1024px) */}
        <Route element={<CashierLayout />}>
          <Route path="/admin" element={<AdminDashboard />} />
          <Route path="/admin/matrix" element={<MatrixPage />} />
          <Route path="/admin/payments" element={<PaymentsPage />} />
          <Route path="/admin/ledger" element={<AdminLedgerPage />} />
          {ADMIN_NAV.filter(([to]) => !['/admin', '/admin/matrix', '/admin/payments', '/admin/ledger'].includes(to)).map(([to, key]) => (
            <Route key={to} path={to} element={<AdminPlaceholderPage titleKey={key} />} />
          ))}
        </Route>
        <Route path="/" element={<Landing />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      <UpdatePrompt />
    </>
  );
}
