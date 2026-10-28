import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateInvoiceTotals,
  canCustomerCancelOrder,
  computeRunningBalances,
  computeTwelveMonthCutoffDate,
  describeApprovedItemStatus,
  formatCustomerAccountNumber,
  formatPaisa,
  isValidAdminOrderTransition,
  parseMoneyToPaisa,
  validateOrderApprovalItems,
} from './domain.ts';
import { URDU_MESSAGES } from './types.ts';

test('Customer sequential account formatting begins at BRB-C-ID131 and increments cleanly', () => {
  assert.equal(formatCustomerAccountNumber(131), 'BRB-C-ID131');
  assert.equal(formatCustomerAccountNumber(132), 'BRB-C-ID132');
  assert.equal(formatCustomerAccountNumber(133), 'BRB-C-ID133');
  assert.equal(formatCustomerAccountNumber(134), 'BRB-C-ID134');
  assert.throws(() => formatCustomerAccountNumber(0));
});

test('Decimal-safe paisa monetary arithmetic avoids floating-point drift', () => {
  assert.equal(parseMoneyToPaisa('85000'), 8_500_000);
  assert.equal(parseMoneyToPaisa('85,000.50'), 8_500_050);
  assert.equal(parseMoneyToPaisa(0.1) + parseMoneyToPaisa(0.2), 30);
  assert.equal(formatPaisa(8_500_000, 'Rs.'), 'Rs. 85,000');
  assert.equal(formatPaisa(8_500_050, 'Rs.'), 'Rs. 85,000.50');
  assert.equal(
    URDU_MESSAGES.newInvoiceAddedTemplate(formatPaisa(8_500_000, 'Rs.')),
    'آپ کے اکاؤنٹ میں Rs. 85,000 کی نئی Invoice شامل کی گئی ہے۔'
  );
  assert.throws(() => parseMoneyToPaisa('-100'));
  assert.throws(() => parseMoneyToPaisa('12.345'));
});

test('Invoice line totals and grand totals compute accurately', () => {
  const res = calculateInvoiceTotals([
    { quantity: 10, ratePaisa: parseMoneyToPaisa('4250') },
    { quantity: 20, ratePaisa: parseMoneyToPaisa('2125') },
  ]);
  assert.deepEqual(res.lineTotalsPaisa, [4_250_000, 4_250_000]);
  assert.equal(res.grandTotalPaisa, 8_500_000);
  assert.throws(() => calculateInvoiceTotals([{ quantity: 0, ratePaisa: 1000 }]));
  assert.throws(() => calculateInvoiceTotals([{ quantity: 5, ratePaisa: 0 }]));
});

test('Running ledger balances agree with opening + debits - credits including partial & overpayments', () => {
  const entries = [
    { id: 1, entryDate: '2026-08-01', createdAt: '2026-08-01T10:00:00Z', debitPaisa: 8_500_000, creditPaisa: 0 },
    { id: 2, entryDate: '2026-08-05', createdAt: '2026-08-05T10:00:00Z', debitPaisa: 0, creditPaisa: 3_500_000 },
    { id: 3, entryDate: '2026-08-10', createdAt: '2026-08-10T10:00:00Z', debitPaisa: 0, creditPaisa: 6_000_000 },
  ];
  const { entriesWithRunning, finalBalancePaisa } = computeRunningBalances(entries, 0);
  assert.equal(entriesWithRunning[0].runningBalancePaisa, 8_500_000);
  assert.equal(entriesWithRunning[1].runningBalancePaisa, 5_000_000); // partial payment
  assert.equal(entriesWithRunning[2].runningBalancePaisa, -1_000_000); // overpayment credit balance
  assert.equal(finalBalancePaisa, -1_000_000);
});

test('Order approval enforces mandatory reduction reason and labels Added by BRB items', () => {
  const requested = [
    { requestedItemId: 101, productId: 1, requestedQty: 10 },
    { requestedItemId: 102, productId: 2, requestedQty: 20 },
  ];

  // Missing reduction reason on reduced quantity fails
  const missingReason = validateOrderApprovalItems(requested, [
    { requestedItemId: 101, productId: 1, approvedQty: 5, reductionReason: '' },
    { requestedItemId: 102, productId: 2, approvedQty: 20 },
  ]);
  assert.equal(missingReason.valid, false);

  // Valid partial approval with Urdu reason + Added by BRB item passes
  const validPartial = validateOrderApprovalItems(requested, [
    {
      requestedItemId: 101,
      productId: 1,
      approvedQty: 5,
      reductionReason: 'Stock کم ہونے کی وجہ سے 5 Bags approve کیے گئے۔',
    },
    {
      requestedItemId: 102,
      productId: 2,
      approvedQty: 15,
      reductionReason: 'Stock کم ہونے کی وجہ سے 15 Bags approve کیے گئے۔',
    },
    {
      requestedItemId: null,
      productId: 3,
      approvedQty: 5,
    },
  ]);
  assert.equal(validPartial.valid, true);

  assert.equal(describeApprovedItemStatus(10, 10, false), 'Fully Approved');
  assert.equal(describeApprovedItemStatus(10, 5, false), '5 Bags Approved');
  assert.equal(describeApprovedItemStatus(null, 5, true), 'Added by BRB');
});

test('Customer cancellation and Admin status transitions strictly obey specification', () => {
  assert.equal(canCustomerCancelOrder('Order Received'), true);
  assert.equal(canCustomerCancelOrder('Under Review'), true);
  assert.equal(canCustomerCancelOrder('Confirmed / Partially Approved'), false);
  assert.equal(canCustomerCancelOrder('Preparing'), false);
  assert.equal(canCustomerCancelOrder('Dispatched'), false);
  assert.equal(canCustomerCancelOrder('Delivered'), false);
  assert.equal(canCustomerCancelOrder('Cancelled'), false);

  assert.equal(isValidAdminOrderTransition('Order Received', 'Under Review'), true);
  assert.equal(isValidAdminOrderTransition('Under Review', 'Confirmed / Partially Approved'), true);
  assert.equal(isValidAdminOrderTransition('Confirmed / Partially Approved', 'Preparing'), true);
  assert.equal(isValidAdminOrderTransition('Preparing', 'Dispatched'), true);
  assert.equal(isValidAdminOrderTransition('Dispatched', 'Delivered'), true);
  // Cannot jump directly from Order Received to Delivered bypassing approval!
  assert.equal(isValidAdminOrderTransition('Order Received', 'Delivered'), false);
});

test('12-month ledger cutoff computes exact prior-year boundary including leap-day safety', () => {
  assert.equal(
    computeTwelveMonthCutoffDate(new Date('2026-10-28T12:00:00Z'), 'Asia/Karachi'),
    '2025-10-28'
  );
  // Leap day Feb 29, 2024 -> Feb 28, 2023
  assert.equal(
    computeTwelveMonthCutoffDate(new Date('2024-02-29T12:00:00Z'), 'UTC'),
    '2023-02-28'
  );
});
