import 'dotenv/config';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { openBrbDatabase } from './src/server/db.ts';
import { AppError, BrbEngine } from './src/server/engine.ts';
import type { AuthenticatedAdmin, AuthenticatedCustomer } from './src/server/engine.ts';
import { generateInvoicePdfBuffer } from './src/server/pdf.ts';
import { formatPaisa } from './src/shared/domain.ts';
import type { OrderStatus, ProductCategory } from './src/shared/types.ts';

interface AuthedRequest extends Request {
  customer?: AuthenticatedCustomer;
  admin?: AuthenticatedAdmin;
  rawToken?: string;
}

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(maxPerMinute: number, bucketPrefix: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'local';
    const key = `${bucketPrefix}:${ip}`;
    const now = Date.now();
    const cur = rateBuckets.get(key);
    if (!cur || now > cur.resetAt) {
      rateBuckets.set(key, { count: 1, resetAt: now + 60_000 });
      next();
      return;
    }
    if (cur.count >= maxPerMinute) {
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Please wait a moment and try again.',
        },
      });
      return;
    }
    cur.count += 1;
    next();
  };
}

function extractBearerToken(req: Request): string {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    throw new AppError(401, 'MISSING_TOKEN', 'Authentication token is required.');
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    throw new AppError(401, 'MISSING_TOKEN', 'Authentication token is empty.');
  }
  return token;
}

export function createBrbExpressApp(engine: BrbEngine) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '6mb' }));

  // Basic security headers (compatible with AI Studio preview iframe)
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  const requireCustomer = (req: AuthedRequest, _res: Response, next: NextFunction) => {
    try {
      const rawToken = extractBearerToken(req);
      req.rawToken = rawToken;
      req.customer = engine.authenticateCustomerToken(rawToken);
      next();
    } catch (err) {
      next(err);
    }
  };

  const requireAdmin = (req: AuthedRequest, _res: Response, next: NextFunction) => {
    try {
      const rawToken = extractBearerToken(req);
      req.rawToken = rawToken;
      req.admin = engine.authenticateAdminToken(rawToken);
      next();
    } catch (err) {
      next(err);
    }
  };

  // =========================================================================
  // PUBLIC BOOTSTRAP & AUTHENTICATION ENDPOINTS
  // =========================================================================

  app.get('/api/public/bootstrap-info', (_req, res, next) => {
    try {
      res.json(engine.getPublicBootstrapInfo());
    } catch (err) {
      next(err);
    }
  });

  // Controlled Initial Main Administrator Setup (locked forever once 1st admin exists)
  app.post('/api/admin/auth/bootstrap', rateLimit(10, 'admin_bootstrap'), (req, res, next) => {
    try {
      const result = engine.bootstrapMainAdmin(req.body || {});
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  // Separate Admin Login & 2FA & Password Recovery
  app.post('/api/admin/auth/login', rateLimit(20, 'admin_login'), async (req, res, next) => {
    try {
      const result = await engine.loginAdmin(req.body || {});
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/admin/auth/verify-2fa', rateLimit(20, 'admin_2fa'), (req, res, next) => {
    try {
      const result = engine.verifyAdminTwoFactor({
        challengeId: Number(req.body?.challengeId),
        otp: String(req.body?.otp || ''),
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/admin/auth/forgot-password', rateLimit(10, 'admin_pw_req'), async (req, res, next) => {
    try {
      const result = await engine.requestAdminPasswordReset(String(req.body?.identifier || ''));
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/admin/auth/reset-password', rateLimit(15, 'admin_pw_reset'), (req, res, next) => {
    try {
      engine.completeAdminPasswordReset(req.body || {});
      res.json({ updated: true });
    } catch (err) {
      next(err);
    }
  });

  // Customer Login, Registration + OTP, and Forgot Password + OTP
  app.post('/api/customer/auth/login', rateLimit(25, 'cust_login'), (req, res, next) => {
    try {
      const result = engine.loginCustomer(req.body || {});
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/customer/auth/register', rateLimit(15, 'cust_reg'), async (req, res, next) => {
    try {
      const result = await engine.startCustomerRegistration(req.body || {});
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/customer/auth/verify-otp', rateLimit(25, 'cust_otp'), (req, res, next) => {
    try {
      const result = engine.verifyCustomerRegistrationOtp(req.body || {});
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/customer/auth/forgot-password', rateLimit(12, 'cust_pw_req'), async (req, res, next) => {
    try {
      const result = await engine.requestCustomerPasswordReset(req.body || {});
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/customer/auth/reset-password', rateLimit(15, 'cust_pw_reset'), async (req, res, next) => {
    try {
      await engine.completeCustomerPasswordReset(req.body || {});
      res.json({ updated: true });
    } catch (err) {
      next(err);
    }
  });

  // =========================================================================
  // PROTECTED CUSTOMER APPLICATION ENDPOINTS (STRICT ISOLATION)
  // =========================================================================

  app.post('/api/customer/auth/logout', requireCustomer, (req: AuthedRequest, res, next) => {
    try {
      if (req.rawToken) engine.revokeToken(req.rawToken);
      res.json({ loggedOut: true });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/customer/me', requireCustomer, (req: AuthedRequest, res, next) => {
    try {
      const c = req.customer!;
      const currency = engine.getCurrencySymbol();
      const orders = engine.listOrdersForCustomer(c);
      const invoices = engine.listInvoicesForCustomer(c);
      const notifications = engine.listCustomerNotifications(c);
      const unreadCount = notifications.filter((n) => !n.isRead).length;

      res.json({
        customer: {
          id: c.id,
          accountNumber: c.accountNumber,
          name: c.name,
          businessName: c.businessName,
          mobileNumber: c.mobileNumber,
          city: c.city,
          status: c.status,
          outstandingBalancePaisa: c.outstandingBalancePaisa,
          outstandingBalanceFormatted: formatPaisa(c.outstandingBalancePaisa, currency),
        },
        recentOrders: orders.slice(0, 5),
        latestInvoice: invoices[0] ?? null,
        unreadNotificationCount: unreadCount,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/customer/products', requireCustomer, (req: AuthedRequest, res, next) => {
    try {
      const cat = req.query.category ? (String(req.query.category) as ProductCategory) : undefined;
      res.json({ products: engine.listProductsForCustomer(cat) });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/customer/orders', requireCustomer, (req: AuthedRequest, res, next) => {
    try {
      res.json({ orders: engine.listOrdersForCustomer(req.customer!) });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/customer/orders/:id', requireCustomer, (req: AuthedRequest, res, next) => {
    try {
      res.json({ order: engine.getCustomerOrderById(req.customer!, Number(req.params.id)) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/customer/orders', requireCustomer, async (req: AuthedRequest, res, next) => {
    try {
      const order = await engine.submitCustomerOrder(req.customer!, req.body || {});
      res.status(201).json({ order });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/customer/orders/:id/cancel', requireCustomer, (req: AuthedRequest, res, next) => {
    try {
      const order = engine.cancelCustomerOrder(req.customer!, Number(req.params.id));
      res.json({ order });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/customer/invoices', requireCustomer, (req: AuthedRequest, res, next) => {
    try {
      res.json({ invoices: engine.listInvoicesForCustomer(req.customer!) });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/customer/invoices/:id', requireCustomer, (req: AuthedRequest, res, next) => {
    try {
      const invoice = engine.getInvoiceAuthorized(Number(req.params.id), {
        type: 'customer',
        customer: req.customer!,
      });
      res.json({ invoice });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/customer/invoices/:id/pdf', requireCustomer, async (req: AuthedRequest, res, next) => {
    try {
      const invoice = engine.getInvoiceAuthorized(Number(req.params.id), {
        type: 'customer',
        customer: req.customer!,
      });
      const pdfBuf = await generateInvoicePdfBuffer(invoice);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="BRB-Invoice-${invoice.invoiceNumber}.pdf"`
      );
      res.send(pdfBuf);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/customer/payments', requireCustomer, (req: AuthedRequest, res, next) => {
    try {
      res.json({ payments: engine.listPaymentsForCustomer(req.customer!) });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/customer/payments/:id', requireCustomer, (req: AuthedRequest, res, next) => {
    try {
      res.json({ payment: engine.getCustomerPaymentById(req.customer!, Number(req.params.id)) });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/customer/ledger', requireCustomer, (req: AuthedRequest, res, next) => {
    try {
      const typeParam = String(req.query.type || 'all');
      const ledger = engine.getCustomerLedger(req.customer!, {
        search: req.query.search ? String(req.query.search) : undefined,
        type:
          typeParam === 'invoice' || typeParam === 'payment' ? typeParam : 'all',
        fromDate: req.query.fromDate ? String(req.query.fromDate) : undefined,
        toDate: req.query.toDate ? String(req.query.toDate) : undefined,
      });
      res.json(ledger);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/customer/notifications', requireCustomer, (req: AuthedRequest, res, next) => {
    try {
      res.json({ notifications: engine.listCustomerNotifications(req.customer!) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/customer/notifications/:id/read', requireCustomer, (req: AuthedRequest, res, next) => {
    try {
      engine.markNotificationRead(req.customer!, Number(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // =========================================================================
  // PROTECTED ADMINISTRATIVE APPLICATION ENDPOINTS (RBAC ENFORCED)
  // =========================================================================

  app.post('/api/admin/auth/logout', requireAdmin, (req: AuthedRequest, res, next) => {
    try {
      if (req.rawToken) engine.revokeToken(req.rawToken);
      res.json({ loggedOut: true });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/me', requireAdmin, (req: AuthedRequest, res) => {
    res.json({ admin: req.admin! });
  });

  app.get('/api/admin/dashboard', requireAdmin, (req: AuthedRequest, res, next) => {
    try {
      res.json(engine.getAdminDashboardSummary(req.admin!));
    } catch (err) {
      next(err);
    }
  });

  // Customers Management
  app.get('/api/admin/customers', requireAdmin, (req: AuthedRequest, res, next) => {
    try {
      const customers = engine.listCustomersForAdmin(req.admin!, {
        search: req.query.search ? String(req.query.search) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
      });
      res.json({ customers });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/admin/customers', requireAdmin, (req: AuthedRequest, res, next) => {
    try {
      const customer = engine.createCustomerByAdmin(req.admin!, req.body || {});
      res.status(201).json({ customer });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/admin/customers/:id/registration-decision', requireAdmin, async (req: AuthedRequest, res, next) => {
    try {
      const decision = req.body?.decision === 'reject' ? 'reject' : 'approve';
      const customer = await engine.approveOrRejectCustomerRegistration(
        req.admin!,
        Number(req.params.id),
        decision,
        req.body?.reason ? String(req.body.reason) : undefined
      );
      res.json({ customer });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/admin/customers/:id/block-state', requireAdmin, async (req: AuthedRequest, res, next) => {
    try {
      const customer = await engine.setCustomerBlockState(
        req.admin!,
        Number(req.params.id),
        Boolean(req.body?.blocked),
        req.body?.reason ? String(req.body.reason) : undefined
      );
      res.json({ customer });
    } catch (err) {
      next(err);
    }
  });

  // Products Management
  app.get('/api/admin/products', requireAdmin, (req: AuthedRequest, res, next) => {
    try {
      const includeArchived = req.query.includeArchived === '1';
      res.json({ products: engine.listProductsForAdmin(req.admin!, includeArchived) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/admin/products', requireAdmin, (req: AuthedRequest, res, next) => {
    try {
      const product = engine.createProduct(req.admin!, req.body || {});
      res.status(201).json({ product });
    } catch (err) {
      next(err);
    }
  });

  app.put('/api/admin/products/:id', requireAdmin, (req: AuthedRequest, res, next) => {
    try {
      const product = engine.updateProduct(req.admin!, Number(req.params.id), req.body || {});
      res.json({ product });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/admin/products/:id', requireAdmin, (req: AuthedRequest, res, next) => {
    try {
      const result = engine.deleteOrArchiveProduct(req.admin!, Number(req.params.id));
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Orders & Approval Management
  app.get('/api/admin/orders', requireAdmin, (req: AuthedRequest, res, next) => {
    try {
      const orders = engine.listOrdersForAdmin(req.admin!, {
        status: req.query.status ? String(req.query.status) : undefined,
        search: req.query.search ? String(req.query.search) : undefined,
      });
      res.json({ orders });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/admin/orders/:id/approve', requireAdmin, async (req: AuthedRequest, res, next) => {
    try {
      const order = await engine.approveOrderByAdmin(req.admin!, Number(req.params.id), req.body || {});
      res.json({ order });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/admin/orders/:id/status', requireAdmin, async (req: AuthedRequest, res, next) => {
    try {
      const order = await engine.updateOrderStatusByAdmin(
        req.admin!,
        Number(req.params.id),
        String(req.body?.status || '') as OrderStatus,
        req.body?.note ? String(req.body.note) : undefined
      );
      res.json({ order });
    } catch (err) {
      next(err);
    }
  });

  // Invoices & PDF
  app.get('/api/admin/invoices', requireAdmin, (req: AuthedRequest, res, next) => {
    try {
      const invoices = engine.listInvoicesForAdmin(req.admin!, {
        search: req.query.search ? String(req.query.search) : undefined,
        customerId: req.query.customerId ? Number(req.query.customerId) : undefined,
        fromDate: req.query.fromDate ? String(req.query.fromDate) : undefined,
        toDate: req.query.toDate ? String(req.query.toDate) : undefined,
      });
      res.json({ invoices });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/admin/invoices', requireAdmin, async (req: AuthedRequest, res, next) => {
    try {
      const invoice = await engine.createInvoice(req.admin!, req.body || {});
      res.status(201).json({ invoice });
    } catch (err) {
      next(err);
    }
  });

  app.put('/api/admin/invoices/:id', requireAdmin, async (req: AuthedRequest, res, next) => {
    try {
      const invoice = await engine.editInvoice(req.admin!, Number(req.params.id), req.body || {});
      res.json({ invoice });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/invoices/:id/pdf', requireAdmin, async (req: AuthedRequest, res, next) => {
    try {
      const invoice = engine.getInvoiceAuthorized(Number(req.params.id), {
        type: 'admin',
        admin: req.admin!,
      });
      const pdfBuf = await generateInvoicePdfBuffer(invoice);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="BRB-Invoice-${invoice.invoiceNumber}.pdf"`
      );
      res.send(pdfBuf);
    } catch (err) {
      next(err);
    }
  });

  // Payments & Master Ledger
  app.get('/api/admin/payments', requireAdmin, (req: AuthedRequest, res, next) => {
    try {
      const payments = engine.listPaymentsForAdmin(req.admin!, {
        search: req.query.search ? String(req.query.search) : undefined,
        customerId: req.query.customerId ? Number(req.query.customerId) : undefined,
        fromDate: req.query.fromDate ? String(req.query.fromDate) : undefined,
        toDate: req.query.toDate ? String(req.query.toDate) : undefined,
      });
      res.json({ payments });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/admin/payments', requireAdmin, async (req: AuthedRequest, res, next) => {
    try {
      const payment = await engine.createPayment(req.admin!, req.body || {});
      res.status(201).json({ payment });
    } catch (err) {
      next(err);
    }
  });

  app.put('/api/admin/payments/:id', requireAdmin, async (req: AuthedRequest, res, next) => {
    try {
      const payment = await engine.editPayment(req.admin!, Number(req.params.id), req.body || {});
      res.json({ payment });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/ledger', requireAdmin, (req: AuthedRequest, res, next) => {
    try {
      const presetRaw = String(req.query.preset || 'all');
      const preset = ['all', 'today', 'week', 'month', 'custom'].includes(presetRaw)
        ? (presetRaw as 'all' | 'today' | 'week' | 'month' | 'custom')
        : 'all';
      const entries = engine.getAdminLedger(req.admin!, {
        customerId: req.query.customerId ? Number(req.query.customerId) : undefined,
        search: req.query.search ? String(req.query.search) : undefined,
        preset,
        fromDate: req.query.fromDate ? String(req.query.fromDate) : undefined,
        toDate: req.query.toDate ? String(req.query.toDate) : undefined,
      });
      res.json({ entries });
    } catch (err) {
      next(err);
    }
  });

  // Notifications, Reports, Staff, Settings, Decisions, Audit, Backups
  app.get('/api/admin/notifications', requireAdmin, (req: AuthedRequest, res, next) => {
    try {
      res.json({ notifications: engine.listAdminNotifications(req.admin!) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/admin/notifications', requireAdmin, async (req: AuthedRequest, res, next) => {
    try {
      const result = await engine.sendAdminNotification(req.admin!, req.body || {});
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/reports', requireAdmin, (req: AuthedRequest, res, next) => {
    try {
      const reports = engine.getReconciledReports(req.admin!, {
        fromDate: req.query.fromDate ? String(req.query.fromDate) : undefined,
        toDate: req.query.toDate ? String(req.query.toDate) : undefined,
      });
      res.json(reports);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/staff', requireAdmin, (req: AuthedRequest, res, next) => {
    try {
      res.json({ staff: engine.listStaffAccounts(req.admin!) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/admin/staff', requireAdmin, (req: AuthedRequest, res, next) => {
    try {
      const staff = engine.createStaffAccount(req.admin!, req.body || {});
      res.status(201).json({ staff });
    } catch (err) {
      next(err);
    }
  });

  app.put('/api/admin/staff/:id', requireAdmin, (req: AuthedRequest, res, next) => {
    try {
      engine.updateStaffAccount(req.admin!, Number(req.params.id), req.body || {});
      res.json({ staff: engine.listStaffAccounts(req.admin!) });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/settings', requireAdmin, (req: AuthedRequest, res, next) => {
    try {
      res.json(engine.getAdminSettings(req.admin!));
    } catch (err) {
      next(err);
    }
  });

  app.put('/api/admin/settings', requireAdmin, (req: AuthedRequest, res, next) => {
    try {
      res.json(engine.updateAdminSettings(req.admin!, req.body || {}));
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/decisions', requireAdmin, (_req: AuthedRequest, res, next) => {
    try {
      res.json({ decisions: engine.listDecisionRegister() });
    } catch (err) {
      next(err);
    }
  });

  app.put('/api/admin/decisions/:id', requireAdmin, (req: AuthedRequest, res, next) => {
    try {
      const decision = engine.updateDecisionRegisterItem(
        req.admin!,
        Number(req.params.id),
        req.body || {}
      );
      res.json({ decision });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/audit-logs', requireAdmin, (req: AuthedRequest, res, next) => {
    try {
      res.json({ logs: engine.listAuditLogs(req.admin!) });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/backups', requireAdmin, (req: AuthedRequest, res, next) => {
    try {
      res.json({ backups: engine.listBackupHistory(req.admin!) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/admin/backups/export', requireAdmin, (req: AuthedRequest, res, next) => {
    try {
      const snapshot = engine.exportBackupSnapshot(req.admin!, req.body || {});
      res.status(201).json(snapshot);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/admin/backups/verify', requireAdmin, (req: AuthedRequest, res, next) => {
    try {
      const verified = engine.verifyBackupSnapshot(
        req.admin!,
        String(req.body?.bundleJson || ''),
        req.body?.passphrase ? String(req.body.passphrase) : undefined
      );
      res.json({
        valid: verified.valid,
        backupUid: verified.backupUid,
        schemaVersion: verified.schemaVersion,
        sha256Checksum: verified.sha256Checksum,
        recordCountsSummary: verified.recordCountsSummary,
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/admin/backups/restore', requireAdmin, (req: AuthedRequest, res, next) => {
    try {
      const restored = engine.restoreBackupSnapshot(req.admin!, String(req.body?.bundleJson || ''), {
        passphrase: req.body?.passphrase ? String(req.body.passphrase) : undefined,
        confirmOverwrite: Boolean(req.body?.confirmOverwrite),
      });
      res.json(restored);
    } catch (err) {
      next(err);
    }
  });

  // Catch-all for unknown /api routes
  app.use('/api/*', (_req, res) => {
    res.status(404).json({
      error: { code: 'API_NOT_FOUND', message: 'Requested API endpoint does not exist.' },
    });
  });

  // Safe Centralized API Error Handler (never leaks stack traces or secrets)
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.status).json({
        error: {
          code: err.code,
          message: err.message,
        },
      });
      return;
    }
    console.error('[BRB Server Unexpected Error]:', err instanceof Error ? err.message : err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected server error occurred. Please try again.',
      },
    });
  });

  return app;
}

async function startServer() {
  const db = openBrbDatabase();
  const engine = new BrbEngine(db);
  const app = createBrbExpressApp(engine);

  const distDir = path.resolve('dist');
  const isProd = process.env.NODE_ENV === 'production' && fs.existsSync(path.join(distDir, 'index.html'));

  if (isProd) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`BRB Feed Industry server listening on http://0.0.0.0:${port}`);
  });
}

// Only start HTTP listener when executed directly (allows importing createBrbExpressApp in tests)
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath.endsWith('server.ts') || invokedPath.endsWith('server.js')) {
  startServer().catch((err) => {
    console.error('Failed to start BRB server:', err);
    process.exit(1);
  });
}
