import React from 'react';
import { ArrowRight, CreditCard, FilePlus2, UserPlus } from 'lucide-react';
import { getOrderStatusToneClass } from '../components/Branding';
import type { AdminDashboardSummary, AdminNavSection, FinanceSubSection } from './types';

export function AdminDashboardSection({
  summary,
  onNavigate,
  onOpenAddCustomer,
  onOpenNewInvoice,
  onOpenAddPayment,
  onInspectOrder,
}: {
  summary: AdminDashboardSummary | null;
  onNavigate: (
    section: AdminNavSection,
    sub?: { finance?: FinanceSubSection; customerStatus?: string }
  ) => void;
  onOpenAddCustomer: () => void;
  onOpenNewInvoice: () => void;
  onOpenAddPayment: () => void;
  onInspectOrder: (orderId: number) => void;
}) {
  if (!summary) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-sm text-slate-500">
        Loading real-time BRB operational metrics...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Action Bar for Quick Admin Workflows (Section 44) */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold text-slate-950">
            Operational Overview
          </h1>
          <p className="text-xs sm:text-sm text-slate-600 mt-0.5">
            Live database metrics across customer accounts, feed &amp; oil mill orders, invoices, and
            ledger balances.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={onOpenAddCustomer}
            className="min-h-[40px] inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-900 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
          >
            <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
            Add Customer
          </button>
          <button
            type="button"
            onClick={onOpenNewInvoice}
            className="min-h-[40px] inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-900 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
          >
            <FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" />
            New Invoice
          </button>
          <button
            type="button"
            onClick={onOpenAddPayment}
            className="min-h-[40px] inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <CreditCard className="h-3.5 w-3.5" aria-hidden="true" />
            Add Payment
          </button>
        </div>
      </div>

      {/* Prominent Focal Anchor: NEW ORDERS Banner + Outstanding Receivable */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
        <section className="lg:col-span-7 rounded-xl border border-amber-300 bg-amber-50/80 p-6 flex flex-col justify-between">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-bold text-amber-900">Priority Action Queue</p>
              <h2 className="mt-1 text-2xl sm:text-3xl font-extrabold text-slate-950">
                NEW ORDERS:{' '}
                <span className="font-mono tabular-nums">{summary.newOrders}</span>
              </h2>
              <p className="mt-1 text-xs sm:text-sm text-slate-700">
                Orders currently in <strong>Order Received</strong> or <strong>Under Review</strong>{' '}
                status awaiting quantity approval.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('orders')}
              className="min-h-[42px] inline-flex items-center gap-1.5 rounded-lg bg-slate-950 px-4 py-2 text-xs font-bold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              Review New Orders
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>

          {summary.prominentNewOrders.length > 0 && (
            <div className="mt-5 pt-4 border-t border-amber-200/80 divide-y divide-amber-200/60">
              {summary.prominentNewOrders.slice(0, 3).map((ord) => (
                <button
                  key={ord.id}
                  type="button"
                  onClick={() => onInspectOrder(ord.id)}
                  className="w-full py-2.5 first:pt-0 last:pb-0 flex items-center justify-between gap-4 text-left hover:opacity-80"
                >
                  <div className="min-w-0">
                    <span className="font-mono font-bold tabular-nums text-xs text-slate-950">
                      {ord.orderNumber}
                    </span>
                    <span className="text-xs text-slate-700">
                      {' '}
                      · {ord.customerName} ({ord.customerAccountNumber}) ·{' '}
                      {ord.requestedItems.length} item(s)
                    </span>
                  </div>
                  <span className={`text-xs shrink-0 ${getOrderStatusToneClass(ord.status)}`}>
                    {ord.status}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-6 flex flex-col justify-between">
          <div>
            <p className="text-xs font-medium text-slate-500">Total Outstanding Amount</p>
            <p className="mt-1 text-2xl sm:text-3xl font-extrabold font-mono tabular-nums text-slate-950">
              {summary.outstandingAmountFormatted}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Reconciled sum of all customer ledger balances across BRB accounts.
            </p>
          </div>

          <div className="mt-5 pt-4 border-t border-slate-100 flex items-center justify-between gap-4">
            <div>
              <p className="text-xs text-slate-500">Pending Invoices (Approved Unbilled Orders)</p>
              <p className="text-lg font-extrabold font-mono tabular-nums text-slate-900">
                {summary.pendingInvoices}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('finance', { finance: 'invoices' })}
              className="min-h-[38px] px-3.5 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
            >
              Open Invoices
            </button>
          </div>
        </section>
      </div>

      {/* Mandatory Customer KPI Strip (Total, Active, Blocked, Pending Registrations) */}
      <section className="rounded-xl border border-slate-200 bg-white grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
        <button
          type="button"
          onClick={() => onNavigate('customers', { customerStatus: 'all' })}
          className="p-5 text-left hover:bg-slate-50 transition-colors"
        >
          <p className="text-xs font-medium text-slate-500">Total Customers</p>
          <p className="mt-1 text-2xl font-extrabold font-mono tabular-nums text-slate-950">
            {summary.totalCustomers}
          </p>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('customers', { customerStatus: 'active' })}
          className="p-5 text-left hover:bg-slate-50 transition-colors"
        >
          <p className="text-xs font-medium text-slate-500">Active Customers</p>
          <p className="mt-1 text-2xl font-extrabold font-mono tabular-nums text-emerald-700">
            {summary.activeCustomers}
          </p>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('customers', { customerStatus: 'blocked' })}
          className="p-5 text-left hover:bg-slate-50 transition-colors"
        >
          <p className="text-xs font-medium text-slate-500">Blocked Customers</p>
          <p className="mt-1 text-2xl font-extrabold font-mono tabular-nums text-rose-700">
            {summary.blockedCustomers}
          </p>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('customers', { customerStatus: 'pending_approval' })}
          className="p-5 text-left hover:bg-slate-50 transition-colors"
        >
          <p className="text-xs font-medium text-slate-500">Pending Registrations</p>
          <p className="mt-1 text-2xl font-extrabold font-mono tabular-nums text-amber-700">
            {summary.pendingRegistrations}
          </p>
        </button>
      </section>

      {/* Bottom 2-Column Split: Recent Payments & Recent Notifications */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
          <div className="flex items-center justify-between gap-2 mb-4">
            <h2 className="text-sm font-bold text-slate-950">Recent Payments</h2>
            <button
              type="button"
              onClick={() => onNavigate('finance', { finance: 'payments' })}
              className="text-xs font-semibold text-slate-700 hover:text-slate-950 underline underline-offset-4 whitespace-nowrap shrink-0"
            >
              All Payments
            </button>
          </div>
          {summary.recentPayments.length === 0 ? (
            <p className="text-xs text-slate-500 py-4">No payments recorded yet.</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {summary.recentPayments.map((pay) => (
                <div
                  key={pay.id}
                  className="py-3 first:pt-0 last:pb-0 flex items-center justify-between gap-3 text-xs"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900 truncate">
                      {pay.customerName}{' '}
                      <span className="font-mono text-slate-500">({pay.customerAccountNumber})</span>
                    </p>
                    <p className="text-slate-500 font-mono tabular-nums mt-0.5">
                      {pay.paymentDate} · {pay.paymentMethod} · {pay.paymentNumber}
                    </p>
                  </div>
                  <span className="font-mono font-bold tabular-nums text-emerald-700 shrink-0">
                    {pay.amountFormatted}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
          <div className="flex items-center justify-between gap-2 mb-4">
            <h2 className="text-sm font-bold text-slate-950">Recent Notifications</h2>
            <button
              type="button"
              onClick={() => onNavigate('operations')}
              className="text-xs font-semibold text-slate-700 hover:text-slate-950 underline underline-offset-4 whitespace-nowrap shrink-0"
            >
              Notification Log
            </button>
          </div>
          {summary.recentNotifications.length === 0 ? (
            <p className="text-xs text-slate-500 py-4">No notifications sent yet.</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {summary.recentNotifications.map((n) => (
                <div key={n.id} className="py-3 first:pt-0 last:pb-0 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-900 truncate">
                      {n.customerName} ({n.customerAccountNumber})
                    </span>
                    <span className="font-mono tabular-nums text-slate-400 shrink-0">
                      SMS: {n.smsDeliveryStatus}
                    </span>
                  </div>
                  <p className="text-slate-600 mt-0.5 truncate">{n.title}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
