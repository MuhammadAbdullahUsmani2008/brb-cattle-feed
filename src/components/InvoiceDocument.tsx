import React, { useState } from 'react';
import { Download, Printer, X } from 'lucide-react';
import type { InvoiceView } from '../shared/types';
import { BRAND_NAMES } from '../shared/types';
import { downloadAuthenticatedPdf } from '../lib/api';
import { BrbLogo, InlineAlert } from './Branding';

export function InvoiceDocumentModal({
  invoice,
  portal,
  onClose,
}: {
  invoice: InvoiceView;
  portal: 'customer' | 'admin';
  onClose: () => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleDownloadPdf = async () => {
    setErrorMsg(null);
    setDownloading(true);
    try {
      await downloadAuthenticatedPdf({
        portal,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to generate PDF.');
    } finally {
      setDownloading(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const snap = invoice.brandingSnapshot;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Invoice #${invoice.invoiceNumber} Preview`}
      className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/60 backdrop-blur-xs p-3 sm:p-6 print:static print:bg-white print:p-0"
    >
      <div className="mx-auto max-w-3xl rounded-2xl border border-slate-200 bg-white shadow-2xl overflow-hidden print:max-w-none print:rounded-none print:border-0 print:shadow-none">
        {/* Action Toolbar (Hidden during print) */}
        <div className="no-print flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-5 py-3.5">
          <div className="text-sm font-semibold text-slate-900">
            Official Invoice <span className="font-mono tabular-nums">#{invoice.invoiceNumber}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handlePrint}
              className="min-h-[40px] inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0"
            >
              <Printer className="h-3.5 w-3.5" aria-hidden="true" />
              Print Invoice
            </button>
            <button
              type="button"
              disabled={downloading}
              onClick={handleDownloadPdf}
              className="min-h-[40px] inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              {downloading ? 'Generating PDF...' : 'Download PDF'}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close invoice preview"
              className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 transition-colors shrink-0"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {errorMsg && (
          <div className="no-print px-6 pt-4">
            <InlineAlert tone="error" message={errorMsg} onDismiss={() => setErrorMsg(null)} />
          </div>
        )}

        {/* Printable Invoice Sheet — Mandatory Section 30 Top Sequence:
            1. Top yellow line
            2. BRB logo immediately below
            3. Large title: BRB Cattle Feed & Oil Mills */}
        <div className="bg-white">
          {/* 1. Top Yellow Line */}
          <div className="h-3.5 w-full bg-amber-400 print:bg-amber-400" />

          <div className="p-6 sm:p-8">
            {/* 2. BRB Logo Immediately Below + 3. Large Title */}
            <div className="flex flex-col items-center text-center border-b border-slate-200 pb-6">
              <BrbLogo logoDataUrl={snap.logoDataUrl} size="lg" />
              <h1 className="mt-3 text-2xl sm:text-3xl font-extrabold tracking-tight text-slate-950">
                {snap.invoiceHeading || BRAND_NAMES.invoiceHeading}
              </h1>
              {(snap.businessAddress || snap.businessPhone) && (
                <p className="mt-1 text-xs text-slate-600">
                  {[snap.businessAddress, snap.businessPhone].filter(Boolean).join(' · ')}
                </p>
              )}
            </div>

            {/* Customer & Invoice Metadata */}
            <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4 pb-6 border-b border-slate-200 text-sm">
              <div>
                <p className="text-xs font-medium text-slate-500">Billed To</p>
                <p className="mt-0.5 text-base font-bold text-slate-900">{invoice.customerName}</p>
                <p className="mt-0.5 text-xs text-slate-600">
                  Account Number:{' '}
                  <span className="font-mono font-semibold text-slate-900 tabular-nums">
                    {invoice.customerAccountNumber}
                  </span>
                </p>
              </div>
              <div className="sm:text-right">
                <p className="text-xs font-medium text-slate-500">Invoice Details</p>
                <p className="mt-0.5 text-base font-bold font-mono tabular-nums text-slate-900">
                  Invoice #{invoice.invoiceNumber}
                </p>
                <p className="mt-0.5 text-xs text-slate-600 font-mono tabular-nums">
                  Date: {invoice.invoiceDate}
                  {invoice.sourceOrderNumber ? ` · Order ${invoice.sourceOrderNumber}` : ' · Direct Invoice'}
                  {invoice.revisionCount > 0 ? ` · Rev ${invoice.revisionCount}` : ''}
                </p>
              </div>
            </div>

            {/* Line Items Table */}
            <div className="mt-6 overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b-2 border-slate-900 text-xs font-semibold text-slate-700">
                    <th className="py-2.5 pr-3 w-10">#</th>
                    <th className="py-2.5 px-3">Product Description</th>
                    <th className="py-2.5 px-3">Packing</th>
                    <th className="py-2.5 px-3 text-right">Qty</th>
                    <th className="py-2.5 px-3 text-right">Rate</th>
                    <th className="py-2.5 pl-3 text-right">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {invoice.items.map((item, index) => (
                    <tr key={item.id || index}>
                      <td className="py-3 pr-3 font-mono tabular-nums text-xs text-slate-500">
                        {index + 1}
                      </td>
                      <td className="py-3 px-3 font-medium text-slate-900">{item.productName}</td>
                      <td className="py-3 px-3 text-slate-600 whitespace-nowrap">{item.packingWeight || '—'}</td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums font-medium text-slate-900">
                        {item.quantity}
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                        {item.rateFormatted}
                      </td>
                      <td className="py-3 pl-3 text-right font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                        {item.lineTotalFormatted}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Grand Total Row */}
            <div className="mt-6 flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-t-2 border-slate-900 pt-4">
              <div className="text-xs text-slate-600 max-w-md">
                {invoice.notes && (
                  <p>
                    <span className="font-semibold text-slate-800">Notes:</span> {invoice.notes}
                  </p>
                )}
                {snap.footerNote && <p className="mt-1 text-slate-500">{snap.footerNote}</p>}
              </div>
              <div className="flex items-baseline justify-between sm:justify-end gap-6">
                <span className="text-sm font-semibold text-slate-600">Grand Total</span>
                <span className="text-2xl font-extrabold font-mono tabular-nums text-slate-950 whitespace-nowrap">
                  {invoice.grandTotalFormatted}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
