import React, { useState } from 'react';
import { AlertCircle, CheckCircle2, Info, Package, Wheat, Droplets, X } from 'lucide-react';
import type { OrderStatus, ProductCategory } from '../shared/types';

export function BrbLogo({
  logoDataUrl,
  size = 'md',
}: {
  logoDataUrl: string | null;
  size?: 'sm' | 'md' | 'lg';
}) {
  const [imgFailed, setImgFailed] = useState(false);

  const dims =
    size === 'sm'
      ? 'h-9 px-2.5 text-[11px]'
      : size === 'lg'
        ? 'h-16 px-4 text-xs'
        : 'h-12 px-3 text-xs';

  if (logoDataUrl && !imgFailed) {
    const imgSize = size === 'sm' ? 'h-9 max-w-[120px]' : size === 'lg' ? 'h-16 max-w-[200px]' : 'h-12 max-w-[160px]';
    return (
      <img
        src={logoDataUrl}
        alt="BRB Cattle Feeds & Oil Mills Official Logo"
        referrerPolicy="no-referrer"
        onError={() => setImgFailed(true)}
        className={`${imgSize} w-auto object-contain shrink-0`}
      />
    );
  }

  return (
    <div
      aria-label="BRB Temporary Logo Placeholder"
      className={`${dims} inline-flex flex-col items-center justify-center rounded-lg border border-dashed border-amber-500/80 bg-amber-50 text-slate-900 shrink-0 select-none`}
    >
      <span className="font-bold tracking-tight leading-none text-slate-950">BRB</span>
      <span className="text-[9px] font-medium text-amber-900 leading-tight mt-0.5 whitespace-nowrap">
        Temporary Logo Placeholder
      </span>
    </div>
  );
}

export function ProductVisual({
  imageUrl,
  name,
  category,
  isActive = true,
  className = 'h-36 w-full',
}: {
  imageUrl: string | null;
  name: string;
  category: ProductCategory;
  isActive?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const isFeed = category === 'BRB Cattle Feed';

  if (imageUrl && !failed) {
    return (
      <div className={`relative overflow-hidden bg-slate-100 ${className}`}>
        <img
          src={imageUrl}
          alt={name}
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className={`h-full w-full object-cover ${!isActive ? 'grayscale opacity-70' : ''}`}
        />
      </div>
    );
  }

  return (
    <div
      className={`relative flex flex-col items-center justify-center overflow-hidden ${
        isFeed ? 'bg-amber-50/70 text-amber-950' : 'bg-slate-100 text-slate-800'
      } ${!isActive ? 'opacity-65 grayscale' : ''} ${className}`}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/90 shadow-xs border border-slate-200/80">
        {isFeed ? (
          <Wheat className="h-6 w-6 text-amber-700" aria-hidden="true" />
        ) : (
          <Droplets className="h-6 w-6 text-slate-700" aria-hidden="true" />
        )}
      </div>
      <span className="mt-2 px-3 text-center text-xs font-semibold text-slate-700 truncate max-w-full">
        {name}
      </span>
      <span className="text-[11px] text-slate-500">
        {isFeed ? 'Cattle Feed' : 'Oil Mill'}
      </span>
    </div>
  );
}

export function InlineAlert({
  tone,
  title,
  message,
  isUrdu = false,
  onDismiss,
}: {
  tone: 'error' | 'success' | 'info' | 'warning';
  title?: string;
  message: string;
  isUrdu?: boolean;
  onDismiss?: () => void;
}) {
  const styles = {
    error: 'bg-rose-50 border-rose-200 text-rose-950',
    success: 'bg-emerald-50 border-emerald-200 text-emerald-950',
    warning: 'bg-amber-50 border-amber-300 text-amber-950',
    info: 'bg-slate-100 border-slate-200 text-slate-900',
  }[tone];

  const Icon =
    tone === 'error'
      ? AlertCircle
      : tone === 'success'
        ? CheckCircle2
        : tone === 'warning'
          ? AlertCircle
          : Info;

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex items-start justify-between gap-3 rounded-xl border p-3.5 text-sm ${styles}`}
    >
      <div className="flex items-start gap-2.5 min-w-0 flex-1">
        <Icon className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          {title && <p className="font-semibold leading-snug mb-0.5">{title}</p>}
          <p
            dir={isUrdu ? 'rtl' : undefined}
            className={isUrdu ? 'font-urdu text-base leading-relaxed text-right' : 'leading-relaxed'}
          >
            {message}
          </p>
        </div>
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss message"
          className="min-h-[32px] min-w-[32px] inline-flex items-center justify-center rounded-lg hover:bg-black/5 transition-colors shrink-0"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Back',
  destructive = false,
  busy = false,
  children,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  children?: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="brb-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 backdrop-blur-xs p-4"
    >
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
        <h3 id="brb-dialog-title" className="text-lg font-bold text-slate-900">
          {title}
        </h3>
        <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">{description}</p>
        {children && <div className="mt-4">{children}</div>}
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`min-h-[44px] px-4 py-2 rounded-lg text-sm font-semibold text-white transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 ${
              destructive ? 'bg-rose-600 hover:bg-rose-700' : 'bg-slate-900 hover:bg-slate-800'
            }`}
          >
            {busy ? 'Processing...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function getOrderStatusToneClass(status: OrderStatus): string {
  switch (status) {
    case 'Order Received':
      return 'text-amber-700 font-semibold';
    case 'Under Review':
      return 'text-sky-700 font-semibold';
    case 'Confirmed / Partially Approved':
      return 'text-emerald-700 font-semibold';
    case 'Preparing':
      return 'text-indigo-700 font-semibold';
    case 'Dispatched':
      return 'text-blue-700 font-semibold';
    case 'Delivered':
      return 'text-emerald-800 font-semibold';
    case 'Cancelled':
      return 'text-rose-700 font-semibold';
    default:
      return 'text-slate-700 font-medium';
  }
}

export function EmptyStateBox({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
      <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
        <Package className="h-5 w-5" aria-hidden="true" />
      </div>
      <h4 className="mt-3 text-sm font-semibold text-slate-900">{title}</h4>
      <p className="mt-1 text-xs text-slate-500 max-w-md mx-auto leading-relaxed">{description}</p>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-4 min-h-[42px] px-4 py-2 rounded-lg bg-slate-900 text-xs font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
