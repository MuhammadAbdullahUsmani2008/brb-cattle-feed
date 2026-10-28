import React, { useCallback, useEffect, useState } from 'react';
import { Search, UserPlus } from 'lucide-react';
import type { CustomerPublicView } from '../shared/types';
import { adminApi } from '../lib/api';
import { ConfirmDialog, EmptyStateBox, InlineAlert } from '../components/Branding';

export function AdminCustomersSection({
  initialStatusFilter = 'all',
  openCreateInitially = false,
  onClearOpenCreate,
  onDataChanged,
  onOpenCustomerLedger,
}: {
  initialStatusFilter?: string;
  openCreateInitially?: boolean;
  onClearOpenCreate?: () => void;
  onDataChanged: () => void;
  onOpenCustomerLedger: (customerId: number) => void;
}) {
  const [customers, setCustomers] = useState<CustomerPublicView[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(initialStatusFilter);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<{ tone: 'success' | 'error' | 'info'; message: string } | null>(null);

  // Add Customer Modal
  const [showCreateModal, setShowCreateModal] = useState(openCreateInitially);
  const [newName, setNewName] = useState('');
  const [newBusiness, setNewBusiness] = useState('');
  const [newMobile, setNewMobile] = useState('');
  const [newCity, setNewCity] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [creating, setCreating] = useState(false);

  // Block / Unblock / Reject Dialog
  const [blockTarget, setBlockTarget] = useState<{
    customer: CustomerPublicView;
    mode: 'block' | 'unblock' | 'reject';
  } | null>(null);
  const [actionReason, setActionReason] = useState('');
  const [actionBusy, setActionBusy] = useState(false);

  useEffect(() => {
    setStatusFilter(initialStatusFilter);
  }, [initialStatusFilter]);

  useEffect(() => {
    if (openCreateInitially) {
      setShowCreateModal(true);
      onClearOpenCreate?.();
    }
  }, [openCreateInitially, onClearOpenCreate]);

  const loadCustomers = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const qs = params.toString();
      const res = await adminApi<{ customers: CustomerPublicView[] }>(
        `/api/admin/customers${qs ? `?${qs}` : ''}`
      );
      setCustomers(res.customers);
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Unable to load customers.',
      });
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter]);

  useEffect(() => {
    void loadCustomers();
  }, [loadCustomers]);

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setBanner(null);
    try {
      const res = await adminApi<{ customer: CustomerPublicView }>('/api/admin/customers', {
        method: 'POST',
        body: {
          name: newName.trim(),
          businessName: newBusiness.trim(),
          mobileNumber: newMobile.trim(),
          city: newCity.trim(),
          notes: newNotes.trim(),
        },
      });
      setShowCreateModal(false);
      setNewName('');
      setNewBusiness('');
      setNewMobile('');
      setNewCity('');
      setNewNotes('');
      await loadCustomers();
      onDataChanged();
      setBanner({
        tone: 'success',
        message: `Created customer ${res.customer.name} with sequential account number ${res.customer.accountNumber}.`,
      });
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Failed to create customer.',
      });
    } finally {
      setCreating(false);
    }
  };

  const handleApproveRegistration = async (cust: CustomerPublicView) => {
    setActionBusy(true);
    setBanner(null);
    try {
      const res = await adminApi<{ customer: CustomerPublicView }>(
        `/api/admin/customers/${cust.id}/registration-decision`,
        {
          method: 'POST',
          body: { decision: 'approve' },
        }
      );
      await loadCustomers();
      onDataChanged();
      setBanner({
        tone: 'success',
        message: `Registration approved. Account ${res.customer.accountNumber} is now Active.`,
      });
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Approval failed.',
      });
    } finally {
      setActionBusy(false);
    }
  };

  const handleConfirmDialogAction = async () => {
    if (!blockTarget) return;
    setActionBusy(true);
    setBanner(null);
    try {
      if (blockTarget.mode === 'reject') {
        await adminApi(`/api/admin/customers/${blockTarget.customer.id}/registration-decision`, {
          method: 'POST',
          body: { decision: 'reject', reason: actionReason.trim() || 'Declined by administrator' },
        });
        setBanner({
          tone: 'info',
          message: `Declined registration for ${blockTarget.customer.accountNumber}.`,
        });
      } else {
        const shouldBlock = blockTarget.mode === 'block';
        await adminApi(`/api/admin/customers/${blockTarget.customer.id}/block-state`, {
          method: 'POST',
          body: { blocked: shouldBlock, reason: actionReason.trim() },
        });
        setBanner({
          tone: shouldBlock ? 'info' : 'success',
          message: shouldBlock
            ? `Blocked account ${blockTarget.customer.accountNumber} and revoked active customer sessions.`
            : `Unblocked account ${blockTarget.customer.accountNumber}.`,
        });
      }
      setBlockTarget(null);
      setActionReason('');
      await loadCustomers();
      onDataChanged();
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Customer update failed.',
      });
    } finally {
      setActionBusy(false);
    }
  };

  const statusTone = (status: CustomerPublicView['status']) => {
    switch (status) {
      case 'active':
        return 'text-emerald-700 font-semibold';
      case 'pending_approval':
        return 'text-amber-700 font-bold';
      case 'blocked':
        return 'text-rose-700 font-bold';
      case 'rejected':
        return 'text-rose-600 font-medium';
      default:
        return 'text-slate-600 font-medium';
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold text-slate-950">
            Customer Accounts &amp; Registrations
          </h1>
          <p className="text-xs sm:text-sm text-slate-600 mt-0.5">
            Sequential BRB-C-ID131+ allocation, OTP-verified registration approvals, and instant
            account blocking.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowCreateModal(true)}
          className="min-h-[42px] inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
        >
          <UserPlus className="h-4 w-4" />
          Add Customer (Auto BRB-C-ID)
        </button>
      </div>

      {banner && (
        <InlineAlert
          tone={banner.tone}
          message={banner.message}
          onDismiss={() => setBanner(null)}
        />
      )}

      {/* Search & Status Filter Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            aria-label="Search customers"
            placeholder="Search name, BRB-C-ID, mobile, business..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full min-h-[40px] rounded-lg border border-slate-300 bg-white pl-9 pr-3 py-2 text-xs text-slate-900 focus:border-slate-900 focus:outline-none"
          />
        </div>

        <div className="flex overflow-x-auto gap-1 p-1 rounded-lg bg-slate-200/70">
          {(
            [
              ['all', 'All'],
              ['pending_approval', 'Pending Approval'],
              ['active', 'Active'],
              ['unregistered', 'Unregistered'],
              ['blocked', 'Blocked'],
            ] as const
          ).map(([st, label]) => (
            <button
              key={st}
              type="button"
              onClick={() => setStatusFilter(st)}
              className={`min-h-[34px] px-3 py-1 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                statusFilter === st
                  ? 'bg-white text-slate-950 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Customer Directory Table */}
      {loading ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-xs text-slate-500">
          Loading customer directory...
        </div>
      ) : customers.length === 0 ? (
        <EmptyStateBox
          title="No Matching Customer Accounts"
          description="Create a new BRB customer account to allocate sequential BRB-C-ID131+ identifiers."
          actionLabel="Add First Customer"
          onAction={() => setShowCreateModal(true)}
        />
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs sm:text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-600">
                <th className="py-3 px-4">Account ID</th>
                <th className="py-3 px-4">Customer / Business</th>
                <th className="py-3 px-4">Mobile</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Outstanding Balance</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {customers.map((cust) => (
                <tr key={cust.id} className="hover:bg-slate-50/70">
                  <td className="py-3 px-4 font-mono font-bold tabular-nums text-slate-950 whitespace-nowrap">
                    {cust.accountNumber}
                  </td>
                  <td className="py-3 px-4">
                    <p className="font-semibold text-slate-900">{cust.name}</p>
                    {(cust.businessName || cust.city) && (
                      <p className="text-xs text-slate-500">
                        {[cust.businessName, cust.city].filter(Boolean).join(' · ')}
                      </p>
                    )}
                    {cust.blockedReason && (
                      <p className="text-xs text-rose-700 mt-0.5">
                        Blocked reason: {cust.blockedReason}
                      </p>
                    )}
                  </td>
                  <td className="py-3 px-4 font-mono tabular-nums text-xs text-slate-700 whitespace-nowrap">
                    {cust.mobileNumber}
                  </td>
                  <td className="py-3 px-4 whitespace-nowrap">
                    <span className={`text-xs ${statusTone(cust.status)}`}>
                      {cust.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right font-mono font-bold tabular-nums text-slate-950 whitespace-nowrap">
                    {cust.outstandingBalanceFormatted}
                  </td>
                  <td className="py-3 px-4 text-right">
                    <div className="inline-flex items-center justify-end gap-2">
                      {cust.status === 'pending_approval' && (
                        <>
                          <button
                            type="button"
                            disabled={actionBusy}
                            onClick={() => void handleApproveRegistration(cust)}
                            className="min-h-[34px] px-3 py-1 rounded-md bg-emerald-700 text-xs font-semibold text-white hover:bg-emerald-800 transition-colors whitespace-nowrap shrink-0"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            disabled={actionBusy}
                            onClick={() => {
                              setActionReason('');
                              setBlockTarget({ customer: cust, mode: 'reject' });
                            }}
                            className="min-h-[34px] px-2.5 py-1 rounded-md border border-rose-300 text-xs font-semibold text-rose-700 hover:bg-rose-50 transition-colors whitespace-nowrap shrink-0"
                          >
                            Reject
                          </button>
                        </>
                      )}

                      <button
                        type="button"
                        onClick={() => onOpenCustomerLedger(cust.id)}
                        className="min-h-[34px] px-2.5 py-1 rounded-md border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                      >
                        Full Ledger
                      </button>

                      {cust.status === 'blocked' ? (
                        <button
                          type="button"
                          onClick={() => {
                            setActionReason('');
                            setBlockTarget({ customer: cust, mode: 'unblock' });
                          }}
                          className="min-h-[34px] px-2.5 py-1 rounded-md bg-slate-900 text-xs font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                        >
                          Unblock
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setActionReason('');
                            setBlockTarget({ customer: cust, mode: 'block' });
                          }}
                          className="min-h-[34px] px-2.5 py-1 rounded-md border border-rose-200 text-xs font-semibold text-rose-700 hover:bg-rose-50 transition-colors whitespace-nowrap shrink-0"
                        >
                          Block
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Customer Modal */}
      {showCreateModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Create BRB Customer Account"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 backdrop-blur-xs p-4"
        >
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
            <h2 className="text-lg font-extrabold text-slate-950">
              Create BRB Customer Account
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Automatically assigns the next sequential BRB Account Number (starting at BRB-C-ID131).
            </p>

            <form onSubmit={handleCreateCustomer} className="mt-5 space-y-4">
              <div>
                <label
                  htmlFor="cust-new-name"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Customer Full Name *
                </label>
                <input
                  id="cust-new-name"
                  type="text"
                  required
                  minLength={2}
                  placeholder="e.g., Chaudhry Tariq Dairy Farm"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label
                    htmlFor="cust-new-mobile"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    Registered Mobile Number *
                  </label>
                  <input
                    id="cust-new-mobile"
                    type="tel"
                    required
                    placeholder="03001234567"
                    value={newMobile}
                    onChange={(e) => setNewMobile(e.target.value)}
                    className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono tabular-nums text-slate-900 focus:border-slate-900 focus:outline-none"
                  />
                </div>
                <div>
                  <label
                    htmlFor="cust-new-city"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    City / Area
                  </label>
                  <input
                    id="cust-new-city"
                    type="text"
                    placeholder="e.g., Sahiwal"
                    value={newCity}
                    onChange={(e) => setNewCity(e.target.value)}
                    className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="cust-new-biz"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Farm / Dealership Name
                </label>
                <input
                  id="cust-new-biz"
                  type="text"
                  placeholder="Optional business title"
                  value={newBusiness}
                  onChange={(e) => setNewBusiness(e.target.value)}
                  className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="cust-new-notes"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Internal Administrative Notes
                </label>
                <input
                  id="cust-new-notes"
                  type="text"
                  placeholder="Optional internal note"
                  value={newNotes}
                  onChange={(e) => setNewNotes(e.target.value)}
                  className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                />
              </div>

              <div className="pt-2 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="min-h-[42px] px-4 py-2 rounded-lg border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="min-h-[42px] px-5 py-2 rounded-lg bg-slate-900 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  {creating ? 'Allocating Account...' : 'Create Customer Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Block / Unblock / Reject Dialog */}
      <ConfirmDialog
        open={Boolean(blockTarget)}
        title={
          blockTarget?.mode === 'block'
            ? `Block ${blockTarget.customer.accountNumber}?`
            : blockTarget?.mode === 'unblock'
              ? `Unblock ${blockTarget.customer.accountNumber}?`
              : `Decline Registration (${blockTarget?.customer.accountNumber})?`
        }
        description={
          blockTarget?.mode === 'block'
            ? 'Blocking immediately revokes all active customer sessions and displays the mandatory Urdu blocked message.'
            : blockTarget?.mode === 'unblock'
              ? 'Unblocking restores customer sign-in access (requiring a fresh login).'
              : 'Enter the reason for declining this customer registration.'
        }
        confirmLabel={
          blockTarget?.mode === 'block'
            ? 'Block Account'
            : blockTarget?.mode === 'unblock'
              ? 'Unblock Account'
              : 'Decline Registration'
        }
        destructive={blockTarget?.mode !== 'unblock'}
        busy={actionBusy}
        onConfirm={() => void handleConfirmDialogAction()}
        onCancel={() => setBlockTarget(null)}
      >
        {blockTarget?.mode !== 'unblock' && (
          <div>
            <label
              htmlFor="cust-action-reason"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Administrative Reason *
            </label>
            <input
              id="cust-action-reason"
              type="text"
              required
              placeholder="Enter audit reason (min 3 characters)"
              value={actionReason}
              onChange={(e) => setActionReason(e.target.value)}
              className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
            />
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}
