import {
  ADMIN_PERMISSIONS,
  CUSTOMER_CANCELLABLE_STATUSES,
  ORDER_STATUSES,
  PRODUCT_CATEGORIES,
  PRODUCT_USAGES,
  PAYMENT_METHODS,
} from './types.ts';
import type {
  AdminPermission,
  AdminRole,
  OrderStatus,
  PaymentMethod,
  ProductCategory,
  ProductUsage,
} from './types.ts';

/**
 * Formats sequential customer account number: BRB-C-ID131, BRB-C-ID132...
 */
export function formatCustomerAccountNumber(sequenceNumber: number): string {
  if (!Number.isInteger(sequenceNumber) || sequenceNumber < 1) {
    throw new Error('Customer sequence number must be a positive integer.');
  }
  return `BRB-C-ID${sequenceNumber}`;
}

export function normalizeAccountNumber(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isValidAccountNumberFormat(accountNumber: string): boolean {
  return /^BRB-C-ID\d{1,10}$/.test(normalizeAccountNumber(accountNumber));
}

export function normalizePakistaniMobile(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '').trim();
  if (digits.startsWith('+92') && digits.length === 13) {
    return digits;
  }
  if (digits.startsWith('92') && digits.length === 12) {
    return `+${digits}`;
  }
  if (digits.startsWith('03') && digits.length === 11) {
    return `+92${digits.slice(1)}`;
  }
  return digits;
}

export function isValidMobileNumber(raw: string): boolean {
  const norm = normalizePakistaniMobile(raw);
  return /^\+?\d{10,15}$/.test(norm);
}

/**
 * Decimal-safe monetary conversion: converts human currency string or number
 * (up to 2 decimal places) into integer paisa (cents) without float drift.
 */
export function parseMoneyToPaisa(input: string | number): number {
  const raw = typeof input === 'number' ? input.toFixed(4) : String(input).trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?(\d*)?$/.test(raw)) {
    throw new Error('Monetary amount must be a valid non-negative number.');
  }
  const parts = raw.split('.');
  const wholeStr = parts[0] || '0';
  const fracRaw = parts[1] || '';
  if (fracRaw.length > 2 && !/^0*$/.test(fracRaw.slice(2))) {
    throw new Error('Monetary amount supports at most 2 decimal places.');
  }
  const fracPadded = (fracRaw + '00').slice(0, 2);
  const whole = Number(wholeStr);
  const frac = Number(fracPadded);
  const totalPaisa = whole * 100 + frac;
  if (!Number.isSafeInteger(totalPaisa) || totalPaisa < 0 || totalPaisa > 900_000_000_000) {
    throw new Error('Monetary amount is out of safe bounds.');
  }
  return totalPaisa;
}

/**
 * Formats integer paisa into human-readable currency string (e.g. "Rs. 85,000" or "Rs. 85,000.50").
 */
export function formatPaisa(paisa: number, currencySymbol = 'Rs.', alwaysShowDecimals = false): string {
  if (!Number.isSafeInteger(paisa)) {
    throw new Error('Balance/amount must be an integer paisa value.');
  }
  const isNegative = paisa < 0;
  const abs = Math.abs(paisa);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const formattedWhole = whole.toLocaleString('en-US');
  const decimals = frac > 0 || alwaysShowDecimals ? `.${String(frac).padStart(2, '0')}` : '';
  return `${isNegative ? '-' : ''}${currencySymbol} ${formattedWhole}${decimals}`;
}

export interface InvoiceLineCalcInput {
  quantity: number;
  ratePaisa: number;
}

export interface InvoiceCalcResult {
  lineTotalsPaisa: number[];
  grandTotalPaisa: number;
}

/**
 * Authoritative invoice line and grand-total calculation using integer paisa.
 */
export function calculateInvoiceTotals(items: InvoiceLineCalcInput[]): InvoiceCalcResult {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('At least one invoice line item is required.');
  }
  let grandTotalPaisa = 0;
  const lineTotalsPaisa = items.map((item, idx) => {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0 || item.quantity > 1_000_000) {
      throw new Error(`Line item ${idx + 1}: quantity must be a positive whole number.`);
    }
    if (!Number.isSafeInteger(item.ratePaisa) || item.ratePaisa <= 0) {
      throw new Error(`Line item ${idx + 1}: rate must be greater than zero.`);
    }
    const lineTotal = item.quantity * item.ratePaisa;
    if (!Number.isSafeInteger(lineTotal)) {
      throw new Error(`Line item ${idx + 1}: total exceeds safe monetary bounds.`);
    }
    grandTotalPaisa += lineTotal;
    if (!Number.isSafeInteger(grandTotalPaisa)) {
      throw new Error('Invoice grand total exceeds safe monetary bounds.');
    }
    return lineTotal;
  });

  return { lineTotalsPaisa, grandTotalPaisa };
}

export interface RawLedgerItem {
  id: number;
  entryDate: string;
  createdAt: string;
  debitPaisa: number;
  creditPaisa: number;
}

/**
 * Computes chronological running balances and authoritative current outstanding balance:
 * Outstanding Balance = openingBalancePaisa + sum(debitPaisa) - sum(creditPaisa).
 */
export function computeRunningBalances<T extends RawLedgerItem>(
  entriesChronological: T[],
  openingBalancePaisa = 0
): { entriesWithRunning: Array<T & { runningBalancePaisa: number }>; finalBalancePaisa: number } {
  let running = openingBalancePaisa;
  const entriesWithRunning = entriesChronological.map((entry) => {
    running = running + entry.debitPaisa - entry.creditPaisa;
    return { ...entry, runningBalancePaisa: running };
  });
  return { entriesWithRunning, finalBalancePaisa: running };
}

/**
 * Validates order status transition rules for customer vs admin actors.
 */
export function canCustomerCancelOrder(currentStatus: OrderStatus): boolean {
  return CUSTOMER_CANCELLABLE_STATUSES.includes(currentStatus);
}

const ADMIN_ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  'Order Received': ['Under Review', 'Confirmed / Partially Approved', 'Cancelled'],
  'Under Review': ['Confirmed / Partially Approved', 'Cancelled'],
  'Confirmed / Partially Approved': ['Preparing'],
  Preparing: ['Dispatched'],
  Dispatched: ['Delivered'],
  Delivered: [],
  Cancelled: [],
};

export function isValidAdminOrderTransition(fromStatus: OrderStatus, toStatus: OrderStatus): boolean {
  return ADMIN_ALLOWED_TRANSITIONS[fromStatus]?.includes(toStatus) ?? false;
}

export interface RequestedItemSpec {
  requestedItemId: number;
  productId: number;
  requestedQty: number;
}

export interface ApprovedItemInput {
  requestedItemId?: number | null;
  productId: number;
  approvedQty: number;
  reductionReason?: string | null;
}

/**
 * Validates order approval rules:
 * - Every original requested item must be accounted for without mutating original request.
 * - If approvedQty < requestedQty, a non-empty reductionReason is mandatory.
 * - Additional items without requestedItemId are permitted and marked as Added by BRB (must have approvedQty > 0).
 */
export function validateOrderApprovalItems(
  requestedItems: RequestedItemSpec[],
  approvedInputs: ApprovedItemInput[]
): { valid: true } | { valid: false; error: string } {
  if (requestedItems.length === 0) {
    return { valid: false, error: 'Order has no original requested items.' };
  }
  const byRequestedId = new Map<number, ApprovedItemInput>();
  for (const inp of approvedInputs) {
    if (!Number.isInteger(inp.approvedQty) || inp.approvedQty < 0 || inp.approvedQty > 1_000_000) {
      return { valid: false, error: 'Approved quantities must be whole numbers >= 0.' };
    }
    if (inp.requestedItemId != null) {
      if (byRequestedId.has(inp.requestedItemId)) {
        return { valid: false, error: 'Duplicate approval entry for a requested item.' };
      }
      byRequestedId.set(inp.requestedItemId, inp);
    } else {
      if (inp.approvedQty <= 0) {
        return { valid: false, error: 'Products added by BRB must have a quantity of at least 1.' };
      }
    }
  }

  let totalApprovedAcrossAll = 0;
  for (const reqItem of requestedItems) {
    const decision = byRequestedId.get(reqItem.requestedItemId);
    if (!decision) {
      return {
        valid: false,
        error: `Missing approval quantity decision for requested item #${reqItem.requestedItemId}.`,
      };
    }
    if (decision.approvedQty < reqItem.requestedQty) {
      const reason = (decision.reductionReason ?? '').trim();
      if (reason.length < 3) {
        return {
          valid: false,
          error:
            'A reduction reason is mandatory whenever an approved quantity is less than the customer requested quantity.',
        };
      }
    }
    totalApprovedAcrossAll += decision.approvedQty;
  }

  for (const inp of approvedInputs) {
    if (inp.requestedItemId == null) {
      totalApprovedAcrossAll += inp.approvedQty;
    }
  }

  if (totalApprovedAcrossAll <= 0) {
    return {
      valid: false,
      error: 'At least one item must have a positive approved quantity to confirm an order (otherwise cancel the order).',
    };
  }

  return { valid: true };
}

/**
 * Formats item-level comparison status label for Customer Order view (Section 22).
 */
export function describeApprovedItemStatus(
  requestedQty: number | null,
  approvedQty: number,
  isAddedByBrb: boolean,
  unitLabel = 'Bags'
): string {
  if (isAddedByBrb || requestedQty == null) {
    return 'Added by BRB';
  }
  if (approvedQty >= requestedQty) {
    return 'Fully Approved';
  }
  if (approvedQty === 0) {
    return `0 ${unitLabel} Approved`;
  }
  return `${approvedQty} ${unitLabel} Approved`;
}

/**
 * Computes the YYYY-MM-DD date string representing exactly 12 months prior to referenceDate
 * in the configured IANA timezone (default Asia/Karachi) for the customer 12-month ledger rule.
 */
export function computeTwelveMonthCutoffDate(
  referenceDate: Date = new Date(),
  timeZone = 'Asia/Karachi'
): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const localToday = formatter.format(referenceDate); // YYYY-MM-DD
  const [yStr, mStr, dStr] = localToday.split('-');
  const year = Number(yStr) - 1;
  const month = Number(mStr);
  const day = Number(dStr);
  // Handle Feb 29 -> Feb 28 in non-leap year
  const maxDayInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const clampedDay = Math.min(day, maxDayInMonth);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`;
}

/**
 * Default proposed least-privilege permissions per administrative role (Section 42).
 */
export function getDefaultPermissionsForRole(role: AdminRole): AdminPermission[] {
  switch (role) {
    case 'main_admin':
      return [...ADMIN_PERMISSIONS];
    case 'customer_staff':
      return ['manage_customers', 'approve_registrations', 'block_customers', 'send_notifications'];
    case 'order_staff':
      return ['manage_products', 'manage_orders', 'send_notifications'];
    case 'finance_staff':
      return ['manage_invoices', 'manage_payments', 'view_full_ledger', 'view_reports', 'send_notifications'];
    case 'report_viewer':
      return ['view_full_ledger', 'view_reports'];
  }
}

export function isValidProductCategory(val: unknown): val is ProductCategory {
  return typeof val === 'string' && (PRODUCT_CATEGORIES as readonly string[]).includes(val);
}

export function isValidProductUsage(val: unknown): val is ProductUsage {
  return typeof val === 'string' && (PRODUCT_USAGES as readonly string[]).includes(val);
}

export function isValidPaymentMethod(val: unknown): val is PaymentMethod {
  return typeof val === 'string' && (PAYMENT_METHODS as readonly string[]).includes(val);
}

export function isValidOrderStatus(val: unknown): val is OrderStatus {
  return typeof val === 'string' && (ORDER_STATUSES as readonly string[]).includes(val);
}
