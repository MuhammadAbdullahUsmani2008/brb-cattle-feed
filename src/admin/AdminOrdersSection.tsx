import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, FilePlus2, Plus, Search, Trash2 } from 'lucide-react';
import { ORDER_STATUSES } from '../shared/types';
import type { OrderStatus, OrderView, ProductAdminView } from '../shared/types';
import { describeApprovedItemStatus, isValidAdminOrderTransition } from '../shared/domain';
import { adminApi } from '../lib/api';
import { EmptyStateBox, getOrderStatusToneClass, InlineAlert } from '../components/Branding';

interface DraftApprovalItem {
  requestedItemId: number;
  productId: number;
  productName: string;
  packingWeight: string;
  requestedQty: number;
  approvedQty: number;
  reductionReason: string;
}

interface DraftAddedItem {
  key: string;
  productId: number;
  approvedQty: number;
}

export function AdminOrdersSection({
  focusOrderId,
  onClearFocusOrder,
  onDataChanged,
  onCreateInvoiceForOrder,
}: {
  focusOrderId: number | null;
  onClearFocusOrder: () => void;
  onDataChanged: () => void;
  onCreateInvoiceForOrder: (order: OrderView) => void;
}) {
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [products, setProducts] = useState<ProductAdminView[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(focusOrderId);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ tone: 'success' | 'error' | 'info'; message: string } | null>(null);

  // Approval Form State
  const [draftRequested, setDraftRequested] = useState<DraftApprovalItem[]>([]);
  const [draftAdded, setDraftAdded] = useState<DraftAddedItem[]>([]);
  const [addProductId, setAddProductId] = useState<number>(0);
  const [addProductQty, setAddProductQty] = useState<number>(5);
  const [statusNote, setStatusNote] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const qs = params.toString();

      const [ordRes, prodRes] = await Promise.all([
        adminApi<{ orders: OrderView[] }>(`/api/admin/orders${qs ? `?${qs}` : ''}`),
        adminApi<{ products: ProductAdminView[] }>('/api/admin/products'),
      ]);
      setOrders(ordRes.orders);
      setProducts(prodRes.products.filter((p) => !p.isArchived));
      if (prodRes.products.length > 0 && addProductId === 0) {
        const firstActive = prodRes.products.find((p) => p.isActive && !p.isArchived);
        if (firstActive) setAddProductId(firstActive.id);
      }
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Unable to load orders.',
      });
    } finally {
      setLoading(false);
    }
  }, [addProductId, search, statusFilter]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (focusOrderId) {
      setSelectedOrderId(focusOrderId);
      onClearFocusOrder();
    }
  }, [focusOrderId, onClearFocusOrder]);

  const activeOrder = useMemo(() => {
    if (orders.length === 0) return null;
    if (selectedOrderId != null) {
      const match = orders.find((o) => o.id === selectedOrderId);
      if (match) return match;
    }
    return orders[0];
  }, [orders, selectedOrderId]);

  // Reset approval form draft whenever selected order changes
  useEffect(() => {
    if (!activeOrder) {
      setDraftRequested([]);
      setDraftAdded([]);
      return;
    }
    setDraftRequested(
      activeOrder.requestedItems.map((ri) => ({
        requestedItemId: ri.id,
        productId: ri.productId,
        productName: ri.productNameSnapshot,
        packingWeight: ri.packingSnapshot,
        requestedQty: ri.requestedQty,
        approvedQty: ri.requestedQty,
        reductionReason: '',
      }))
    );
    setDraftAdded([]);
    setStatusNote('');
  }, [activeOrder?.id]);

  const handleAddBrbItem = () => {
    if (!addProductId || addProductQty <= 0) return;
    setDraftAdded((prev) => [
      ...prev,
      {
        key: `add_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        productId: addProductId,
        approvedQty: Math.floor(addProductQty),
      },
    ]);
  };

  const handleApproveOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeOrder) return;
    setBusy(true);
    setBanner(null);
    try {
      const items = [
        ...draftRequested.map((d) => ({
          requestedItemId: d.requestedItemId,
          productId: d.productId,
          approvedQty: Number(d.approvedQty),
          reductionReason:
            Number(d.approvedQty) < d.requestedQty ? d.reductionReason.trim() : null,
        })),
        ...draftAdded.map((a) => ({
          requestedItemId: null,
          productId: a.productId,
          approvedQty: Number(a.approvedQty),
          reductionReason: null,
        })),
      ];

      const res = await adminApi<{ order: OrderView }>(
        `/api/admin/orders/${activeOrder.id}/approve`,
        {
          method: 'POST',
          body: { items },
        }
      );
      setSelectedOrderId(res.order.id);
      await loadData();
      onDataChanged();
      setBanner({
        tone: 'success',
        message: `Order ${res.order.orderNumber} approved (${res.order.status}) and customer notified.`,
      });
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Order approval failed.',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleTransitionStatus = async (nextStatus: OrderStatus) => {
    if (!activeOrder) return;
    setBusy(true);
    setBanner(null);
    try {
      const res = await adminApi<{ order: OrderView }>(
        `/api/admin/orders/${activeOrder.id}/status`,
        {
          method: 'POST',
          body: { status: nextStatus, note: statusNote.trim() || undefined },
        }
      );
      setSelectedOrderId(res.order.id);
      setStatusNote('');
      await loadData();
      onDataChanged();
      setBanner({
        tone: 'success',
        message: `Updated ${res.order.orderNumber} to "${res.order.status}".`,
      });
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Status update failed.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl sm:text-2xl font-extrabold text-slate-950">
          Order Review, Quantity Approval &amp; Dispatch
        </h1>
        <p className="text-xs sm:text-sm text-slate-600 mt-0.5">
          Preserve original customer requests, enter mandatory reasons for reduced quantities, add
          extra items labeled Added by BRB, and generate invoices.
        </p>
      </div>

      {banner && (
        <InlineAlert
          tone={banner.tone}
          message={banner.message}
          onDismiss={() => setBanner(null)}
        />
      )}

      {/* Search & Status Filter */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            aria-label="Search orders"
            placeholder="Order #, customer name, BRB-C-ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full min-h-[40px] rounded-lg border border-slate-300 bg-white pl-9 pr-3 py-2 text-xs text-slate-900 focus:border-slate-900 focus:outline-none"
          />
        </div>

        <select
          aria-label="Filter orders by status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="min-h-[40px] rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-900"
        >
          <option value="all">All Order Statuses</option>
          {ORDER_STATUSES.map((st) => (
            <option key={st} value={st}>
              {st}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-xs text-slate-500">
          Loading customer orders...
        </div>
      ) : orders.length === 0 ? (
        <EmptyStateBox
          title="No Customer Orders Found"
          description="Submitted customer orders appear here immediately for review and quantity approval."
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left 4 Cols: Orders Queue */}
          <div className="lg:col-span-4 rounded-xl border border-slate-200 bg-white divide-y divide-slate-100 max-h-[700px] overflow-y-auto">
            {orders.map((ord) => {
              const selected = activeOrder?.id === ord.id;
              return (
                <button
                  key={ord.id}
                  type="button"
                  onClick={() => setSelectedOrderId(ord.id)}
                  className={`w-full p-4 text-left transition-colors ${
                    selected ? 'bg-amber-50/80' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono font-bold tabular-nums text-sm text-slate-950">
                      {ord.orderNumber}
                    </span>
                    <span className="font-mono tabular-nums text-[11px] text-slate-400">
                      {ord.createdAt.slice(0, 10)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs font-semibold text-slate-800 truncate">
                    {ord.customerName} ({ord.customerAccountNumber})
                  </p>
                  <p className={`mt-1 text-xs ${getOrderStatusToneClass(ord.status)}`}>
                    {ord.status}
                    {ord.linkedInvoiceNumber ? ` · Inv #${ord.linkedInvoiceNumber}` : ''}
                  </p>
                </button>
              );
            })}
          </div>

          {/* Right 8 Cols: Active Order Review / Comparison / Status Controls */}
          {activeOrder && (
            <div className="lg:col-span-8 rounded-xl border border-slate-200 bg-white p-5 sm:p-6 space-y-6">
              {/* Order Header */}
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
                <div>
                  <h2 className="text-xl font-extrabold font-mono tabular-nums text-slate-950">
                    {activeOrder.orderNumber}
                  </h2>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Customer: <strong className="text-slate-900">{activeOrder.customerName}</strong>{' '}
                    (<span className="font-mono">{activeOrder.customerAccountNumber}</span>) ·
                    Submitted {activeOrder.createdAt.slice(0, 16).replace('T', ' ')}
                  </p>
                  <p className={`mt-1 text-sm ${getOrderStatusToneClass(activeOrder.status)}`}>
                    Current Status: {activeOrder.status}
                  </p>
                </div>

                {/* Create Invoice Action (when Approved & not yet invoiced) */}
                {['Confirmed / Partially Approved', 'Preparing', 'Dispatched', 'Delivered'].includes(
                  activeOrder.status
                ) &&
                  !activeOrder.linkedInvoiceId && (
                    <button
                      type="button"
                      onClick={() => onCreateInvoiceForOrder(activeOrder)}
                      className="min-h-[42px] inline-flex items-center gap-1.5 rounded-lg bg-amber-400 px-4 py-2 text-xs font-extrabold text-slate-950 hover:bg-amber-300 transition-colors whitespace-nowrap shrink-0"
                    >
                      <FilePlus2 className="h-4 w-4" />
                      Create Invoice from Order
                    </button>
                  )}

                {activeOrder.linkedInvoiceNumber && (
                  <span className="text-xs font-mono font-bold tabular-nums text-emerald-800">
                    Billed under Invoice #{activeOrder.linkedInvoiceNumber}
                  </span>
                )}
              </div>

              {/* Approval Form for Pending Orders ('Order Received' | 'Under Review') */}
              {(activeOrder.status === 'Order Received' ||
                activeOrder.status === 'Under Review') && (
                <form onSubmit={handleApproveOrder} className="space-y-5">
                  {activeOrder.status === 'Order Received' && (
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs">
                      <span className="text-slate-700">
                        Optional: Mark order as <strong>Under Review</strong> before finalizing
                        approved quantities.
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleTransitionStatus('Under Review')}
                        className="min-h-[34px] px-3 py-1 rounded-md border border-slate-300 bg-white font-semibold text-slate-800 hover:bg-slate-100 whitespace-nowrap shrink-0"
                      >
                        Mark Under Review
                      </button>
                    </div>
                  )}

                  <div>
                    <h3 className="text-sm font-bold text-slate-950">
                      1. Review Customer Requested Items
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Reducing any requested quantity requires an explicit explanation visible to the
                      customer.
                    </p>

                    <div className="mt-3 divide-y divide-slate-200 border-t border-b border-slate-200">
                      {draftRequested.map((item, idx) => {
                        const isReduced = item.approvedQty < item.requestedQty;
                        return (
                          <div key={item.requestedItemId} className="py-3.5 space-y-2.5">
                            <div className="flex flex-wrap items-center justify-between gap-4">
                              <div>
                                <p className="text-sm font-bold text-slate-900">
                                  {item.productName}
                                </p>
                                <p className="text-xs text-slate-500">
                                  {item.packingWeight} · Customer Requested:{' '}
                                  <strong className="font-mono tabular-nums text-slate-900">
                                    {item.requestedQty}
                                  </strong>
                                </p>
                              </div>

                              <div className="flex items-center gap-2">
                                <label
                                  htmlFor={`app-qty-${item.requestedItemId}`}
                                  className="text-xs font-semibold text-slate-700"
                                >
                                  Approved Qty:
                                </label>
                                <input
                                  id={`app-qty-${item.requestedItemId}`}
                                  type="number"
                                  min={0}
                                  max={100000}
                                  required
                                  value={item.approvedQty}
                                  onChange={(e) => {
                                    const val = Math.max(0, Math.floor(Number(e.target.value || 0)));
                                    setDraftRequested((prev) =>
                                      prev.map((row, i) =>
                                        i === idx ? { ...row, approvedQty: val } : row
                                      )
                                    );
                                  }}
                                  className="w-24 min-h-[38px] rounded-lg border border-slate-300 px-2.5 py-1.5 text-right font-mono font-bold tabular-nums text-sm text-slate-950 focus:border-slate-900 focus:outline-none"
                                />
                              </div>
                            </div>

                            {isReduced && (
                              <div className="rounded-lg border border-amber-300 bg-amber-50/70 p-3 space-y-2">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <label
                                    htmlFor={`red-reason-${item.requestedItemId}`}
                                    className="text-xs font-bold text-amber-950"
                                  >
                                    Mandatory Reduction Reason ({item.approvedQty} of{' '}
                                    {item.requestedQty} approved) *
                                  </label>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const sampleUrdu = `Stock کم ہونے کی وجہ سے ${item.approvedQty} Bags approve کیے گئے۔`;
                                      setDraftRequested((prev) =>
                                        prev.map((row, i) =>
                                          i === idx ? { ...row, reductionReason: sampleUrdu } : row
                                        )
                                      );
                                    }}
                                    className="text-[11px] font-semibold text-amber-900 underline hover:text-slate-950"
                                  >
                                    Fill Standard Urdu Stock Reason
                                  </button>
                                </div>
                                <input
                                  id={`red-reason-${item.requestedItemId}`}
                                  type="text"
                                  required
                                  placeholder="e.g., Stock کم ہونے کی وجہ سے 5 Bags approve کیے گئے۔"
                                  value={item.reductionReason}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setDraftRequested((prev) =>
                                      prev.map((row, i) =>
                                        i === idx ? { ...row, reductionReason: val } : row
                                      )
                                    );
                                  }}
                                  className="w-full min-h-[38px] rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs text-slate-900 focus:border-slate-900 focus:outline-none"
                                />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* 2. Add Extra Products ("Added by BRB") */}
                  <div>
                    <h3 className="text-sm font-bold text-slate-950">
                      2. Add Additional Products (Labeled &ldquo;Added by BRB&rdquo;)
                    </h3>
                    <div className="mt-2 flex flex-wrap items-center gap-2.5">
                      <select
                        aria-label="Select extra product to add"
                        value={addProductId}
                        onChange={(e) => setAddProductId(Number(e.target.value))}
                        className="min-h-[38px] flex-1 min-w-[200px] rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-900"
                      >
                        <option value={0}>Select product...</option>
                        {products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.category} · {p.packingWeight})
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min={1}
                        max={10000}
                        aria-label="Extra product quantity"
                        value={addProductQty}
                        onChange={(e) => setAddProductQty(Number(e.target.value || 1))}
                        className="w-24 min-h-[38px] rounded-lg border border-slate-300 px-2.5 py-1.5 text-right font-mono tabular-nums text-xs font-bold text-slate-900"
                      />
                      <button
                        type="button"
                        onClick={handleAddBrbItem}
                        className="min-h-[38px] inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 whitespace-nowrap shrink-0"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Add Item
                      </button>
                    </div>

                    {draftAdded.length > 0 && (
                      <div className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200 px-3">
                        {draftAdded.map((added) => {
                          const prod = products.find((p) => p.id === added.productId);
                          return (
                            <div
                              key={added.key}
                              className="py-2.5 flex items-center justify-between gap-3 text-xs"
                            >
                              <div>
                                <span className="font-bold text-slate-900">
                                  {prod?.name || `Product #${added.productId}`}
                                </span>{' '}
                                <span className="text-indigo-700 font-semibold">
                                  · Added by BRB
                                </span>
                              </div>
                              <div className="flex items-center gap-3">
                                <span className="font-mono font-bold tabular-nums text-slate-900">
                                  Qty: {added.approvedQty}
                                </span>
                                <button
                                  type="button"
                                  aria-label="Remove added item"
                                  onClick={() =>
                                    setDraftAdded((prev) => prev.filter((x) => x.key !== added.key))
                                  }
                                  className="text-rose-700 hover:text-rose-900"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="pt-2 flex flex-wrap items-center justify-between gap-3">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleTransitionStatus('Cancelled')}
                      className="min-h-[42px] px-4 py-2 rounded-lg border border-rose-300 text-xs font-semibold text-rose-700 hover:bg-rose-50 whitespace-nowrap shrink-0"
                    >
                      Cancel Order
                    </button>
                    <button
                      type="submit"
                      disabled={busy}
                      className="min-h-[44px] inline-flex items-center gap-2 rounded-lg bg-slate-900 px-5 py-2.5 text-xs font-bold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      {busy
                        ? 'Approving Order...'
                        : 'Confirm & Approve Order Quantities'}
                    </button>
                  </div>
                </form>
              )}

              {/* Read-Only Comparison & Fulfillment Transitions Once Approved / Cancelled */}
              {activeOrder.status !== 'Order Received' &&
                activeOrder.status !== 'Under Review' && (
                  <div className="space-y-5">
                    <div>
                      <h3 className="text-sm font-bold text-slate-950">
                        Original Request vs. Approved Quantities
                      </h3>
                      <div className="mt-2 divide-y divide-slate-100 border-t border-b border-slate-100 text-xs">
                        {activeOrder.approvedItems.length > 0
                          ? activeOrder.approvedItems.map((ai) => (
                              <div key={ai.id} className="py-3 space-y-1">
                                <div className="flex items-baseline justify-between gap-3">
                                  <span className="font-bold text-slate-900">
                                    {ai.productNameSnapshot} ({ai.packingSnapshot})
                                  </span>
                                  <span className="font-mono tabular-nums text-slate-800">
                                    {ai.isAddedByBrb
                                      ? `Added by BRB · Approved ${ai.approvedQty}`
                                      : `Requested ${ai.requestedQty} → Approved ${ai.approvedQty} (${describeApprovedItemStatus(
                                          ai.requestedQty,
                                          ai.approvedQty,
                                          ai.isAddedByBrb
                                        )})`}
                                  </span>
                                </div>
                                {ai.reductionReason && (
                                  <p
                                    dir={/[\u0600-\u06FF]/.test(ai.reductionReason) ? 'rtl' : undefined}
                                    className={
                                      /[\u0600-\u06FF]/.test(ai.reductionReason)
                                        ? 'font-urdu text-sm text-amber-900 text-right'
                                        : 'text-amber-900'
                                    }
                                  >
                                    Reason: {ai.reductionReason}
                                  </p>
                                )}
                              </div>
                            ))
                          : activeOrder.requestedItems.map((ri) => (
                              <div
                                key={ri.id}
                                className="py-2.5 flex items-center justify-between"
                              >
                                <span>{ri.productNameSnapshot}</span>
                                <span className="font-mono tabular-nums">
                                  Requested: {ri.requestedQty}
                                </span>
                              </div>
                            ))}
                      </div>
                    </div>

                    {/* Validated Next Status Transitions */}
                    {(() => {
                      const nextAllowed = ORDER_STATUSES.filter(
                        (cand) =>
                          cand !== 'Confirmed / Partially Approved' &&
                          isValidAdminOrderTransition(activeOrder.status, cand)
                      );
                      if (nextAllowed.length === 0) return null;
                      return (
                        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
                          <h4 className="text-xs font-bold text-slate-900">
                            Advance Order Fulfillment Status
                          </h4>
                          <input
                            type="text"
                            placeholder="Optional dispatch / vehicle / gate-pass note"
                            value={statusNote}
                            onChange={(e) => setStatusNote(e.target.value)}
                            className="w-full min-h-[38px] rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900"
                          />
                          <div className="flex flex-wrap items-center gap-2">
                            {nextAllowed.map((st) => (
                              <button
                                key={st}
                                type="button"
                                disabled={busy}
                                onClick={() => void handleTransitionStatus(st)}
                                className={`min-h-[38px] px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                                  st === 'Cancelled'
                                    ? 'border border-rose-300 bg-white text-rose-700 hover:bg-rose-50'
                                    : 'bg-slate-900 text-white hover:bg-slate-800'
                                }`}
                              >
                                Move to: {st}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
