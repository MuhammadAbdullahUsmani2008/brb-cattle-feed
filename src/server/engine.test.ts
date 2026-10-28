import test from 'node:test';
import assert from 'node:assert/strict';
import { openBrbDatabase } from './db.ts';
import { AppError, BrbEngine } from './engine.ts';
import { generateInvoicePdfBuffer } from './pdf.ts';
import { URDU_MESSAGES } from '../shared/types.ts';

function createIsolatedEngine() {
  const db = openBrbDatabase(':memory:');
  const engine = new BrbEngine(db);
  return { db, engine };
}

test('End-to-End Acceptance: Admin Bootstrap, Sequential Customers, OTP Registration, Approval, Blocking & Isolation', async () => {
  const { db, engine } = createIsolatedEngine();

  // 1. Controlled initial admin setup starting at BRB-C-ID131 and Invoice #5001
  const { admin: mainAdmin, token: adminToken } = engine.bootstrapMainAdmin({
    username: 'brb_admin',
    email: 'admin@brbfeed.pk',
    displayName: 'BRB Main Administrator',
    mobileNumber: '03001112222',
    password: 'StrongAdminPassword!2026',
    startingCustomerSeq: 131,
    startingInvoiceNumber: 5001,
  });

  // Second bootstrap call must be rejected forever
  assert.throws(
    () =>
      engine.bootstrapMainAdmin({
        username: 'attacker',
        email: 'attacker@evil.com',
        displayName: 'Attacker',
        password: 'Password123!',
      }),
    (err: unknown) => err instanceof AppError && err.status === 403
  );

  // 2. Sequential Customer Account Allocation: BRB-C-ID131, BRB-C-ID132, BRB-C-ID133
  const custA = engine.createCustomerByAdmin(mainAdmin, {
    name: 'Chaudhry Dairy Farm',
    mobileNumber: '03001234567',
    city: 'Sahiwal',
  });
  const custB = engine.createCustomerByAdmin(mainAdmin, {
    name: 'Al-Madina Cattle Ranch',
    mobileNumber: '03007654321',
    city: 'Okara',
  });
  const custC = engine.createCustomerByAdmin(mainAdmin, {
    name: 'Rejected Test Account',
    mobileNumber: '03009998888',
    city: 'Multan',
  });

  assert.equal(custA.accountNumber, 'BRB-C-ID131');
  assert.equal(custB.accountNumber, 'BRB-C-ID132');
  assert.equal(custC.accountNumber, 'BRB-C-ID133');

  // 3. Customer A registers -> OTP -> Pending Approval (cannot log in yet!)
  const regA = await engine.startCustomerRegistration({
    accountNumber: 'BRB-C-ID131',
    mobileNumber: '03001234567',
    password: 'CustomerPass123',
    confirmPassword: 'CustomerPass123',
  });
  assert.ok(regA.devSandboxOtp);

  // Wrong OTP increments attempts and fails
  assert.throws(
    () => engine.verifyCustomerRegistrationOtp({ accountNumber: 'BRB-C-ID131', otp: '000000' }),
    (err: unknown) => err instanceof AppError && err.code === 'INVALID_OTP'
  );

  // Correct OTP transitions to pending_approval
  const verifiedA = engine.verifyCustomerRegistrationOtp({
    accountNumber: 'BRB-C-ID131',
    otp: regA.devSandboxOtp!,
  });
  assert.equal(verifiedA.status, 'pending_approval');

  // Pending approval customer cannot log in
  assert.throws(
    () => engine.loginCustomer({ accountNumber: 'BRB-C-ID131', password: 'CustomerPass123' }),
    (err: unknown) => err instanceof AppError && err.code === 'PENDING_APPROVAL'
  );

  // 4. Customer C registers, verifies OTP, and is REJECTED by Admin -> cannot log in or re-register
  const regC = await engine.startCustomerRegistration({
    accountNumber: 'BRB-C-ID133',
    mobileNumber: '03009998888',
    password: 'CustomerPass123',
    confirmPassword: 'CustomerPass123',
  });
  engine.verifyCustomerRegistrationOtp({ accountNumber: 'BRB-C-ID133', otp: regC.devSandboxOtp! });
  await engine.approveOrRejectCustomerRegistration(mainAdmin, custC.id, 'reject', 'Duplicate dealer record');

  assert.throws(
    () => engine.loginCustomer({ accountNumber: 'BRB-C-ID133', password: 'CustomerPass123' }),
    (err: unknown) => err instanceof AppError && err.code === 'ACCOUNT_REJECTED'
  );

  // 5. Approve Customer A and Customer B
  await engine.approveOrRejectCustomerRegistration(mainAdmin, custA.id, 'approve');
  const regB = await engine.startCustomerRegistration({
    accountNumber: 'BRB-C-ID132',
    mobileNumber: '03007654321',
    password: 'CustomerBPass123',
    confirmPassword: 'CustomerBPass123',
  });
  engine.verifyCustomerRegistrationOtp({ accountNumber: 'BRB-C-ID132', otp: regB.devSandboxOtp! });
  await engine.approveOrRejectCustomerRegistration(mainAdmin, custB.id, 'approve');

  const sessionA = engine.loginCustomer({ accountNumber: 'BRB-C-ID131', password: 'CustomerPass123' });
  const sessionB = engine.loginCustomer({ accountNumber: 'BRB-C-ID132', password: 'CustomerBPass123' });

  // 6. Customer token must NEVER authenticate as Admin
  assert.throws(
    () => engine.authenticateAdminToken(sessionA.token),
    (err: unknown) => err instanceof AppError && err.status === 401
  );
  assert.equal(engine.authenticateAdminToken(adminToken).id, mainAdmin.id);

  // 7. Account Blocking immediately revokes active sessions and returns exact Urdu message
  await engine.setCustomerBlockState(mainAdmin, custB.id, true, 'Overdue settlement review');
  assert.throws(
    () => engine.authenticateCustomerToken(sessionB.token),
    (err: unknown) =>
      err instanceof AppError &&
      err.code === 'ACCOUNT_BLOCKED' &&
      err.message === URDU_MESSAGES.accountBlocked
  );
  assert.throws(
    () => engine.loginCustomer({ accountNumber: 'BRB-C-ID132', password: 'CustomerBPass123' }),
    (err: unknown) =>
      err instanceof AppError &&
      err.code === 'ACCOUNT_BLOCKED' &&
      err.message === URDU_MESSAGES.accountBlocked
  );

  // Unblocking restores login capability (with fresh session)
  await engine.setCustomerBlockState(mainAdmin, custB.id, false);
  const freshSessionB = engine.loginCustomer({ accountNumber: 'BRB-C-ID132', password: 'CustomerBPass123' });
  assert.equal(freshSessionB.customer.accountNumber, 'BRB-C-ID132');

  db.close();
});

test('End-to-End Acceptance: Products, Mixed-Category Orders, Immutable Request, Reduction Reason, Added by BRB & Cancellation', async () => {
  const { db, engine } = createIsolatedEngine();
  const { admin } = engine.bootstrapMainAdmin({
    username: 'brb_admin',
    email: 'admin@brbfeed.pk',
    displayName: 'Main Admin',
    password: 'StrongAdminPassword!2026',
  });

  const c1 = engine.createCustomerByAdmin(admin, { name: 'Customer One', mobileNumber: '03001234567' });
  const c2 = engine.createCustomerByAdmin(admin, { name: 'Customer Two', mobileNumber: '03002223333' });
  const r1 = await engine.startCustomerRegistration({
    accountNumber: c1.accountNumber,
    mobileNumber: '03001234567',
    password: 'Password123',
    confirmPassword: 'Password123',
  });
  engine.verifyCustomerRegistrationOtp({ accountNumber: c1.accountNumber, otp: r1.devSandboxOtp! });
  await engine.approveOrRejectCustomerRegistration(admin, c1.id, 'approve');

  const r2 = await engine.startCustomerRegistration({
    accountNumber: c2.accountNumber,
    mobileNumber: '03002223333',
    password: 'Password123',
    confirmPassword: 'Password123',
  });
  engine.verifyCustomerRegistrationOtp({ accountNumber: c2.accountNumber, otp: r2.devSandboxOtp! });
  await engine.approveOrRejectCustomerRegistration(admin, c2.id, 'approve');

  const authC1 = engine.authenticateCustomerToken(
    engine.loginCustomer({ accountNumber: c1.accountNumber, password: 'Password123' }).token
  );
  const authC2 = engine.authenticateCustomerToken(
    engine.loginCustomer({ accountNumber: c2.accountNumber, password: 'Password123' }).token
  );

  // Create products across BOTH categories (Section 17 & 22) + 1 deactivated product
  const gold = engine.createProduct(admin, {
    name: 'Gold',
    category: 'BRB Cattle Feed',
    packingWeight: '40 kg Bag',
    usage: 'Milk',
    shortDescription: 'High-yield dairy concentrate.',
    fullDetails: 'Balanced nutrition feed for lactating cattle.',
  });
  const wanda = engine.createProduct(admin, {
    name: 'Wanda',
    category: 'BRB Cattle Feed',
    packingWeight: '40 kg Bag',
    usage: 'Both',
    shortDescription: 'All-purpose cattle feed.',
    fullDetails: 'Suitable for milk and meat herds.',
  });
  const shahi = engine.createProduct(admin, {
    name: 'Shahi Special',
    category: 'BRB Oil Mill',
    packingWeight: '35 kg Cake Bag',
    usage: 'Meat',
    shortDescription: 'Premium oilseed cake.',
    fullDetails: 'Cold-pressed oil mill specialty.',
  });
  const inactiveProd = engine.createProduct(admin, {
    name: 'Seasonal Blend',
    category: 'BRB Oil Mill',
    packingWeight: '40 kg Bag',
    usage: 'Both',
    shortDescription: 'Out of season formula.',
    fullDetails: 'Temporarily deactivated.',
    isActive: false,
  });

  // Customer product view contains deactivated item (visible!) and ZERO price properties
  const custProds = engine.listProductsForCustomer();
  assert.equal(custProds.length, 4);
  for (const p of custProds) {
    assert.equal('price' in p, false);
    assert.equal('rate' in p, false);
  }
  assert.equal(custProds.find((p) => p.id === inactiveProd.id)?.isActive, false);

  // Ordering deactivated product is rejected on backend
  await assert.rejects(
    () =>
      engine.submitCustomerOrder(authC1, {
        items: [{ productId: inactiveProd.id, quantity: 5 }],
      }),
    (err: unknown) => err instanceof AppError && err.code === 'PRODUCT_UNAVAILABLE'
  );

  // Submit mixed-category order with idempotency key (Gold: 10, Wanda: 20, Shahi Special: 4)
  const order1 = await engine.submitCustomerOrder(authC1, {
    idempotencyKey: 'idem-order-1',
    items: [
      { productId: gold.id, quantity: 10 },
      { productId: wanda.id, quantity: 20 },
    ],
  });
  // Retry with same idempotencyKey returns exact same order without duplicating
  const order1Retry = await engine.submitCustomerOrder(authC1, {
    idempotencyKey: 'idem-order-1',
    items: [
      { productId: gold.id, quantity: 10 },
      { productId: wanda.id, quantity: 20 },
    ],
  });
  assert.equal(order1.id, order1Retry.id);
  assert.equal(order1.status, 'Order Received');

  // Customer 2 CANNOT read or cancel Customer 1's order!
  assert.throws(
    () => engine.getCustomerOrderById(authC2, order1.id),
    (err: unknown) => err instanceof AppError && err.status === 404
  );

  // Admin approval WITHOUT reduction reason when reducing Gold 10 -> 5 MUST fail!
  await assert.rejects(
    () =>
      engine.approveOrderByAdmin(admin, order1.id, {
        items: [
          { requestedItemId: order1.requestedItems[0].id, productId: gold.id, approvedQty: 5, reductionReason: '' },
          { requestedItemId: order1.requestedItems[1].id, productId: wanda.id, approvedQty: 20 },
        ],
      }),
    (err: unknown) => err instanceof AppError && err.code === 'APPROVAL_VALIDATION_FAILED'
  );

  // Valid partial approval (Gold 10->5, Wanda 20->15 with Urdu reason) + Added by BRB (Shahi Special: 5)
  const approvedOrder = await engine.approveOrderByAdmin(admin, order1.id, {
    items: [
      {
        requestedItemId: order1.requestedItems[0].id,
        productId: gold.id,
        approvedQty: 5,
        reductionReason: 'Stock کم ہونے کی وجہ سے 5 Bags approve کیے گئے۔',
      },
      {
        requestedItemId: order1.requestedItems[1].id,
        productId: wanda.id,
        approvedQty: 15,
        reductionReason: 'Stock کم ہونے کی وجہ سے 15 Bags approve کیے گئے۔',
      },
      {
        requestedItemId: null,
        productId: shahi.id,
        approvedQty: 5,
      },
    ],
  });

  // Original request MUST remain completely unchanged!
  assert.equal(approvedOrder.requestedItems[0].requestedQty, 10);
  assert.equal(approvedOrder.requestedItems[1].requestedQty, 20);
  assert.equal(approvedOrder.approvedItems.length, 3);
  assert.equal(approvedOrder.approvedItems[2].isAddedByBrb, true);
  assert.equal(approvedOrder.status, 'Confirmed / Partially Approved');

  // Customer cancellation MUST fail once Confirmed / Partially Approved!
  assert.throws(
    () => engine.cancelCustomerOrder(authC1, order1.id),
    (err: unknown) => err instanceof AppError && err.code === 'CANCELLATION_NOT_ALLOWED'
  );

  // Separate order in "Order Received" CAN be cancelled and stays in history
  const cancellableOrder = await engine.submitCustomerOrder(authC1, {
    items: [{ productId: gold.id, quantity: 3 }],
  });
  const cancelled = engine.cancelCustomerOrder(authC1, cancellableOrder.id);
  assert.equal(cancelled.status, 'Cancelled');
  const historyList = engine.listOrdersForCustomer(authC1);
  assert.ok(historyList.some((o) => o.id === cancellableOrder.id && o.status === 'Cancelled'));

  db.close();
});

test('End-to-End Acceptance: Invoices (Order & Offline), Sequential 5001+, PDF Generation, Payments, 12-Month Ledger & Backup/Restore', async () => {
  const { db, engine } = createIsolatedEngine();
  const { admin } = engine.bootstrapMainAdmin({
    username: 'brb_admin',
    email: 'admin@brbfeed.pk',
    displayName: 'Main Admin',
    password: 'StrongAdminPassword!2026',
    startingCustomerSeq: 131,
    startingInvoiceNumber: 5001,
  });

  const cust = engine.createCustomerByAdmin(admin, {
    name: 'Mian Dairy & Cattle',
    mobileNumber: '03005556666',
  });
  const reg = await engine.startCustomerRegistration({
    accountNumber: cust.accountNumber,
    mobileNumber: '03005556666',
    password: 'Password123',
    confirmPassword: 'Password123',
  });
  engine.verifyCustomerRegistrationOtp({ accountNumber: cust.accountNumber, otp: reg.devSandboxOtp! });
  await engine.approveOrRejectCustomerRegistration(admin, cust.id, 'approve');
  const authCust = engine.authenticateCustomerToken(
    engine.loginCustomer({ accountNumber: cust.accountNumber, password: 'Password123' }).token
  );

  const prod = engine.createProduct(admin, {
    name: 'BRB Gold Super High-Protein Lactation Concentrate Formula',
    category: 'BRB Cattle Feed',
    packingWeight: '40 kg Bag',
    usage: 'Milk',
    shortDescription: 'Concentrate feed.',
    fullDetails: 'Full feed details.',
  });

  // 1. Historical offline invoice older than 12 months (e.g. 2025-05-10 vs reference 2026-10-28): Rs. 20,000
  const oldInv = await engine.createInvoice(admin, {
    customerId: cust.id,
    invoiceDate: '2025-05-10',
    idempotencyKey: 'inv-old-1',
    items: [{ productId: prod.id, quantity: 5, rate: '4000' }],
  });
  assert.equal(oldInv.invoiceNumber, 5001);
  assert.equal(oldInv.grandTotalFormatted, 'Rs. 20,000');

  // 2. Approved Order -> Order-Linked Invoice (#5002) on 2026-10-20 for Rs. 85,000
  const ord = await engine.submitCustomerOrder(authCust, {
    items: [{ productId: prod.id, quantity: 20 }],
  });
  await engine.approveOrderByAdmin(admin, ord.id, {
    items: [{ requestedItemId: ord.requestedItems[0].id, productId: prod.id, approvedQty: 20 }],
  });

  const orderInv = await engine.createInvoice(admin, {
    customerId: cust.id,
    sourceOrderId: ord.id,
    invoiceDate: '2026-10-20',
    items: [{ productId: prod.id, quantity: 20, rate: '4250' }],
  });
  assert.equal(orderInv.invoiceNumber, 5002);
  assert.equal(orderInv.grandTotalFormatted, 'Rs. 85,000');

  // Duplicate invoicing of the same order must be blocked!
  await assert.rejects(
    () =>
      engine.createInvoice(admin, {
        customerId: cust.id,
        sourceOrderId: ord.id,
        invoiceDate: '2026-10-20',
        items: [{ productId: prod.id, quantity: 20, rate: '4250' }],
      }),
    (err: unknown) => err instanceof AppError && err.code === 'DUPLICATE_ORDER_INVOICE'
  );

  // Verify exact Urdu notification message for Rs. 85,000 invoice!
  const notifs = engine.listCustomerNotifications(authCust);
  assert.ok(
    notifs.some((n) => n.message === 'آپ کے اکاؤنٹ میں Rs. 85,000 کی نئی Invoice شامل کی گئی ہے۔')
  );

  // 3. Payment Recording (Bank Transfer: Rs. 35,000) -> Balance becomes 20,000 + 85,000 - 35,000 = Rs. 70,000
  const pay1 = await engine.createPayment(admin, {
    customerId: cust.id,
    amount: '35000',
    paymentDate: '2026-10-22',
    paymentMethod: 'Bank Transfer',
    referenceNumber: 'HBL-TXN-998811',
    idempotencyKey: 'pay-idem-1',
  });
  // Retry with same idempotencyKey does NOT double-credit!
  const pay1Retry = await engine.createPayment(admin, {
    customerId: cust.id,
    amount: '35000',
    paymentDate: '2026-10-22',
    paymentMethod: 'Bank Transfer',
    referenceNumber: 'HBL-TXN-998811',
    idempotencyKey: 'pay-idem-1',
  });
  assert.equal(pay1.id, pay1Retry.id);

  // 4. Authorized Invoice Edit (5002 updated from 20 * 4250 = 85,000 to 20 * 4500 = 90,000) -> Balance = 20,000 + 90,000 - 35,000 = Rs. 75,000 (no double debit!)
  const editedInv = await engine.editInvoice(admin, orderInv.id, {
    reason: 'Corrected agreed bag rate from Rs. 4,250 to Rs. 4,500',
    items: [{ productId: prod.id, quantity: 20, rate: '4500' }],
  });
  assert.equal(editedInv.grandTotalFormatted, 'Rs. 90,000');
  assert.equal(editedInv.revisionCount, 1);

  // 5. Verify 12-Month Customer Ledger Window vs Admin Full Multi-Year Ledger
  const refNow = new Date('2026-10-28T12:00:00Z');
  const custLedger = engine.getCustomerLedger(authCust, {}, refNow);
  // Customer ONLY sees the 2 entries from Oct 2026 (NOT the May 2025 invoice!), while broughtForward is Rs. 20,000 and final balance is Rs. 75,000!
  assert.equal(custLedger.entries.length, 2);
  assert.equal(custLedger.broughtForwardFormatted, 'Rs. 20,000');
  assert.equal(custLedger.outstandingBalanceFormatted, 'Rs. 75,000');
  // Chronological newest entry's runningBalance agrees with outstandingBalance!
  assert.equal(custLedger.entries[0].runningBalanceFormatted, 'Rs. 75,000');

  // Admin sees ALL 3 historical ledger entries including 2025-05-10!
  const adminLedger = engine.getAdminLedger(admin, { customerId: cust.id }, refNow);
  assert.equal(adminLedger.length, 3);

  // 6. Verify Real Server-Side Multi-Item PDF Generation (`%PDF-1.`)
  const multiLineInv = await engine.createInvoice(admin, {
    customerId: cust.id,
    invoiceDate: '2026-10-28',
    items: Array.from({ length: 28 }, (_, idx) => ({
      productName: `BRB Cattle Feed Special Batch #${idx + 1} — Extended Commercial Product Description for Wrapping Verification`,
      packingWeight: '40 kg Polypropylene Bag',
      quantity: idx + 1,
      rate: '3800',
    })),
  });
  assert.equal(multiLineInv.invoiceNumber, 5003);
  const pdfBuffer = await generateInvoicePdfBuffer(multiLineInv);
  assert.ok(pdfBuffer.length > 2500);
  assert.equal(pdfBuffer.subarray(0, 5).toString('ascii'), '%PDF-');

  // 7. Verify Encrypted Backup Export, Tamper Detection & Full Restoration into Fresh DB!
  const backup = engine.exportBackupSnapshot(admin, {
    passphrase: 'BackupVaultSecret!2026',
    notes: 'Pre-deployment verification backup',
  });
  assert.equal(backup.isEncrypted, true);

  // Tampered checksum/passphrase must fail verification
  assert.throws(
    () => engine.verifyBackupSnapshot(admin, backup.bundleJson, 'WrongPassphrase'),
    (err: unknown) => err instanceof AppError && err.code === 'DECRYPTION_FAILED'
  );

  // Restore into a brand-new empty isolated database and verify balances & invoices match 100%!
  const { db: db2, engine: engine2 } = createIsolatedEngine();
  const { admin: tempAdmin2 } = engine2.bootstrapMainAdmin({
    username: 'temp_restore_admin',
    email: 'restore@brbfeed.pk',
    displayName: 'Restore Operator',
    password: 'RestorePassword!2026',
  });
  const restoreRes = engine2.restoreBackupSnapshot(tempAdmin2, backup.bundleJson, {
    passphrase: 'BackupVaultSecret!2026',
    confirmOverwrite: true,
  });
  assert.equal(restoreRes.restoredBackupUid, backup.backupUid);

  const restoredInvoices = engine2.listInvoicesForAdmin(admin);
  assert.equal(restoredInvoices.length, 3);
  assert.equal(restoredInvoices[0].invoiceNumber, 5003);

  db.close();
  db2.close();
});
