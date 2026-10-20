import { Routes, Route, Navigate } from 'react-router-dom';
import { MemberLayout } from './layouts/MemberLayout';
import { ADMIN_NAV, CashierLayout } from './layouts/CashierLayout';
import { HomePage } from './pages/member/HomePage';
import { PayPage } from './pages/member/PayPage';
import { VotesPage } from './pages/member/VotesPage';
import { AssetsPage } from './pages/member/AssetsPage';
import { MenuPage } from './pages/member/MenuPage';
import { ActivationPage } from './pages/auth/ActivationPage';
import { LoginPage } from './pages/auth/LoginPage';
import { AdminDashboard } from './pages/admin/DashboardPage';
import { AdminPlaceholderPage } from './pages/admin/AdminPlaceholderPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { UpdatePrompt } from './components/UpdatePrompt';

export function App() {
  return (
    <>
      <Routes>
        {/* Auth */}
        <Route path="/activate" element={<ActivationPage />} />
        <Route path="/login" element={<LoginPage />} />

        {/* Member routes (mobile-first) */}
        <Route element={<MemberLayout />}>
          <Route path="/home" element={<HomePage />} />
          <Route path="/pay" element={<PayPage />} />
          <Route path="/votes" element={<VotesPage />} />
          <Route path="/votes/:id" element={<VotesPage />} />
          <Route path="/assets" element={<AssetsPage />} />
          <Route path="/assets/:id" element={<AssetsPage />} />
          <Route path="/menu" element={<MenuPage />} />
        </Route>

        {/* Cashier/Admin routes (desktop-first, stacked below 1024px) */}
        <Route element={<CashierLayout />}>
          <Route path="/admin" element={<AdminDashboard />} />
          {ADMIN_NAV.filter(([to]) => to !== '/admin').map(([to, key]) => (
            <Route key={to} path={to} element={<AdminPlaceholderPage titleKey={key} />} />
          ))}
        </Route>

        <Route path="/" element={<Navigate to="/home" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      <UpdatePrompt />
    </>
  );
}
