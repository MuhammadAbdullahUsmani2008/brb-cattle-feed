import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CreditCard, Download, Edit3, FilePlus2, Plus, Search, Trash2 } from 'lucide-react';
import { PAYMENT_METHODS } from '../shared/types';
import type {
  CustomerPublicView,
  InvoiceView,
  LedgerEntryView,
  OrderView,
  PaymentMethod,
  PaymentView,
  ProductAdminView,
} from '../shared/types';
import { formatPaisa, parseMoneyToPaisa } from '../shared/domain';
import { adminApi, downloadAuthenticatedPdf } from '../lib/api';
import { EmptyStateBox, InlineAlert } from '../components/Branding';
import { InvoiceDocumentModal } from '../components/InvoiceDocument';
import type { FinanceSubSection } from './types';

interface DraftInvoiceLine {
  key: string;
  productId: number | null;
  productName: string;
  packingWeight: string;
  quantity: number;
  rate: string;
}

export function AdminFinanceSection({
  subSection,
  onChangeSubSection,
  preselectedOrderForInvoice,
  onClearPreselectedOrder,
  openNewInvoiceInitially,
  onClearOpenNewInvoice,
  openAddPaymentInitially,
  onClearOpenAddPayment,
  focusLedgerCustomerId,
  onClearFocusLedgerCustomer,
  onDataChanged,
}: {
  subSection: FinanceSubSection;
  onChangeSubSection: (sub: FinanceSubSection) => void;
  preselectedOrderForInvoice: OrderView | null;
  onClearPreselectedOrder: () => void;
  openNewInvoiceInitially: boolean;
  onClearOpenNewInvoice: () => void;
  openAddPaymentInitially: boolean;
  onClearOpenAddPayment: () => void;
  focusLedgerCustomerId: number | null;
  onClearFocusLedgerCustomer: () => void;
  onDataChanged: () => void;
}) {
  const [customers, setCustomers] = useState<CustomerPublicView[]>([]);
  const [products, setProducts] = useState<ProductAdminView[]>([]);
  const [approvedOrders, setApprovedOrders] = useState<OrderView[]>([]);
  const [invoices, setInvoices] = useState<InvoiceView[]>([]);
  const [payments, setPayments] = useState<PaymentView[]>([]);
  const [ledgerEntries, setLedgerEntries] = useState<LedgerEntryView[]>([]);

  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<{ tone: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [previewInvoice, setPreviewInvoice] = useState<InvoiceView | null>(null);

  // Invoice Creation / Edit Modal State
  const [invoiceModalOpen, setInvoiceModalOpen] = useState(false);
  const [editingInvoice, setEditingInvoice] = useState<InvoiceView | null>(null);
  const [invoiceMode, setInvoiceMode] = useState<'offline' | 'order'>('offline');
  const [invCustomerId, setInvCustomerId] = useState<number>(0);
  const [invCustomerSearch, setInvCustomerSearch] = useState('');
  const [invSourceOrderId, setInvSourceOrderId] = useState<number | null>(null);
  const [invDate, setInvDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [invNotes, setInvNotes] = useState('');
  const [invEditReason, setInvEditReason] = useState('');
  const [invLines, setInvLines] = useState<DraftInvoiceLine[]>([]);
  const [savingInvoice, setSavingInvoice] = useState(false);

  // Payment Creation / Edit Modal State
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [editingPayment, setEditingPayment] = useState<PaymentView | null>(null);
  const [payCustomerId, setPayCustomerId] = useState<number>(0);
  const [payCustomerSearch, setPayCustomerSearch] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [payDate, setPayDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [payMethod, setPayMethod] = useState<PaymentMethod>('Cash');
  const [payReference, setPayReference] = useState('');
  const [payRemarks, setPayRemarks] = useState('');
  const [payEditReason, setPayEditReason] = useState('');
  const [savingPayment, setSavingPayment] = useState(false);

  // Search & Ledger Filters
  const [invoiceSearch, setInvoiceSearch] = useState('');
  const [paymentSearch, setPaymentSearch] = useState('');
  const [ledgerSearch, setLedgerSearch] = useState('');
  const [ledgerCustomerId, setLedgerCustomerId] = useState<number>(focusLedgerCustomerId || 0);
  const [ledgerPreset, setLedgerPreset] = useState<'all' | 'today' | 'week' | 'month' | 'custom'>('all');
  const [ledgerFromDate, setLedgerFromDate] = useState('');
  const [ledgerToDate, setLedgerToDate] = useState('');

  const loadFinanceData = useCallback(async () => {
    setLoading(true);
    try {
      const ledgerParams = new URLSearchParams();
      if (ledgerCustomerId > 0) ledgerParams.set('customerId', String(ledgerCustomerId));
      if (ledgerSearch.trim()) ledgerParams.set('search', ledgerSearch.trim());
      ledgerParams.set('preset', ledgerPreset);
      if (ledgerPreset === 'custom') {
        if (ledgerFromDate) ledgerParams.set('fromDate', ledgerFromDate);
        if (ledgerToDate) ledgerParams.set('toDate', ledgerToDate);
      }

      const [custRes, prodRes, ordRes, invRes, payRes, ledRes] = await Promise.all([
        adminApi<{ customers: CustomerPublicView[] }>('/api/admin/customers'),
        adminApi<{ products: ProductAdminView[] }>('/api/admin/products'),
        adminApi<{ orders: OrderView[] }>('/api/admin/orders'),
        adminApi<{ invoices: InvoiceView[] }>(
          `/api/admin/invoices${invoiceSearch.trim() ? `?search=${encodeURIComponent(invoiceSearch.trim())}` : ''}`
        ),
        adminApi<{ payments: PaymentView[] }>(
          `/api/admin/payments${paymentSearch.trim() ? `?search=${encodeURIComponent(paymentSearch.trim())}` : ''}`
        ),
        adminApi<{ entries: LedgerEntryView[] }>(`/api/admin/ledger?${ledgerParams.toString()}`),
      ]);

      setCustomers(custRes.customers);
      setProducts(prodRes.products.filter((p) => !p.isArchived));
      setApprovedOrders(
        ordRes.orders.filter(
          (o) =>
            ['Confirmed / Partially Approved', 'Preparing', 'Dispatched', 'Delivered'].includes(
              o.status
            ) && !o.linkedInvoiceId
        )
      );
      setInvoices(invRes.invoices);
      setPayments(payRes.payments);
      setLedgerEntries(ledRes.entries);
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Unable to load financial data.',
      });
    } finally {
      setLoading(false);
    }
  }, [
    invoiceSearch,
    ledgerCustomerId,
    ledgerFromDate,
    ledgerPreset,
    ledgerSearch,
    ledgerToDate,
    paymentSearch,
  ]);

  useEffect(() => {
    void loadFinanceData();
  }, [loadFinanceData]);

  const populateInvoiceFromOrder = useCallback((ord: OrderView) => {
    setEditingInvoice(null);
    setInvoiceMode('order');
    setInvCustomerId(ord.customerId);
    setInvSourceOrderId(ord.id);
    setInvDate(new Date().toISOString().slice(0, 10));
    setInvNotes(`Against Approved Order ${ord.orderNumber}`);
    setInvEditReason('');
    const billableItems = ord.approvedItems.filter((ai) => ai.approvedQty > 0);
    setInvLines(
      billableItems.map((ai, i) => ({
        key: `ordline_${i}_${ai.id}`,
        productId: ai.productId,
        productName: ai.productNameSnapshot,
        packingWeight: ai.packingSnapshot,
        quantity: ai.approvedQty,
        rate: '',
      }))
    );
    setInvoiceModalOpen(true);
  }, []);

  useEffect(() => {
    if (preselectedOrderForInvoice) {
      onChangeSubSection('invoices');
      populateInvoiceFromOrder(preselectedOrderForInvoice);
      onClearPreselectedOrder();
    }
  }, [
    onChangeSubSection,
    onClearPreselectedOrder,
    populateInvoiceFromOrder,
    preselectedOrderForInvoice,
  ]);

  useEffect(() => {
    if (openNewInvoiceInitially) {
      openOfflineInvoiceModal();
      onClearOpenNewInvoice();
    }
  }, [openNewInvoiceInitially, onClearOpenNewInvoice]);

  useEffect(() => {
    if (openAddPaymentInitially) {
      openCreatePaymentModal();
      onClearOpenAddPayment();
    }
  }, [openAddPaymentInitially, onClearOpenAddPayment]);

  useEffect(() => {
    if (focusLedgerCustomerId) {
      setLedgerCustomerId(focusLedgerCustomerId);
      onClearFocusLedgerCustomer();
    }
  }, [focusLedgerCustomerId, onClearFocusLedgerCustomer]);

  const openOfflineInvoiceModal = () => {
    setEditingInvoice(null);
    setInvoiceMode('offline');
    setInvCustomerId(customers[0]?.id || 0);
    setInvCustomerSearch('');
    setInvSourceOrderId(null);
    setInvDate(new Date().toISOString().slice(0, 10));
    setInvNotes('');
    setInvEditReason('');
    const defaultProd = products[0];
    setInvLines([
      {
        key: `line_${Date.now()}`,
        productId: defaultProd?.id ?? null,
        productName: defaultProd?.name ?? '',
        packingWeight: defaultProd?.packingWeight ?? '40 kg Bag',
        quantity: 10,
        rate: '',
      },
    ]);
    setInvoiceModalOpen(true);
  };

  const openEditInvoiceModal = (inv: InvoiceView) => {
    setEditingInvoice(inv);
    setInvoiceMode(inv.sourceOrderId ? 'order' : 'offline');
    setInvCustomerId(inv.customerId);
    setInvSourceOrderId(inv.sourceOrderId);
    setInvDate(inv.invoiceDate);
    setInvNotes(inv.notes);
    setInvEditReason('');
    setInvLines(
      inv.items.map((it, idx) => ({
        key: `edit_${idx}_${it.id}`,
        productId: it.productId,
        productName: it.productName,
        packingWeight: it.packingWeight,
        quantity: it.quantity,
        rate: String(it.ratePaisa / 100),
      }))
    );
    setInvoiceModalOpen(true);
  };

  const openCreatePaymentModal = () => {
    setEditingPayment(null);
    setPayCustomerId(customers[0]?.id || 0);
    setPayCustomerSearch('');
    setPayAmount('');
    setPayDate(new Date().toISOString().slice(0, 10));
    setPayMethod('Cash');
    setPayReference('');
    setPayRemarks('');
    setPayEditReason('');
    setPaymentModalOpen(true);
  };

  const openEditPaymentModal = (pay: PaymentView) => {
    setEditingPayment(pay);
    setPayCustomerId(pay.customerId);
    setPayAmount(String(pay.amountPaisa / 100));
    setPayDate(pay.paymentDate);
    setPayMethod(pay.paymentMethod);
    setPayReference(pay.referenceNumber);
    setPayRemarks(pay.remarks);
    setPayEditReason('');
    setPaymentModalOpen(true);
  };

  const selectedInvoiceCustomer = useMemo(
    () => customers.find((c) => c.id === invCustomerId) || null,
    [customers, invCustomerId]
  );

  const selectedPaymentCustomer = useMemo(
    () => customers.find((c) => c.id === payCustomerId) || null,
    [customers, payCustomerId]
  );

  const calculatedInvoicePreview = useMemo(() => {
    let grandTotalPaisa = 0;
    const lineTotalsPaisa = invLines.map((l) => {
      try {
        const ratePaisa = l.rate.trim() ? parseMoneyToPaisa(l.rate) : 0;
        const total = Math.max(0, Math.floor(l.quantity || 0)) * ratePaisa;
        grandTotalPaisa += total;
        return total;
      } catch {
        return 0;
      }
    });
    return { lineTotalsPaisa, grandTotalPaisa };
  }, [invLines]);

  const handleSaveInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingInvoice(true);
    setBanner(null);
    try {
      const itemsPayload = invLines.map((l) => ({
        productId: l.productId,
        productName: l.productName,
        packingWeight: l.packingWeight,
        quantity: Number(l.quantity),
        rate: l.rate.trim(),
      }));

      if (editingInvoice) {
        const res = await adminApi<{ invoice: InvoiceView }>(
          `/api/admin/invoices/${editingInvoice.id}`,
          {
            method: 'PUT',
            body: {
              invoiceDate: invDate,
              notes: invNotes,
              reason: invEditReason.trim(),
              items: itemsPayload,
            },
          }
        );
        setInvoiceModalOpen(false);
        await loadFinanceData();
        onDataChanged();
        setPreviewInvoice(res.invoice);
        setBanner({
          tone: 'success',
          message: `Updated Invoice #${res.invoice.invoiceNumber} (Rev ${res.invoice.revisionCount}) and reconciled customer ledger.`,
        });
      } else {
        const res = await adminApi<{ invoice: InvoiceView }>('/api/admin/invoices', {
          method: 'POST',
          body: {
            customerId: invCustomerId,
            sourceOrderId: invoiceMode === 'order' ? invSourceOrderId : null,
            invoiceDate: invDate,
            notes: invNotes,
            items: itemsPayload,
            idempotencyKey: `inv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          },
        });
        setInvoiceModalOpen(false);
        await loadFinanceData();
        onDataChanged();
        setPreviewInvoice(res.invoice);
        setBanner({
          tone: 'success',
          message: `Created Invoice #${res.invoice.invoiceNumber} (${res.invoice.grandTotalFormatted}), debited ledger, and sent Urdu customer notification.`,
        });
      }
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Invoice save failed.',
      });
    } finally {
      setSavingInvoice(false);
    }
  };

  const handleSavePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingPayment(true);
    setBanner(null);
    try {
      if (editingPayment) {
        const res = await adminApi<{ payment: PaymentView }>(
          `/api/admin/payments/${editingPayment.id}`,
          {
            method: 'PUT',
            body: {
              amount: payAmount.trim(),
              paymentDate: payDate,
              paymentMethod: payMethod,
              referenceNumber: payReference.trim(),
              remarks: payRemarks.trim(),
              reason: payEditReason.trim(),
            },
          }
        );
        setPaymentModalOpen(false);
        await loadFinanceData();
        onDataChanged();
        setBanner({
          tone: 'success',
          message: `Updated ${res.payment.paymentNumber} (Rev ${res.payment.revisionCount}) and reconciled customer balance.`,
        });
      } else {
        const res = await adminApi<{ payment: PaymentView }>('/api/admin/payments', {
          method: 'POST',
          body: {
            customerId: payCustomerId,
            amount: payAmount.trim(),
            paymentDate: payDate,
            paymentMethod: payMethod,
            referenceNumber: payReference.trim(),
            remarks: payRemarks.trim(),
            idempotencyKey: `pay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          },
        });
        setPaymentModalOpen(false);
        await loadFinanceData();
        onDataChanged();
        setBanner({
          tone: 'success',
          message: `Recorded ${res.payment.paymentNumber} (${res.payment.amountFormatted}), credited ledger, and notified customer.`,
        });
      }
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Payment save failed.',
      });
    } finally {
      setSavingPayment(false);
    }
  };

  const filteredInvoiceCustomers = useMemo(() => {
    const q = invCustomerSearch.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.accountNumber.toLowerCase().includes(q) ||
        c.mobileNumber.includes(q)
    );
  }, [customers, invCustomerSearch]);

  const filteredPaymentCustomers = useMemo(() => {
    const q = payCustomerSearch.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.accountNumber.toLowerCase().includes(q) ||
        c.mobileNumber.includes(q)
    );
  }, [customers, payCustomerSearch]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold text-slate-950">
            Invoices, Payments &amp; Master Accounting Ledger
          </h1>
          <p className="text-xs sm:text-sm text-slate-600 mt-0.5">
            Sequential invoices (#5001+), vector PDF generation, payment receipts, and multi-year
            accounting ledger.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={openOfflineInvoiceModal}
            className="min-h-[40px] inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-900 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
          >
            <FilePlus2 className="h-3.5 w-3.5" />
            New Invoice
          </button>
          <button
            type="button"
            onClick={openCreatePaymentModal}
            className="min-h-[40px] inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-bold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <CreditCard className="h-3.5 w-3.5" />
            ADD PAYMENT
          </button>
        </div>
      </div>

      {banner && (
        <InlineAlert
          tone={banner.tone}
          message={banner.message}
          onDismiss={() => setBanner(null)}
        />
      )}

      {/* Sub-Section Segmented Control */}
      <div className="inline-flex flex-wrap items-center gap-1 p-1 rounded-xl bg-slate-200/70">
        {(
          [
            ['invoices', `Invoices (${invoices.length})`],
            ['payments', `Payments (${payments.length})`],
            ['ledger', 'Master Ledger (Full History)'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => onChangeSubSection(id)}
            className={`min-h-[38px] px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              subSection === id
                ? 'bg-white text-slate-950 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ================================================================
          SUB-TAB 1: INVOICES (Method A: Order-Linked & Method B: Offline)
         ================================================================ */}
      {subSection === 'invoices' && (
        <div className="space-y-4">
          {approvedOrders.length > 0 && (
            <div className="rounded-xl border border-amber-300 bg-amber-50/70 p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-slate-900">
                <strong>{approvedOrders.length}</strong> approved order(s) are ready for Method A
                invoicing:{' '}
                {approvedOrders
                  .slice(0, 3)
                  .map((o) => `${o.orderNumber} (${o.customerName})`)
                  .join(' · ')}
              </div>
              <button
                type="button"
                onClick={() => populateInvoiceFromOrder(approvedOrders[0])}
                className="min-h-[36px] px-3.5 py-1.5 rounded-lg bg-amber-400 text-xs font-extrabold text-slate-950 hover:bg-amber-300 whitespace-nowrap shrink-0"
              >
                Bill {approvedOrders[0].orderNumber}
              </button>
            </div>
          )}

          <div className="relative max-w-md">
            <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              aria-label="Search invoices"
              placeholder="Search Invoice #, customer name, BRB-C-ID..."
              value={invoiceSearch}
              onChange={(e) => setInvoiceSearch(e.target.value)}
              className="w-full min-h-[40px] rounded-lg border border-slate-300 bg-white pl-9 pr-3 py-2 text-xs text-slate-900"
            />
          </div>

          {loading ? (
            <div className="rounded-xl border border-slate-200 bg-white p-8 text-xs text-slate-500">
              Loading invoices...
            </div>
          ) : invoices.length === 0 ? (
            <EmptyStateBox
              title="No Invoices Issued Yet"
              description="Create an invoice from an approved order (Method A) or issue an independent offline invoice (Method B)."
              actionLabel="Create First Invoice"
              onAction={openOfflineInvoiceModal}
            />
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs sm:text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-4">Invoice #</th>
                    <th className="py-3 px-4">Date</th>
                    <th className="py-3 px-4">Customer</th>
                    <th className="py-3 px-4">Source</th>
                    <th className="py-3 px-4 text-right">Grand Total</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {invoices.map((inv) => (
                    <tr key={inv.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 font-mono font-bold tabular-nums text-slate-950 whitespace-nowrap">
                        #{inv.invoiceNumber}
                        {inv.revisionCount > 0 ? ` (Rev ${inv.revisionCount})` : ''}
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums text-xs text-slate-600 whitespace-nowrap">
                        {inv.invoiceDate}
                      </td>
                      <td className="py-3 px-4">
                        <span className="font-semibold text-slate-900">{inv.customerName}</span>{' '}
                        <span className="font-mono text-xs text-slate-500">
                          ({inv.customerAccountNumber})
                        </span>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600 whitespace-nowrap">
                        {inv.sourceOrderNumber ? `Order ${inv.sourceOrderNumber}` : 'Offline / Direct'}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-bold tabular-nums text-slate-950 whitespace-nowrap">
                        {inv.grandTotalFormatted}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setPreviewInvoice(inv)}
                            className="min-h-[34px] px-2.5 py-1 rounded-md border border-slate-300 text-xs font-semibold text-slate-800 hover:bg-slate-50 whitespace-nowrap shrink-0"
                          >
                            Preview / Print
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void downloadAuthenticatedPdf({
                                portal: 'admin',
                                invoiceId: inv.id,
                                invoiceNumber: inv.invoiceNumber,
                              }).catch((e) =>
                                setBanner({
                                  tone: 'error',
                                  message: e instanceof Error ? e.message : 'PDF download failed.',
                                })
                              )
                            }
                            className="min-h-[34px] inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-slate-900 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap shrink-0"
                          >
                            <Download className="h-3 w-3" />
                            PDF
                          </button>
                          <button
                            type="button"
                            aria-label={`Edit Invoice #${inv.invoiceNumber}`}
                            onClick={() => openEditInvoiceModal(inv)}
                            className="min-h-[34px] min-w-[34px] inline-flex items-center justify-center rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50"
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ================================================================
          SUB-TAB 2: PAYMENTS (Separate ADD PAYMENT Workflow)
         ================================================================ */}
      {subSection === 'payments' && (
        <div className="space-y-4">
          <div className="relative max-w-md">
            <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              aria-label="Search payments"
              placeholder="Search Payment #, ref #, customer, BRB-C-ID..."
              value={paymentSearch}
              onChange={(e) => setPaymentSearch(e.target.value)}
              className="w-full min-h-[40px] rounded-lg border border-slate-300 bg-white pl-9 pr-3 py-2 text-xs text-slate-900"
            />
          </div>

          {payments.length === 0 ? (
            <EmptyStateBox
              title="No Payments Recorded Yet"
              description="Use ADD PAYMENT to credit customer accounts via Cash, Bank Transfer, Cheque, Online Payment, or Other."
              actionLabel="Record First Payment"
              onAction={openCreatePaymentModal}
            />
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs sm:text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-4">Payment #</th>
                    <th className="py-3 px-4">Date</th>
                    <th className="py-3 px-4">Customer</th>
                    <th className="py-3 px-4">Method &amp; Reference</th>
                    <th className="py-3 px-4 text-right">Amount Credited</th>
                    <th className="py-3 px-4 text-right">Edit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {payments.map((pay) => (
                    <tr key={pay.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 font-mono font-bold tabular-nums text-slate-950 whitespace-nowrap">
                        {pay.paymentNumber}
                        {pay.revisionCount > 0 ? ` (Rev ${pay.revisionCount})` : ''}
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums text-xs text-slate-600 whitespace-nowrap">
                        {pay.paymentDate}
                      </td>
                      <td className="py-3 px-4">
                        <span className="font-semibold text-slate-900">{pay.customerName}</span>{' '}
                        <span className="font-mono text-xs text-slate-500">
                          ({pay.customerAccountNumber})
                        </span>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600">
                        {pay.paymentMethod}
                        {pay.referenceNumber ? ` · Ref: ${pay.referenceNumber}` : ''}
                        {pay.remarks ? ` · ${pay.remarks}` : ''}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-bold tabular-nums text-emerald-700 whitespace-nowrap">
                        {pay.amountFormatted}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <button
                          type="button"
                          aria-label={`Edit ${pay.paymentNumber}`}
                          onClick={() => openEditPaymentModal(pay)}
                          className="min-h-[34px] min-w-[34px] inline-flex items-center justify-center rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ================================================================
          SUB-TAB 3: MASTER ACCOUNTING LEDGER (All History Including >12m)
         ================================================================ */}
      {subSection === 'ledger' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="relative">
                <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="search"
                  aria-label="Search master ledger"
                  placeholder="Customer, BRB-C-ID, Invoice #, Payment ref..."
                  value={ledgerSearch}
                  onChange={(e) => setLedgerSearch(e.target.value)}
                  className="w-full min-h-[40px] rounded-lg border border-slate-300 pl-9 pr-3 py-2 text-xs text-slate-900"
                />
              </div>

              <select
                aria-label="Filter master ledger by customer"
                value={ledgerCustomerId}
                onChange={(e) => setLedgerCustomerId(Number(e.target.value))}
                className="min-h-[40px] rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-900"
              >
                <option value={0}>All Customers (Multi-Year Master Ledger)</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.accountNumber} — {c.name} ({c.outstandingBalanceFormatted})
                  </option>
                ))}
              </select>

              <div className="flex overflow-x-auto gap-1 p-1 rounded-lg bg-slate-100">
                {(
                  [
                    ['all', 'All Time'],
                    ['today', 'Today'],
                    ['week', 'This Week'],
                    ['month', 'This Month'],
                    ['custom', 'Custom'],
                  ] as const
                ).map(([pr, label]) => (
                  <button
                    key={pr}
                    type="button"
                    onClick={() => setLedgerPreset(pr)}
                    className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                      ledgerPreset === pr ? 'bg-white text-slate-950 shadow-xs' : 'text-slate-600'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {ledgerPreset === 'custom' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <input
                  type="date"
                  aria-label="Custom ledger start date"
                  value={ledgerFromDate}
                  onChange={(e) => setLedgerFromDate(e.target.value)}
                  className="min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono tabular-nums"
                />
                <input
                  type="date"
                  aria-label="Custom ledger end date"
                  value={ledgerToDate}
                  onChange={(e) => setLedgerToDate(e.target.value)}
                  className="min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono tabular-nums"
                />
              </div>
            )}
          </div>

          {ledgerEntries.length === 0 ? (
            <EmptyStateBox
              title="No Ledger Transactions Match Filter"
              description="All posted invoices (debits) and payments (credits), including records older than 12 months, are retained in this administrative ledger."
            />
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs sm:text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-4">Date</th>
                    <th className="py-3 px-4">Customer</th>
                    <th className="py-3 px-4">Description</th>
                    <th className="py-3 px-4 text-right">Debit</th>
                    <th className="py-3 px-4 text-right">Credit</th>
                    <th className="py-3 px-4 text-right">Customer Running Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {ledgerEntries.map((le) => (
                    <tr key={le.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 font-mono tabular-nums text-xs text-slate-600 whitespace-nowrap">
                        {le.entryDate}
                      </td>
                      <td className="py-3 px-4">
                        <span className="font-semibold text-slate-900">{le.customerName}</span>{' '}
                        <span className="font-mono text-xs text-slate-500">
                          ({le.customerAccountNumber})
                        </span>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-800">{le.description}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-900 whitespace-nowrap">
                        {le.debitFormatted}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-emerald-700 font-medium whitespace-nowrap">
                        {le.creditFormatted}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-bold tabular-nums text-slate-950 whitespace-nowrap">
                        {le.runningBalanceFormatted}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ================================================================
          MODAL: CREATE / EDIT INVOICE (Method A & Method B)
         ================================================================ */}
      {invoiceModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={editingInvoice ? 'Edit Invoice' : 'Create Invoice'}
          className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/50 backdrop-blur-xs p-4 flex items-center justify-center"
        >
          <div className="w-full max-w-3xl rounded-2xl border border-slate-200 bg-white p-6 shadow-xl my-8">
            <h2 className="text-lg font-extrabold text-slate-950">
              {editingInvoice
                ? `Edit Invoice #${editingInvoice.invoiceNumber}`
                : 'Create Official BRB Invoice'}
            </h2>

            {!editingInvoice && (
              <div className="mt-3 inline-flex items-center gap-1 p-1 rounded-lg bg-slate-100">
                <button
                  type="button"
                  onClick={() => {
                    setInvoiceMode('offline');
                    setInvSourceOrderId(null);
                  }}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold ${
                    invoiceMode === 'offline' ? 'bg-white text-slate-950 shadow-xs' : 'text-slate-600'
                  }`}
                >
                  Method B: Independent / Offline Invoice
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setInvoiceMode('order');
                    if (approvedOrders[0]) populateInvoiceFromOrder(approvedOrders[0]);
                  }}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold ${
                    invoiceMode === 'order' ? 'bg-white text-slate-950 shadow-xs' : 'text-slate-600'
                  }`}
                >
                  Method A: From Approved Order ({approvedOrders.length})
                </button>
              </div>
            )}

            <form onSubmit={handleSaveInvoice} className="mt-4 space-y-4">
              {!editingInvoice && invoiceMode === 'order' && (
                <div>
                  <label
                    htmlFor="inv-order-select"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    Approved Order *
                  </label>
                  <select
                    id="inv-order-select"
                    value={invSourceOrderId || 0}
                    onChange={(e) => {
                      const ord = approvedOrders.find((o) => o.id === Number(e.target.value));
                      if (ord) populateInvoiceFromOrder(ord);
                    }}
                    className="w-full min-h-[42px] rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-900"
                  >
                    <option value={0}>Select an approved unbilled order...</option>
                    {approvedOrders.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.orderNumber} — {o.customerName} ({o.customerAccountNumber})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Customer Search + Selection + Current Outstanding Balance Display (Section 28) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label
                    htmlFor="inv-cust-select"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    Customer Account *
                  </label>
                  {!editingInvoice && invoiceMode === 'offline' && (
                    <input
                      type="search"
                      placeholder="Filter customer by name or BRB-C-ID..."
                      value={invCustomerSearch}
                      onChange={(e) => setInvCustomerSearch(e.target.value)}
                      className="mb-1.5 w-full min-h-[34px] rounded-lg border border-slate-200 px-2.5 py-1 text-xs"
                    />
                  )}
                  <select
                    id="inv-cust-select"
                    disabled={Boolean(editingInvoice) || invoiceMode === 'order'}
                    value={invCustomerId}
                    onChange={(e) => setInvCustomerId(Number(e.target.value))}
                    className="w-full min-h-[42px] rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-900 disabled:bg-slate-50"
                  >
                    <option value={0}>Select customer...</option>
                    {filteredInvoiceCustomers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.accountNumber} — {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="inv-date"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    Invoice Date *
                  </label>
                  <input
                    id="inv-date"
                    type="date"
                    required
                    value={invDate}
                    onChange={(e) => setInvDate(e.target.value)}
                    className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono tabular-nums text-slate-900"
                  />
                </div>
              </div>

              {selectedInvoiceCustomer && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                  <span>
                    Customer: <strong className="text-slate-900">{selectedInvoiceCustomer.name}</strong>{' '}
                    · Account:{' '}
                    <strong className="font-mono text-slate-900">
                      {selectedInvoiceCustomer.accountNumber}
                    </strong>
                  </span>
                  <span>
                    Current Outstanding Balance:{' '}
                    <strong className="font-mono tabular-nums text-slate-950">
                      {selectedInvoiceCustomer.outstandingBalanceFormatted}
                    </strong>
                  </span>
                </div>
              )}

              {/* Invoice Line Items */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-slate-900">
                    Invoice Products, Quantities &amp; Rates
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const p = products[0];
                      setInvLines((prev) => [
                        ...prev,
                        {
                          key: `line_${Date.now()}_${prev.length}`,
                          productId: p?.id ?? null,
                          productName: p?.name ?? '',
                          packingWeight: p?.packingWeight ?? '40 kg Bag',
                          quantity: 1,
                          rate: '',
                        },
                      ]);
                    }}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-slate-800 hover:underline"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add Line Item
                  </button>
                </div>

                <div className="space-y-2.5">
                  {invLines.map((line, idx) => (
                    <div
                      key={line.key}
                      className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center rounded-lg border border-slate-200 p-2.5"
                    >
                      <div className="sm:col-span-5">
                        <select
                          aria-label={`Line ${idx + 1} product`}
                          value={line.productId || 0}
                          onChange={(e) => {
                            const pid = Number(e.target.value);
                            const found = products.find((p) => p.id === pid);
                            setInvLines((prev) =>
                              prev.map((row, i) =>
                                i === idx
                                  ? {
                                      ...row,
                                      productId: found ? found.id : null,
                                      productName: found ? found.name : row.productName,
                                      packingWeight: found ? found.packingWeight : row.packingWeight,
                                    }
                                  : row
                              )
                            );
                          }}
                          className="w-full min-h-[38px] rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-900"
                        >
                          <option value={0}>
                            {line.productName ? `${line.productName} (Snapshot)` : 'Select product...'}
                          </option>
                          {products.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} ({p.packingWeight})
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="sm:col-span-2">
                        <input
                          type="number"
                          min={1}
                          required
                          aria-label={`Line ${idx + 1} quantity`}
                          placeholder="Qty"
                          value={line.quantity}
                          onChange={(e) => {
                            const val = Math.max(1, Math.floor(Number(e.target.value || 1)));
                            setInvLines((prev) =>
                              prev.map((row, i) => (i === idx ? { ...row, quantity: val } : row))
                            );
                          }}
                          className="w-full min-h-[38px] rounded-md border border-slate-300 px-2.5 text-right font-mono tabular-nums text-xs font-bold"
                        />
                      </div>

                      <div className="sm:col-span-2">
                        <input
                          type="text"
                          inputMode="decimal"
                          required
                          aria-label={`Line ${idx + 1} rate`}
                          placeholder="Rate (Rs.)"
                          value={line.rate}
                          onChange={(e) => {
                            const val = e.target.value;
                            setInvLines((prev) =>
                              prev.map((row, i) => (i === idx ? { ...row, rate: val } : row))
                            );
                          }}
                          className="w-full min-h-[38px] rounded-md border border-slate-300 px-2.5 text-right font-mono tabular-nums text-xs"
                        />
                      </div>

                      <div className="sm:col-span-2 text-right font-mono tabular-nums text-xs font-bold text-slate-900">
                        {formatPaisa(calculatedInvoicePreview.lineTotalsPaisa[idx] || 0)}
                      </div>

                      <div className="sm:col-span-1 text-right">
                        {invLines.length > 1 && (
                          <button
                            type="button"
                            aria-label={`Remove line ${idx + 1}`}
                            onClick={() =>
                              setInvLines((prev) => prev.filter((_, i) => i !== idx))
                            }
                            className="text-rose-700 hover:text-rose-900"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-200 pt-3">
                <input
                  type="text"
                  placeholder="Optional invoice notes / delivery remarks"
                  value={invNotes}
                  onChange={(e) => setInvNotes(e.target.value)}
                  className="flex-1 min-w-[220px] min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
                />
                <div className="text-right">
                  <span className="text-xs text-slate-500 mr-2">Calculated Grand Total:</span>
                  <span className="text-xl font-extrabold font-mono tabular-nums text-slate-950">
                    {formatPaisa(calculatedInvoicePreview.grandTotalPaisa)}
                  </span>
                </div>
              </div>

              {editingInvoice && (
                <div>
                  <label
                    htmlFor="inv-edit-reason"
                    className="block text-xs font-bold text-amber-900 mb-1"
                  >
                    Mandatory Financial Audit Reason for Invoice Edit *
                  </label>
                  <input
                    id="inv-edit-reason"
                    type="text"
                    required
                    minLength={4}
                    placeholder="Explain why this posted invoice is being revised"
                    value={invEditReason}
                    onChange={(e) => setInvEditReason(e.target.value)}
                    className="w-full min-h-[40px] rounded-lg border border-amber-300 bg-amber-50/40 px-3 py-2 text-xs text-slate-900"
                  />
                </div>
              )}

              <div className="pt-2 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setInvoiceModalOpen(false)}
                  className="min-h-[42px] px-4 py-2 rounded-lg border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingInvoice || invCustomerId <= 0}
                  className="min-h-[42px] px-5 py-2 rounded-lg bg-slate-900 text-xs font-bold text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  {savingInvoice
                    ? 'Posting to Ledger...'
                    : editingInvoice
                      ? 'Save Invoice Revision'
                      : 'Issue Invoice & Post Debit'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ================================================================
          MODAL: ADD / EDIT PAYMENT (Sections 32 & 33)
         ================================================================ */}
      {paymentModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={editingPayment ? 'Edit Payment' : 'Add Payment'}
          className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/50 backdrop-blur-xs p-4 flex items-center justify-center"
        >
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-xl my-8">
            <h2 className="text-lg font-extrabold text-slate-950">
              {editingPayment ? `Edit ${editingPayment.paymentNumber}` : 'ADD PAYMENT'}
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Credits the customer ledger atomically and updates current outstanding balance.
            </p>

            <form onSubmit={handleSavePayment} className="mt-4 space-y-4">
              <div>
                <label
                  htmlFor="pay-cust-select"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Customer Account *
                </label>
                {!editingPayment && (
                  <input
                    type="search"
                    placeholder="Filter customer by name or BRB-C-ID..."
                    value={payCustomerSearch}
                    onChange={(e) => setPayCustomerSearch(e.target.value)}
                    className="mb-1.5 w-full min-h-[34px] rounded-lg border border-slate-200 px-2.5 py-1 text-xs"
                  />
                )}
                <select
                  id="pay-cust-select"
                  disabled={Boolean(editingPayment)}
                  value={payCustomerId}
                  onChange={(e) => setPayCustomerId(Number(e.target.value))}
                  className="w-full min-h-[42px] rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-900 disabled:bg-slate-50"
                >
                  <option value={0}>Select customer...</option>
                  {filteredPaymentCustomers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.accountNumber} — {c.name}
                    </option>
                  ))}
                </select>
              </div>

              {selectedPaymentCustomer && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 flex items-center justify-between text-xs">
                  <span className="font-mono font-semibold text-slate-800">
                    {selectedPaymentCustomer.accountNumber}
                  </span>
                  <span>
                    Current Balance:{' '}
                    <strong className="font-mono tabular-nums text-slate-950">
                      {selectedPaymentCustomer.outstandingBalanceFormatted}
                    </strong>
                  </span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label
                    htmlFor="pay-amount"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    Payment Amount (Rs.) *
                  </label>
                  <input
                    id="pay-amount"
                    type="text"
                    inputMode="decimal"
                    required
                    placeholder="e.g., 50000"
                    value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value)}
                    className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 py-2 font-mono tabular-nums text-sm font-bold text-slate-900"
                  />
                </div>
                <div>
                  <label
                    htmlFor="pay-date"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    Payment Date *
                  </label>
                  <input
                    id="pay-date"
                    type="date"
                    required
                    value={payDate}
                    onChange={(e) => setPayDate(e.target.value)}
                    className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 py-2 font-mono tabular-nums text-xs text-slate-900"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label
                    htmlFor="pay-method"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    Payment Method *
                  </label>
                  <select
                    id="pay-method"
                    value={payMethod}
                    onChange={(e) => setPayMethod(e.target.value as PaymentMethod)}
                    className="w-full min-h-[42px] rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-900"
                  >
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="pay-ref"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    Reference / Cheque / Slip #
                  </label>
                  <input
                    id="pay-ref"
                    type="text"
                    placeholder="Optional slip or cheque #"
                    value={payReference}
                    onChange={(e) => setPayReference(e.target.value)}
                    className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-900"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="pay-remarks"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Remarks / Notes
                </label>
                <input
                  id="pay-remarks"
                  type="text"
                  placeholder="Optional remarks"
                  value={payRemarks}
                  onChange={(e) => setPayRemarks(e.target.value)}
                  className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900"
                />
              </div>

              {editingPayment && (
                <div>
                  <label
                    htmlFor="pay-edit-reason"
                    className="block text-xs font-bold text-amber-900 mb-1"
                  >
                    Mandatory Audit Reason for Payment Edit *
                  </label>
                  <input
                    id="pay-edit-reason"
                    type="text"
                    required
                    minLength={4}
                    placeholder="Explain why this posted payment is being revised"
                    value={payEditReason}
                    onChange={(e) => setPayEditReason(e.target.value)}
                    className="w-full min-h-[40px] rounded-lg border border-amber-300 bg-amber-50/40 px-3 py-2 text-xs text-slate-900"
                  />
                </div>
              )}

              <div className="pt-2 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setPaymentModalOpen(false)}
                  className="min-h-[42px] px-4 py-2 rounded-lg border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingPayment || payCustomerId <= 0}
                  className="min-h-[42px] px-5 py-2 rounded-lg bg-slate-900 text-xs font-bold text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  {savingPayment
                    ? 'Recording...'
                    : editingPayment
                      ? 'Save Payment Revision'
                      : 'Record Payment & Credit Ledger'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {previewInvoice && (
        <InvoiceDocumentModal
          invoice={previewInvoice}
          portal="admin"
          onClose={() => setPreviewInvoice(null)}
        />
      )}
    </div>
  );
}
