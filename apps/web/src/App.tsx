import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { MemberLayout } from './layouts/MemberLayout';
import { ADMIN_NAV, CashierLayout } from './layouts/CashierLayout';
import { HomePage } from './pages/member/HomePage';
import { PayPage } from './pages/member/PayPage';
import { VotesPage } from './pages/member/VotesPage';
import { AssetsPage } from './pages/member/AssetsPage';
import { ShopPage } from './pages/member/ShopPage';
import { MenuPage } from './pages/member/MenuPage';
import { LedgerPage } from './pages/member/LedgerPage';
import { MembersPage } from './pages/member/MembersPage';
import { ConstitutionPage } from './pages/member/ConstitutionPage';
import { NoticesPage } from './pages/member/NoticesPage';
import { SettlementPage } from './pages/member/SettlementPage';
import { ActivationPage } from './pages/auth/ActivationPage';
import { LoginPage } from './pages/auth/LoginPage';
import { TotpPage } from './pages/auth/TotpPage';
import { useAuth } from './lib/auth';
import { AdminDashboard } from './pages/admin/DashboardPage';
import { MatrixPage } from './pages/admin/MatrixPage';
import { PaymentsPage } from './pages/admin/PaymentsPage';
import { AdminLedgerPage } from './pages/admin/AdminLedgerPage';
import { AdminSystemStatusPage } from './pages/admin/AdminSystemStatusPage';
import { MembersAdminPage } from './pages/admin/MembersAdminPage';
import { ProposalsPage } from './pages/admin/ProposalsPage';
import { RulesPage } from './pages/admin/RulesPage';
import { CharityPage } from './pages/admin/CharityPage';
import { SettingsPage } from './pages/admin/SettingsPage';
import { AdminPlaceholderPage } from './pages/admin/AdminPlaceholderPage';
import { VoteDetailPage } from './pages/member/VoteDetailPage';
import { ReconcilePage } from './pages/admin/ReconcilePage';
import { ReportsPage } from './pages/admin/ReportsPage';
import { AdminAssetsPage } from './pages/admin/AdminAssetsPage';
import { AdminHoldingPage } from './pages/admin/AdminHoldingPage';
import { AdminRentPage } from './pages/admin/AdminRentPage';
import { MeetingsPage } from './pages/admin/MeetingsPage';
import { ObligationsPage } from './pages/admin/ObligationsPage';
import { AdminSettlementsPage } from './pages/admin/AdminSettlementsPage';
import { AdminNotificationsPage } from './pages/admin/AdminNotificationsPage';
import { ChangePinPage } from './pages/member/ChangePinPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { UpdatePrompt } from './components/UpdatePrompt';

/** Everything except /activate and /login needs a session. */
function RequireAuth() {
  const { status } = useAuth();
  if (status === 'loading') return null;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
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
          <Route path="/votes/:id" element={<VoteDetailPage />} />
          <Route path="/assets" element={<AssetsPage />} />
          <Route path="/assets/:id" element={<AssetsPage />} />
          <Route path="/assets/shop/:id" element={<ShopPage />} />
          <Route path="/menu" element={<MenuPage />} />
          <Route path="/menu/ledger" element={<LedgerPage />} />
          <Route path="/menu/members" element={<MembersPage />} />
          <Route path="/menu/pin" element={<ChangePinPage />} />
          <Route path="/menu/constitution" element={<ConstitutionPage />} />
          <Route path="/menu/notices" element={<NoticesPage />} />
          <Route path="/menu/settlement" element={<SettlementPage />} />
          <Route path="/settlements" element={<SettlementPage />} />
        </Route>

        {/* Cashier/Admin routes (desktop-first, stacked below 1024px) */}
        <Route element={<CashierLayout />}>
          <Route path="/admin" element={<AdminDashboard />} />
          <Route path="/admin/matrix" element={<MatrixPage />} />
          <Route path="/admin/payments" element={<PaymentsPage />} />
          <Route path="/admin/ledger" element={<AdminLedgerPage />} />
          <Route path="/admin/system" element={<AdminSystemStatusPage />} />
          <Route path="/admin/members" element={<MembersAdminPage />} />
          <Route path="/admin/proposals" element={<ProposalsPage />} />
          <Route path="/admin/rules" element={<RulesPage />} />
          <Route path="/admin/meetings" element={<MeetingsPage />} />
          <Route path="/admin/charity" element={<CharityPage />} />
          <Route path="/admin/settings" element={<SettingsPage />} />
          <Route path="/admin/notifications" element={<AdminNotificationsPage />} />
          <Route path="/admin/assets" element={<AdminAssetsPage />} />
          <Route path="/admin/assets/investment/:id" element={<AdminHoldingPage />} />
          <Route path="/admin/reconcile" element={<ReconcilePage />} />
          <Route path="/admin/reports" element={<ReportsPage />} />
          <Route path="/admin/rent" element={<AdminRentPage />} />
          <Route path="/admin/obligations" element={<ObligationsPage />} />
          <Route path="/admin/settlements" element={<AdminSettlementsPage />} />
          {ADMIN_NAV.filter(([to]) => !['/admin', '/admin/matrix', '/admin/payments', '/admin/ledger', '/admin/members', '/admin/proposals', '/admin/rules', '/admin/meetings', '/admin/charity', '/admin/settings', '/admin/notifications', '/admin/assets', '/admin/reconcile', '/admin/reports', '/admin/rent', '/admin/obligations', '/admin/settlements', '/admin/system'].includes(to)).map(([to, key]) => (
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
