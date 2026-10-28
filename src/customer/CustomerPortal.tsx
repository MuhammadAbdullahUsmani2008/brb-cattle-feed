import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bell,
  ChevronRight,
  ClipboardList,
  Download,
  FileText,
  Home,
  LogOut,
  Minus,
  Package,
  Plus,
  Search,
  ShoppingBag,
  User,
  X,
} from 'lucide-react';
import {
  BRAND_NAMES,
  CUSTOMER_CANCELLABLE_STATUSES,
  PRODUCT_CATEGORIES,
  URDU_MESSAGES,
} from '../shared/types';
import type {
  CustomerPublicView,
  InvoiceView,
  LedgerEntryView,
  NotificationView,
  OrderView,
  PaymentView,
  ProductCategory,
  ProductCustomerView,
} from '../shared/types';
import { describeApprovedItemStatus } from '../shared/domain';
import { ApiClientError, customerApi, downloadAuthenticatedPdf } from '../lib/api';
import type { PublicBootstrapInfo } from '../lib/api';
import {
  BrbLogo,
  ConfirmDialog,
  EmptyStateBox,
  getOrderStatusToneClass,
  InlineAlert,
  ProductVisual,
} from '../components/Branding';
import { InvoiceDocumentModal } from '../components/InvoiceDocument';

type CustomerNavTab = 'home' | 'products' | 'orders' | 'account' | 'new_order';
type AccountSubTab = 'ledger' | 'invoices' | 'payments' | 'orders' | 'notifications';

interface CustomerMeResponse {
  customer: CustomerPublicView;
  recentOrders: OrderView[];
  latestInvoice: InvoiceView | null;
  unreadNotificationCount: number;
}

interface CustomerLedgerResponse {
  cutoffDate: string;
  broughtForwardPaisa: number;
  broughtForwardFormatted: string;
  outstandingBalancePaisa: number;
  outstandingBalanceFormatted: string;
  entries: LedgerEntryView[];
}

export function CustomerPortal({
  bootstrap,
  initialCustomer,
  onLogout,
  onBlocked,
}: {
  bootstrap: PublicBootstrapInfo;
  initialCustomer: CustomerPublicView;
  onLogout: () => void;
  onBlocked: (urduMessage: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<CustomerNavTab>('home');
  const [accountSubTab, setAccountSubTab] = useState<AccountSubTab>('ledger');

  const [customer, setCustomer] = useState<CustomerPublicView>(initialCustomer);
  const [recentOrders, setRecentOrders] = useState<OrderView[]>([]);
  const [latestInvoice, setLatestInvoice] = useState<InvoiceView | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);

  const [products, setProducts] = useState<ProductCustomerView[]>([]);
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [invoices, setInvoices] = useState<InvoiceView[]>([]);
  const [payments, setPayments] = useState<PaymentView[]>([]);
  const [notifications, setNotifications] = useState<NotificationView[]>([]);
  const [ledgerData, setLedgerData] = useState<CustomerLedgerResponse | null>(null);

  // Filters
  const [productCategoryFilter, setProductCategoryFilter] = useState<'all' | ProductCategory>('all');
  const [selectedProductDetail, setSelectedProductDetail] = useState<ProductCustomerView | null>(null);
  const [selectedOrderDetail, setSelectedOrderDetail] = useState<OrderView | null>(null);
  const [previewInvoice, setPreviewInvoice] = useState<InvoiceView | null>(null);
  const [selectedPaymentDetail, setSelectedPaymentDetail] = useState<PaymentView | null>(null);

  // Ledger filters
  const [ledgerSearch, setLedgerSearch] = useState('');
  const [ledgerType, setLedgerType] = useState<'all' | 'invoice' | 'payment'>('all');
  const [ledgerFromDate, setLedgerFromDate] = useState('');
  const [ledgerToDate, setLedgerToDate] = useState('');

  // New Order Cart + Review Step
  const [cartQuantities, setCartQuantities] = useState<Record<number, number>>({});
  const [orderStep, setOrderStep] = useState<'build' | 'review'>('build');
  const [orderIdempotencyKey, setOrderIdempotencyKey] = useState<string>('');
  const [submittingOrder, setSubmittingOrder] = useState(false);

  // Cancel confirmation modal
  const [cancelOrderTarget, setCancelOrderTarget] = useState<OrderView | null>(null);
  const [cancellingOrder, setCancellingOrder] = useState(false);

  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<{ tone: 'success' | 'error' | 'info'; message: string } | null>(null);

  const handleApiError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiClientError) {
        if (err.code === 'ACCOUNT_BLOCKED') {
          onBlocked(err.message || URDU_MESSAGES.accountBlocked);
          return;
        }
        if (err.status === 401) {
          onLogout();
          return;
        }
      }
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'An unexpected error occurred.',
      });
    },
    [onBlocked, onLogout]
  );

  const refreshCoreData = useCallback(async () => {
    try {
      const [meRes, prodRes, ordRes, invRes, payRes, notifRes] = await Promise.all([
        customerApi<CustomerMeResponse>('/api/customer/me'),
        customerApi<{ products: ProductCustomerView[] }>('/api/customer/products'),
        customerApi<{ orders: OrderView[] }>('/api/customer/orders'),
        customerApi<{ invoices: InvoiceView[] }>('/api/customer/invoices'),
        customerApi<{ payments: PaymentView[] }>('/api/customer/payments'),
        customerApi<{ notifications: NotificationView[] }>('/api/customer/notifications'),
      ]);
      setCustomer(meRes.customer);
      setRecentOrders(meRes.recentOrders);
      setLatestInvoice(meRes.latestInvoice);
      setUnreadCount(meRes.unreadNotificationCount);
      setProducts(prodRes.products);
      setOrders(ordRes.orders);
      setInvoices(invRes.invoices);
      setPayments(payRes.payments);
      setNotifications(notifRes.notifications);
    } catch (err) {
      handleApiError(err);
    } finally {
      setLoading(false);
    }
  }, [handleApiError]);

  const refreshLedger = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (ledgerSearch.trim()) params.set('search', ledgerSearch.trim());
      if (ledgerType !== 'all') params.set('type', ledgerType);
      if (ledgerFromDate) params.set('fromDate', ledgerFromDate);
      if (ledgerToDate) params.set('toDate', ledgerToDate);
      const qs = params.toString();
      const res = await customerApi<CustomerLedgerResponse>(
        `/api/customer/ledger${qs ? `?${qs}` : ''}`
      );
      setLedgerData(res);
    } catch (err) {
      handleApiError(err);
    }
  }, [handleApiError, ledgerFromDate, ledgerSearch, ledgerToDate, ledgerType]);

  useEffect(() => {
    void refreshCoreData();
  }, [refreshCoreData]);

  useEffect(() => {
    void refreshLedger();
  }, [refreshLedger]);

  const filteredProducts = useMemo(() => {
    if (productCategoryFilter === 'all') return products;
    return products.filter((p) => p.category === productCategoryFilter);
  }, [productCategoryFilter, products]);

  const activeProducts = useMemo(() => products.filter((p) => p.isActive), [products]);

  const cartLines = useMemo(() => {
    return activeProducts
      .map((product) => ({
        product,
        quantity: cartQuantities[product.id] || 0,
      }))
      .filter((line) => line.quantity > 0);
  }, [activeProducts, cartQuantities]);

  const totalCartUnits = useMemo(
    () => cartLines.reduce((sum, l) => sum + l.quantity, 0),
    [cartLines]
  );

  const openNewOrderBuilder = (preselectProductId?: number) => {
    if (preselectProductId) {
      setCartQuantities((prev) => ({
        ...prev,
        [preselectProductId]: Math.max(1, prev[preselectProductId] || 0),
      }));
    }
    setOrderStep('build');
    setOrderIdempotencyKey(`ord_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`);
    setActiveTab('new_order');
  };

  const updateCartQty = (productId: number, nextQty: number) => {
    const clamped = Math.max(0, Math.min(10000, Math.floor(nextQty || 0)));
    setCartQuantities((prev) => {
      const copy = { ...prev };
      if (clamped <= 0) {
        delete copy[productId];
      } else {
        copy[productId] = clamped;
      }
      return copy;
    });
  };

  const handleSubmitOrder = async () => {
    if (cartLines.length === 0) return;
    setSubmittingOrder(true);
    setBanner(null);
    try {
      const key =
        orderIdempotencyKey || `ord_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const res = await customerApi<{ order: OrderView }>('/api/customer/orders', {
        method: 'POST',
        body: {
          items: cartLines.map((l) => ({
            productId: l.product.id,
            quantity: l.quantity,
          })),
          idempotencyKey: key,
        },
      });
      setCartQuantities({});
      setOrderStep('build');
      await refreshCoreData();
      setSelectedOrderDetail(res.order);
      setActiveTab('orders');
      setBanner({
        tone: 'success',
        message: `Order ${res.order.orderNumber} submitted with status "${res.order.status}".`,
      });
    } catch (err) {
      handleApiError(err);
    } finally {
      setSubmittingOrder(false);
    }
  };

  const handleConfirmCancelOrder = async () => {
    if (!cancelOrderTarget) return;
    setCancellingOrder(true);
    try {
      const res = await customerApi<{ order: OrderView }>(
        `/api/customer/orders/${cancelOrderTarget.id}/cancel`,
        { method: 'POST' }
      );
      setCancelOrderTarget(null);
      setSelectedOrderDetail(res.order);
      await refreshCoreData();
      setBanner({
        tone: 'info',
        message: `Order ${res.order.orderNumber} has been cancelled and retained in your order history.`,
      });
    } catch (err) {
      handleApiError(err);
    } finally {
      setCancellingOrder(false);
    }
  };

  const handleOpenNotification = async (notif: NotificationView) => {
    try {
      if (!notif.isRead) {
        await customerApi(`/api/customer/notifications/${notif.id}/read`, { method: 'POST' });
        setNotifications((prev) =>
          prev.map((n) => (n.id === notif.id ? { ...n, isRead: true, appDeliveryStatus: 'read' } : n))
        );
        setUnreadCount((c) => Math.max(0, c - 1));
      }

      if (notif.targetType === 'invoice' && notif.targetId) {
        const found = invoices.find((i) => i.id === notif.targetId);
        if (found) {
          setPreviewInvoice(found);
          return;
        }
        const invRes = await customerApi<{ invoice: InvoiceView }>(
          `/api/customer/invoices/${notif.targetId}`
        );
        setPreviewInvoice(invRes.invoice);
        return;
      }

      if (notif.targetType === 'order' && notif.targetId) {
        const found = orders.find((o) => o.id === notif.targetId);
        if (found) {
          setSelectedOrderDetail(found);
          setActiveTab('orders');
          return;
        }
        const ordRes = await customerApi<{ order: OrderView }>(
          `/api/customer/orders/${notif.targetId}`
        );
        setSelectedOrderDetail(ordRes.order);
        setActiveTab('orders');
        return;
      }

      if (notif.targetType === 'payment' && notif.targetId) {
        const found = payments.find((p) => p.id === notif.targetId);
        if (found) {
          setSelectedPaymentDetail(found);
          setActiveTab('account');
          setAccountSubTab('payments');
          return;
        }
        const payRes = await customerApi<{ payment: PaymentView }>(
          `/api/customer/payments/${notif.targetId}`
        );
        setSelectedPaymentDetail(payRes.payment);
        setActiveTab('account');
        setAccountSubTab('payments');
        return;
      }
    } catch (err) {
      handleApiError(err);
    }
  };

  const handleSignOut = async () => {
    try {
      await customerApi('/api/customer/auth/logout', { method: 'POST' });
    } catch {
      // Ignore logout network issue
    }
    onLogout();
  };

  return (
    <div className="min-h-screen bg-slate-50 pb-20 md:pb-10">
      {/* Top Bar — 3-Zone Contract on Desktop + Compact 56px Sticky Header on Mobile (<15% Sticky Cap) */}
      <header className="no-print sticky top-0 z-30 h-14 bg-white/95 backdrop-blur-md border-b border-slate-200 px-4 sm:px-6 flex items-center justify-between gap-8">
        {/* Zone 1: Brand Title (single line) */}
        <button
          type="button"
          onClick={() => setActiveTab('home')}
          className="text-base sm:text-lg font-extrabold tracking-tight text-slate-950 whitespace-nowrap shrink-0 text-left"
        >
          {BRAND_NAMES.invoiceHeading}
        </button>

        {/* Zone 2: 4 Single-line Navigation Links (Desktop) */}
        <nav aria-label="Customer Navigation" className="hidden md:flex items-center gap-6 text-sm font-medium">
          {(
            [
              ['home', 'Home'],
              ['products', 'Products'],
              ['orders', 'Orders'],
              ['account', 'Account'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              className={`py-1 transition-colors whitespace-nowrap shrink-0 ${
                activeTab === id
                  ? 'text-slate-950 font-bold underline decoration-amber-400 decoration-2 underline-offset-8'
                  : 'text-slate-600 hover:text-slate-950'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        {/* Zone 3: Contextual Primary Action + Notification Bell */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
            onClick={() => {
              setActiveTab('account');
              setAccountSubTab('notifications');
            }}
            className="min-h-[44px] min-w-[44px] relative inline-flex items-center justify-center rounded-xl text-slate-700 hover:bg-slate-100 transition-colors"
          >
            <Bell className="h-5 w-5" aria-hidden="true" />
            {unreadCount > 0 && (
              <span className="absolute top-1.5 right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-amber-400 text-[10px] font-extrabold font-mono tabular-nums text-slate-950 flex items-center justify-center">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => openNewOrderBuilder()}
            className="hidden sm:inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-amber-400 px-4 py-2 text-xs font-extrabold text-slate-950 hover:bg-amber-300 transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            NEW ORDER
          </button>
        </div>
      </header>

      <main className="no-print mx-auto max-w-6xl px-4 sm:px-6 pt-5 space-y-6">
        {banner && (
          <InlineAlert
            tone={banner.tone}
            message={banner.message}
            onDismiss={() => setBanner(null)}
          />
        )}

        {/* ================================================================
            1. CUSTOMER HOME SCREEN (Section 16)
           ================================================================ */}
        {activeTab === 'home' && (
          <div className="space-y-6">
            {/* Customer Identity, Logo, Current Outstanding Balance & Prominent NEW ORDER CTA */}
            <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-7">
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
                <div className="flex items-start sm:items-center gap-4">
                  <BrbLogo logoDataUrl={bootstrap.logoDataUrl} size="md" />
                  <div>
                    <p className="text-xs font-medium text-slate-500">
                      {BRAND_NAMES.mainBusinessHeading}
                    </p>
                    <h1 className="text-xl sm:text-2xl font-extrabold text-slate-950">
                      {customer.name}
                    </h1>
                    <p className="mt-0.5 text-xs text-slate-600">
                      Account Number:{' '}
                      <span className="font-mono font-bold tabular-nums text-slate-900">
                        {customer.accountNumber}
                      </span>
                      {customer.businessName ? ` · ${customer.businessName}` : ''}
                    </p>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row sm:items-center gap-4 lg:gap-6 pt-4 lg:pt-0 border-t lg:border-t-0 border-slate-100">
                  <div>
                    <p className="text-xs font-medium text-slate-500">Current Outstanding Balance</p>
                    <p className="text-2xl sm:text-3xl font-extrabold font-mono tabular-nums text-slate-950">
                      {customer.outstandingBalanceFormatted}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => openNewOrderBuilder()}
                    className="min-h-[48px] inline-flex items-center justify-center gap-2 rounded-xl bg-amber-400 px-6 py-3 text-sm font-extrabold text-slate-950 hover:bg-amber-300 transition-colors whitespace-nowrap shrink-0"
                  >
                    <ShoppingBag className="h-4 w-4" aria-hidden="true" />
                    NEW ORDER
                  </button>
                </div>
              </div>

              {/* Quick Section Shortcuts */}
              <div className="mt-6 pt-5 border-t border-slate-100 grid grid-cols-2 sm:grid-cols-4 gap-3">
                <button
                  type="button"
                  onClick={() => setActiveTab('products')}
                  className="min-h-[48px] flex items-center justify-between rounded-xl border border-slate-200 px-3.5 py-2.5 text-left text-xs font-semibold text-slate-800 hover:bg-slate-50 transition-colors"
                >
                  <span>Product List ({products.length})</span>
                  <ChevronRight className="h-4 w-4 text-slate-400 shrink-0" />
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('orders')}
                  className="min-h-[48px] flex items-center justify-between rounded-xl border border-slate-200 px-3.5 py-2.5 text-left text-xs font-semibold text-slate-800 hover:bg-slate-50 transition-colors"
                >
                  <span>Recent Orders ({orders.length})</span>
                  <ChevronRight className="h-4 w-4 text-slate-400 shrink-0" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab('account');
                    setAccountSubTab('ledger');
                  }}
                  className="min-h-[48px] flex items-center justify-between rounded-xl border border-slate-200 px-3.5 py-2.5 text-left text-xs font-semibold text-slate-800 hover:bg-slate-50 transition-colors"
                >
                  <span>My Account / Ledger</span>
                  <ChevronRight className="h-4 w-4 text-slate-400 shrink-0" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab('account');
                    setAccountSubTab('notifications');
                  }}
                  className="min-h-[48px] flex items-center justify-between rounded-xl border border-slate-200 px-3.5 py-2.5 text-left text-xs font-semibold text-slate-800 hover:bg-slate-50 transition-colors"
                >
                  <span>Notifications ({unreadCount} new)</span>
                  <ChevronRight className="h-4 w-4 text-slate-400 shrink-0" />
                </button>
              </div>
            </section>

            {/* Two-Column Operational Grid on Desktop */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Left 7 Cols: Product List Showcase (Strictly Zero Prices) */}
              <section className="lg:col-span-7 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
                <div className="flex items-center justify-between gap-4 mb-4">
                  <div>
                    <h2 className="text-base font-bold text-slate-950">BRB Product Catalog</h2>
                    <p className="text-xs text-slate-500">
                      BRB Cattle Feed &amp; BRB Oil Mill · Select products to start an order
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveTab('products')}
                    className="text-xs font-semibold text-slate-700 hover:text-slate-950 underline underline-offset-4 whitespace-nowrap shrink-0"
                  >
                    View All Products
                  </button>
                </div>

                {loading ? (
                  <p className="text-sm text-slate-500 py-6">Loading BRB catalog...</p>
                ) : products.length === 0 ? (
                  <EmptyStateBox
                    title="No Products Listed Yet"
                    description="Products added by BRB Administration will appear here."
                  />
                ) : (
                  <div className="divide-y divide-slate-100">
                    {products.slice(0, 5).map((prod) => (
                      <div
                        key={prod.id}
                        className="py-3.5 first:pt-0 last:pb-0 flex items-center justify-between gap-4"
                      >
                        <div className="flex items-center gap-3.5 min-w-0">
                          <ProductVisual
                            imageUrl={prod.imageUrl}
                            name={prod.name}
                            category={prod.category}
                            isActive={prod.isActive}
                            className="h-14 w-14 rounded-xl shrink-0"
                          />
                          <div className="min-w-0">
                            <p className="text-sm font-bold text-slate-900 truncate">{prod.name}</p>
                            <p className="text-xs text-slate-500 mt-0.5">
                              {prod.category} · {prod.packingWeight} · Usage: {prod.usage}
                            </p>
                            {!prod.isActive && (
                              <p className="text-xs font-semibold text-rose-700 mt-0.5">
                                Currently Unavailable
                              </p>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => setSelectedProductDetail(prod)}
                            className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                          >
                            Details
                          </button>
                          {prod.isActive ? (
                            <button
                              type="button"
                              onClick={() => openNewOrderBuilder(prod.id)}
                              className="min-h-[40px] px-3.5 py-1.5 rounded-lg bg-slate-900 text-xs font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                            >
                              Order
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled
                              className="min-h-[40px] px-3 py-1.5 rounded-lg bg-slate-100 text-xs font-medium text-slate-400 cursor-not-allowed whitespace-nowrap shrink-0"
                            >
                              Unavailable
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Right 5 Cols: Latest Invoice & Recent Orders */}
              <div className="lg:col-span-5 space-y-6">
                {/* Latest Invoice */}
                <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <h2 className="text-base font-bold text-slate-950">Latest Invoice</h2>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveTab('account');
                        setAccountSubTab('invoices');
                      }}
                      className="text-xs font-semibold text-slate-700 hover:text-slate-950 underline underline-offset-4 whitespace-nowrap shrink-0"
                    >
                      Invoice History
                    </button>
                  </div>

                  {latestInvoice ? (
                    <div>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="font-mono font-bold tabular-nums text-base text-slate-900">
                          Invoice #{latestInvoice.invoiceNumber}
                        </span>
                        <span className="font-mono font-extrabold tabular-nums text-lg text-slate-950">
                          {latestInvoice.grandTotalFormatted}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
                        Date: {latestInvoice.invoiceDate} · {latestInvoice.items.length} item(s)
                      </p>
                      <div className="mt-4 flex items-center gap-2.5">
                        <button
                          type="button"
                          onClick={() => setPreviewInvoice(latestInvoice)}
                          className="min-h-[42px] flex-1 rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                        >
                          View Invoice
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void downloadAuthenticatedPdf({
                              portal: 'customer',
                              invoiceId: latestInvoice.id,
                              invoiceNumber: latestInvoice.invoiceNumber,
                            }).catch(handleApiError)
                          }
                          className="min-h-[42px] inline-flex items-center justify-center gap-1.5 rounded-xl bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                        >
                          <Download className="h-3.5 w-3.5" aria-hidden="true" />
                          PDF
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500 py-3">
                      No invoices have been posted to your account yet.
                    </p>
                  )}
                </section>

                {/* Recent Orders */}
                <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <h2 className="text-base font-bold text-slate-950">Recent Orders</h2>
                    <button
                      type="button"
                      onClick={() => setActiveTab('orders')}
                      className="text-xs font-semibold text-slate-700 hover:text-slate-950 underline underline-offset-4 whitespace-nowrap shrink-0"
                    >
                      All Orders
                    </button>
                  </div>

                  {recentOrders.length === 0 ? (
                    <p className="text-xs text-slate-500 py-3">
                      You have not submitted any orders yet. Tap NEW ORDER above to begin.
                    </p>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {recentOrders.map((ord) => (
                        <button
                          key={ord.id}
                          type="button"
                          onClick={() => {
                            setSelectedOrderDetail(ord);
                            setActiveTab('orders');
                          }}
                          className="w-full py-3 first:pt-0 last:pb-0 flex items-center justify-between gap-3 text-left hover:bg-slate-50/70 rounded-lg transition-colors"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-bold font-mono tabular-nums text-slate-900">
                              {ord.orderNumber}
                            </p>
                            <p className="text-xs text-slate-500 mt-0.5">
                              {ord.requestedItems.length} product(s) ·{' '}
                              <span className={getOrderStatusToneClass(ord.status)}>{ord.status}</span>
                            </p>
                          </div>
                          <ChevronRight className="h-4 w-4 text-slate-400 shrink-0" />
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            </div>
          </div>
        )}

        {/* ================================================================
            2. PRODUCTS CATALOG TAB (Sections 17 & 18 — ZERO PRICES)
           ================================================================ */}
        {activeTab === 'products' && (
          <div className="space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h1 className="text-xl sm:text-2xl font-extrabold text-slate-950">
                  BRB Product Catalog
                </h1>
                <p className="text-xs sm:text-sm text-slate-600 mt-0.5">
                  Browse Cattle Feed and Oil Mill products. Select active products to place a new order.
                </p>
              </div>

              <button
                type="button"
                onClick={() => openNewOrderBuilder()}
                className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-amber-400 px-5 py-2.5 text-xs font-extrabold text-slate-950 hover:bg-amber-300 transition-colors whitespace-nowrap shrink-0"
              >
                <ShoppingBag className="h-4 w-4" aria-hidden="true" />
                NEW ORDER {totalCartUnits > 0 ? `(${totalCartUnits})` : ''}
              </button>
            </div>

            {/* Interactive Category Filter Buttons */}
            <div className="inline-flex flex-wrap items-center gap-1 p-1 rounded-xl bg-slate-200/70">
              {(['all', ...PRODUCT_CATEGORIES] as const).map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setProductCategoryFilter(cat)}
                  className={`min-h-[40px] px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                    productCategoryFilter === cat
                      ? 'bg-white text-slate-950 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {cat === 'all' ? 'All Products' : cat}
                </button>
              ))}
            </div>

            {filteredProducts.length === 0 ? (
              <EmptyStateBox
                title="No Products in This Category"
                description="Switch category tabs or check back once BRB updates the catalog."
              />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {filteredProducts.map((prod) => (
                  <article
                    key={prod.id}
                    className="rounded-2xl border border-slate-200 bg-white overflow-hidden flex flex-col justify-between"
                  >
                    <div>
                      <ProductVisual
                        imageUrl={prod.imageUrl}
                        name={prod.name}
                        category={prod.category}
                        isActive={prod.isActive}
                        className="h-44 w-full border-b border-slate-100"
                      />
                      <div className="p-5">
                        {/* Unboxed metadata kicker (Zero-Pill rule) */}
                        <p className="text-xs text-slate-500">
                          {prod.category} · {prod.packingWeight} · Usage: {prod.usage}
                        </p>
                        <h2 className="mt-1 text-base font-bold text-slate-950">{prod.name}</h2>
                        <p className="mt-1.5 text-xs text-slate-600 leading-relaxed line-clamp-2">
                          {prod.shortDescription}
                        </p>
                        {!prod.isActive && (
                          <p className="mt-2 text-xs font-bold text-rose-700">
                            Currently Unavailable
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="px-5 pb-5 pt-2 flex items-center gap-2.5">
                      <button
                        type="button"
                        onClick={() => setSelectedProductDetail(prod)}
                        className="min-h-[44px] flex-1 rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                      >
                        View Details
                      </button>
                      {prod.isActive ? (
                        <button
                          type="button"
                          onClick={() => openNewOrderBuilder(prod.id)}
                          className="min-h-[44px] flex-1 rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                        >
                          Add to Order
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled
                          className="min-h-[44px] flex-1 rounded-xl bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-400 cursor-not-allowed whitespace-nowrap shrink-0"
                        >
                          Currently Unavailable
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ================================================================
            3. NEW ORDER BUILDER & MANDATORY REVIEW STEP (Section 21)
           ================================================================ */}
        {activeTab === 'new_order' && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h1 className="text-xl sm:text-2xl font-extrabold text-slate-950">
                  {orderStep === 'build' ? 'Create New Order' : 'Review Your Order Before Submission'}
                </h1>
                <p className="text-xs sm:text-sm text-slate-600 mt-0.5">
                  {orderStep === 'build'
                    ? 'Select quantities across BRB Cattle Feed and BRB Oil Mill products.'
                    : 'Confirm your selected products and bag/unit quantities before submitting to BRB.'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveTab('home')}
                className="min-h-[42px] px-3.5 py-2 rounded-xl border border-slate-300 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
              >
                Cancel
              </button>
            </div>

            {orderStep === 'build' ? (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                <div className="lg:col-span-8 space-y-6">
                  {PRODUCT_CATEGORIES.map((category) => {
                    const catProducts = products.filter((p) => p.category === category);
                    return (
                      <section
                        key={category}
                        className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6"
                      >
                        <h2 className="text-base font-bold text-slate-950">{category}</h2>
                        {catProducts.length === 0 ? (
                          <p className="mt-2 text-xs text-slate-500">
                            No products registered in {category}.
                          </p>
                        ) : (
                          <div className="mt-3 divide-y divide-slate-100">
                            {catProducts.map((prod) => {
                              const qty = cartQuantities[prod.id] || 0;
                              return (
                                <div
                                  key={prod.id}
                                  className="py-3.5 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                                >
                                  <div className="min-w-0">
                                    <p className="text-sm font-bold text-slate-900">{prod.name}</p>
                                    <p className="text-xs text-slate-500 mt-0.5">
                                      {prod.packingWeight} · Usage: {prod.usage}
                                    </p>
                                    {!prod.isActive && (
                                      <p className="text-xs font-semibold text-rose-700 mt-0.5">
                                        Currently Unavailable — cannot be ordered
                                      </p>
                                    )}
                                  </div>

                                  {prod.isActive ? (
                                    <div className="flex items-center gap-2 shrink-0">
                                      <button
                                        type="button"
                                        aria-label={`Decrease ${prod.name} quantity`}
                                        onClick={() => updateCartQty(prod.id, qty - 1)}
                                        className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-800 hover:bg-slate-50"
                                      >
                                        <Minus className="h-4 w-4" />
                                      </button>
                                      <input
                                        type="number"
                                        min={0}
                                        max={10000}
                                        aria-label={`${prod.name} quantity`}
                                        value={qty === 0 ? '' : qty}
                                        placeholder="0"
                                        onChange={(e) =>
                                          updateCartQty(prod.id, Number(e.target.value || 0))
                                        }
                                        className="w-20 min-h-[44px] rounded-xl border border-slate-300 px-2.5 text-center font-mono font-bold tabular-nums text-sm text-slate-950 focus:border-slate-900 focus:outline-none"
                                      />
                                      <button
                                        type="button"
                                        aria-label={`Increase ${prod.name} quantity`}
                                        onClick={() => updateCartQty(prod.id, qty + 1)}
                                        className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-800 hover:bg-slate-50"
                                      >
                                        <Plus className="h-4 w-4" />
                                      </button>
                                    </div>
                                  ) : (
                                    <span className="text-xs font-semibold text-slate-400 shrink-0">
                                      Currently Unavailable
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>

                {/* Live Selection Summary */}
                <aside className="lg:col-span-4 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
                  <h2 className="text-base font-bold text-slate-950">Selected Order Items</h2>
                  {cartLines.length === 0 ? (
                    <p className="mt-3 text-xs text-slate-500 leading-relaxed">
                      Add bag or unit quantities for one or more active products to review and submit
                      your order.
                    </p>
                  ) : (
                    <div className="mt-4 divide-y divide-slate-100">
                      {cartLines.map(({ product, quantity }) => (
                        <div key={product.id} className="py-2.5 flex items-baseline justify-between gap-3 text-sm">
                          <div className="min-w-0">
                            <p className="font-semibold text-slate-900 truncate">{product.name}</p>
                            <p className="text-xs text-slate-500">{product.packingWeight}</p>
                          </div>
                          <span className="font-mono font-bold tabular-nums text-slate-950 shrink-0">
                            {quantity}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="mt-5 pt-4 border-t border-slate-200">
                    <div className="flex items-center justify-between text-xs text-slate-600 mb-4">
                      <span>Total Selected Products: {cartLines.length}</span>
                      <span className="font-mono font-bold tabular-nums text-slate-900">
                        Total Qty: {totalCartUnits}
                      </span>
                    </div>
                    <button
                      type="button"
                      disabled={cartLines.length === 0}
                      onClick={() => setOrderStep('review')}
                      className="w-full min-h-[48px] rounded-xl bg-amber-400 px-4 py-3 text-sm font-extrabold text-slate-950 hover:bg-amber-300 transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
                    >
                      Review Order →
                    </button>
                  </div>
                </aside>
              </div>
            ) : (
              /* Mandatory Order Review Step Before Final Submission */
              <section className="max-w-2xl mx-auto rounded-2xl border border-slate-200 bg-white p-6 sm:p-8">
                <p className="text-xs font-medium text-slate-500">
                  Account {customer.accountNumber} · {customer.name}
                </p>
                <h2 className="mt-1 text-lg font-bold text-slate-950">Order Summary</h2>

                <div className="mt-4 divide-y divide-slate-200 border-t border-b border-slate-200">
                  {cartLines.map(({ product, quantity }) => (
                    <div key={product.id} className="py-3.5 flex items-center justify-between gap-4">
                      <div>
                        <p className="text-sm font-bold text-slate-900">{product.name}</p>
                        <p className="text-xs text-slate-500">
                          {product.category} · {product.packingWeight}
                        </p>
                      </div>
                      <p className="text-base font-extrabold font-mono tabular-nums text-slate-950 shrink-0">
                        {quantity} Bags / Units
                      </p>
                    </div>
                  ))}
                </div>

                <p className="mt-4 text-xs text-slate-500 leading-relaxed">
                  Once submitted, your order receives status{' '}
                  <strong className="text-slate-800">Order Received</strong> and is queued for BRB
                  review and quantity confirmation.
                </p>

                <div className="mt-6 flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-3">
                  <button
                    type="button"
                    disabled={submittingOrder}
                    onClick={() => setOrderStep('build')}
                    className="min-h-[46px] px-5 py-2.5 rounded-xl border border-slate-300 bg-white text-sm font-semibold text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                  >
                    ← Edit Quantities
                  </button>
                  <button
                    type="button"
                    disabled={submittingOrder || cartLines.length === 0}
                    onClick={handleSubmitOrder}
                    className="min-h-[48px] px-6 py-3 rounded-xl bg-amber-400 text-sm font-extrabold text-slate-950 hover:bg-amber-300 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                  >
                    {submittingOrder ? 'Submitting Order...' : 'SUBMIT ORDER'}
                  </button>
                </div>
              </section>
            )}
          </div>
        )}

        {/* ================================================================
            4. ORDERS HISTORY, COMPARISON & CANCELLATION (Sections 22–26)
           ================================================================ */}
        {activeTab === 'orders' && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h1 className="text-xl sm:text-2xl font-extrabold text-slate-950">My Orders</h1>
                <p className="text-xs sm:text-sm text-slate-600 mt-0.5">
                  Track status updates and compare original requested quantities with BRB approved quantities.
                </p>
              </div>
              <button
                type="button"
                onClick={() => openNewOrderBuilder()}
                className="min-h-[44px] inline-flex items-center gap-2 rounded-xl bg-amber-400 px-5 py-2.5 text-xs font-extrabold text-slate-950 hover:bg-amber-300 transition-colors whitespace-nowrap shrink-0"
              >
                <Plus className="h-4 w-4" />
                NEW ORDER
              </button>
            </div>

            {orders.length === 0 ? (
              <EmptyStateBox
                title="No Orders Submitted Yet"
                description="Place your first Cattle Feed or Oil Mill order using the NEW ORDER button."
                actionLabel="Start New Order"
                onAction={() => openNewOrderBuilder()}
              />
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                {/* Orders List */}
                <div className="lg:col-span-5 rounded-2xl border border-slate-200 bg-white divide-y divide-slate-100 overflow-hidden">
                  {orders.map((ord) => {
                    const isSelected = selectedOrderDetail?.id === ord.id;
                    return (
                      <button
                        key={ord.id}
                        type="button"
                        onClick={() => setSelectedOrderDetail(ord)}
                        className={`w-full p-4 sm:p-5 text-left transition-colors flex items-center justify-between gap-3 ${
                          isSelected ? 'bg-amber-50/70' : 'hover:bg-slate-50'
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="font-mono font-bold tabular-nums text-sm text-slate-950">
                            {ord.orderNumber}
                          </p>
                          <p className="mt-0.5 text-xs text-slate-500 font-mono tabular-nums">
                            {ord.createdAt.slice(0, 10)} · {ord.requestedItems.length} requested item(s)
                          </p>
                          <p className={`mt-1 text-xs ${getOrderStatusToneClass(ord.status)}`}>
                            {ord.status}
                          </p>
                        </div>
                        <ChevronRight className="h-4 w-4 text-slate-400 shrink-0" />
                      </button>
                    );
                  })}
                </div>

                {/* Order Detail & Comparison Panel */}
                <div className="lg:col-span-7">
                  {(() => {
                    const ord = selectedOrderDetail || orders[0];
                    if (!ord) return null;
                    const canCancel = CUSTOMER_CANCELLABLE_STATUSES.includes(ord.status);

                    return (
                      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-7 space-y-6">
                        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
                          <div>
                            <p className="text-xs text-slate-500 font-mono tabular-nums">
                              Submitted {ord.createdAt.slice(0, 16).replace('T', ' ')}
                            </p>
                            <h2 className="text-xl font-extrabold font-mono tabular-nums text-slate-950">
                              {ord.orderNumber}
                            </h2>
                            <p className={`mt-1 text-sm ${getOrderStatusToneClass(ord.status)}`}>
                              Status: {ord.status}
                            </p>
                          </div>

                          <div className="flex flex-wrap items-center gap-2.5">
                            {ord.linkedInvoiceId && (
                              <button
                                type="button"
                                onClick={() => {
                                  const inv = invoices.find((i) => i.id === ord.linkedInvoiceId);
                                  if (inv) setPreviewInvoice(inv);
                                }}
                                className="min-h-[42px] inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                              >
                                <FileText className="h-3.5 w-3.5" />
                                View Invoice #{ord.linkedInvoiceNumber}
                              </button>
                            )}

                            {canCancel && (
                              <button
                                type="button"
                                onClick={() => setCancelOrderTarget(ord)}
                                className="min-h-[42px] rounded-xl border border-rose-300 bg-rose-50 px-4 py-2 text-xs font-semibold text-rose-800 hover:bg-rose-100 transition-colors whitespace-nowrap shrink-0"
                              >
                                Cancel Order
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Original Customer Request (Immutable) */}
                        <div>
                          <h3 className="text-sm font-bold text-slate-950">
                            Original Requested Quantities
                          </h3>
                          <div className="mt-2.5 divide-y divide-slate-100 border-t border-b border-slate-100">
                            {ord.requestedItems.map((ri) => (
                              <div
                                key={ri.id}
                                className="py-2.5 flex items-center justify-between gap-4 text-sm"
                              >
                                <div>
                                  <p className="font-semibold text-slate-900">
                                    {ri.productNameSnapshot}
                                  </p>
                                  <p className="text-xs text-slate-500">
                                    {ri.categorySnapshot} · {ri.packingSnapshot}
                                  </p>
                                </div>
                                <span className="font-mono font-bold tabular-nums text-slate-900 shrink-0">
                                  Requested: {ri.requestedQty}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Approved Items Comparison (Includes Reduction Reasons & "Added by BRB") */}
                        <div>
                          <h3 className="text-sm font-bold text-slate-950">
                            BRB Approved Quantities &amp; Comparison
                          </h3>
                          {ord.approvedItems.length === 0 ? (
                            <p className="mt-2 text-xs text-slate-500">
                              {ord.status === 'Cancelled'
                                ? 'This order was cancelled prior to approval.'
                                : 'Awaiting BRB order review and quantity confirmation.'}
                            </p>
                          ) : (
                            <div className="mt-2.5 divide-y divide-slate-200 border-t border-b border-slate-200">
                              {ord.approvedItems.map((ai) => {
                                const statusLabel = describeApprovedItemStatus(
                                  ai.requestedQty,
                                  ai.approvedQty,
                                  ai.isAddedByBrb
                                );
                                const isReduced =
                                  !ai.isAddedByBrb &&
                                  ai.requestedQty != null &&
                                  ai.approvedQty < ai.requestedQty;
                                const hasUrduReason = Boolean(
                                  ai.reductionReason && /[\u0600-\u06FF]/.test(ai.reductionReason)
                                );

                                return (
                                  <div key={ai.id} className="py-3.5 space-y-1.5">
                                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                                      <div>
                                        <p className="text-sm font-bold text-slate-900">
                                          {ai.productNameSnapshot}
                                        </p>
                                        <p className="text-xs text-slate-500">
                                          {ai.categorySnapshot} · {ai.packingSnapshot}
                                        </p>
                                      </div>

                                      <div className="text-right font-mono tabular-nums text-xs">
                                        {ai.isAddedByBrb ? (
                                          <span className="font-bold text-indigo-700">
                                            Added by BRB · Qty {ai.approvedQty}
                                          </span>
                                        ) : (
                                          <span className="text-slate-700">
                                            Requested {ai.requestedQty} →{' '}
                                            <strong className="text-slate-950">
                                              Approved {ai.approvedQty}
                                            </strong>{' '}
                                            ·{' '}
                                            <span
                                              className={
                                                isReduced
                                                  ? 'text-amber-800 font-semibold'
                                                  : 'text-emerald-700 font-semibold'
                                              }
                                            >
                                              {statusLabel}
                                            </span>
                                          </span>
                                        )}
                                      </div>
                                    </div>

                                    {ai.reductionReason && (
                                      <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-950">
                                        <span className="font-semibold">Reason: </span>
                                        <span
                                          dir={hasUrduReason ? 'rtl' : undefined}
                                          className={hasUrduReason ? 'font-urdu text-sm' : ''}
                                        >
                                          {ai.reductionReason}
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        {/* Status Timeline */}
                        <div>
                          <h3 className="text-xs font-bold text-slate-700">Status History</h3>
                          <div className="mt-2 space-y-1.5 text-xs text-slate-600">
                            {ord.statusHistory.map((h) => (
                              <div
                                key={h.id}
                                className="flex flex-wrap items-baseline justify-between gap-2"
                              >
                                <span>
                                  <strong className="text-slate-800">{h.toStatus}</strong>
                                  {h.note ? ` · ${h.note}` : ''}
                                </span>
                                <span className="font-mono tabular-nums text-slate-400">
                                  {h.createdAt.slice(0, 16).replace('T', ' ')}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </section>
                    );
                  })()}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ================================================================
            5. CUSTOMER ACCOUNT PAGE (Sections 34, 35, 36 & 39)
               Account History / Ledger (12-Month) · Invoice History ·
               Payment History · Orders · Notifications
           ================================================================ */}
        {activeTab === 'account' && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h1 className="text-xl sm:text-2xl font-extrabold text-slate-950">My Account</h1>
                <p className="text-xs sm:text-sm text-slate-600 mt-0.5">
                  {customer.name} ·{' '}
                  <span className="font-mono font-semibold text-slate-900">
                    {customer.accountNumber}
                  </span>{' '}
                  · Current Balance:{' '}
                  <span className="font-mono font-bold text-slate-950">
                    {customer.outstandingBalanceFormatted}
                  </span>
                </p>
              </div>

              <button
                type="button"
                onClick={handleSignOut}
                className="min-h-[42px] inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0"
              >
                <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                Logout
              </button>
            </div>

            {/* Sub-Navigation Segmented Tabs */}
            <div className="flex overflow-x-auto gap-1 p-1 rounded-xl bg-slate-200/70">
              {(
                [
                  ['ledger', 'Account History / Ledger'],
                  ['invoices', `Invoice History (${invoices.length})`],
                  ['payments', `Payment History (${payments.length})`],
                  ['orders', `Orders (${orders.length})`],
                  ['notifications', `Notifications (${unreadCount} unread)`],
                ] as const
              ).map(([sub, label]) => (
                <button
                  key={sub}
                  type="button"
                  onClick={() => setAccountSubTab(sub)}
                  className={`min-h-[40px] px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                    accountSubTab === sub
                      ? 'bg-white text-slate-950 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* 5A. 12-Month Customer Ledger */}
            {accountSubTab === 'ledger' && (
              <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 space-y-5">
                <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-slate-100 pb-4">
                  <div>
                    <h2 className="text-base font-bold text-slate-950">
                      12-Month Account Ledger Statement
                    </h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Showing transactions from{' '}
                      <span className="font-mono tabular-nums font-semibold text-slate-700">
                        {ledgerData?.cutoffDate || '—'}
                      </span>{' '}
                      to present · Pre-window balance brought forward:{' '}
                      <span className="font-mono tabular-nums font-semibold text-slate-800">
                        {ledgerData?.broughtForwardFormatted || 'Rs. 0'}
                      </span>
                    </p>
                  </div>
                  <div className="sm:text-right">
                    <p className="text-xs text-slate-500">Current Outstanding Balance</p>
                    <p className="text-xl font-extrabold font-mono tabular-nums text-slate-950">
                      {ledgerData?.outstandingBalanceFormatted || customer.outstandingBalanceFormatted}
                    </p>
                  </div>
                </div>

                {/* Search, Type & Date Range Filters */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  <div className="relative">
                    <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="search"
                      aria-label="Search ledger entries"
                      placeholder="Invoice #, ref, method..."
                      value={ledgerSearch}
                      onChange={(e) => setLedgerSearch(e.target.value)}
                      className="w-full min-h-[42px] rounded-xl border border-slate-300 pl-9 pr-3 py-2 text-xs text-slate-900 focus:border-slate-900 focus:outline-none"
                    />
                  </div>
                  <select
                    aria-label="Filter ledger by entry type"
                    value={ledgerType}
                    onChange={(e) => setLedgerType(e.target.value as 'all' | 'invoice' | 'payment')}
                    className="min-h-[42px] rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-900 focus:border-slate-900 focus:outline-none"
                  >
                    <option value="all">All Entries (Invoices &amp; Payments)</option>
                    <option value="invoice">Invoices Only (Debits)</option>
                    <option value="payment">Payments Only (Credits)</option>
                  </select>
                  <input
                    type="date"
                    aria-label="Ledger from date"
                    value={ledgerFromDate}
                    min={ledgerData?.cutoffDate}
                    onChange={(e) => setLedgerFromDate(e.target.value)}
                    className="min-h-[42px] rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-mono tabular-nums text-slate-900 focus:border-slate-900 focus:outline-none"
                  />
                  <input
                    type="date"
                    aria-label="Ledger to date"
                    value={ledgerToDate}
                    onChange={(e) => setLedgerToDate(e.target.value)}
                    className="min-h-[42px] rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-mono tabular-nums text-slate-900 focus:border-slate-900 focus:outline-none"
                  />
                </div>

                {!ledgerData || ledgerData.entries.length === 0 ? (
                  <EmptyStateBox
                    title="No Ledger Entries in Selected Range"
                    description="Invoices and payments recorded within the latest 12 months appear here with running balances."
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-left text-xs sm:text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 text-xs font-semibold text-slate-600">
                          <th className="py-2.5 pr-3">Date</th>
                          <th className="py-2.5 px-3">Description / Reference</th>
                          <th className="py-2.5 px-3 text-right">Debit (Invoice)</th>
                          <th className="py-2.5 px-3 text-right">Credit (Payment)</th>
                          <th className="py-2.5 pl-3 text-right">Running Balance</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {ledgerData.entries.map((entry) => (
                          <tr key={entry.id} className="hover:bg-slate-50/80">
                            <td className="py-3 pr-3 font-mono tabular-nums text-xs text-slate-600 whitespace-nowrap">
                              {entry.entryDate}
                            </td>
                            <td className="py-3 px-3">
                              {entry.invoiceId ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    const inv = invoices.find((i) => i.id === entry.invoiceId);
                                    if (inv) setPreviewInvoice(inv);
                                  }}
                                  className="font-semibold text-slate-900 hover:underline text-left"
                                >
                                  {entry.description}
                                </button>
                              ) : (
                                <span className="font-medium text-slate-900">{entry.description}</span>
                              )}
                            </td>
                            <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-900 whitespace-nowrap">
                              {entry.debitFormatted}
                            </td>
                            <td className="py-3 px-3 text-right font-mono tabular-nums text-emerald-700 font-medium whitespace-nowrap">
                              {entry.creditFormatted}
                            </td>
                            <td className="py-3 pl-3 text-right font-mono tabular-nums font-bold text-slate-950 whitespace-nowrap">
                              {entry.runningBalanceFormatted}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}

            {/* 5B. Invoice History */}
            {accountSubTab === 'invoices' && (
              <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
                <h2 className="text-base font-bold text-slate-950 mb-4">Invoice History</h2>
                {invoices.length === 0 ? (
                  <EmptyStateBox
                    title="No Invoices Issued Yet"
                    description="Official BRB invoices linked to your account will appear here for viewing and PDF download."
                  />
                ) : (
                  <div className="divide-y divide-slate-100">
                    {invoices.map((inv) => (
                      <div
                        key={inv.id}
                        className="py-3.5 first:pt-0 last:pb-0 flex flex-wrap items-center justify-between gap-4"
                      >
                        <div>
                          <p className="text-sm font-bold font-mono tabular-nums text-slate-950">
                            Invoice #{inv.invoiceNumber}
                          </p>
                          <p className="text-xs text-slate-500 font-mono tabular-nums mt-0.5">
                            Date: {inv.invoiceDate}
                            {inv.sourceOrderNumber ? ` · Order ${inv.sourceOrderNumber}` : ''}
                            {` · ${inv.items.length} item(s)`}
                          </p>
                        </div>

                        <div className="flex items-center gap-3">
                          <span className="font-mono font-bold tabular-nums text-sm text-slate-950">
                            {inv.grandTotalFormatted}
                          </span>
                          <button
                            type="button"
                            onClick={() => setPreviewInvoice(inv)}
                            className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                          >
                            View / Print
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void downloadAuthenticatedPdf({
                                portal: 'customer',
                                invoiceId: inv.id,
                                invoiceNumber: inv.invoiceNumber,
                              }).catch(handleApiError)
                            }
                            className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-xs font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                          >
                            <Download className="h-3.5 w-3.5" />
                            PDF
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* 5C. Payment History */}
            {accountSubTab === 'payments' && (
              <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
                <h2 className="text-base font-bold text-slate-950 mb-4">Payment History</h2>
                {selectedPaymentDetail && (
                  <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50/70 p-4 flex items-start justify-between gap-3 text-xs">
                    <div>
                      <p className="font-bold text-emerald-950 font-mono tabular-nums">
                        {selectedPaymentDetail.paymentNumber} · {selectedPaymentDetail.amountFormatted}
                      </p>
                      <p className="mt-0.5 text-emerald-900">
                        Date: {selectedPaymentDetail.paymentDate} · Method:{' '}
                        {selectedPaymentDetail.paymentMethod}
                        {selectedPaymentDetail.referenceNumber
                          ? ` · Ref: ${selectedPaymentDetail.referenceNumber}`
                          : ''}
                        {selectedPaymentDetail.remarks ? ` · ${selectedPaymentDetail.remarks}` : ''}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedPaymentDetail(null)}
                      aria-label="Close payment highlight"
                      className="text-emerald-800 hover:text-emerald-950"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                )}

                {payments.length === 0 ? (
                  <EmptyStateBox
                    title="No Payments Recorded Yet"
                    description="Payments credited to your BRB account appear here automatically."
                  />
                ) : (
                  <div className="divide-y divide-slate-100">
                    {payments.map((pay) => (
                      <div
                        key={pay.id}
                        className="py-3.5 first:pt-0 last:pb-0 flex flex-wrap items-center justify-between gap-4"
                      >
                        <div>
                          <p className="text-sm font-bold font-mono tabular-nums text-slate-950">
                            {pay.paymentNumber}
                          </p>
                          <p className="text-xs text-slate-500 mt-0.5">
                            {pay.paymentDate} · {pay.paymentMethod}
                            {pay.referenceNumber ? ` · Ref: ${pay.referenceNumber}` : ''}
                            {pay.remarks ? ` · ${pay.remarks}` : ''}
                          </p>
                        </div>
                        <span className="font-mono font-bold tabular-nums text-sm text-emerald-700">
                          {pay.amountFormatted}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* 5D. Orders Shortcut inside Account */}
            {accountSubTab === 'orders' && (
              <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-base font-bold text-slate-950">Account Orders</h2>
                  <button
                    type="button"
                    onClick={() => setActiveTab('orders')}
                    className="text-xs font-semibold text-slate-700 hover:text-slate-950 underline underline-offset-4"
                  >
                    Open Full Order Comparison View
                  </button>
                </div>
                {orders.length === 0 ? (
                  <EmptyStateBox
                    title="No Orders Found"
                    description="Your submitted BRB orders will appear here."
                  />
                ) : (
                  <div className="divide-y divide-slate-100">
                    {orders.map((ord) => (
                      <button
                        key={ord.id}
                        type="button"
                        onClick={() => {
                          setSelectedOrderDetail(ord);
                          setActiveTab('orders');
                        }}
                        className="w-full py-3 first:pt-0 last:pb-0 flex items-center justify-between gap-4 text-left hover:bg-slate-50 rounded-lg"
                      >
                        <div>
                          <p className="text-sm font-bold font-mono tabular-nums text-slate-950">
                            {ord.orderNumber}
                          </p>
                          <p className={`text-xs mt-0.5 ${getOrderStatusToneClass(ord.status)}`}>
                            {ord.status}
                          </p>
                        </div>
                        <ChevronRight className="h-4 w-4 text-slate-400" />
                      </button>
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* 5E. Notification Center (Section 39) */}
            {accountSubTab === 'notifications' && (
              <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
                <h2 className="text-base font-bold text-slate-950 mb-4">Notification Center</h2>
                {notifications.length === 0 ? (
                  <EmptyStateBox
                    title="No Notifications Yet"
                    description="Alerts for order approvals, new invoices, and payments will appear here."
                  />
                ) : (
                  <div className="divide-y divide-slate-100">
                    {notifications.map((notif) => {
                      const hasUrdu = /[\u0600-\u06FF]/.test(notif.message);
                      return (
                        <button
                          key={notif.id}
                          type="button"
                          onClick={() => void handleOpenNotification(notif)}
                          className={`w-full py-4 first:pt-0 last:pb-0 text-left flex items-start justify-between gap-4 rounded-lg transition-colors ${
                            !notif.isRead ? 'bg-amber-50/50 px-3' : 'hover:bg-slate-50 px-1'
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                              <span className="font-semibold text-slate-900">{notif.title}</span>
                              <span>·</span>
                              <span className="font-mono tabular-nums">
                                {notif.createdAt.slice(0, 16).replace('T', ' ')}
                              </span>
                              {!notif.isRead && (
                                <>
                                  <span>·</span>
                                  <span className="font-bold text-amber-800">Unread</span>
                                </>
                              )}
                            </div>
                            <p
                              dir={hasUrdu ? 'rtl' : undefined}
                              className={`mt-1 text-slate-700 ${
                                hasUrdu ? 'font-urdu text-sm text-right' : 'text-xs leading-relaxed'
                              }`}
                            >
                              {notif.message}
                            </p>
                          </div>
                          {notif.targetType && (
                            <ChevronRight className="h-4 w-4 text-slate-400 mt-1 shrink-0" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </main>

      {/* Mobile Fixed Bottom Navigation — Home | Products | Orders | Account (Section 16) */}
      <nav
        aria-label="Mobile Bottom Navigation"
        className="no-print md:hidden fixed bottom-0 left-0 right-0 z-30 h-14 bg-white/95 backdrop-blur-md border-t border-slate-200 grid grid-cols-4 items-center"
      >
        {(
          [
            ['home', 'Home', Home],
            ['products', 'Products', Package],
            ['orders', 'Orders', ClipboardList],
            ['account', 'Account', User],
          ] as const
        ).map(([id, label, Icon]) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              className={`min-h-[48px] flex flex-col items-center justify-center transition-colors ${
                active ? 'text-slate-950 font-bold' : 'text-slate-500'
              }`}
            >
              <Icon
                className={`h-5 w-5 ${active ? 'text-amber-600' : 'text-slate-500'}`}
                aria-hidden="true"
              />
              <span className="text-[11px] leading-tight mt-0.5 whitespace-nowrap">{label}</span>
            </button>
          );
        })}
      </nav>

      {/* Product Details Modal (Section 18 — Strictly Zero Prices) */}
      {selectedProductDetail && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${selectedProductDetail.name} Details`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 backdrop-blur-xs p-4"
        >
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-xl">
            <ProductVisual
              imageUrl={selectedProductDetail.imageUrl}
              name={selectedProductDetail.name}
              category={selectedProductDetail.category}
              isActive={selectedProductDetail.isActive}
              className="h-52 w-full border-b border-slate-100"
            />
            <div className="p-6">
              <p className="text-xs text-slate-500">
                {selectedProductDetail.category} · Packing: {selectedProductDetail.packingWeight} ·
                Usage: {selectedProductDetail.usage}
              </p>
              <h3 className="mt-1 text-xl font-extrabold text-slate-950">
                {selectedProductDetail.name}
              </h3>
              <p className="mt-2 text-sm font-medium text-slate-700">
                {selectedProductDetail.shortDescription}
              </p>
              {selectedProductDetail.fullDetails &&
                selectedProductDetail.fullDetails !== selectedProductDetail.shortDescription && (
                  <p className="mt-3 text-xs text-slate-600 leading-relaxed whitespace-pre-line">
                    {selectedProductDetail.fullDetails}
                  </p>
                )}

              {!selectedProductDetail.isActive && (
                <p className="mt-3 text-xs font-bold text-rose-700">
                  Currently Unavailable — Ordering is temporarily disabled for this product.
                </p>
              )}

              <div className="mt-6 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setSelectedProductDetail(null)}
                  className="min-h-[44px] px-4 py-2 rounded-xl border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                >
                  Close
                </button>
                {selectedProductDetail.isActive && (
                  <button
                    type="button"
                    onClick={() => {
                      const pid = selectedProductDetail.id;
                      setSelectedProductDetail(null);
                      openNewOrderBuilder(pid);
                    }}
                    className="min-h-[44px] px-5 py-2 rounded-xl bg-amber-400 text-xs font-extrabold text-slate-950 hover:bg-amber-300 transition-colors whitespace-nowrap shrink-0"
                  >
                    Order This Product
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Order Cancellation Confirmation Dialog */}
      <ConfirmDialog
        open={Boolean(cancelOrderTarget)}
        title={`Cancel ${cancelOrderTarget?.orderNumber || 'Order'}?`}
        description="Cancelled orders will no longer be processed by BRB, while remaining permanently visible in your order history."
        confirmLabel="Confirm Cancellation"
        cancelLabel="Keep Order"
        destructive
        busy={cancellingOrder}
        onConfirm={() => void handleConfirmCancelOrder()}
        onCancel={() => setCancelOrderTarget(null)}
      />

      {/* Official Invoice Preview & PDF Modal */}
      {previewInvoice && (
        <InvoiceDocumentModal
          invoice={previewInvoice}
          portal="customer"
          onClose={() => setPreviewInvoice(null)}
        />
      )}
    </div>
  );
}
