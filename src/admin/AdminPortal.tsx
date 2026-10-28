import React, { useCallback, useEffect, useState } from 'react';
import {
  Bell,
  Boxes,
  ClipboardList,
  ExternalLink,
  Landmark,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  UserCircle2,
  Users,
  X,
} from 'lucide-react';
import { BRAND_NAMES } from '../shared/types';
import type { OrderView } from '../shared/types';
import { adminApi, ApiClientError } from '../lib/api';
import type { PublicBootstrapInfo } from '../lib/api';
import { BrbLogo, InlineAlert } from '../components/Branding';
import { AdminCustomersSection } from './AdminCustomersSection';
import { AdminDashboardSection } from './AdminDashboardSection';
import { AdminFinanceSection } from './AdminFinanceSection';
import { AdminOperationsSection } from './AdminOperationsSection';
import { AdminOrdersSection } from './AdminOrdersSection';
import { AdminProductsSection } from './AdminProductsSection';
import type {
  AdminAuthenticatedProfile,
  AdminDashboardSummary,
  AdminNavSection,
  FinanceSubSection,
  OperationsSubSection,
} from './types';

const NAV_ITEMS: Array<{
  id: AdminNavSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'orders', label: 'Orders & Approvals', icon: ClipboardList },
  { id: 'customers', label: 'Customers', icon: Users },
  { id: 'products', label: 'Products Catalog', icon: Boxes },
  { id: 'finance', label: 'Invoices, Payments & Ledger', icon: Landmark },
  { id: 'operations', label: 'Operations & System', icon: Settings },
];

export function AdminPortal({
  bootstrap,
  admin,
  onLogout,
  onRefreshBootstrap,
  onSwitchToCustomerPortal,
}: {
  bootstrap: PublicBootstrapInfo;
  admin: AdminAuthenticatedProfile;
  onLogout: () => void;
  onRefreshBootstrap: () => void;
  onSwitchToCustomerPortal: () => void;
}) {
  const [section, setSection] = useState<AdminNavSection>('dashboard');
  const [financeSub, setFinanceSub] = useState<FinanceSubSection>('invoices');
  const [opsSub, setOpsSub] = useState<OperationsSubSection>('notifications');
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const [summary, setSummary] = useState<AdminDashboardSummary | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Cross-section workflow triggers
  const [customerStatusFilter, setCustomerStatusFilter] = useState<string>('all');
  const [openCreateCustomer, setOpenCreateCustomer] = useState(false);
  const [focusOrderId, setFocusOrderId] = useState<number | null>(null);
  const [preselectedOrderForInvoice, setPreselectedOrderForInvoice] = useState<OrderView | null>(
    null
  );
  const [openNewInvoice, setOpenNewInvoice] = useState(false);
  const [openAddPayment, setOpenAddPayment] = useState(false);
  const [focusLedgerCustomerId, setFocusLedgerCustomerId] = useState<number | null>(null);

  const loadDashboardSummary = useCallback(async () => {
    try {
      const res = await adminApi<AdminDashboardSummary>('/api/admin/dashboard');
      setSummary(res);
      setErrorMsg(null);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) {
        onLogout();
        return;
      }
      setErrorMsg(err instanceof Error ? err.message : 'Unable to refresh dashboard summary.');
    }
  }, [onLogout]);

  useEffect(() => {
    void loadDashboardSummary();
  }, [loadDashboardSummary]);

  const handleSignOutClick = async () => {
    try {
      await adminApi('/api/admin/auth/logout', { method: 'POST' });
    } catch {
      // Proceed with local token cleanup even if session already expired
    }
    onLogout();
  };

  const handleDashboardNavigate = (
    target: AdminNavSection,
    sub?: { finance?: FinanceSubSection; customerStatus?: string }
  ) => {
    if (sub?.finance) setFinanceSub(sub.finance);
    if (sub?.customerStatus) setCustomerStatusFilter(sub.customerStatus);
    else if (target === 'customers') setCustomerStatusFilter('all');
    setSection(target);
  };

  const sectionLabel = NAV_ITEMS.find((i) => i.id === section)?.label || 'Dashboard';

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Desktop Left Workspace Sidebar (256px per SaaS layout architecture) */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 border-r border-slate-200 bg-white z-30">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-3">
          <BrbLogo logoDataUrl={bootstrap.logoDataUrl} size="sm" />
          <div className="min-w-0">
            <p className="text-xs font-extrabold tracking-tight text-slate-950 truncate">
              {BRAND_NAMES.applicationName}
            </p>
            <p className="text-[11px] text-slate-500 truncate">Administrative Console</p>
          </div>
        </div>

        <nav aria-label="Administrative primary navigation" className="flex-1 p-3 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            const countIndicator =
              item.id === 'orders' && summary && summary.newOrders > 0
                ? summary.newOrders
                : item.id === 'customers' && summary && summary.pendingRegistrations > 0
                  ? summary.pendingRegistrations
                  : null;

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setSection(item.id);
                  if (item.id === 'customers') setCustomerStatusFilter('all');
                }}
                className={`w-full min-h-[42px] flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-700 hover:bg-slate-100 hover:text-slate-950'
                }`}
              >
                <span className="flex items-center gap-2.5 min-w-0 truncate">
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="truncate">{item.label}</span>
                </span>
                {countIndicator !== null && (
                  <span
                    className={`font-mono tabular-nums text-[11px] font-bold shrink-0 ${
                      active ? 'text-amber-300' : 'text-amber-700'
                    }`}
                  >
                    {countIndicator}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-slate-200 space-y-1">
          <button
            type="button"
            onClick={onSwitchToCustomerPortal}
            className="w-full min-h-[40px] flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition-colors whitespace-nowrap"
          >
            <span>Open Customer Portal</span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          </button>
        </div>
      </aside>

      {/* Mobile Navigation Drawer */}
      {mobileDrawerOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Mobile navigation menu"
          className="fixed inset-0 z-50 lg:hidden flex"
        >
          <div
            className="fixed inset-0 bg-slate-950/50 backdrop-blur-xs"
            onClick={() => setMobileDrawerOpen(false)}
          />
          <div className="relative w-72 max-w-[85vw] bg-white h-full flex flex-col border-r border-slate-200 z-10">
            <div className="px-4 py-4 border-b border-slate-200 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <BrbLogo logoDataUrl={bootstrap.logoDataUrl} size="sm" />
                <span className="text-xs font-extrabold text-slate-950 truncate">
                  {BRAND_NAMES.invoiceHeading}
                </span>
              </div>
              <button
                type="button"
                aria-label="Close navigation menu"
                onClick={() => setMobileDrawerOpen(false)}
                className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = section === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setSection(item.id);
                      setMobileDrawerOpen(false);
                    }}
                    className={`w-full min-h-[44px] flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                      active
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-700 hover:bg-slate-100 hover:text-slate-950'
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="p-3 border-t border-slate-200">
              <button
                type="button"
                onClick={() => {
                  setMobileDrawerOpen(false);
                  onSwitchToCustomerPortal();
                }}
                className="w-full min-h-[44px] flex items-center justify-between rounded-lg px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                <span>Open Customer Portal</span>
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content Column */}
      <div className="flex-1 flex flex-col min-w-0 lg:pl-64">
        {/* Top Admin Header (Section 44: BRB Logo, Business Name, Admin Name, Notifications, Profile, Logout) */}
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur-xs">
          <div className="h-1 bg-amber-400 w-full" aria-hidden="true" />
          <div className="flex items-center justify-between gap-4 px-4 sm:px-6 py-3">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                aria-label="Open navigation menu"
                onClick={() => setMobileDrawerOpen(true)}
                className="lg:hidden min-h-[40px] min-w-[40px] inline-flex items-center justify-center rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 shrink-0"
              >
                <Menu className="h-4 w-4" />
              </button>
              <div className="hidden sm:block lg:hidden">
                <BrbLogo logoDataUrl={bootstrap.logoDataUrl} size="sm" />
              </div>
              <div className="min-w-0 flex items-center gap-2 text-sm">
                <span className="font-extrabold text-slate-950 truncate">
                  {BRAND_NAMES.invoiceHeading}
                </span>
                <span className="hidden md:inline text-slate-300" aria-hidden="true">
                  /
                </span>
                <span className="hidden md:inline text-xs font-medium text-slate-600 whitespace-nowrap">
                  {sectionLabel}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                aria-label="Notifications and SMS log"
                onClick={() => {
                  setOpsSub('notifications');
                  setSection('operations');
                }}
                className="min-h-[40px] inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
              >
                <Bell className="h-4 w-4 text-slate-600" aria-hidden="true" />
                <span className="hidden sm:inline">Notifications</span>
              </button>

              <button
                type="button"
                onClick={() => setProfileOpen(true)}
                className="min-h-[40px] inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-900 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
              >
                <UserCircle2 className="h-4 w-4 text-slate-600" aria-hidden="true" />
                <span className="max-w-[130px] truncate">{admin.displayName}</span>
              </button>

              <button
                type="button"
                onClick={() => void handleSignOutClick()}
                className="min-h-[40px] inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Logout</span>
              </button>
            </div>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1400px] w-full mx-auto space-y-6">
          {errorMsg && (
            <InlineAlert
              tone="error"
              message={errorMsg}
              onDismiss={() => setErrorMsg(null)}
            />
          )}

          {section === 'dashboard' && (
            <AdminDashboardSection
              summary={summary}
              onNavigate={handleDashboardNavigate}
              onOpenAddCustomer={() => {
                setCustomerStatusFilter('all');
                setOpenCreateCustomer(true);
                setSection('customers');
              }}
              onOpenNewInvoice={() => {
                setFinanceSub('invoices');
                setOpenNewInvoice(true);
                setSection('finance');
              }}
              onOpenAddPayment={() => {
                setFinanceSub('payments');
                setOpenAddPayment(true);
                setSection('finance');
              }}
              onInspectOrder={(orderId) => {
                setFocusOrderId(orderId);
                setSection('orders');
              }}
            />
          )}

          {section === 'customers' && (
            <AdminCustomersSection
              initialStatusFilter={customerStatusFilter}
              openCreateInitially={openCreateCustomer}
              onClearOpenCreate={() => setOpenCreateCustomer(false)}
              onDataChanged={() => void loadDashboardSummary()}
              onOpenCustomerLedger={(customerId) => {
                setFocusLedgerCustomerId(customerId);
                setFinanceSub('ledger');
                setSection('finance');
              }}
            />
          )}

          {section === 'products' && (
            <AdminProductsSection onDataChanged={() => void loadDashboardSummary()} />
          )}

          {section === 'orders' && (
            <AdminOrdersSection
              focusOrderId={focusOrderId}
              onClearFocusOrder={() => setFocusOrderId(null)}
              onDataChanged={() => void loadDashboardSummary()}
              onCreateInvoiceForOrder={(order) => {
                setPreselectedOrderForInvoice(order);
                setFinanceSub('invoices');
                setSection('finance');
              }}
            />
          )}

          {section === 'finance' && (
            <AdminFinanceSection
              subSection={financeSub}
              onChangeSubSection={setFinanceSub}
              preselectedOrderForInvoice={preselectedOrderForInvoice}
              onClearPreselectedOrder={() => setPreselectedOrderForInvoice(null)}
              openNewInvoiceInitially={openNewInvoice}
              onClearOpenNewInvoice={() => setOpenNewInvoice(false)}
              openAddPaymentInitially={openAddPayment}
              onClearOpenAddPayment={() => setOpenAddPayment(false)}
              focusLedgerCustomerId={focusLedgerCustomerId}
              onClearFocusLedgerCustomer={() => setFocusLedgerCustomerId(null)}
              onDataChanged={() => void loadDashboardSummary()}
            />
          )}

          {section === 'operations' && (
            <AdminOperationsSection
              admin={admin}
              subSection={opsSub}
              onChangeSubSection={setOpsSub}
              onSettingsUpdated={() => {
                onRefreshBootstrap();
                void loadDashboardSummary();
              }}
              onDataChanged={() => void loadDashboardSummary()}
            />
          )}
        </main>
      </div>

      {/* Admin Profile Modal */}
      {profileOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="admin-profile-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 backdrop-blur-xs p-4"
        >
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 id="admin-profile-title" className="text-lg font-bold text-slate-950">
                Administrator Profile
              </h3>
              <button
                type="button"
                aria-label="Close profile modal"
                onClick={() => setProfileOpen(false)}
                className="min-h-[36px] min-w-[36px] inline-flex items-center justify-center rounded-lg hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <dl className="divide-y divide-slate-100 text-xs">
              <div className="py-2 flex justify-between gap-4">
                <dt className="text-slate-500">Display Name</dt>
                <dd className="font-semibold text-slate-900">{admin.displayName}</dd>
              </div>
              <div className="py-2 flex justify-between gap-4">
                <dt className="text-slate-500">Username</dt>
                <dd className="font-mono text-slate-900">@{admin.username}</dd>
              </div>
              <div className="py-2 flex justify-between gap-4">
                <dt className="text-slate-500">Email</dt>
                <dd className="text-slate-900">{admin.email}</dd>
              </div>
              <div className="py-2 flex justify-between gap-4">
                <dt className="text-slate-500">Role</dt>
                <dd className="font-mono font-semibold text-slate-900">{admin.role}</dd>
              </div>
              <div className="py-2 flex justify-between gap-4">
                <dt className="text-slate-500">Two-Step Verification</dt>
                <dd className="text-slate-900">{admin.twoFactorEnabled ? 'Enabled' : 'Disabled'}</dd>
              </div>
            </dl>

            <div>
              <p className="text-xs font-semibold text-slate-700 mb-1.5">Granted Permissions</p>
              <p className="text-[11px] font-mono text-slate-600 leading-relaxed">
                {admin.permissions.join(' · ')}
              </p>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => setProfileOpen(false)}
                className="min-h-[40px] rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
