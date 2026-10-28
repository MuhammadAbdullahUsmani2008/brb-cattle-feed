import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import {
  ADMIN_PERMISSIONS,
  ADMIN_ROLES,
  BRAND_NAMES,
  DECISION_REGISTER_STATUSES,
  URDU_MESSAGES,
} from '../shared/types.ts';
import type {
  AdminPermission,
  AdminRole,
  CustomerAccountStatus,
  CustomerPublicView,
  DecisionRegisterItem,
  DecisionRegisterStatus,
  InvoiceLineItemView,
  InvoiceView,
  LedgerEntryView,
  NotificationEventType,
  NotificationView,
  OrderApprovedItemView,
  OrderRequestedItemView,
  OrderStatus,
  OrderStatusHistoryView,
  OrderView,
  PaymentMethod,
  PaymentView,
  ProductAdminView,
  ProductCategory,
  ProductCustomerView,
  ProductUsage,
} from '../shared/types.ts';
import {
  calculateInvoiceTotals,
  canCustomerCancelOrder,
  computeRunningBalances,
  computeTwelveMonthCutoffDate,
  formatCustomerAccountNumber,
  formatPaisa,
  getDefaultPermissionsForRole,
  isValidAccountNumberFormat,
  isValidAdminOrderTransition,
  isValidMobileNumber,
  isValidOrderStatus,
  isValidPaymentMethod,
  isValidProductCategory,
  isValidProductUsage,
  normalizeAccountNumber,
  normalizePakistaniMobile,
  parseMoneyToPaisa,
  validateOrderApprovalItems,
} from '../shared/domain.ts';
import {
  computeSha256Hex,
  decryptBackupPayload,
  encryptBackupPayload,
  generateNumericOtp,
  generateSessionToken,
  hashOtp,
  hashPassword,
  hashToken,
  verifyOtpDigest,
  verifyPassword,
} from './crypto.ts';
import { CURRENT_SCHEMA_VERSION } from './db.ts';
import { dispatchSmsViaProvider, isIsolatedDevOtpAllowed } from './sms.ts';
import type { SmsProviderConfig } from './sms.ts';

export class AppError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface AuthenticatedAdmin {
  id: number;
  username: string;
  email: string;
  displayName: string;
  mobileNumber: string;
  role: AdminRole;
  permissions: AdminPermission[];
  twoFactorEnabled: boolean;
}

export interface AuthenticatedCustomer {
  id: number;
  accountNumber: string;
  name: string;
  businessName: string;
  mobileNumber: string;
  city: string;
  status: CustomerAccountStatus;
  outstandingBalancePaisa: number;
}

interface PendingSmsTask {
  notificationId?: number;
  otpChallengeId?: number;
  recipientMobile: string;
  messageBody: string;
  idempotencyKey: string;
}

export class BrbEngine {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // =========================================================================
  // SETTINGS & CONFIGURATION HELPERS
  // =========================================================================

  public getSetting(key: string, fallback = ''): string {
    const row = this.db
      .prepare(`SELECT setting_value FROM system_settings WHERE setting_key = ?`)
      .get(key) as { setting_value: string } | undefined;
    return row ? row.setting_value : fallback;
  }

  public getCurrencySymbol(): string {
    return this.getSetting('currency_symbol', 'Rs.') || 'Rs.';
  }

  public getTimeZone(): string {
    return this.getSetting('timezone', 'Asia/Karachi') || 'Asia/Karachi';
  }

  public getTodayLocalIso(now: Date = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.getTimeZone(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  }

  public getSmsConfig(): SmsProviderConfig {
    return {
      enabled: this.getSetting('sms_enabled', '0') === '1',
      providerUrl: this.getSetting('sms_provider_url', ''),
      apiKey: this.getSetting('sms_provider_api_key', ''),
      senderId: this.getSetting('sms_sender_id', 'BRB-FEED'),
    };
  }

  public getPublicBootstrapInfo() {
    const adminCountRow = this.db.prepare(`SELECT COUNT(*) AS cnt FROM admin_users`).get() as {
      cnt: number;
    };
    const smsCfg = this.getSmsConfig();
    const smsConfigured = Boolean(
      smsCfg.enabled &&
        (smsCfg.providerUrl || process.env.SMS_PROVIDER_URL) &&
        (smsCfg.apiKey || process.env.SMS_PROVIDER_API_KEY)
    );
    return {
      hasAnyAdmin: adminCountRow.cnt > 0,
      applicationName: BRAND_NAMES.applicationName,
      mainBusinessHeading: BRAND_NAMES.mainBusinessHeading,
      invoiceHeading: BRAND_NAMES.invoiceHeading,
      logoDataUrl: this.getSetting('brand_logo_data_url', '') || null,
      whatsappContactNumber: this.getSetting('whatsapp_contact_number', ''),
      currencySymbol: this.getCurrencySymbol(),
      timezone: this.getTimeZone(),
      smsConfigured,
      devEnvironment: isIsolatedDevOtpAllowed(),
    };
  }

  private writeAuditLogTx(params: {
    actorType: 'admin' | 'customer' | 'system';
    actorId: number | null;
    actorName: string;
    action: string;
    entityType: string;
    entityId: string | number;
    reason?: string | null;
    beforeObj?: unknown;
    afterObj?: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO audit_logs (
          actor_type, actor_id, actor_name, action, entity_type, entity_id,
          reason, before_json, after_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.actorType,
        params.actorId,
        params.actorName,
        params.action,
        params.entityType,
        String(params.entityId),
        params.reason ?? null,
        params.beforeObj !== undefined ? JSON.stringify(params.beforeObj) : null,
        params.afterObj !== undefined ? JSON.stringify(params.afterObj) : null,
        new Date().toISOString()
      );
  }

  private allocateSequenceTx(seqKey: string): number {
    const row = this.db
      .prepare(`SELECT next_val FROM system_sequences WHERE seq_key = ?`)
      .get(seqKey) as { next_val: number } | undefined;
    if (!row) {
      throw new AppError(500, 'SEQUENCE_MISSING', `System sequence "${seqKey}" is not initialized.`);
    }
    const allocated = row.next_val;
    this.db
      .prepare(`UPDATE system_sequences SET next_val = ?, updated_at = ? WHERE seq_key = ?`)
      .run(allocated + 1, new Date().toISOString(), seqKey);
    return allocated;
  }

  /**
   * Reconciles customer.outstanding_balance_paisa directly from authoritative ledger_entries
   * inside the active transaction so balance and ledger can never diverge.
   */
  private reconcileCustomerBalanceTx(customerId: number): number {
    const cust = this.db
      .prepare(`SELECT opening_balance_paisa FROM customers WHERE id = ?`)
      .get(customerId) as { opening_balance_paisa: number } | undefined;
    if (!cust) {
      throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Customer record not found.');
    }
    const sums = this.db
      .prepare(
        `SELECT
          COALESCE(SUM(debit_paisa), 0) AS total_debit,
          COALESCE(SUM(credit_paisa), 0) AS total_credit
         FROM ledger_entries
         WHERE customer_id = ?`
      )
      .get(customerId) as { total_debit: number; total_credit: number };

    const nextBalance = cust.opening_balance_paisa + sums.total_debit - sums.total_credit;
    this.db
      .prepare(`UPDATE customers SET outstanding_balance_paisa = ?, updated_at = ? WHERE id = ?`)
      .run(nextBalance, new Date().toISOString(), customerId);
    return nextBalance;
  }

  private createNotificationTx(params: {
    customerId: number;
    eventType: NotificationEventType;
    title: string;
    message: string;
    targetType?: 'invoice' | 'payment' | 'order' | 'account' | null;
    targetId?: number | null;
    idempotencyKey?: string;
    createdByAdminId?: number | null;
  }): PendingSmsTask | null {
    if (params.idempotencyKey) {
      const existing = this.db
        .prepare(`SELECT id FROM notifications WHERE idempotency_key = ?`)
        .get(params.idempotencyKey) as { id: number } | undefined;
      if (existing) {
        return null;
      }
    }

    const cust = this.db
      .prepare(`SELECT mobile_number FROM customers WHERE id = ?`)
      .get(params.customerId) as { mobile_number: string } | undefined;
    if (!cust) return null;

    const smsCfg = this.getSmsConfig();
    const initialSmsStatus =
      smsCfg.enabled && (smsCfg.providerUrl || process.env.SMS_PROVIDER_URL)
        ? 'queued'
        : 'not_configured';

    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO notifications (
          customer_id, event_type, title, message, target_type, target_id,
          is_read, app_delivery_status, sms_delivery_status, idempotency_key,
          created_by_admin_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 'persisted', ?, ?, ?, ?)`
      )
      .run(
        params.customerId,
        params.eventType,
        params.title,
        params.message,
        params.targetType ?? null,
        params.targetId ?? null,
        initialSmsStatus,
        params.idempotencyKey ?? null,
        params.createdByAdminId ?? null,
        now
      );

    const notificationId = Number(info.lastInsertRowid);
    return {
      notificationId,
      recipientMobile: cust.mobile_number,
      messageBody: `${BRAND_NAMES.invoiceHeading}: ${params.message}`,
      idempotencyKey: params.idempotencyKey || `notif-${notificationId}`,
    };
  }

  public async flushPendingSmsTasks(tasks: Array<PendingSmsTask | null>): Promise<void> {
    const valid = tasks.filter((t): t is PendingSmsTask => t !== null);
    if (valid.length === 0) return;
    const cfg = this.getSmsConfig();
    for (const task of valid) {
      const res = await dispatchSmsViaProvider(
        cfg,
        task.recipientMobile,
        task.messageBody,
        task.idempotencyKey
      );
      if (task.notificationId) {
        this.db
          .prepare(
            `UPDATE notifications
             SET sms_delivery_status = ?, sms_provider_ref = ?, sms_error_detail = ?
             WHERE id = ?`
          )
          .run(res.status, res.providerRef, res.errorDetail, task.notificationId);
      }
      if (task.otpChallengeId) {
        this.db
          .prepare(`UPDATE otp_challenges SET sms_status = ? WHERE id = ?`)
          .run(res.status, task.otpChallengeId);
      }
    }
  }

  // =========================================================================
  // INITIAL ADMIN SETUP & ADMIN AUTHENTICATION / RBAC
  // =========================================================================

  public bootstrapMainAdmin(input: {
    username: string;
    email: string;
    displayName: string;
    mobileNumber?: string;
    password: string;
    startingCustomerSeq?: number;
    startingInvoiceNumber?: number;
    twoFactorEnabled?: boolean;
  }): { admin: AuthenticatedAdmin; token: string } {
    const username = (input.username || '').trim();
    const email = (input.email || '').trim().toLowerCase();
    const displayName = (input.displayName || '').trim();
    const password = input.password || '';
    const mobileNumber = input.mobileNumber ? normalizePakistaniMobile(input.mobileNumber) : '';

    if (username.length < 3 || username.length > 64) {
      throw new AppError(400, 'INVALID_USERNAME', 'Username must be between 3 and 64 characters.');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AppError(400, 'INVALID_EMAIL', 'Please enter a valid administrator email address.');
    }
    if (displayName.length < 2 || displayName.length > 120) {
      throw new AppError(400, 'INVALID_NAME', 'Display name must be between 2 and 120 characters.');
    }
    if (password.length < 8) {
      throw new AppError(400, 'WEAK_PASSWORD', 'Administrator password must be at least 8 characters.');
    }

    const tx = this.db.transaction(() => {
      const existingCount = (
        this.db.prepare(`SELECT COUNT(*) AS cnt FROM admin_users`).get() as { cnt: number }
      ).cnt;
      if (existingCount > 0) {
        throw new AppError(
          403,
          'BOOTSTRAP_LOCKED',
          'Initial administrator setup has already been completed and is permanently locked.'
        );
      }

      const now = new Date().toISOString();
      if (input.startingCustomerSeq !== undefined) {
        if (!Number.isInteger(input.startingCustomerSeq) || input.startingCustomerSeq < 1) {
          throw new AppError(400, 'INVALID_SEQ', 'Starting customer sequence must be a positive integer.');
        }
        this.db
          .prepare(`UPDATE system_sequences SET next_val = ?, updated_at = ? WHERE seq_key = 'customer_account'`)
          .run(input.startingCustomerSeq, now);
      }
      if (input.startingInvoiceNumber !== undefined) {
        if (!Number.isInteger(input.startingInvoiceNumber) || input.startingInvoiceNumber < 1) {
          throw new AppError(400, 'INVALID_SEQ', 'Starting invoice number must be a positive integer.');
        }
        this.db
          .prepare(`UPDATE system_sequences SET next_val = ?, updated_at = ? WHERE seq_key = 'invoice_number'`)
          .run(input.startingInvoiceNumber, now);
      }

      const permissions = getDefaultPermissionsForRole('main_admin');
      const passwordHash = hashPassword(password);
      const info = this.db
        .prepare(
          `INSERT INTO admin_users (
            username, email, display_name, mobile_number, password_hash,
            role, permissions_json, two_factor_enabled, is_active, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'main_admin', ?, ?, 1, ?, ?)`
        )
        .run(
          username,
          email,
          displayName,
          mobileNumber,
          passwordHash,
          JSON.stringify(permissions),
          input.twoFactorEnabled ? 1 : 0,
          now,
          now
        );

      const adminId = Number(info.lastInsertRowid);
      this.writeAuditLogTx({
        actorType: 'admin',
        actorId: adminId,
        actorName: displayName,
        action: 'BOOTSTRAP_MAIN_ADMIN',
        entityType: 'admin_user',
        entityId: adminId,
        afterObj: {
          username,
          email,
          role: 'main_admin',
          startingCustomerSeq: input.startingCustomerSeq ?? 131,
          startingInvoiceNumber: input.startingInvoiceNumber ?? 5001,
        },
      });

      const { rawToken, tokenHash } = generateSessionToken();
      const expiresAt = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
      this.db
        .prepare(
          `INSERT INTO auth_sessions (token_hash, actor_type, admin_id, expires_at, created_at)
           VALUES (?, 'admin', ?, ?, ?)`
        )
        .run(tokenHash, adminId, expiresAt, now);

      return {
        token: rawToken,
        admin: {
          id: adminId,
          username,
          email,
          displayName,
          mobileNumber,
          role: 'main_admin' as AdminRole,
          permissions,
          twoFactorEnabled: Boolean(input.twoFactorEnabled),
        },
      };
    });

    return tx.immediate();
  }

  public async loginAdmin(input: {
    identifier: string;
    password: string;
  }): Promise<
    | { requiresTwoFactor: false; admin: AuthenticatedAdmin; token: string }
    | {
        requiresTwoFactor: true;
        challengeId: number;
        maskedDestination: string;
        smsStatus: string;
        devSandboxOtp?: string;
      }
  > {
    const identifier = (input.identifier || '').trim();
    const password = input.password || '';
    if (!identifier || !password) {
      throw new AppError(400, 'MISSING_CREDENTIALS', 'Username/Email and password are required.');
    }

    const row = this.db
      .prepare(
        `SELECT * FROM admin_users WHERE (username = ? OR email = ?) LIMIT 1`
      )
      .get(identifier, identifier.toLowerCase()) as Record<string, unknown> | undefined;

    if (!row || !verifyPassword(password, String(row.password_hash))) {
      this.writeAuditLogTx({
        actorType: 'system',
        actorId: null,
        actorName: identifier.slice(0, 64),
        action: 'ADMIN_LOGIN_FAILED',
        entityType: 'admin_auth',
        entityId: identifier.slice(0, 64),
      });
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid administrator username/email or password.');
    }

    if (Number(row.is_active) !== 1) {
      throw new AppError(403, 'ADMIN_DISABLED', 'This staff/administrator account has been deactivated.');
    }

    const adminId = Number(row.id);
    if (Number(row.two_factor_enabled) === 1) {
      const otpCode = generateNumericOtp();
      const destination = String(row.mobile_number || row.email);
      const otpContext = `admin:${adminId}:admin_2fa`;
      const otpDigest = hashOtp(otpCode, otpContext);
      const expirySec = Number(this.getSetting('otp_expiry_seconds', '300')) || 300;
      const cooldownSec = Number(this.getSetting('otp_resend_cooldown_seconds', '60')) || 60;
      const maxAttempts = Number(this.getSetting('otp_max_attempts', '5')) || 5;
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();

      const info = this.db
        .prepare(
          `INSERT INTO otp_challenges (
            target_type, target_id, mobile_or_email, purpose, otp_digest,
            attempts_used, max_attempts, expires_at, resend_available_at, created_at
          ) VALUES ('admin', ?, ?, 'admin_2fa', ?, 0, ?, ?, ?, ?)`
        )
        .run(
          adminId,
          destination,
          otpDigest,
          maxAttempts,
          new Date(nowMs + expirySec * 1000).toISOString(),
          new Date(nowMs + cooldownSec * 1000).toISOString(),
          nowIso
        );

      const challengeId = Number(info.lastInsertRowid);
      let smsStatus = 'not_configured';
      if (row.mobile_number) {
        const smsRes = await dispatchSmsViaProvider(
          this.getSmsConfig(),
          String(row.mobile_number),
          `BRB Admin 2FA verification code: ${otpCode}`,
          `admin-2fa-${challengeId}`
        );
        smsStatus = smsRes.status;
        this.db
          .prepare(`UPDATE otp_challenges SET sms_status = ? WHERE id = ?`)
          .run(smsStatus, challengeId);
      }

      const masked =
        destination.length > 4
          ? `${destination.slice(0, 3)}***${destination.slice(-3)}`
          : '***';

      return {
        requiresTwoFactor: true,
        challengeId,
        maskedDestination: masked,
        smsStatus,
        ...(isIsolatedDevOtpAllowed() && smsStatus === 'not_configured'
          ? { devSandboxOtp: otpCode }
          : {}),
      };
    }

    return this.issueAdminSession(row);
  }

  public verifyAdminTwoFactor(input: {
    challengeId: number;
    otp: string;
  }): { admin: AuthenticatedAdmin; token: string } {
    const challenge = this.db
      .prepare(`SELECT * FROM otp_challenges WHERE id = ? AND target_type = 'admin' AND purpose = 'admin_2fa'`)
      .get(input.challengeId) as Record<string, unknown> | undefined;

    if (!challenge || challenge.consumed_at) {
      throw new AppError(400, 'INVALID_OTP_CHALLENGE', 'Verification session is invalid or already used.');
    }
    if (Date.now() > Date.parse(String(challenge.expires_at))) {
      throw new AppError(400, 'OTP_EXPIRED', 'Verification code has expired. Please sign in again.');
    }
    const attemptsUsed = Number(challenge.attempts_used);
    const maxAttempts = Number(challenge.max_attempts);
    if (attemptsUsed >= maxAttempts) {
      throw new AppError(429, 'OTP_MAX_ATTEMPTS', 'Maximum verification attempts exceeded. Please sign in again.');
    }

    const adminId = Number(challenge.target_id);
    const ok = verifyOtpDigest(input.otp || '', `admin:${adminId}:admin_2fa`, String(challenge.otp_digest));
    if (!ok) {
      this.db
        .prepare(`UPDATE otp_challenges SET attempts_used = attempts_used + 1 WHERE id = ?`)
        .run(challenge.id);
      throw new AppError(401, 'INVALID_OTP', 'Incorrect verification code.');
    }

    const row = this.db.prepare(`SELECT * FROM admin_users WHERE id = ?`).get(adminId) as
      | Record<string, unknown>
      | undefined;
    if (!row || Number(row.is_active) !== 1) {
      throw new AppError(403, 'ADMIN_DISABLED', 'Administrator account is inactive.');
    }

    this.db
      .prepare(`UPDATE otp_challenges SET consumed_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), challenge.id);

    const issued = this.issueAdminSession(row);
    return { admin: issued.admin, token: issued.token };
  }

  public async requestAdminPasswordReset(identifier: string): Promise<{
    acknowledged: true;
    challengeId?: number;
    smsStatus?: string;
    devSandboxOtp?: string;
  }> {
    const clean = (identifier || '').trim();
    if (!clean) {
      throw new AppError(400, 'MISSING_IDENTIFIER', 'Enter your administrator username or email.');
    }
    const row = this.db
      .prepare(`SELECT * FROM admin_users WHERE (username = ? OR email = ?) AND is_active = 1 LIMIT 1`)
      .get(clean, clean.toLowerCase()) as Record<string, unknown> | undefined;

    if (!row) {
      return { acknowledged: true };
    }

    const adminId = Number(row.id);
    const latest = this.db
      .prepare(
        `SELECT resend_available_at FROM otp_challenges
         WHERE target_type = 'admin' AND target_id = ? AND purpose = 'admin_password_reset'
         ORDER BY id DESC LIMIT 1`
      )
      .get(adminId) as { resend_available_at: string } | undefined;

    if (latest && Date.now() < Date.parse(latest.resend_available_at)) {
      throw new AppError(429, 'OTP_COOLDOWN', 'Please wait before requesting another recovery code.');
    }

    const otpCode = generateNumericOtp();
    const otpDigest = hashOtp(otpCode, `admin:${adminId}:admin_password_reset`);
    const expirySec = Number(this.getSetting('otp_expiry_seconds', '300')) || 300;
    const cooldownSec = Number(this.getSetting('otp_resend_cooldown_seconds', '60')) || 60;
    const maxAttempts = Number(this.getSetting('otp_max_attempts', '5')) || 5;
    const nowMs = Date.now();

    const info = this.db
      .prepare(
        `INSERT INTO otp_challenges (
          target_type, target_id, mobile_or_email, purpose, otp_digest,
          attempts_used, max_attempts, expires_at, resend_available_at, created_at
        ) VALUES ('admin', ?, ?, 'admin_password_reset', ?, 0, ?, ?, ?, ?)`
      )
      .run(
        adminId,
        String(row.mobile_number || row.email),
        otpDigest,
        maxAttempts,
        new Date(nowMs + expirySec * 1000).toISOString(),
        new Date(nowMs + cooldownSec * 1000).toISOString(),
        new Date(nowMs).toISOString()
      );

    const challengeId = Number(info.lastInsertRowid);
    let smsStatus = 'not_configured';
    if (row.mobile_number) {
      const res = await dispatchSmsViaProvider(
        this.getSmsConfig(),
        String(row.mobile_number),
        `BRB Admin password recovery code: ${otpCode}`,
        `admin-reset-${challengeId}`
      );
      smsStatus = res.status;
      this.db.prepare(`UPDATE otp_challenges SET sms_status = ? WHERE id = ?`).run(smsStatus, challengeId);
    }

    return {
      acknowledged: true,
      challengeId,
      smsStatus,
      ...(isIsolatedDevOtpAllowed() && smsStatus === 'not_configured' ? { devSandboxOtp: otpCode } : {}),
    };
  }

  public completeAdminPasswordReset(input: {
    identifier: string;
    otp: string;
    newPassword: string;
    confirmPassword: string;
  }): void {
    if ((input.newPassword || '').length < 8) {
      throw new AppError(400, 'WEAK_PASSWORD', 'New password must be at least 8 characters.');
    }
    if (input.newPassword !== input.confirmPassword) {
      throw new AppError(400, 'PASSWORD_MISMATCH', 'New password and confirmation do not match.');
    }
    const clean = (input.identifier || '').trim();
    const row = this.db
      .prepare(`SELECT * FROM admin_users WHERE (username = ? OR email = ?) AND is_active = 1 LIMIT 1`)
      .get(clean, clean.toLowerCase()) as Record<string, unknown> | undefined;
    if (!row) {
      throw new AppError(400, 'RESET_INVALID', 'Invalid recovery details or expired OTP.');
    }
    const adminId = Number(row.id);
    const challenge = this.db
      .prepare(
        `SELECT * FROM otp_challenges
         WHERE target_type = 'admin' AND target_id = ? AND purpose = 'admin_password_reset' AND consumed_at IS NULL
         ORDER BY id DESC LIMIT 1`
      )
      .get(adminId) as Record<string, unknown> | undefined;

    if (!challenge || Date.now() > Date.parse(String(challenge.expires_at))) {
      throw new AppError(400, 'OTP_EXPIRED', 'Recovery code is invalid or expired.');
    }
    if (Number(challenge.attempts_used) >= Number(challenge.max_attempts)) {
      throw new AppError(429, 'OTP_MAX_ATTEMPTS', 'Maximum recovery attempts exceeded.');
    }
    if (!verifyOtpDigest(input.otp || '', `admin:${adminId}:admin_password_reset`, String(challenge.otp_digest))) {
      this.db
        .prepare(`UPDATE otp_challenges SET attempts_used = attempts_used + 1 WHERE id = ?`)
        .run(challenge.id);
      throw new AppError(400, 'INVALID_OTP', 'Recovery code is incorrect.');
    }

    const tx = this.db.transaction(() => {
      const now = new Date().toISOString();
      this.db
        .prepare(`UPDATE otp_challenges SET consumed_at = ? WHERE id = ?`)
        .run(now, challenge.id);
      this.db
        .prepare(`UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?`)
        .run(hashPassword(input.newPassword), now, adminId);
      // Revoke all active sessions for this admin
      this.db
        .prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE actor_type = 'admin' AND admin_id = ? AND revoked_at IS NULL`)
        .run(now, adminId);
      this.writeAuditLogTx({
        actorType: 'admin',
        actorId: adminId,
        actorName: String(row.display_name),
        action: 'ADMIN_PASSWORD_RESET',
        entityType: 'admin_user',
        entityId: adminId,
      });
    });
    tx.immediate();
  }

  private issueAdminSession(row: Record<string, unknown>): {
    requiresTwoFactor: false;
    admin: AuthenticatedAdmin;
    token: string;
  } {
    const adminId = Number(row.id);
    const { rawToken, tokenHash } = generateSessionToken();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
    this.db
      .prepare(
        `INSERT INTO auth_sessions (token_hash, actor_type, admin_id, expires_at, created_at)
         VALUES (?, 'admin', ?, ?, ?)`
      )
      .run(tokenHash, adminId, expiresAt, now);

    const permissions = JSON.parse(String(row.permissions_json || '[]')) as AdminPermission[];
    return {
      requiresTwoFactor: false,
      token: rawToken,
      admin: {
        id: adminId,
        username: String(row.username),
        email: String(row.email),
        displayName: String(row.display_name),
        mobileNumber: String(row.mobile_number || ''),
        role: String(row.role) as AdminRole,
        permissions,
        twoFactorEnabled: Number(row.two_factor_enabled) === 1,
      },
    };
  }

  public authenticateAdminToken(rawToken: string): AuthenticatedAdmin {
    const tokenHash = hashToken(rawToken);
    const row = this.db
      .prepare(
        `SELECT s.expires_at, s.revoked_at, a.*
         FROM auth_sessions s
         INNER JOIN admin_users a ON a.id = s.admin_id
         WHERE s.token_hash = ? AND s.actor_type = 'admin'
         LIMIT 1`
      )
      .get(tokenHash) as Record<string, unknown> | undefined;

    if (!row || row.revoked_at) {
      throw new AppError(401, 'UNAUTHORIZED', 'Administrator session is invalid or signed out.');
    }
    if (Date.now() > Date.parse(String(row.expires_at))) {
      throw new AppError(401, 'SESSION_EXPIRED', 'Administrator session has expired. Please log in again.');
    }
    if (Number(row.is_active) !== 1) {
      throw new AppError(403, 'ADMIN_DISABLED', 'Administrator account is deactivated.');
    }

    const role = String(row.role) as AdminRole;
    const permissions =
      role === 'main_admin'
        ? [...ADMIN_PERMISSIONS]
        : (JSON.parse(String(row.permissions_json || '[]')) as AdminPermission[]);

    return {
      id: Number(row.id),
      username: String(row.username),
      email: String(row.email),
      displayName: String(row.display_name),
      mobileNumber: String(row.mobile_number || ''),
      role,
      permissions,
      twoFactorEnabled: Number(row.two_factor_enabled) === 1,
    };
  }

  public assertAdminPermission(admin: AuthenticatedAdmin, permission: AdminPermission): void {
    if (admin.role === 'main_admin') return;
    if (!admin.permissions.includes(permission)) {
      throw new AppError(
        403,
        'FORBIDDEN_PERMISSION',
        `Your staff role (${admin.role}) does not have the "${permission}" permission.`
      );
    }
  }

  public revokeToken(rawToken: string): void {
    const tokenHash = hashToken(rawToken);
    this.db
      .prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?`)
      .run(new Date().toISOString(), tokenHash);
  }

  // =========================================================================
  // STAFF / ADMIN ACCOUNT MANAGEMENT (MAIN ADMIN)
  // =========================================================================

  public listStaffAccounts(actor: AuthenticatedAdmin) {
    this.assertAdminPermission(actor, 'manage_staff');
    const rows = this.db
      .prepare(`SELECT * FROM admin_users ORDER BY id ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      username: String(r.username),
      email: String(r.email),
      displayName: String(r.display_name),
      mobileNumber: String(r.mobile_number || ''),
      role: String(r.role) as AdminRole,
      permissions: JSON.parse(String(r.permissions_json || '[]')) as AdminPermission[],
      twoFactorEnabled: Number(r.two_factor_enabled) === 1,
      isActive: Number(r.is_active) === 1,
      createdAt: String(r.created_at),
    }));
  }

  public createStaffAccount(
    actor: AuthenticatedAdmin,
    input: {
      username: string;
      email: string;
      displayName: string;
      mobileNumber?: string;
      password: string;
      role: AdminRole;
      permissions?: AdminPermission[];
      twoFactorEnabled?: boolean;
    }
  ) {
    this.assertAdminPermission(actor, 'manage_staff');
    const username = (input.username || '').trim();
    const email = (input.email || '').trim().toLowerCase();
    const displayName = (input.displayName || '').trim();
    if (username.length < 3 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || displayName.length < 2) {
      throw new AppError(400, 'INVALID_STAFF_FIELDS', 'Valid username, email, and display name are required.');
    }
    if ((input.password || '').length < 8) {
      throw new AppError(400, 'WEAK_PASSWORD', 'Staff password must be at least 8 characters.');
    }
    if (!(ADMIN_ROLES as readonly string[]).includes(input.role)) {
      throw new AppError(400, 'INVALID_ROLE', 'Invalid administrative role.');
    }

    const perms =
      input.role === 'main_admin'
        ? [...ADMIN_PERMISSIONS]
        : (input.permissions ?? getDefaultPermissionsForRole(input.role)).filter((p) =>
            (ADMIN_PERMISSIONS as readonly string[]).includes(p)
          );

    const tx = this.db.transaction(() => {
      const dup = this.db
        .prepare(`SELECT id FROM admin_users WHERE username = ? OR email = ?`)
        .get(username, email);
      if (dup) {
        throw new AppError(409, 'DUPLICATE_STAFF', 'Username or email is already assigned to another staff account.');
      }
      const now = new Date().toISOString();
      const info = this.db
        .prepare(
          `INSERT INTO admin_users (
            username, email, display_name, mobile_number, password_hash,
            role, permissions_json, two_factor_enabled, is_active, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .run(
          username,
          email,
          displayName,
          input.mobileNumber ? normalizePakistaniMobile(input.mobileNumber) : '',
          hashPassword(input.password),
          input.role,
          JSON.stringify(perms),
          input.twoFactorEnabled ? 1 : 0,
          now,
          now
        );
      const staffId = Number(info.lastInsertRowid);
      this.writeAuditLogTx({
        actorType: 'admin',
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'CREATE_STAFF_ACCOUNT',
        entityType: 'admin_user',
        entityId: staffId,
        afterObj: { username, email, role: input.role, permissions: perms },
      });
      return staffId;
    });

    const staffId = tx.immediate();
    return this.listStaffAccounts(actor).find((s) => s.id === staffId)!;
  }

  public updateStaffAccount(
    actor: AuthenticatedAdmin,
    staffId: number,
    input: {
      role?: AdminRole;
      permissions?: AdminPermission[];
      twoFactorEnabled?: boolean;
      isActive?: boolean;
    }
  ): void {
    this.assertAdminPermission(actor, 'manage_staff');
    if (staffId === actor.id && input.isActive === false) {
      throw new AppError(422, 'SELF_LOCKOUT', 'You cannot deactivate your own active administrator account.');
    }
    const existing = this.db
      .prepare(`SELECT * FROM admin_users WHERE id = ?`)
      .get(staffId) as Record<string, unknown> | undefined;
    if (!existing) {
      throw new AppError(404, 'STAFF_NOT_FOUND', 'Staff account not found.');
    }

    const nextRole = (input.role ?? String(existing.role)) as AdminRole;
    if (!(ADMIN_ROLES as readonly string[]).includes(nextRole)) {
      throw new AppError(400, 'INVALID_ROLE', 'Invalid staff role.');
    }
    const nextPerms =
      nextRole === 'main_admin'
        ? [...ADMIN_PERMISSIONS]
        : (input.permissions ?? (JSON.parse(String(existing.permissions_json)) as AdminPermission[])).filter((p) =>
            (ADMIN_PERMISSIONS as readonly string[]).includes(p)
          );
    const nextTwoFactor =
      input.twoFactorEnabled !== undefined ? (input.twoFactorEnabled ? 1 : 0) : Number(existing.two_factor_enabled);
    const nextActive = input.isActive !== undefined ? (input.isActive ? 1 : 0) : Number(existing.is_active);

    const tx = this.db.transaction(() => {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE admin_users
           SET role = ?, permissions_json = ?, two_factor_enabled = ?, is_active = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(nextRole, JSON.stringify(nextPerms), nextTwoFactor, nextActive, now, staffId);

      // Revoke sessions on role/deactivation changes (Section 43)
      this.db
        .prepare(
          `UPDATE auth_sessions SET revoked_at = ? WHERE actor_type = 'admin' AND admin_id = ? AND revoked_at IS NULL`
        )
        .run(now, staffId);

      this.writeAuditLogTx({
        actorType: 'admin',
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'UPDATE_STAFF_PERMISSIONS',
        entityType: 'admin_user',
        entityId: staffId,
        beforeObj: {
          role: existing.role,
          permissions: JSON.parse(String(existing.permissions_json)),
          isActive: Number(existing.is_active) === 1,
        },
        afterObj: {
          role: nextRole,
          permissions: nextPerms,
          isActive: nextActive === 1,
        },
      });
    });

    tx.immediate();
  }

  // =========================================================================
  // CUSTOMER ACCOUNTS, REGISTRATION, OTP, LOGIN, RESET & BLOCKING
  // =========================================================================

  private mapCustomerRow(row: Record<string, unknown>): CustomerPublicView {
    const currency = this.getCurrencySymbol();
    const balance = Number(row.outstanding_balance_paisa);
    return {
      id: Number(row.id),
      accountNumber: String(row.account_number),
      name: String(row.name),
      businessName: String(row.business_name || ''),
      mobileNumber: String(row.mobile_number),
      city: String(row.city || ''),
      status: String(row.status) as CustomerAccountStatus,
      outstandingBalancePaisa: balance,
      outstandingBalanceFormatted: formatPaisa(balance, currency),
      blockedReason: row.blocked_reason ? String(row.blocked_reason) : null,
      createdAt: String(row.created_at),
    };
  }

  /**
   * Administrator pre-creates a customer account, atomically allocating sequential BRB-C-ID131+.
   */
  public createCustomerByAdmin(
    actor: AuthenticatedAdmin,
    input: {
      name: string;
      businessName?: string;
      mobileNumber: string;
      city?: string;
      notes?: string;
    }
  ): CustomerPublicView {
    this.assertAdminPermission(actor, 'manage_customers');
    const name = (input.name || '').trim();
    if (name.length < 2 || name.length > 140) {
      throw new AppError(400, 'INVALID_CUSTOMER_NAME', 'Customer name must be between 2 and 140 characters.');
    }
    if (!isValidMobileNumber(input.mobileNumber || '')) {
      throw new AppError(400, 'INVALID_MOBILE', 'Please enter a valid customer mobile number (e.g., 03001234567).');
    }
    const mobile = normalizePakistaniMobile(input.mobileNumber);

    const tx = this.db.transaction(() => {
      const seq = this.allocateSequenceTx('customer_account');
      const accountNumber = formatCustomerAccountNumber(seq);
      const now = new Date().toISOString();

      const info = this.db
        .prepare(
          `INSERT INTO customers (
            account_number, sequence_number, name, business_name, mobile_number,
            city, notes, status, opening_balance_paisa, outstanding_balance_paisa,
            created_by_admin_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unregistered', 0, 0, ?, ?, ?)`
        )
        .run(
          accountNumber,
          seq,
          name,
          (input.businessName || '').trim(),
          mobile,
          (input.city || '').trim(),
          (input.notes || '').trim(),
          actor.id,
          now,
          now
        );

      const customerId = Number(info.lastInsertRowid);
      this.writeAuditLogTx({
        actorType: 'admin',
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'CREATE_CUSTOMER_ACCOUNT',
        entityType: 'customer',
        entityId: customerId,
        afterObj: { accountNumber, name, mobileNumber: mobile },
      });

      const created = this.db.prepare(`SELECT * FROM customers WHERE id = ?`).get(customerId) as Record<
        string,
        unknown
      >;
      return this.mapCustomerRow(created);
    });

    return tx.immediate();
  }

  /**
   * Step 1 of Customer Registration:
   * Registration (BRB Account Number + Mobile + Password + Confirm Password) -> Mobile OTP
   */
  public async startCustomerRegistration(input: {
    accountNumber: string;
    mobileNumber: string;
    password: string;
    confirmPassword: string;
  }): Promise<{
    challengeId: number;
    accountNumber: string;
    smsStatus: string;
    devSandboxOtp?: string;
  }> {
    const accountNumber = normalizeAccountNumber(input.accountNumber || '');
    if (!isValidAccountNumberFormat(accountNumber)) {
      throw new AppError(
        400,
        'INVALID_ACCOUNT_NUMBER',
        'Please enter a valid BRB Account Number (for example, BRB-C-ID131).'
      );
    }
    if (!isValidMobileNumber(input.mobileNumber || '')) {
      throw new AppError(400, 'INVALID_MOBILE', 'Please enter a valid mobile number.');
    }
    const mobile = normalizePakistaniMobile(input.mobileNumber);
    const password = input.password || '';
    if (password.length < 6) {
      throw new AppError(400, 'WEAK_PASSWORD', 'Password must be at least 6 characters long.');
    }
    if (password !== input.confirmPassword) {
      throw new AppError(400, 'PASSWORD_MISMATCH', 'Password and Confirm Password do not match.');
    }

    const otpCode = generateNumericOtp();
    const expirySec = Number(this.getSetting('otp_expiry_seconds', '300')) || 300;
    const cooldownSec = Number(this.getSetting('otp_resend_cooldown_seconds', '60')) || 60;
    const maxAttempts = Number(this.getSetting('otp_max_attempts', '5')) || 5;

    const tx = this.db.transaction(() => {
      const cust = this.db
        .prepare(`SELECT * FROM customers WHERE account_number = ?`)
        .get(accountNumber) as Record<string, unknown> | undefined;

      if (!cust || normalizePakistaniMobile(String(cust.mobile_number)) !== mobile) {
        throw new AppError(
          400,
          'REGISTRATION_NOT_ELIGIBLE',
          'The submitted BRB Account Number and Mobile Number do not match an eligible BRB customer record. Contact BRB via WhatsApp for assistance.'
        );
      }

      const status = String(cust.status) as CustomerAccountStatus;
      if (status === 'blocked') {
        throw new AppError(403, 'ACCOUNT_BLOCKED', URDU_MESSAGES.accountBlocked);
      }
      if (status === 'rejected') {
        throw new AppError(
          403,
          'REGISTRATION_REJECTED',
          'This registration was declined by BRB administration. Please contact BRB office.'
        );
      }
      if (status === 'active') {
        throw new AppError(409, 'ALREADY_REGISTERED', 'This BRB account is already registered and active. Please log in.');
      }
      if (status === 'pending_approval') {
        throw new AppError(
          409,
          'PENDING_APPROVAL',
          'Your registration is already verified and awaiting administrator approval.'
        );
      }

      const customerId = Number(cust.id);
      const latestOtp = this.db
        .prepare(
          `SELECT resend_available_at FROM otp_challenges
           WHERE target_type = 'customer' AND target_id = ? AND purpose = 'customer_registration'
           ORDER BY id DESC LIMIT 1`
        )
        .get(customerId) as { resend_available_at: string } | undefined;

      if (latestOtp && Date.now() < Date.parse(latestOtp.resend_available_at)) {
        throw new AppError(429, 'OTP_COOLDOWN', 'Please wait before requesting a new OTP code.');
      }

      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const passwordHash = hashPassword(password);
      this.db
        .prepare(`UPDATE customers SET password_hash = ?, status = 'pending_otp', updated_at = ? WHERE id = ?`)
        .run(passwordHash, nowIso, customerId);

      const otpDigest = hashOtp(otpCode, `customer:${customerId}:customer_registration`);
      const info = this.db
        .prepare(
          `INSERT INTO otp_challenges (
            target_type, target_id, mobile_or_email, purpose, otp_digest,
            attempts_used, max_attempts, expires_at, resend_available_at, created_at
          ) VALUES ('customer', ?, ?, 'customer_registration', ?, 0, ?, ?, ?, ?)`
        )
        .run(
          customerId,
          mobile,
          otpDigest,
          maxAttempts,
          new Date(nowMs + expirySec * 1000).toISOString(),
          new Date(nowMs + cooldownSec * 1000).toISOString(),
          nowIso
        );

      return { challengeId: Number(info.lastInsertRowid), customerId };
    });

    const { challengeId } = tx.immediate();
    const smsRes = await dispatchSmsViaProvider(
      this.getSmsConfig(),
      mobile,
      `BRB Feed Industry registration OTP for ${accountNumber}: ${otpCode}`,
      `cust-reg-otp-${challengeId}`
    );
    this.db
      .prepare(`UPDATE otp_challenges SET sms_status = ? WHERE id = ?`)
      .run(smsRes.status, challengeId);

    return {
      challengeId,
      accountNumber,
      smsStatus: smsRes.status,
      ...(isIsolatedDevOtpAllowed() && smsRes.status === 'not_configured'
        ? { devSandboxOtp: otpCode }
        : {}),
    };
  }

  /**
   * Step 2 of Customer Registration:
   * Mobile OTP Verified -> Pending Admin Approval
   */
  public verifyCustomerRegistrationOtp(input: {
    accountNumber: string;
    otp: string;
  }): { status: 'pending_approval'; message: string } {
    const accountNumber = normalizeAccountNumber(input.accountNumber || '');
    const cust = this.db
      .prepare(`SELECT * FROM customers WHERE account_number = ?`)
      .get(accountNumber) as Record<string, unknown> | undefined;

    if (!cust || String(cust.status) !== 'pending_otp') {
      throw new AppError(400, 'INVALID_REGISTRATION_STATE', 'No pending OTP registration found for this account.');
    }

    const customerId = Number(cust.id);
    const challenge = this.db
      .prepare(
        `SELECT * FROM otp_challenges
         WHERE target_type = 'customer' AND target_id = ? AND purpose = 'customer_registration' AND consumed_at IS NULL
         ORDER BY id DESC LIMIT 1`
      )
      .get(customerId) as Record<string, unknown> | undefined;

    if (!challenge) {
      throw new AppError(400, 'OTP_NOT_FOUND', 'No active OTP challenge found. Please register again.');
    }
    if (Date.now() > Date.parse(String(challenge.expires_at))) {
      throw new AppError(400, 'OTP_EXPIRED', 'OTP has expired. Please request a new OTP.');
    }
    if (Number(challenge.attempts_used) >= Number(challenge.max_attempts)) {
      throw new AppError(429, 'OTP_MAX_ATTEMPTS', 'Maximum OTP verification attempts reached. Please wait and request a new OTP.');
    }

    const ok = verifyOtpDigest(
      input.otp || '',
      `customer:${customerId}:customer_registration`,
      String(challenge.otp_digest)
    );
    if (!ok) {
      this.db
        .prepare(`UPDATE otp_challenges SET attempts_used = attempts_used + 1 WHERE id = ?`)
        .run(challenge.id);
      throw new AppError(400, 'INVALID_OTP', 'Invalid OTP code. Please check and try again.');
    }

    const tx = this.db.transaction(() => {
      const now = new Date().toISOString();
      this.db
        .prepare(`UPDATE otp_challenges SET consumed_at = ? WHERE id = ?`)
        .run(now, challenge.id);
      this.db
        .prepare(`UPDATE customers SET status = 'pending_approval', updated_at = ? WHERE id = ?`)
        .run(now, customerId);
      this.writeAuditLogTx({
        actorType: 'customer',
        actorId: customerId,
        actorName: String(cust.name),
        action: 'CUSTOMER_OTP_VERIFIED_PENDING_APPROVAL',
        entityType: 'customer',
        entityId: customerId,
      });
    });

    tx.immediate();
    return {
      status: 'pending_approval',
      message: 'Mobile OTP verified. Your account is now awaiting BRB Administrator approval.',
    };
  }

  /**
   * Step 3 of Customer Registration:
   * Admin Approval -> Account Activated (or Rejected)
   */
  public async approveOrRejectCustomerRegistration(
    actor: AuthenticatedAdmin,
    customerId: number,
    decision: 'approve' | 'reject',
    reason?: string
  ): Promise<CustomerPublicView> {
    this.assertAdminPermission(actor, 'approve_registrations');
    let smsTask: PendingSmsTask | null = null;

    const tx = this.db.transaction(() => {
      const cust = this.db
        .prepare(`SELECT * FROM customers WHERE id = ?`)
        .get(customerId) as Record<string, unknown> | undefined;
      if (!cust) {
        throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Customer record not found.');
      }
      const prevStatus = String(cust.status);
      if (prevStatus !== 'pending_approval') {
        throw new AppError(
          422,
          'INVALID_APPROVAL_STATE',
          `Only accounts in pending_approval status can be reviewed (current: ${prevStatus}).`
        );
      }

      const now = new Date().toISOString();
      if (decision === 'approve') {
        this.db
          .prepare(
            `UPDATE customers
             SET status = 'active', approved_at = ?, approved_by_admin_id = ?, rejected_reason = NULL, updated_at = ?
             WHERE id = ?`
          )
          .run(now, actor.id, now, customerId);

        smsTask = this.createNotificationTx({
          customerId,
          eventType: 'Registration Approved',
          title: 'Registration Approved',
          message: `Your BRB account (${cust.account_number}) has been approved and activated. You may now log in.`,
          targetType: 'account',
          targetId: customerId,
          createdByAdminId: actor.id,
        });
      } else {
        const rejectReason = (reason || 'Registration declined by administrator.').trim();
        this.db
          .prepare(
            `UPDATE customers
             SET status = 'rejected', rejected_reason = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(rejectReason, now, customerId);

        smsTask = this.createNotificationTx({
          customerId,
          eventType: 'Registration Rejected',
          title: 'Registration Not Approved',
          message: `Your registration request for ${cust.account_number} was not approved. Reason: ${rejectReason}`,
          targetType: 'account',
          targetId: customerId,
          createdByAdminId: actor.id,
        });
      }

      this.writeAuditLogTx({
        actorType: 'admin',
        actorId: actor.id,
        actorName: actor.displayName,
        action: decision === 'approve' ? 'APPROVE_CUSTOMER_REGISTRATION' : 'REJECT_CUSTOMER_REGISTRATION',
        entityType: 'customer',
        entityId: customerId,
        reason: reason ?? null,
        beforeObj: { status: prevStatus },
        afterObj: { status: decision === 'approve' ? 'active' : 'rejected' },
      });

      const updated = this.db.prepare(`SELECT * FROM customers WHERE id = ?`).get(customerId) as Record<
        string,
        unknown
      >;
      return this.mapCustomerRow(updated);
    });

    const result = tx.immediate();
    await this.flushPendingSmsTasks([smsTask]);
    return result;
  }

  public loginCustomer(input: {
    accountNumber: string;
    password: string;
  }): { customer: CustomerPublicView; token: string } {
    const accountNumber = normalizeAccountNumber(input.accountNumber || '');
    const password = input.password || '';
    if (!accountNumber || !password) {
      throw new AppError(400, 'MISSING_CREDENTIALS', 'Please enter your BRB Account Number and Password.');
    }

    const cust = this.db
      .prepare(`SELECT * FROM customers WHERE account_number = ?`)
      .get(accountNumber) as Record<string, unknown> | undefined;

    if (!cust || !cust.password_hash || !verifyPassword(password, String(cust.password_hash))) {
      this.writeAuditLogTx({
        actorType: 'system',
        actorId: null,
        actorName: accountNumber.slice(0, 64),
        action: 'CUSTOMER_LOGIN_FAILED',
        entityType: 'customer_auth',
        entityId: accountNumber.slice(0, 64),
      });
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid BRB Account Number or Password.');
    }

    const status = String(cust.status) as CustomerAccountStatus;
    if (status === 'blocked') {
      throw new AppError(403, 'ACCOUNT_BLOCKED', URDU_MESSAGES.accountBlocked);
    }
    if (status === 'pending_otp') {
      throw new AppError(
        403,
        'PENDING_OTP',
        'Please complete mobile OTP verification before logging in.'
      );
    }
    if (status === 'pending_approval') {
      throw new AppError(
        403,
        'PENDING_APPROVAL',
        'Your registration is awaiting BRB Administrator approval. You will be notified once activated.'
      );
    }
    if (status === 'rejected') {
      throw new AppError(
        403,
        'ACCOUNT_REJECTED',
        'Your account registration was declined. Please contact BRB office for assistance.'
      );
    }
    if (status !== 'active') {
      throw new AppError(403, 'ACCOUNT_INACTIVE', 'Your account is not yet activated.');
    }

    const customerId = Number(cust.id);
    const { rawToken, tokenHash } = generateSessionToken();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    this.db
      .prepare(
        `INSERT INTO auth_sessions (token_hash, actor_type, customer_id, expires_at, created_at)
         VALUES (?, 'customer', ?, ?, ?)`
      )
      .run(tokenHash, customerId, expiresAt, now);

    return {
      token: rawToken,
      customer: this.mapCustomerRow(cust),
    };
  }

  public authenticateCustomerToken(rawToken: string): AuthenticatedCustomer {
    const tokenHash = hashToken(rawToken);
    const row = this.db
      .prepare(
        `SELECT s.expires_at, s.revoked_at, c.*
         FROM auth_sessions s
         INNER JOIN customers c ON c.id = s.customer_id
         WHERE s.token_hash = ? AND s.actor_type = 'customer'
         LIMIT 1`
      )
      .get(tokenHash) as Record<string, unknown> | undefined;

    if (!row) {
      throw new AppError(401, 'UNAUTHORIZED', 'Please log in to access your BRB customer account.');
    }
    const status = String(row.status) as CustomerAccountStatus;
    if (status === 'blocked') {
      throw new AppError(403, 'ACCOUNT_BLOCKED', URDU_MESSAGES.accountBlocked);
    }
    if (row.revoked_at) {
      throw new AppError(401, 'UNAUTHORIZED', 'Please log in to access your BRB customer account.');
    }
    if (Date.now() > Date.parse(String(row.expires_at))) {
      throw new AppError(401, 'SESSION_EXPIRED', 'Your session has expired. Please log in again.');
    }
    if (status !== 'active') {
      throw new AppError(403, 'ACCOUNT_INACTIVE', 'Your customer account is not active.');
    }

    return {
      id: Number(row.id),
      accountNumber: String(row.account_number),
      name: String(row.name),
      businessName: String(row.business_name || ''),
      mobileNumber: String(row.mobile_number),
      city: String(row.city || ''),
      status,
      outstandingBalancePaisa: Number(row.outstanding_balance_paisa),
    };
  }

  /**
   * Customer Forgot Password (Section 14):
   * Account Number + Registered Mobile Number -> OTP -> New Password -> Password Updated
   */
  public async requestCustomerPasswordReset(input: {
    accountNumber: string;
    mobileNumber: string;
  }): Promise<{
    acknowledged: true;
    smsStatus?: string;
    devSandboxOtp?: string;
  }> {
    const accountNumber = normalizeAccountNumber(input.accountNumber || '');
    const mobile = normalizePakistaniMobile(input.mobileNumber || '');

    if (!accountNumber || !mobile) {
      throw new AppError(400, 'MISSING_FIELDS', 'Enter your BRB Account Number and registered Mobile Number.');
    }

    const cust = this.db
      .prepare(`SELECT * FROM customers WHERE account_number = ?`)
      .get(accountNumber) as Record<string, unknown> | undefined;

    // Generic public response to avoid leaking whether an account/phone exists (Section 14)
    if (
      !cust ||
      normalizePakistaniMobile(String(cust.mobile_number)) !== mobile ||
      String(cust.status) !== 'active'
    ) {
      return { acknowledged: true };
    }

    const customerId = Number(cust.id);
    const latestOtp = this.db
      .prepare(
        `SELECT resend_available_at FROM otp_challenges
         WHERE target_type = 'customer' AND target_id = ? AND purpose = 'customer_password_reset'
         ORDER BY id DESC LIMIT 1`
      )
      .get(customerId) as { resend_available_at: string } | undefined;

    if (latestOtp && Date.now() < Date.parse(latestOtp.resend_available_at)) {
      throw new AppError(429, 'OTP_COOLDOWN', 'Please wait before requesting another OTP.');
    }

    const otpCode = generateNumericOtp();
    const expirySec = Number(this.getSetting('otp_expiry_seconds', '300')) || 300;
    const cooldownSec = Number(this.getSetting('otp_resend_cooldown_seconds', '60')) || 60;
    const maxAttempts = Number(this.getSetting('otp_max_attempts', '5')) || 5;
    const nowMs = Date.now();
    const otpDigest = hashOtp(otpCode, `customer:${customerId}:customer_password_reset`);

    const info = this.db
      .prepare(
        `INSERT INTO otp_challenges (
          target_type, target_id, mobile_or_email, purpose, otp_digest,
          attempts_used, max_attempts, expires_at, resend_available_at, created_at
        ) VALUES ('customer', ?, ?, 'customer_password_reset', ?, 0, ?, ?, ?, ?)`
      )
      .run(
        customerId,
        mobile,
        otpDigest,
        maxAttempts,
        new Date(nowMs + expirySec * 1000).toISOString(),
        new Date(nowMs + cooldownSec * 1000).toISOString(),
        new Date(nowMs).toISOString()
      );

    const challengeId = Number(info.lastInsertRowid);
    const smsRes = await dispatchSmsViaProvider(
      this.getSmsConfig(),
      mobile,
      `BRB Feed Industry password reset OTP for ${accountNumber}: ${otpCode}`,
      `cust-pwreset-${challengeId}`
    );
    this.db.prepare(`UPDATE otp_challenges SET sms_status = ? WHERE id = ?`).run(smsRes.status, challengeId);

    return {
      acknowledged: true,
      smsStatus: smsRes.status,
      ...(isIsolatedDevOtpAllowed() && smsRes.status === 'not_configured'
        ? { devSandboxOtp: otpCode }
        : {}),
    };
  }

  public async completeCustomerPasswordReset(input: {
    accountNumber: string;
    mobileNumber: string;
    otp: string;
    newPassword: string;
    confirmPassword: string;
  }): Promise<void> {
    if ((input.newPassword || '').length < 6) {
      throw new AppError(400, 'WEAK_PASSWORD', 'New password must be at least 6 characters.');
    }
    if (input.newPassword !== input.confirmPassword) {
      throw new AppError(400, 'PASSWORD_MISMATCH', 'New password and confirmation do not match.');
    }
    const accountNumber = normalizeAccountNumber(input.accountNumber || '');
    const mobile = normalizePakistaniMobile(input.mobileNumber || '');

    const cust = this.db
      .prepare(`SELECT * FROM customers WHERE account_number = ?`)
      .get(accountNumber) as Record<string, unknown> | undefined;

    if (
      !cust ||
      normalizePakistaniMobile(String(cust.mobile_number)) !== mobile ||
      String(cust.status) !== 'active'
    ) {
      throw new AppError(400, 'RESET_INVALID', 'Invalid verification details or expired OTP.');
    }

    const customerId = Number(cust.id);
    const challenge = this.db
      .prepare(
        `SELECT * FROM otp_challenges
         WHERE target_type = 'customer' AND target_id = ? AND purpose = 'customer_password_reset' AND consumed_at IS NULL
         ORDER BY id DESC LIMIT 1`
      )
      .get(customerId) as Record<string, unknown> | undefined;

    if (!challenge || Date.now() > Date.parse(String(challenge.expires_at))) {
      throw new AppError(400, 'OTP_EXPIRED', 'OTP has expired or is invalid.');
    }
    if (Number(challenge.attempts_used) >= Number(challenge.max_attempts)) {
      throw new AppError(429, 'OTP_MAX_ATTEMPTS', 'Maximum OTP attempts reached. Request a new OTP.');
    }
    if (
      !verifyOtpDigest(
        input.otp || '',
        `customer:${customerId}:customer_password_reset`,
        String(challenge.otp_digest)
      )
    ) {
      this.db
        .prepare(`UPDATE otp_challenges SET attempts_used = attempts_used + 1 WHERE id = ?`)
        .run(challenge.id);
      throw new AppError(400, 'INVALID_OTP', 'Incorrect OTP code.');
    }

    let smsTask: PendingSmsTask | null = null;
    const tx = this.db.transaction(() => {
      const now = new Date().toISOString();
      this.db
        .prepare(`UPDATE otp_challenges SET consumed_at = ? WHERE id = ?`)
        .run(now, challenge.id);
      this.db
        .prepare(`UPDATE customers SET password_hash = ?, updated_at = ? WHERE id = ?`)
        .run(hashPassword(input.newPassword), now, customerId);
      // Revoke all active customer sessions
      this.db
        .prepare(
          `UPDATE auth_sessions SET revoked_at = ? WHERE actor_type = 'customer' AND customer_id = ? AND revoked_at IS NULL`
        )
        .run(now, customerId);

      smsTask = this.createNotificationTx({
        customerId,
        eventType: 'Password Reset / Changed',
        title: 'Password Updated',
        message: `Your BRB account (${accountNumber}) password was updated successfully.`,
        targetType: 'account',
        targetId: customerId,
      });

      this.writeAuditLogTx({
        actorType: 'customer',
        actorId: customerId,
        actorName: String(cust.name),
        action: 'CUSTOMER_PASSWORD_RESET',
        entityType: 'customer',
        entityId: customerId,
      });
    });

    tx.immediate();
    await this.flushPendingSmsTasks([smsTask]);
  }

  /**
   * Account Blocking & Unblocking (Section 15)
   */
  public async setCustomerBlockState(
    actor: AuthenticatedAdmin,
    customerId: number,
    blocked: boolean,
    reason?: string
  ): Promise<CustomerPublicView> {
    this.assertAdminPermission(actor, 'block_customers');
    const cleanReason = (reason || '').trim();
    if (blocked && cleanReason.length < 3) {
      throw new AppError(400, 'REASON_REQUIRED', 'Please enter an administrative reason for blocking this account.');
    }

    let smsTask: PendingSmsTask | null = null;
    const tx = this.db.transaction(() => {
      const cust = this.db
        .prepare(`SELECT * FROM customers WHERE id = ?`)
        .get(customerId) as Record<string, unknown> | undefined;
      if (!cust) {
        throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Customer account not found.');
      }

      const prevStatus = String(cust.status);
      const now = new Date().toISOString();

      if (blocked) {
        this.db
          .prepare(
            `UPDATE customers
             SET status = 'blocked', blocked_reason = ?, blocked_at = ?, blocked_by_admin_id = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(cleanReason, now, actor.id, now, customerId);

        // Immediately revoke all existing customer sessions!
        this.db
          .prepare(
            `UPDATE auth_sessions SET revoked_at = ? WHERE actor_type = 'customer' AND customer_id = ? AND revoked_at IS NULL`
          )
          .run(now, customerId);

        smsTask = this.createNotificationTx({
          customerId,
          eventType: 'Account Blocked',
          title: 'Account Blocked',
          message: URDU_MESSAGES.accountBlocked,
          targetType: 'account',
          targetId: customerId,
          createdByAdminId: actor.id,
        });
      } else {
        // Restore to active if they had completed approval, otherwise unregistered
        const nextStatus: CustomerAccountStatus = cust.approved_at ? 'active' : 'unregistered';
        this.db
          .prepare(
            `UPDATE customers
             SET status = ?, blocked_reason = NULL, blocked_at = NULL, blocked_by_admin_id = NULL, updated_at = ?
             WHERE id = ?`
          )
          .run(nextStatus, now, customerId);

        smsTask = this.createNotificationTx({
          customerId,
          eventType: 'Account Unblocked',
          title: 'Account Unblocked',
          message: `Your BRB account (${cust.account_number}) has been unblocked by BRB administration.`,
          targetType: 'account',
          targetId: customerId,
          createdByAdminId: actor.id,
        });
      }

      this.writeAuditLogTx({
        actorType: 'admin',
        actorId: actor.id,
        actorName: actor.displayName,
        action: blocked ? 'BLOCK_CUSTOMER' : 'UNBLOCK_CUSTOMER',
        entityType: 'customer',
        entityId: customerId,
        reason: cleanReason || null,
        beforeObj: { status: prevStatus },
        afterObj: { status: blocked ? 'blocked' : cust.approved_at ? 'active' : 'unregistered' },
      });

      const updated = this.db.prepare(`SELECT * FROM customers WHERE id = ?`).get(customerId) as Record<
        string,
        unknown
      >;
      return this.mapCustomerRow(updated);
    });

    const result = tx.immediate();
    await this.flushPendingSmsTasks([smsTask]);
    return result;
  }

  public listCustomersForAdmin(
    actor: AuthenticatedAdmin,
    filters?: { search?: string; status?: string }
  ): CustomerPublicView[] {
    if (
      !actor.permissions.includes('manage_customers') &&
      !actor.permissions.includes('approve_registrations') &&
      !actor.permissions.includes('manage_invoices') &&
      !actor.permissions.includes('manage_payments') &&
      !actor.permissions.includes('view_reports') &&
      actor.role !== 'main_admin'
    ) {
      throw new AppError(403, 'FORBIDDEN', 'Insufficient permission to view customer directory.');
    }

    const clauses: string[] = ['1=1'];
    const params: unknown[] = [];

    if (filters?.status && filters.status !== 'all') {
      clauses.push('status = ?');
      params.push(filters.status);
    }
    if (filters?.search?.trim()) {
      const q = `%${filters.search.trim()}%`;
      clauses.push('(name LIKE ? OR account_number LIKE ? OR mobile_number LIKE ? OR business_name LIKE ?)');
      params.push(q, q, q, q);
    }

    const rows = this.db
      .prepare(`SELECT * FROM customers WHERE ${clauses.join(' AND ')} ORDER BY sequence_number DESC`)
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((r) => this.mapCustomerRow(r));
  }

  // =========================================================================
  // PRODUCT CATALOG & MANAGEMENT (ZERO CUSTOMER PRICES)
  // =========================================================================

  private validateImageDataUrl(imageUrl: string | null | undefined): string | null {
    if (!imageUrl || !imageUrl.trim()) return null;
    const trimmed = imageUrl.trim();
    if (!/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/i.test(trimmed)) {
      throw new AppError(
        400,
        'INVALID_IMAGE',
        'Image must be a valid PNG, JPEG, or WebP upload.'
      );
    }
    if (trimmed.length > 2_800_000) {
      throw new AppError(400, 'IMAGE_TOO_LARGE', 'Uploaded image must be smaller than 2 MB.');
    }
    return trimmed;
  }

  /**
   * Customer-facing product list:
   * - Includes active and deactivated products (deactivated show "Currently Unavailable")
   * - Excludes archived products
   * - NEVER returns any pricing information
   */
  public listProductsForCustomer(category?: ProductCategory): ProductCustomerView[] {
    const clauses = ['is_archived = 0'];
    const params: unknown[] = [];
    if (category) {
      if (!isValidProductCategory(category)) {
        throw new AppError(400, 'INVALID_CATEGORY', 'Invalid product category.');
      }
      clauses.push('category = ?');
      params.push(category);
    }

    const rows = this.db
      .prepare(`SELECT * FROM products WHERE ${clauses.join(' AND ')} ORDER BY is_active DESC, id ASC`)
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      category: String(r.category) as ProductCategory,
      packingWeight: String(r.packing_weight),
      usage: String(r.usage) as ProductUsage,
      shortDescription: String(r.short_description),
      fullDetails: String(r.full_details),
      imageUrl: r.image_data_url ? String(r.image_data_url) : null,
      isActive: Number(r.is_active) === 1,
    }));
  }

  public listProductsForAdmin(actor: AuthenticatedAdmin, includeArchived = false): ProductAdminView[] {
    if (
      actor.role !== 'main_admin' &&
      !actor.permissions.includes('manage_products') &&
      !actor.permissions.includes('manage_orders') &&
      !actor.permissions.includes('manage_invoices')
    ) {
      throw new AppError(403, 'FORBIDDEN', 'Insufficient permission to access product catalog.');
    }

    const sql = includeArchived
      ? `SELECT * FROM products ORDER BY is_archived ASC, id DESC`
      : `SELECT * FROM products WHERE is_archived = 0 ORDER BY id DESC`;
    const rows = this.db.prepare(sql).all() as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      category: String(r.category) as ProductCategory,
      packingWeight: String(r.packing_weight),
      usage: String(r.usage) as ProductUsage,
      shortDescription: String(r.short_description),
      fullDetails: String(r.full_details),
      imageUrl: r.image_data_url ? String(r.image_data_url) : null,
      isActive: Number(r.is_active) === 1,
      isArchived: Number(r.is_archived) === 1,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
  }

  public createProduct(
    actor: AuthenticatedAdmin,
    input: {
      name: string;
      category: ProductCategory;
      packingWeight: string;
      usage: ProductUsage;
      shortDescription: string;
      fullDetails: string;
      imageUrl?: string | null;
      isActive?: boolean;
    }
  ): ProductAdminView {
    this.assertAdminPermission(actor, 'manage_products');
    const name = (input.name || '').trim();
    const packingWeight = (input.packingWeight || '').trim();
    const shortDescription = (input.shortDescription || '').trim();
    const fullDetails = (input.fullDetails || '').trim();

    if (name.length < 2 || name.length > 140) {
      throw new AppError(400, 'INVALID_PRODUCT_NAME', 'Product name must be between 2 and 140 characters.');
    }
    if (!isValidProductCategory(input.category)) {
      throw new AppError(400, 'INVALID_CATEGORY', 'Category must be "BRB Cattle Feed" or "BRB Oil Mill".');
    }
    if (!isValidProductUsage(input.usage)) {
      throw new AppError(400, 'INVALID_USAGE', 'Usage must be "Milk", "Meat", or "Both".');
    }
    if (!packingWeight || packingWeight.length > 60) {
      throw new AppError(400, 'INVALID_PACKING', 'Packing/weight is required (for example, 40 kg Bag).');
    }
    if (!shortDescription || shortDescription.length > 300) {
      throw new AppError(400, 'INVALID_DESCRIPTION', 'Brief description is required (up to 300 characters).');
    }

    const validImage = this.validateImageDataUrl(input.imageUrl);
    const now = new Date().toISOString();
    const isActive = input.isActive === false ? 0 : 1;

    const info = this.db
      .prepare(
        `INSERT INTO products (
          name, category, packing_weight, usage, short_description, full_details,
          image_data_url, is_active, is_archived, created_by_admin_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
      )
      .run(
        name,
        input.category,
        packingWeight,
        input.usage,
        shortDescription,
        fullDetails || shortDescription,
        validImage,
        isActive,
        actor.id,
        now,
        now
      );

    const productId = Number(info.lastInsertRowid);
    this.writeAuditLogTx({
      actorType: 'admin',
      actorId: actor.id,
      actorName: actor.displayName,
      action: 'CREATE_PRODUCT',
      entityType: 'product',
      entityId: productId,
      afterObj: { name, category: input.category, packingWeight, usage: input.usage, isActive: Boolean(isActive) },
    });

    return this.listProductsForAdmin(actor, true).find((p) => p.id === productId)!;
  }

  public updateProduct(
    actor: AuthenticatedAdmin,
    productId: number,
    input: {
      name?: string;
      category?: ProductCategory;
      packingWeight?: string;
      usage?: ProductUsage;
      shortDescription?: string;
      fullDetails?: string;
      imageUrl?: string | null;
      isActive?: boolean;
    }
  ): ProductAdminView {
    this.assertAdminPermission(actor, 'manage_products');
    const existing = this.db
      .prepare(`SELECT * FROM products WHERE id = ?`)
      .get(productId) as Record<string, unknown> | undefined;
    if (!existing) {
      throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
    }

    const name = input.name !== undefined ? input.name.trim() : String(existing.name);
    const category = (input.category ?? String(existing.category)) as ProductCategory;
    const packingWeight =
      input.packingWeight !== undefined ? input.packingWeight.trim() : String(existing.packing_weight);
    const usage = (input.usage ?? String(existing.usage)) as ProductUsage;
    const shortDescription =
      input.shortDescription !== undefined ? input.shortDescription.trim() : String(existing.short_description);
    const fullDetails =
      input.fullDetails !== undefined ? input.fullDetails.trim() : String(existing.full_details);
    const imageUrl =
      input.imageUrl !== undefined
        ? this.validateImageDataUrl(input.imageUrl)
        : existing.image_data_url
          ? String(existing.image_data_url)
          : null;
    const isActive = input.isActive !== undefined ? (input.isActive ? 1 : 0) : Number(existing.is_active);

    if (name.length < 2 || !isValidProductCategory(category) || !isValidProductUsage(usage) || !packingWeight || !shortDescription) {
      throw new AppError(400, 'INVALID_PRODUCT_UPDATE', 'All required product fields must be valid.');
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE products
         SET name = ?, category = ?, packing_weight = ?, usage = ?, short_description = ?,
             full_details = ?, image_data_url = ?, is_active = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(name, category, packingWeight, usage, shortDescription, fullDetails, imageUrl, isActive, now, productId);

    this.writeAuditLogTx({
      actorType: 'admin',
      actorId: actor.id,
      actorName: actor.displayName,
      action: 'UPDATE_PRODUCT',
      entityType: 'product',
      entityId: productId,
      beforeObj: { name: existing.name, isActive: Number(existing.is_active) === 1 },
      afterObj: { name, category, packingWeight, usage, isActive: Boolean(isActive) },
    });

    return this.listProductsForAdmin(actor, true).find((p) => p.id === productId)!;
  }

  /**
   * Safe product deletion (Section 19):
   * Physically deletes only if unreferenced; otherwise archives cleanly so historical orders/invoices never break.
   */
  public deleteOrArchiveProduct(
    actor: AuthenticatedAdmin,
    productId: number
  ): { mode: 'deleted' | 'archived'; message: string } {
    this.assertAdminPermission(actor, 'manage_products');
    const existing = this.db.prepare(`SELECT * FROM products WHERE id = ?`).get(productId) as
      | Record<string, unknown>
      | undefined;
    if (!existing) {
      throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
    }

    const refCounts = this.db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM order_requested_items WHERE product_id = ?) +
          (SELECT COUNT(*) FROM order_approved_items WHERE product_id = ?) +
          (SELECT COUNT(*) FROM invoice_items WHERE product_id = ?) AS total_refs`
      )
      .get(productId, productId, productId) as { total_refs: number };

    if (refCounts.total_refs > 0) {
      this.db
        .prepare(`UPDATE products SET is_archived = 1, is_active = 0, updated_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), productId);
      this.writeAuditLogTx({
        actorType: 'admin',
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'ARCHIVE_REFERENCED_PRODUCT',
        entityType: 'product',
        entityId: productId,
      });
      return {
        mode: 'archived',
        message:
          'Product has historical order/invoice references and was safely archived (removed from catalog while preserving transaction history).',
      };
    }

    this.db.prepare(`DELETE FROM products WHERE id = ?`).run(productId);
    this.writeAuditLogTx({
      actorType: 'admin',
      actorId: actor.id,
      actorName: actor.displayName,
      action: 'DELETE_PRODUCT',
      entityType: 'product',
      entityId: productId,
    });
    return { mode: 'deleted', message: 'Product deleted permanently.' };
  }

  // =========================================================================
  // CUSTOMER ORDERING, ADMIN APPROVAL, REDUCTION REASONS & CANCELLATION
  // =========================================================================

  private hydrateOrders(orderRows: Array<Record<string, unknown>>): OrderView[] {
    if (orderRows.length === 0) return [];
    const reqStmt = this.db.prepare(`SELECT * FROM order_requested_items WHERE order_id = ? ORDER BY id ASC`);
    const appStmt = this.db.prepare(
      `SELECT oai.*, a.display_name AS added_by_admin_name
       FROM order_approved_items oai
       LEFT JOIN admin_users a ON a.id = oai.added_by_admin_id
       WHERE oai.order_id = ?
       ORDER BY oai.id ASC`
    );
    const histStmt = this.db.prepare(`SELECT * FROM order_status_history WHERE order_id = ? ORDER BY id ASC`);
    const invStmt = this.db.prepare(`SELECT id, invoice_number FROM invoices WHERE source_order_id = ? LIMIT 1`);
    const adminStmt = this.db.prepare(`SELECT display_name FROM admin_users WHERE id = ?`);

    return orderRows.map((row) => {
      const orderId = Number(row.id);
      const reqItems = (reqStmt.all(orderId) as Array<Record<string, unknown>>).map(
        (ri): OrderRequestedItemView => ({
          id: Number(ri.id),
          productId: Number(ri.product_id),
          productNameSnapshot: String(ri.product_name_snapshot),
          categorySnapshot: String(ri.category_snapshot) as ProductCategory,
          packingSnapshot: String(ri.packing_snapshot),
          requestedQty: Number(ri.requested_qty),
        })
      );

      const appItems = (appStmt.all(orderId) as Array<Record<string, unknown>>).map(
        (ai): OrderApprovedItemView => ({
          id: Number(ai.id),
          requestedItemId: ai.requested_item_id != null ? Number(ai.requested_item_id) : null,
          productId: Number(ai.product_id),
          productNameSnapshot: String(ai.product_name_snapshot),
          categorySnapshot: String(ai.category_snapshot) as ProductCategory,
          packingSnapshot: String(ai.packing_snapshot),
          requestedQty: ai.requested_qty != null ? Number(ai.requested_qty) : null,
          approvedQty: Number(ai.approved_qty),
          isAddedByBrb: Number(ai.is_added_by_brb) === 1,
          reductionReason: ai.reduction_reason ? String(ai.reduction_reason) : null,
          addedByAdminName: ai.added_by_admin_name ? String(ai.added_by_admin_name) : null,
        })
      );

      const history = (histStmt.all(orderId) as Array<Record<string, unknown>>).map(
        (h): OrderStatusHistoryView => ({
          id: Number(h.id),
          fromStatus: h.from_status ? (String(h.from_status) as OrderStatus) : null,
          toStatus: String(h.to_status) as OrderStatus,
          actorType: String(h.actor_type) as 'customer' | 'admin' | 'system',
          actorName: String(h.actor_name),
          note: h.note ? String(h.note) : null,
          createdAt: String(h.created_at),
        })
      );

      const linkedInv = invStmt.get(orderId) as { id: number; invoice_number: number } | undefined;
      const approvedAdmin =
        row.approved_by_admin_id != null
          ? (adminStmt.get(Number(row.approved_by_admin_id)) as { display_name: string } | undefined)
          : undefined;

      return {
        id: orderId,
        orderNumber: String(row.order_number),
        customerId: Number(row.customer_id),
        customerName: String(row.customer_name),
        customerAccountNumber: String(row.customer_account_number),
        status: String(row.status) as OrderStatus,
        requestedItems: reqItems,
        approvedItems: appItems,
        statusHistory: history,
        approvedByAdminName: approvedAdmin ? approvedAdmin.display_name : null,
        approvedAt: row.approved_at ? String(row.approved_at) : null,
        linkedInvoiceId: linkedInv ? linkedInv.id : null,
        linkedInvoiceNumber: linkedInv ? linkedInv.invoice_number : null,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      };
    });
  }

  public async submitCustomerOrder(
    customer: AuthenticatedCustomer,
    input: {
      items: Array<{ productId: number; quantity: number }>;
      idempotencyKey?: string;
    }
  ): Promise<OrderView> {
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new AppError(400, 'EMPTY_ORDER', 'Please select at least one product to submit an order.');
    }

    // Merge duplicate product lines cleanly if present
    const mergedMap = new Map<number, number>();
    for (const item of input.items) {
      if (!Number.isInteger(item.productId) || item.productId <= 0) {
        throw new AppError(400, 'INVALID_PRODUCT', 'Invalid product selection.');
      }
      if (!Number.isInteger(item.quantity) || item.quantity <= 0 || item.quantity > 100_000) {
        throw new AppError(400, 'INVALID_QUANTITY', 'Each selected product quantity must be a positive whole number.');
      }
      mergedMap.set(item.productId, (mergedMap.get(item.productId) || 0) + item.quantity);
    }

    let smsTask: PendingSmsTask | null = null;
    const tx = this.db.transaction(() => {
      if (input.idempotencyKey) {
        const existingOrder = this.db
          .prepare(
            `SELECT o.*, c.name AS customer_name, c.account_number AS customer_account_number
             FROM orders o
             INNER JOIN customers c ON c.id = o.customer_id
             WHERE o.idempotency_key = ? AND o.customer_id = ?`
          )
          .get(input.idempotencyKey, customer.id) as Record<string, unknown> | undefined;
        if (existingOrder) {
          return this.hydrateOrders([existingOrder])[0];
        }
      }

      const prodStmt = this.db.prepare(`SELECT * FROM products WHERE id = ?`);
      const validatedProducts: Array<{
        id: number;
        name: string;
        category: string;
        packingWeight: string;
        quantity: number;
      }> = [];

      for (const [productId, quantity] of mergedMap.entries()) {
        const prod = prodStmt.get(productId) as Record<string, unknown> | undefined;
        if (!prod || Number(prod.is_archived) === 1) {
          throw new AppError(404, 'PRODUCT_NOT_FOUND', `Selected product (#${productId}) does not exist.`);
        }
        if (Number(prod.is_active) !== 1) {
          throw new AppError(
            422,
            'PRODUCT_UNAVAILABLE',
            `"${prod.name}" is Currently Unavailable and cannot be ordered.`
          );
        }
        validatedProducts.push({
          id: productId,
          name: String(prod.name),
          category: String(prod.category),
          packingWeight: String(prod.packing_weight),
          quantity,
        });
      }

      const seq = this.allocateSequenceTx('order_number');
      const orderNumber = `BRB-ORD-${seq}`;
      const now = new Date().toISOString();

      const info = this.db
        .prepare(
          `INSERT INTO orders (
            order_number, sequence_number, customer_id, status, idempotency_key, created_at, updated_at
          ) VALUES (?, ?, ?, 'Order Received', ?, ?, ?)`
        )
        .run(orderNumber, seq, customer.id, input.idempotencyKey ?? null, now, now);

      const orderId = Number(info.lastInsertRowid);
      const insertReqItem = this.db.prepare(
        `INSERT INTO order_requested_items (
          order_id, product_id, product_name_snapshot, category_snapshot, packing_snapshot, requested_qty
        ) VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const vp of validatedProducts) {
        insertReqItem.run(orderId, vp.id, vp.name, vp.category, vp.packingWeight, vp.quantity);
      }

      this.db
        .prepare(
          `INSERT INTO order_status_history (
            order_id, from_status, to_status, actor_type, actor_id, actor_name, note, created_at
          ) VALUES (?, NULL, 'Order Received', 'customer', ?, ?, 'Order submitted by customer', ?)`
        )
        .run(orderId, customer.id, customer.name, now);

      smsTask = this.createNotificationTx({
        customerId: customer.id,
        eventType: 'Order Received',
        title: `Order Received (${orderNumber})`,
        message: `Your order ${orderNumber} has been received by BRB Cattle Feeds & Oil Mills and is queued for review.`,
        targetType: 'order',
        targetId: orderId,
        idempotencyKey: `order-recv-${orderId}`,
      });

      const createdRow = this.db
        .prepare(
          `SELECT o.*, c.name AS customer_name, c.account_number AS customer_account_number
           FROM orders o
           INNER JOIN customers c ON c.id = o.customer_id
           WHERE o.id = ?`
        )
        .get(orderId) as Record<string, unknown>;

      return this.hydrateOrders([createdRow])[0];
    });

    const created = tx.immediate();
    await this.flushPendingSmsTasks([smsTask]);
    return created;
  }

  public cancelCustomerOrder(customer: AuthenticatedCustomer, orderId: number): OrderView {
    const tx = this.db.transaction(() => {
      const orderRow = this.db
        .prepare(
          `SELECT o.*, c.name AS customer_name, c.account_number AS customer_account_number
           FROM orders o
           INNER JOIN customers c ON c.id = o.customer_id
           WHERE o.id = ?`
        )
        .get(orderId) as Record<string, unknown> | undefined;

      if (!orderRow || Number(orderRow.customer_id) !== customer.id) {
        throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
      }

      const currentStatus = String(orderRow.status) as OrderStatus;
      if (!canCustomerCancelOrder(currentStatus)) {
        throw new AppError(
          422,
          'CANCELLATION_NOT_ALLOWED',
          `Orders in "${currentStatus}" status can no longer be cancelled by the customer.`
        );
      }

      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE orders
           SET status = 'Cancelled', cancelled_by_type = 'customer', cancelled_at = ?, cancel_reason = 'Cancelled by customer', updated_at = ?
           WHERE id = ?`
        )
        .run(now, now, orderId);

      this.db
        .prepare(
          `INSERT INTO order_status_history (
            order_id, from_status, to_status, actor_type, actor_id, actor_name, note, created_at
          ) VALUES (?, ?, 'Cancelled', 'customer', ?, ?, 'Cancelled by customer', ?)`
        )
        .run(orderId, currentStatus, customer.id, customer.name, now);

      const updatedRow = this.db
        .prepare(
          `SELECT o.*, c.name AS customer_name, c.account_number AS customer_account_number
           FROM orders o
           INNER JOIN customers c ON c.id = o.customer_id
           WHERE o.id = ?`
        )
        .get(orderId) as Record<string, unknown>;

      return this.hydrateOrders([updatedRow])[0];
    });

    return tx.immediate();
  }

  public listOrdersForCustomer(customer: AuthenticatedCustomer): OrderView[] {
    const rows = this.db
      .prepare(
        `SELECT o.*, c.name AS customer_name, c.account_number AS customer_account_number
         FROM orders o
         INNER JOIN customers c ON c.id = o.customer_id
         WHERE o.customer_id = ?
         ORDER BY o.id DESC`
      )
      .all(customer.id) as Array<Record<string, unknown>>;
    return this.hydrateOrders(rows);
  }

  public getCustomerOrderById(customer: AuthenticatedCustomer, orderId: number): OrderView {
    const row = this.db
      .prepare(
        `SELECT o.*, c.name AS customer_name, c.account_number AS customer_account_number
         FROM orders o
         INNER JOIN customers c ON c.id = o.customer_id
         WHERE o.id = ? AND o.customer_id = ?`
      )
      .get(orderId, customer.id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
    }
    return this.hydrateOrders([row])[0];
  }

  public listOrdersForAdmin(
    actor: AuthenticatedAdmin,
    filters?: { status?: string; search?: string }
  ): OrderView[] {
    if (
      actor.role !== 'main_admin' &&
      !actor.permissions.includes('manage_orders') &&
      !actor.permissions.includes('manage_invoices') &&
      !actor.permissions.includes('view_reports')
    ) {
      throw new AppError(403, 'FORBIDDEN', 'Insufficient permission to view orders.');
    }

    const clauses = ['1=1'];
    const params: unknown[] = [];
    if (filters?.status && filters.status !== 'all') {
      clauses.push('o.status = ?');
      params.push(filters.status);
    }
    if (filters?.search?.trim()) {
      const q = `%${filters.search.trim()}%`;
      clauses.push('(o.order_number LIKE ? OR c.name LIKE ? OR c.account_number LIKE ?)');
      params.push(q, q, q);
    }

    const rows = this.db
      .prepare(
        `SELECT o.*, c.name AS customer_name, c.account_number AS customer_account_number
         FROM orders o
         INNER JOIN customers c ON c.id = o.customer_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY o.id DESC`
      )
      .all(...params) as Array<Record<string, unknown>>;

    return this.hydrateOrders(rows);
  }

  /**
   * Order Review & Approval (Sections 22 & 23):
   * - Preserves immutable original requested items
   * - Enforces mandatory reduction reason whenever approvedQty < requestedQty
   * - Records administrator-added items labeled "Added by BRB"
   */
  public async approveOrderByAdmin(
    actor: AuthenticatedAdmin,
    orderId: number,
    input: {
      items: Array<{
        requestedItemId?: number | null;
        productId: number;
        approvedQty: number;
        reductionReason?: string | null;
      }>;
    }
  ): Promise<OrderView> {
    this.assertAdminPermission(actor, 'manage_orders');
    const smsTasks: Array<PendingSmsTask | null> = [];

    const tx = this.db.transaction(() => {
      const orderRow = this.db
        .prepare(`SELECT * FROM orders WHERE id = ?`)
        .get(orderId) as Record<string, unknown> | undefined;
      if (!orderRow) {
        throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
      }
      const prevStatus = String(orderRow.status) as OrderStatus;
      if (prevStatus !== 'Order Received' && prevStatus !== 'Under Review') {
        throw new AppError(
          422,
          'ORDER_ALREADY_PROCESSED',
          `Order in "${prevStatus}" status cannot go through initial approval again.`
        );
      }

      const reqRows = this.db
        .prepare(`SELECT * FROM order_requested_items WHERE order_id = ? ORDER BY id ASC`)
        .all(orderId) as Array<Record<string, unknown>>;

      const requestedSpecs = reqRows.map((r) => ({
        requestedItemId: Number(r.id),
        productId: Number(r.product_id),
        requestedQty: Number(r.requested_qty),
      }));

      const validation = validateOrderApprovalItems(requestedSpecs, input.items || []);
      if (!validation.valid) {
        throw new AppError(400, 'APPROVAL_VALIDATION_FAILED', validation.error);
      }

      const reqRowById = new Map<number, Record<string, unknown>>(
        reqRows.map((r) => [Number(r.id), r])
      );
      const prodStmt = this.db.prepare(`SELECT * FROM products WHERE id = ?`);

      const now = new Date().toISOString();
      // Clear any draft approved rows if none existed and insert immutable approved snapshot
      this.db.prepare(`DELETE FROM order_approved_items WHERE order_id = ?`).run(orderId);

      const insertApp = this.db.prepare(
        `INSERT INTO order_approved_items (
          order_id, requested_item_id, product_id, product_name_snapshot,
          category_snapshot, packing_snapshot, requested_qty, approved_qty,
          is_added_by_brb, reduction_reason, added_by_admin_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const decision of input.items) {
        if (decision.requestedItemId != null) {
          const orig = reqRowById.get(decision.requestedItemId)!;
          const origQty = Number(orig.requested_qty);
          const reason =
            decision.approvedQty < origQty ? (decision.reductionReason || '').trim() : null;

          insertApp.run(
            orderId,
            decision.requestedItemId,
            Number(orig.product_id),
            String(orig.product_name_snapshot),
            String(orig.category_snapshot),
            String(orig.packing_snapshot),
            origQty,
            decision.approvedQty,
            0,
            reason,
            null,
            now
          );
        } else {
          // Added by BRB item
          const prod = prodStmt.get(decision.productId) as Record<string, unknown> | undefined;
          if (!prod || Number(prod.is_archived) === 1) {
            throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Added product does not exist.');
          }
          insertApp.run(
            orderId,
            null,
            decision.productId,
            String(prod.name),
            String(prod.category),
            String(prod.packing_weight),
            null,
            decision.approvedQty,
            1,
            null,
            actor.id,
            now
          );
        }
      }

      const nextStatus: OrderStatus = 'Confirmed / Partially Approved';
      this.db
        .prepare(
          `UPDATE orders
           SET status = ?, approved_by_admin_id = ?, approved_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(nextStatus, actor.id, now, now, orderId);

      this.db
        .prepare(
          `INSERT INTO order_status_history (
            order_id, from_status, to_status, actor_type, actor_id, actor_name, note, created_at
          ) VALUES (?, ?, ?, 'admin', ?, ?, 'Order quantities reviewed and approved', ?)`
        )
        .run(orderId, prevStatus, nextStatus, actor.id, actor.displayName, now);

      const customerId = Number(orderRow.customer_id);
      const orderNumber = String(orderRow.order_number);

      smsTasks.push(
        this.createNotificationTx({
          customerId,
          eventType: 'Order Confirmed / Partially Approved',
          title: `Order Approved (${orderNumber})`,
          message: `Your order ${orderNumber} has been reviewed and approved by BRB. Open to compare requested and approved quantities.`,
          targetType: 'order',
          targetId: orderId,
          idempotencyKey: `order-approved-${orderId}`,
          createdByAdminId: actor.id,
        })
      );

      this.writeAuditLogTx({
        actorType: 'admin',
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'APPROVE_ORDER',
        entityType: 'order',
        entityId: orderId,
        beforeObj: { status: prevStatus, requestedItems: requestedSpecs },
        afterObj: { status: nextStatus, approvedItems: input.items },
      });

      const updatedRow = this.db
        .prepare(
          `SELECT o.*, c.name AS customer_name, c.account_number AS customer_account_number
           FROM orders o
           INNER JOIN customers c ON c.id = o.customer_id
           WHERE o.id = ?`
        )
        .get(orderId) as Record<string, unknown>;

      return this.hydrateOrders([updatedRow])[0];
    });

    const approvedOrder = tx.immediate();
    await this.flushPendingSmsTasks(smsTasks);
    return approvedOrder;
  }

  public async updateOrderStatusByAdmin(
    actor: AuthenticatedAdmin,
    orderId: number,
    nextStatus: OrderStatus,
    note?: string
  ): Promise<OrderView> {
    this.assertAdminPermission(actor, 'manage_orders');
    if (!isValidOrderStatus(nextStatus)) {
      throw new AppError(400, 'INVALID_STATUS', 'Invalid target order status.');
    }
    if (nextStatus === 'Confirmed / Partially Approved') {
      throw new AppError(
        400,
        'USE_APPROVAL_WORKFLOW',
        'Use the Order Review & Approval form to confirm quantities and approve an order.'
      );
    }

    let smsTask: PendingSmsTask | null = null;
    const tx = this.db.transaction(() => {
      const orderRow = this.db
        .prepare(`SELECT * FROM orders WHERE id = ?`)
        .get(orderId) as Record<string, unknown> | undefined;
      if (!orderRow) {
        throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
      }

      const prevStatus = String(orderRow.status) as OrderStatus;
      if (!isValidAdminOrderTransition(prevStatus, nextStatus)) {
        throw new AppError(
          422,
          'INVALID_STATUS_TRANSITION',
          `Cannot transition order directly from "${prevStatus}" to "${nextStatus}".`
        );
      }

      const now = new Date().toISOString();
      this.db
        .prepare(`UPDATE orders SET status = ?, updated_at = ? WHERE id = ?`)
        .run(nextStatus, now, orderId);

      this.db
        .prepare(
          `INSERT INTO order_status_history (
            order_id, from_status, to_status, actor_type, actor_id, actor_name, note, created_at
          ) VALUES (?, ?, ?, 'admin', ?, ?, ?, ?)`
        )
        .run(orderId, prevStatus, nextStatus, actor.id, actor.displayName, (note || '').trim() || null, now);

      const eventMap: Partial<Record<OrderStatus, NotificationEventType>> = {
        'Under Review': 'Order Under Review',
        Preparing: 'Order Preparing',
        Dispatched: 'Order Dispatched',
        Delivered: 'Order Delivered',
      };
      const eventType = eventMap[nextStatus];
      if (eventType) {
        smsTask = this.createNotificationTx({
          customerId: Number(orderRow.customer_id),
          eventType,
          title: `${eventType} (${orderRow.order_number})`,
          message: `Order ${orderRow.order_number} status updated to: ${nextStatus}.`,
          targetType: 'order',
          targetId: orderId,
          createdByAdminId: actor.id,
        });
      }

      this.writeAuditLogTx({
        actorType: 'admin',
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'UPDATE_ORDER_STATUS',
        entityType: 'order',
        entityId: orderId,
        reason: note ?? null,
        beforeObj: { status: prevStatus },
        afterObj: { status: nextStatus },
      });

      const updatedRow = this.db
        .prepare(
          `SELECT o.*, c.name AS customer_name, c.account_number AS customer_account_number
           FROM orders o
           INNER JOIN customers c ON c.id = o.customer_id
           WHERE o.id = ?`
        )
        .get(orderId) as Record<string, unknown>;

      return this.hydrateOrders([updatedRow])[0];
    });

    const result = tx.immediate();
    await this.flushPendingSmsTasks([smsTask]);
    return result;
  }

  // =========================================================================
  // INVOICE CREATION (METHOD A & METHOD B), EDITING & LEDGER DEBITS
  // =========================================================================

  private hydrateInvoices(invRows: Array<Record<string, unknown>>): InvoiceView[] {
    if (invRows.length === 0) return [];
    const itemsStmt = this.db.prepare(`SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id ASC`);
    return invRows.map((row) => {
      const invoiceId = Number(row.id);
      const currency = String(row.currency_symbol || 'Rs.');
      const items = (itemsStmt.all(invoiceId) as Array<Record<string, unknown>>).map(
        (it): InvoiceLineItemView => ({
          id: Number(it.id),
          productId: it.product_id != null ? Number(it.product_id) : null,
          productName: String(it.product_name),
          packingWeight: String(it.packing_weight || ''),
          quantity: Number(it.quantity),
          ratePaisa: Number(it.rate_paisa),
          rateFormatted: formatPaisa(Number(it.rate_paisa), currency),
          lineTotalPaisa: Number(it.line_total_paisa),
          lineTotalFormatted: formatPaisa(Number(it.line_total_paisa), currency),
        })
      );

      let brandingSnapshot = {
        invoiceHeading: BRAND_NAMES.invoiceHeading as string,
        logoDataUrl: null as string | null,
        businessAddress: '',
        businessPhone: '',
        accentColor: '#EAB308',
        footerNote: '',
      };
      try {
        brandingSnapshot = {
          ...brandingSnapshot,
          ...(JSON.parse(String(row.branding_snapshot_json)) as typeof brandingSnapshot),
        };
      } catch {
        // Keep safe defaults
      }

      const grandTotalPaisa = Number(row.grand_total_paisa);
      return {
        id: invoiceId,
        invoiceNumber: Number(row.invoice_number),
        customerId: Number(row.customer_id),
        customerName: String(row.customer_name),
        customerAccountNumber: String(row.customer_account_number),
        sourceOrderId: row.source_order_id != null ? Number(row.source_order_id) : null,
        sourceOrderNumber: row.source_order_number ? String(row.source_order_number) : null,
        invoiceDate: String(row.invoice_date),
        currencySymbol: currency,
        grandTotalPaisa,
        grandTotalFormatted: formatPaisa(grandTotalPaisa, currency),
        notes: String(row.notes || ''),
        brandingSnapshot,
        items,
        revisionCount: Number(row.revision_count || 0),
        createdByAdminName: String(row.created_by_admin_name || 'Administrator'),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      };
    });
  }

  public async createInvoice(
    actor: AuthenticatedAdmin,
    input: {
      customerId: number;
      sourceOrderId?: number | null;
      invoiceDate?: string;
      notes?: string;
      idempotencyKey?: string;
      items: Array<{
        productId?: number | null;
        productName?: string;
        packingWeight?: string;
        quantity: number;
        rate: string | number;
      }>;
    }
  ): Promise<InvoiceView> {
    this.assertAdminPermission(actor, 'manage_invoices');
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new AppError(400, 'EMPTY_INVOICE', 'At least one invoice line item is required.');
    }

    const invoiceDate = (input.invoiceDate || this.getTodayLocalIso()).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) {
      throw new AppError(400, 'INVALID_DATE', 'Invoice date must be formatted as YYYY-MM-DD.');
    }

    const parsedRates = input.items.map((item, idx) => {
      let ratePaisa: number;
      try {
        ratePaisa = parseMoneyToPaisa(item.rate);
      } catch (e) {
        throw new AppError(400, 'INVALID_RATE', `Line ${idx + 1}: ${e instanceof Error ? e.message : 'Invalid rate'}`);
      }
      return { quantity: item.quantity, ratePaisa };
    });

    let calcResult;
    try {
      calcResult = calculateInvoiceTotals(parsedRates);
    } catch (e) {
      throw new AppError(400, 'INVALID_INVOICE_TOTALS', e instanceof Error ? e.message : 'Invalid invoice quantities or rates.');
    }

    let smsTask: PendingSmsTask | null = null;
    const tx = this.db.transaction(() => {
      if (input.idempotencyKey) {
        const existingInv = this.db
          .prepare(
            `SELECT i.*, c.name AS customer_name, c.account_number AS customer_account_number,
                    o.order_number AS source_order_number, a.display_name AS created_by_admin_name
             FROM invoices i
             INNER JOIN customers c ON c.id = i.customer_id
             LEFT JOIN orders o ON o.id = i.source_order_id
             INNER JOIN admin_users a ON a.id = i.created_by_admin_id
             WHERE i.idempotency_key = ?`
          )
          .get(input.idempotencyKey) as Record<string, unknown> | undefined;
        if (existingInv) {
          return this.hydrateInvoices([existingInv])[0];
        }
      }

      const cust = this.db
        .prepare(`SELECT * FROM customers WHERE id = ?`)
        .get(input.customerId) as Record<string, unknown> | undefined;
      if (!cust) {
        throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Selected customer does not exist.');
      }

      const sourceOrderId = input.sourceOrderId ?? null;
      if (sourceOrderId != null) {
        const ord = this.db
          .prepare(`SELECT * FROM orders WHERE id = ?`)
          .get(sourceOrderId) as Record<string, unknown> | undefined;
        if (!ord || Number(ord.customer_id) !== input.customerId) {
          throw new AppError(400, 'ORDER_MISMATCH', 'Selected order does not belong to this customer.');
        }
        const ordStatus = String(ord.status) as OrderStatus;
        if (
          !['Confirmed / Partially Approved', 'Preparing', 'Dispatched', 'Delivered'].includes(ordStatus)
        ) {
          throw new AppError(
            422,
            'ORDER_NOT_APPROVED',
            `Cannot create an order-linked invoice while order status is "${ordStatus}". Approve the order first.`
          );
        }
        const dupInv = this.db
          .prepare(`SELECT invoice_number FROM invoices WHERE source_order_id = ?`)
          .get(sourceOrderId) as { invoice_number: number } | undefined;
        if (dupInv) {
          throw new AppError(
            409,
            'DUPLICATE_ORDER_INVOICE',
            `Order is already invoiced under Invoice #${dupInv.invoice_number}.`
          );
        }
      }

      const prodStmt = this.db.prepare(`SELECT * FROM products WHERE id = ?`);
      const resolvedLines = input.items.map((item, idx) => {
        let productName = (item.productName || '').trim();
        let packingWeight = (item.packingWeight || '').trim();
        let productId: number | null = item.productId ?? null;

        if (productId != null) {
          const prod = prodStmt.get(productId) as Record<string, unknown> | undefined;
          if (!prod) {
            throw new AppError(404, 'PRODUCT_NOT_FOUND', `Line ${idx + 1}: Product not found.`);
          }
          productName = String(prod.name);
          packingWeight = String(prod.packing_weight);
        } else if (!productName) {
          throw new AppError(400, 'PRODUCT_REQUIRED', `Line ${idx + 1}: Select a product.`);
        }

        return {
          productId,
          productName,
          packingWeight,
          quantity: item.quantity,
          ratePaisa: parsedRates[idx].ratePaisa,
          lineTotalPaisa: calcResult.lineTotalsPaisa[idx],
        };
      });

      const invoiceNumber = this.allocateSequenceTx('invoice_number');
      const currencySymbol = this.getCurrencySymbol();
      const brandingSnapshot = {
        invoiceHeading: BRAND_NAMES.invoiceHeading,
        logoDataUrl: this.getSetting('brand_logo_data_url', '') || null,
        businessAddress: this.getSetting('invoice_business_address', ''),
        businessPhone: this.getSetting('invoice_business_phone', ''),
        accentColor: this.getSetting('invoice_accent_color', '#EAB308') || '#EAB308',
        footerNote: this.getSetting('invoice_footer_note', ''),
      };

      const now = new Date().toISOString();
      const invInfo = this.db
        .prepare(
          `INSERT INTO invoices (
            invoice_number, customer_id, source_order_id, invoice_date, currency_symbol,
            grand_total_paisa, notes, branding_snapshot_json, idempotency_key,
            revision_count, created_by_admin_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
        )
        .run(
          invoiceNumber,
          input.customerId,
          sourceOrderId,
          invoiceDate,
          currencySymbol,
          calcResult.grandTotalPaisa,
          (input.notes || '').trim(),
          JSON.stringify(brandingSnapshot),
          input.idempotencyKey ?? null,
          actor.id,
          now,
          now
        );

      const invoiceId = Number(invInfo.lastInsertRowid);
      const insertLine = this.db.prepare(
        `INSERT INTO invoice_items (
          invoice_id, product_id, product_name, packing_weight, quantity, rate_paisa, line_total_paisa
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const line of resolvedLines) {
        insertLine.run(
          invoiceId,
          line.productId,
          line.productName,
          line.packingWeight,
          line.quantity,
          line.ratePaisa,
          line.lineTotalPaisa
        );
      }

      // Atomic Ledger Debit Posting (Section 31)
      this.db
        .prepare(
          `INSERT INTO ledger_entries (
            customer_id, entry_date, entry_type, invoice_id, payment_id,
            description, debit_paisa, credit_paisa, created_by_admin_id, created_at, updated_at
          ) VALUES (?, ?, 'invoice', ?, NULL, ?, ?, 0, ?, ?, ?)`
        )
        .run(
          input.customerId,
          invoiceDate,
          invoiceId,
          `Invoice #${invoiceNumber}`,
          calcResult.grandTotalPaisa,
          actor.id,
          now,
          now
        );

      this.reconcileCustomerBalanceTx(input.customerId);

      const formattedAmount = formatPaisa(calcResult.grandTotalPaisa, currencySymbol);
      const urduMsg = URDU_MESSAGES.newInvoiceAddedTemplate(formattedAmount);

      smsTask = this.createNotificationTx({
        customerId: input.customerId,
        eventType: 'New Invoice Added',
        title: `New Invoice #${invoiceNumber}`,
        message: urduMsg,
        targetType: 'invoice',
        targetId: invoiceId,
        idempotencyKey: `inv-created-${invoiceId}`,
        createdByAdminId: actor.id,
      });

      this.writeAuditLogTx({
        actorType: 'admin',
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'CREATE_INVOICE',
        entityType: 'invoice',
        entityId: invoiceId,
        afterObj: {
          invoiceNumber,
          customerId: input.customerId,
          sourceOrderId,
          grandTotalPaisa: calcResult.grandTotalPaisa,
          items: resolvedLines,
        },
      });

      const createdRow = this.db
        .prepare(
          `SELECT i.*, c.name AS customer_name, c.account_number AS customer_account_number,
                  o.order_number AS source_order_number, a.display_name AS created_by_admin_name
           FROM invoices i
           INNER JOIN customers c ON c.id = i.customer_id
           LEFT JOIN orders o ON o.id = i.source_order_id
           INNER JOIN admin_users a ON a.id = i.created_by_admin_id
           WHERE i.id = ?`
        )
        .get(invoiceId) as Record<string, unknown>;

      return this.hydrateInvoices([createdRow])[0];
    });

    const createdInvoice = tx.immediate();
    await this.flushPendingSmsTasks([smsTask]);
    return createdInvoice;
  }

  public async editInvoice(
    actor: AuthenticatedAdmin,
    invoiceId: number,
    input: {
      invoiceDate?: string;
      notes?: string;
      reason: string;
      items: Array<{
        productId?: number | null;
        productName?: string;
        packingWeight?: string;
        quantity: number;
        rate: string | number;
      }>;
    }
  ): Promise<InvoiceView> {
    this.assertAdminPermission(actor, 'edit_financial_records');
    if (this.getSetting('allow_posted_financial_edits', '1') !== '1') {
      throw new AppError(
        422,
        'FINANCIAL_EDITS_LOCKED',
        'Direct editing of posted invoices is currently disabled by accounting policy.'
      );
    }
    const reason = (input.reason || '').trim();
    if (reason.length < 4) {
      throw new AppError(400, 'REASON_REQUIRED', 'A clear audit reason is mandatory when editing a posted invoice.');
    }

    const parsedRates = (input.items || []).map((item, idx) => {
      try {
        return { quantity: item.quantity, ratePaisa: parseMoneyToPaisa(item.rate) };
      } catch (e) {
        throw new AppError(400, 'INVALID_RATE', `Line ${idx + 1}: ${e instanceof Error ? e.message : 'Invalid rate'}`);
      }
    });
    const calcResult = calculateInvoiceTotals(parsedRates);

    let smsTask: PendingSmsTask | null = null;
    const tx = this.db.transaction(() => {
      const existingRow = this.db
        .prepare(
          `SELECT i.*, c.name AS customer_name, c.account_number AS customer_account_number,
                  o.order_number AS source_order_number, a.display_name AS created_by_admin_name
           FROM invoices i
           INNER JOIN customers c ON c.id = i.customer_id
           LEFT JOIN orders o ON o.id = i.source_order_id
           INNER JOIN admin_users a ON a.id = i.created_by_admin_id
           WHERE i.id = ?`
        )
        .get(invoiceId) as Record<string, unknown> | undefined;

      if (!existingRow) {
        throw new AppError(404, 'INVOICE_NOT_FOUND', 'Invoice not found.');
      }

      const previousView = this.hydrateInvoices([existingRow])[0];
      const nextDate = (input.invoiceDate || previousView.invoiceDate).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) {
        throw new AppError(400, 'INVALID_DATE', 'Invoice date must be YYYY-MM-DD.');
      }

      const prodStmt = this.db.prepare(`SELECT * FROM products WHERE id = ?`);
      const resolvedLines = input.items.map((item, idx) => {
        let productName = (item.productName || '').trim();
        let packingWeight = (item.packingWeight || '').trim();
        const productId: number | null = item.productId ?? null;
        if (productId != null) {
          const prod = prodStmt.get(productId) as Record<string, unknown> | undefined;
          if (!prod) throw new AppError(404, 'PRODUCT_NOT_FOUND', `Line ${idx + 1}: Product not found.`);
          productName = String(prod.name);
          packingWeight = String(prod.packing_weight);
        } else if (!productName) {
          throw new AppError(400, 'PRODUCT_REQUIRED', `Line ${idx + 1}: Product name is required.`);
        }
        return {
          productId,
          productName,
          packingWeight,
          quantity: item.quantity,
          ratePaisa: parsedRates[idx].ratePaisa,
          lineTotalPaisa: calcResult.lineTotalsPaisa[idx],
        };
      });

      const now = new Date().toISOString();
      const nextRevision = previousView.revisionCount + 1;

      this.db.prepare(`DELETE FROM invoice_items WHERE invoice_id = ?`).run(invoiceId);
      const insertLine = this.db.prepare(
        `INSERT INTO invoice_items (
          invoice_id, product_id, product_name, packing_weight, quantity, rate_paisa, line_total_paisa
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const line of resolvedLines) {
        insertLine.run(
          invoiceId,
          line.productId,
          line.productName,
          line.packingWeight,
          line.quantity,
          line.ratePaisa,
          line.lineTotalPaisa
        );
      }

      this.db
        .prepare(
          `UPDATE invoices
           SET invoice_date = ?, grand_total_paisa = ?, notes = ?, revision_count = ?,
               updated_by_admin_id = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          nextDate,
          calcResult.grandTotalPaisa,
          input.notes !== undefined ? input.notes.trim() : previousView.notes,
          nextRevision,
          actor.id,
          now,
          invoiceId
        );

      // Update the single linked ledger entry atomically (prevents double-debiting!)
      this.db
        .prepare(
          `UPDATE ledger_entries
           SET entry_date = ?, debit_paisa = ?, description = ?, updated_at = ?
           WHERE invoice_id = ?`
        )
        .run(
          nextDate,
          calcResult.grandTotalPaisa,
          `Invoice #${previousView.invoiceNumber} (Rev ${nextRevision})`,
          now,
          invoiceId
        );

      this.reconcileCustomerBalanceTx(previousView.customerId);

      const updatedRow = this.db
        .prepare(
          `SELECT i.*, c.name AS customer_name, c.account_number AS customer_account_number,
                  o.order_number AS source_order_number, a.display_name AS created_by_admin_name
           FROM invoices i
           INNER JOIN customers c ON c.id = i.customer_id
           LEFT JOIN orders o ON o.id = i.source_order_id
           INNER JOIN admin_users a ON a.id = i.created_by_admin_id
           WHERE i.id = ?`
        )
        .get(invoiceId) as Record<string, unknown>;
      const nextView = this.hydrateInvoices([updatedRow])[0];

      this.db
        .prepare(
          `INSERT INTO invoice_revisions (
            invoice_id, revision_number, previous_snapshot_json, new_snapshot_json,
            reason, edited_by_admin_id, edited_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          invoiceId,
          nextRevision,
          JSON.stringify(previousView),
          JSON.stringify(nextView),
          reason,
          actor.id,
          now
        );

      smsTask = this.createNotificationTx({
        customerId: previousView.customerId,
        eventType: 'Invoice Edited / Updated',
        title: `Invoice #${previousView.invoiceNumber} Updated`,
        message: `Invoice #${previousView.invoiceNumber} was updated to ${nextView.grandTotalFormatted}. Reason: ${reason}`,
        targetType: 'invoice',
        targetId: invoiceId,
        createdByAdminId: actor.id,
      });

      this.writeAuditLogTx({
        actorType: 'admin',
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'EDIT_INVOICE',
        entityType: 'invoice',
        entityId: invoiceId,
        reason,
        beforeObj: { grandTotalPaisa: previousView.grandTotalPaisa, items: previousView.items },
        afterObj: { grandTotalPaisa: nextView.grandTotalPaisa, items: nextView.items },
      });

      return nextView;
    });

    const edited = tx.immediate();
    await this.flushPendingSmsTasks([smsTask]);
    return edited;
  }

  public listInvoicesForCustomer(customer: AuthenticatedCustomer): InvoiceView[] {
    const rows = this.db
      .prepare(
        `SELECT i.*, c.name AS customer_name, c.account_number AS customer_account_number,
                o.order_number AS source_order_number, a.display_name AS created_by_admin_name
         FROM invoices i
         INNER JOIN customers c ON c.id = i.customer_id
         LEFT JOIN orders o ON o.id = i.source_order_id
         INNER JOIN admin_users a ON a.id = i.created_by_admin_id
         WHERE i.customer_id = ?
         ORDER BY i.invoice_number DESC`
      )
      .all(customer.id) as Array<Record<string, unknown>>;
    return this.hydrateInvoices(rows);
  }

  public getInvoiceAuthorized(
    invoiceId: number,
    actor: { type: 'customer'; customer: AuthenticatedCustomer } | { type: 'admin'; admin: AuthenticatedAdmin }
  ): InvoiceView {
    const row = this.db
      .prepare(
        `SELECT i.*, c.name AS customer_name, c.account_number AS customer_account_number,
                o.order_number AS source_order_number, a.display_name AS created_by_admin_name
         FROM invoices i
         INNER JOIN customers c ON c.id = i.customer_id
         LEFT JOIN orders o ON o.id = i.source_order_id
         INNER JOIN admin_users a ON a.id = i.created_by_admin_id
         WHERE i.id = ?`
      )
      .get(invoiceId) as Record<string, unknown> | undefined;

    if (!row) {
      throw new AppError(404, 'INVOICE_NOT_FOUND', 'Invoice not found.');
    }

    if (actor.type === 'customer') {
      if (Number(row.customer_id) !== actor.customer.id) {
        throw new AppError(403, 'FORBIDDEN_INVOICE', 'You are only authorized to access your own invoices.');
      }
    } else {
      if (
        actor.admin.role !== 'main_admin' &&
        !actor.admin.permissions.includes('manage_invoices') &&
        !actor.admin.permissions.includes('view_full_ledger') &&
        !actor.admin.permissions.includes('view_reports')
      ) {
        throw new AppError(403, 'FORBIDDEN', 'Insufficient permission to view invoices.');
      }
    }

    return this.hydrateInvoices([row])[0];
  }

  public listInvoicesForAdmin(
    actor: AuthenticatedAdmin,
    filters?: { search?: string; customerId?: number; fromDate?: string; toDate?: string }
  ): InvoiceView[] {
    if (
      actor.role !== 'main_admin' &&
      !actor.permissions.includes('manage_invoices') &&
      !actor.permissions.includes('view_full_ledger') &&
      !actor.permissions.includes('view_reports')
    ) {
      throw new AppError(403, 'FORBIDDEN', 'Insufficient permission to list invoices.');
    }

    const clauses = ['1=1'];
    const params: unknown[] = [];
    if (filters?.customerId) {
      clauses.push('i.customer_id = ?');
      params.push(filters.customerId);
    }
    if (filters?.fromDate) {
      clauses.push('i.invoice_date >= ?');
      params.push(filters.fromDate);
    }
    if (filters?.toDate) {
      clauses.push('i.invoice_date <= ?');
      params.push(filters.toDate);
    }
    if (filters?.search?.trim()) {
      const q = `%${filters.search.trim()}%`;
      clauses.push('(CAST(i.invoice_number AS TEXT) LIKE ? OR c.name LIKE ? OR c.account_number LIKE ?)');
      params.push(q, q, q);
    }

    const rows = this.db
      .prepare(
        `SELECT i.*, c.name AS customer_name, c.account_number AS customer_account_number,
                o.order_number AS source_order_number, a.display_name AS created_by_admin_name
         FROM invoices i
         INNER JOIN customers c ON c.id = i.customer_id
         LEFT JOIN orders o ON o.id = i.source_order_id
         INNER JOIN admin_users a ON a.id = i.created_by_admin_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY i.invoice_number DESC`
      )
      .all(...params) as Array<Record<string, unknown>>;

    return this.hydrateInvoices(rows);
  }

  // =========================================================================
  // PAYMENT RECORDING, EDITING & LEDGER CREDITS (SECTIONS 32 & 33)
  // =========================================================================

  private mapPaymentRow(row: Record<string, unknown>): PaymentView {
    const currency = this.getCurrencySymbol();
    const amountPaisa = Number(row.amount_paisa);
    return {
      id: Number(row.id),
      paymentNumber: String(row.payment_number),
      customerId: Number(row.customer_id),
      customerName: String(row.customer_name),
      customerAccountNumber: String(row.customer_account_number),
      amountPaisa,
      amountFormatted: formatPaisa(amountPaisa, currency),
      paymentDate: String(row.payment_date),
      paymentMethod: String(row.payment_method) as PaymentMethod,
      referenceNumber: String(row.reference_number || ''),
      remarks: String(row.remarks || ''),
      revisionCount: Number(row.revision_count || 0),
      createdByAdminName: String(row.created_by_admin_name || 'Administrator'),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  public async createPayment(
    actor: AuthenticatedAdmin,
    input: {
      customerId: number;
      amount: string | number;
      paymentDate?: string;
      paymentMethod: PaymentMethod;
      referenceNumber?: string;
      remarks?: string;
      idempotencyKey?: string;
    }
  ): Promise<PaymentView> {
    this.assertAdminPermission(actor, 'manage_payments');
    if (!isValidPaymentMethod(input.paymentMethod)) {
      throw new AppError(
        400,
        'INVALID_PAYMENT_METHOD',
        'Payment method must be Cash, Bank Transfer, Cheque, Online Payment, or Other.'
      );
    }

    let amountPaisa: number;
    try {
      amountPaisa = parseMoneyToPaisa(input.amount);
    } catch (e) {
      throw new AppError(400, 'INVALID_AMOUNT', e instanceof Error ? e.message : 'Invalid payment amount.');
    }
    if (amountPaisa <= 0) {
      throw new AppError(400, 'INVALID_AMOUNT', 'Payment amount must be greater than zero.');
    }

    const paymentDate = (input.paymentDate || this.getTodayLocalIso()).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
      throw new AppError(400, 'INVALID_DATE', 'Payment date must be YYYY-MM-DD.');
    }

    let smsTask: PendingSmsTask | null = null;
    const tx = this.db.transaction(() => {
      if (input.idempotencyKey) {
        const existingPay = this.db
          .prepare(
            `SELECT p.*, c.name AS customer_name, c.account_number AS customer_account_number,
                    a.display_name AS created_by_admin_name
             FROM payments p
             INNER JOIN customers c ON c.id = p.customer_id
             INNER JOIN admin_users a ON a.id = p.created_by_admin_id
             WHERE p.idempotency_key = ?`
          )
          .get(input.idempotencyKey) as Record<string, unknown> | undefined;
        if (existingPay) {
          return this.mapPaymentRow(existingPay);
        }
      }

      const cust = this.db
        .prepare(`SELECT * FROM customers WHERE id = ?`)
        .get(input.customerId) as Record<string, unknown> | undefined;
      if (!cust) {
        throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Selected customer does not exist.');
      }

      const seq = this.allocateSequenceTx('payment_number');
      const paymentNumber = `BRB-PAY-${seq}`;
      const referenceNumber = (input.referenceNumber || '').trim();
      const remarks = (input.remarks || '').trim();
      const now = new Date().toISOString();

      const info = this.db
        .prepare(
          `INSERT INTO payments (
            payment_number, sequence_number, customer_id, amount_paisa, payment_date,
            payment_method, reference_number, remarks, idempotency_key, revision_count,
            created_by_admin_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
        )
        .run(
          paymentNumber,
          seq,
          input.customerId,
          amountPaisa,
          paymentDate,
          input.paymentMethod,
          referenceNumber,
          remarks,
          input.idempotencyKey ?? null,
          actor.id,
          now,
          now
        );

      const paymentId = Number(info.lastInsertRowid);
      const ledgerDesc = referenceNumber
        ? `Payment (${input.paymentMethod} • Ref: ${referenceNumber})`
        : `Payment (${input.paymentMethod})`;

      // Atomic Ledger Credit Posting (Section 33)
      this.db
        .prepare(
          `INSERT INTO ledger_entries (
            customer_id, entry_date, entry_type, invoice_id, payment_id,
            description, debit_paisa, credit_paisa, created_by_admin_id, created_at, updated_at
          ) VALUES (?, ?, 'payment', NULL, ?, ?, 0, ?, ?, ?, ?)`
        )
        .run(input.customerId, paymentDate, paymentId, ledgerDesc, amountPaisa, actor.id, now, now);

      const newBalancePaisa = this.reconcileCustomerBalanceTx(input.customerId);
      const currency = this.getCurrencySymbol();

      smsTask = this.createNotificationTx({
        customerId: input.customerId,
        eventType: 'Payment Received',
        title: `Payment Received (${paymentNumber})`,
        message: `Payment of ${formatPaisa(amountPaisa, currency)} via ${input.paymentMethod} has been credited to your BRB account. Current balance: ${formatPaisa(newBalancePaisa, currency)}.`,
        targetType: 'payment',
        targetId: paymentId,
        idempotencyKey: `pay-created-${paymentId}`,
        createdByAdminId: actor.id,
      });

      this.writeAuditLogTx({
        actorType: 'admin',
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'CREATE_PAYMENT',
        entityType: 'payment',
        entityId: paymentId,
        afterObj: {
          paymentNumber,
          customerId: input.customerId,
          amountPaisa,
          paymentMethod: input.paymentMethod,
          referenceNumber,
        },
      });

      const createdRow = this.db
        .prepare(
          `SELECT p.*, c.name AS customer_name, c.account_number AS customer_account_number,
                  a.display_name AS created_by_admin_name
           FROM payments p
           INNER JOIN customers c ON c.id = p.customer_id
           INNER JOIN admin_users a ON a.id = p.created_by_admin_id
           WHERE p.id = ?`
        )
        .get(paymentId) as Record<string, unknown>;

      return this.mapPaymentRow(createdRow);
    });

    const createdPayment = tx.immediate();
    await this.flushPendingSmsTasks([smsTask]);
    return createdPayment;
  }

  public async editPayment(
    actor: AuthenticatedAdmin,
    paymentId: number,
    input: {
      amount: string | number;
      paymentDate?: string;
      paymentMethod: PaymentMethod;
      referenceNumber?: string;
      remarks?: string;
      reason: string;
    }
  ): Promise<PaymentView> {
    this.assertAdminPermission(actor, 'edit_financial_records');
    if (this.getSetting('allow_posted_financial_edits', '1') !== '1') {
      throw new AppError(422, 'FINANCIAL_EDITS_LOCKED', 'Editing posted payments is currently disabled.');
    }
    const reason = (input.reason || '').trim();
    if (reason.length < 4) {
      throw new AppError(400, 'REASON_REQUIRED', 'A clear audit reason is required to edit a payment.');
    }
    if (!isValidPaymentMethod(input.paymentMethod)) {
      throw new AppError(400, 'INVALID_PAYMENT_METHOD', 'Invalid payment method.');
    }
    const amountPaisa = parseMoneyToPaisa(input.amount);
    if (amountPaisa <= 0) {
      throw new AppError(400, 'INVALID_AMOUNT', 'Payment amount must be greater than zero.');
    }

    let smsTask: PendingSmsTask | null = null;
    const tx = this.db.transaction(() => {
      const existingRow = this.db
        .prepare(
          `SELECT p.*, c.name AS customer_name, c.account_number AS customer_account_number,
                  a.display_name AS created_by_admin_name
           FROM payments p
           INNER JOIN customers c ON c.id = p.customer_id
           INNER JOIN admin_users a ON a.id = p.created_by_admin_id
           WHERE p.id = ?`
        )
        .get(paymentId) as Record<string, unknown> | undefined;

      if (!existingRow) {
        throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment record not found.');
      }
      const prevView = this.mapPaymentRow(existingRow);
      const nextDate = (input.paymentDate || prevView.paymentDate).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) {
        throw new AppError(400, 'INVALID_DATE', 'Payment date must be YYYY-MM-DD.');
      }

      const refNum = input.referenceNumber !== undefined ? input.referenceNumber.trim() : prevView.referenceNumber;
      const remarks = input.remarks !== undefined ? input.remarks.trim() : prevView.remarks;
      const nextRev = prevView.revisionCount + 1;
      const now = new Date().toISOString();

      this.db
        .prepare(
          `UPDATE payments
           SET amount_paisa = ?, payment_date = ?, payment_method = ?, reference_number = ?,
               remarks = ?, revision_count = ?, updated_by_admin_id = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(amountPaisa, nextDate, input.paymentMethod, refNum, remarks, nextRev, actor.id, now, paymentId);

      const ledgerDesc = refNum
        ? `Payment (${input.paymentMethod} • Ref: ${refNum} • Rev ${nextRev})`
        : `Payment (${input.paymentMethod} • Rev ${nextRev})`;

      this.db
        .prepare(
          `UPDATE ledger_entries
           SET entry_date = ?, credit_paisa = ?, description = ?, updated_at = ?
           WHERE payment_id = ?`
        )
        .run(nextDate, amountPaisa, ledgerDesc, now, paymentId);

      this.reconcileCustomerBalanceTx(prevView.customerId);

      const updatedRow = this.db
        .prepare(
          `SELECT p.*, c.name AS customer_name, c.account_number AS customer_account_number,
                  a.display_name AS created_by_admin_name
           FROM payments p
           INNER JOIN customers c ON c.id = p.customer_id
           INNER JOIN admin_users a ON a.id = p.created_by_admin_id
           WHERE p.id = ?`
        )
        .get(paymentId) as Record<string, unknown>;
      const nextView = this.mapPaymentRow(updatedRow);

      this.db
        .prepare(
          `INSERT INTO payment_revisions (
            payment_id, revision_number, previous_snapshot_json, new_snapshot_json,
            reason, edited_by_admin_id, edited_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          paymentId,
          nextRev,
          JSON.stringify(prevView),
          JSON.stringify(nextView),
          reason,
          actor.id,
          now
        );

      smsTask = this.createNotificationTx({
        customerId: prevView.customerId,
        eventType: 'Payment Edited / Updated',
        title: `Payment Updated (${prevView.paymentNumber})`,
        message: `Payment ${prevView.paymentNumber} was updated to ${nextView.amountFormatted}. Reason: ${reason}`,
        targetType: 'payment',
        targetId: paymentId,
        createdByAdminId: actor.id,
      });

      this.writeAuditLogTx({
        actorType: 'admin',
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'EDIT_PAYMENT',
        entityType: 'payment',
        entityId: paymentId,
        reason,
        beforeObj: prevView,
        afterObj: nextView,
      });

      return nextView;
    });

    const edited = tx.immediate();
    await this.flushPendingSmsTasks([smsTask]);
    return edited;
  }

  public listPaymentsForCustomer(customer: AuthenticatedCustomer): PaymentView[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, c.name AS customer_name, c.account_number AS customer_account_number,
                a.display_name AS created_by_admin_name
         FROM payments p
         INNER JOIN customers c ON c.id = p.customer_id
         INNER JOIN admin_users a ON a.id = p.created_by_admin_id
         WHERE p.customer_id = ?
         ORDER BY p.payment_date DESC, p.id DESC`
      )
      .all(customer.id) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapPaymentRow(r));
  }

  public getCustomerPaymentById(customer: AuthenticatedCustomer, paymentId: number): PaymentView {
    const row = this.db
      .prepare(
        `SELECT p.*, c.name AS customer_name, c.account_number AS customer_account_number,
                a.display_name AS created_by_admin_name
         FROM payments p
         INNER JOIN customers c ON c.id = p.customer_id
         INNER JOIN admin_users a ON a.id = p.created_by_admin_id
         WHERE p.id = ? AND p.customer_id = ?`
      )
      .get(paymentId, customer.id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment record not found.');
    }
    return this.mapPaymentRow(row);
  }

  public listPaymentsForAdmin(
    actor: AuthenticatedAdmin,
    filters?: { search?: string; customerId?: number; fromDate?: string; toDate?: string }
  ): PaymentView[] {
    if (
      actor.role !== 'main_admin' &&
      !actor.permissions.includes('manage_payments') &&
      !actor.permissions.includes('view_full_ledger') &&
      !actor.permissions.includes('view_reports')
    ) {
      throw new AppError(403, 'FORBIDDEN', 'Insufficient permission to list payments.');
    }

    const clauses = ['1=1'];
    const params: unknown[] = [];
    if (filters?.customerId) {
      clauses.push('p.customer_id = ?');
      params.push(filters.customerId);
    }
    if (filters?.fromDate) {
      clauses.push('p.payment_date >= ?');
      params.push(filters.fromDate);
    }
    if (filters?.toDate) {
      clauses.push('p.payment_date <= ?');
      params.push(filters.toDate);
    }
    if (filters?.search?.trim()) {
      const q = `%${filters.search.trim()}%`;
      clauses.push(
        '(p.payment_number LIKE ? OR p.reference_number LIKE ? OR c.name LIKE ? OR c.account_number LIKE ?)'
      );
      params.push(q, q, q, q);
    }

    const rows = this.db
      .prepare(
        `SELECT p.*, c.name AS customer_name, c.account_number AS customer_account_number,
                a.display_name AS created_by_admin_name
         FROM payments p
         INNER JOIN customers c ON c.id = p.customer_id
         INNER JOIN admin_users a ON a.id = p.created_by_admin_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY p.payment_date DESC, p.id DESC`
      )
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((r) => this.mapPaymentRow(r));
  }

  // =========================================================================
  // LEDGER QUERIES (12-MONTH CUSTOMER WINDOW VS FULL ADMIN HISTORY)
  // =========================================================================

  /**
   * Customer Ledger (Sections 34, 35, 36):
   * - Strictly enforces the 12-month boundary in SQL (`le.entry_date >= cutoffDate`).
   * - Computes chronological running balances starting from pre-cutoff brought-forward balance so
   *   running balances and current outstanding balance agree 100%.
   */
  public getCustomerLedger(
    customer: AuthenticatedCustomer,
    filters?: {
      search?: string;
      type?: 'all' | 'invoice' | 'payment';
      fromDate?: string;
      toDate?: string;
    },
    referenceNow: Date = new Date()
  ): {
    cutoffDate: string;
    broughtForwardPaisa: number;
    broughtForwardFormatted: string;
    outstandingBalancePaisa: number;
    outstandingBalanceFormatted: string;
    entries: LedgerEntryView[];
  } {
    const currency = this.getCurrencySymbol();
    const cutoffDate = computeTwelveMonthCutoffDate(referenceNow, this.getTimeZone());

    const custRow = this.db
      .prepare(`SELECT opening_balance_paisa, outstanding_balance_paisa FROM customers WHERE id = ?`)
      .get(customer.id) as { opening_balance_paisa: number; outstanding_balance_paisa: number };

    const priorSums = this.db
      .prepare(
        `SELECT
          COALESCE(SUM(debit_paisa), 0) AS prior_debit,
          COALESCE(SUM(credit_paisa), 0) AS prior_credit
         FROM ledger_entries
         WHERE customer_id = ? AND entry_date < ?`
      )
      .get(customer.id, cutoffDate) as { prior_debit: number; prior_credit: number };

    const broughtForwardPaisa =
      custRow.opening_balance_paisa + priorSums.prior_debit - priorSums.prior_credit;

    // Fetch ONLY records within the permitted latest 12-month window in SQL!
    const windowRows = this.db
      .prepare(
        `SELECT le.*, c.name AS customer_name, c.account_number AS customer_account_number,
                i.invoice_number, p.payment_method, p.reference_number
         FROM ledger_entries le
         INNER JOIN customers c ON c.id = le.customer_id
         LEFT JOIN invoices i ON i.id = le.invoice_id
         LEFT JOIN payments p ON p.id = le.payment_id
         WHERE le.customer_id = ? AND le.entry_date >= ?
         ORDER BY le.entry_date ASC, le.id ASC`
      )
      .all(customer.id, cutoffDate) as Array<Record<string, unknown>>;

    const rawForRunning = windowRows.map((r) => ({
      id: Number(r.id),
      entryDate: String(r.entry_date),
      createdAt: String(r.created_at),
      debitPaisa: Number(r.debit_paisa),
      creditPaisa: Number(r.credit_paisa),
      raw: r,
    }));

    const { entriesWithRunning } = computeRunningBalances(rawForRunning, broughtForwardPaisa);

    let mapped: LedgerEntryView[] = entriesWithRunning.map((item) => {
      const r = item.raw;
      return {
        id: item.id,
        customerId: Number(r.customer_id),
        customerName: String(r.customer_name),
        customerAccountNumber: String(r.customer_account_number),
        entryDate: item.entryDate,
        entryType: String(r.entry_type) as LedgerEntryView['entryType'],
        invoiceId: r.invoice_id != null ? Number(r.invoice_id) : null,
        invoiceNumber: r.invoice_number != null ? Number(r.invoice_number) : null,
        paymentId: r.payment_id != null ? Number(r.payment_id) : null,
        paymentMethod: r.payment_method ? String(r.payment_method) : null,
        referenceNumber: r.reference_number ? String(r.reference_number) : null,
        description: String(r.description),
        debitPaisa: item.debitPaisa,
        debitFormatted: item.debitPaisa > 0 ? formatPaisa(item.debitPaisa, currency) : '—',
        creditPaisa: item.creditPaisa,
        creditFormatted: item.creditPaisa > 0 ? formatPaisa(item.creditPaisa, currency) : '—',
        runningBalancePaisa: item.runningBalancePaisa,
        runningBalanceFormatted: formatPaisa(item.runningBalancePaisa, currency),
        createdAt: item.createdAt,
      };
    });

    // Apply optional customer search / date / type filters within the 12-month window
    if (filters?.type && filters.type !== 'all') {
      mapped = mapped.filter((e) => e.entryType === filters.type);
    }
    if (filters?.fromDate) {
      const effectiveFrom = filters.fromDate > cutoffDate ? filters.fromDate : cutoffDate;
      mapped = mapped.filter((e) => e.entryDate >= effectiveFrom);
    }
    if (filters?.toDate) {
      mapped = mapped.filter((e) => e.entryDate <= filters.toDate!);
    }
    if (filters?.search?.trim()) {
      const q = filters.search.trim().toLowerCase();
      mapped = mapped.filter(
        (e) =>
          e.description.toLowerCase().includes(q) ||
          (e.invoiceNumber != null && String(e.invoiceNumber).includes(q)) ||
          (e.referenceNumber && e.referenceNumber.toLowerCase().includes(q)) ||
          (e.paymentMethod && e.paymentMethod.toLowerCase().includes(q))
      );
    }

    // Return newest first for convenient viewing while preserving exact chronological runningBalance on each row
    mapped.reverse();

    return {
      cutoffDate,
      broughtForwardPaisa,
      broughtForwardFormatted: formatPaisa(broughtForwardPaisa, currency),
      outstandingBalancePaisa: custRow.outstanding_balance_paisa,
      outstandingBalanceFormatted: formatPaisa(custRow.outstanding_balance_paisa, currency),
      entries: mapped,
    };
  }

  /**
   * Administrative Ledger (Sections 34 & 35):
   * - Retains and retrieves ALL historical records (including > 12 months)
   * - Supports search by customer name, account number, invoice number, payment reference
   * - Supports date presets: today, week, month, custom, all
   */
  public getAdminLedger(
    actor: AuthenticatedAdmin,
    filters?: {
      customerId?: number;
      search?: string;
      preset?: 'all' | 'today' | 'week' | 'month' | 'custom';
      fromDate?: string;
      toDate?: string;
    },
    referenceNow: Date = new Date()
  ): LedgerEntryView[] {
    if (
      actor.role !== 'main_admin' &&
      !actor.permissions.includes('view_full_ledger') &&
      !actor.permissions.includes('manage_invoices') &&
      !actor.permissions.includes('manage_payments') &&
      !actor.permissions.includes('view_reports')
    ) {
      throw new AppError(403, 'FORBIDDEN', 'Insufficient permission to view accounting ledger.');
    }

    const currency = this.getCurrencySymbol();

    // First compute true chronological running balances per customer across full history
    const customerFilterSql = filters?.customerId ? 'WHERE le.customer_id = ?' : '';
    const allRows = this.db
      .prepare(
        `SELECT le.*, c.name AS customer_name, c.account_number AS customer_account_number,
                c.opening_balance_paisa, i.invoice_number, p.payment_method, p.reference_number
         FROM ledger_entries le
         INNER JOIN customers c ON c.id = le.customer_id
         LEFT JOIN invoices i ON i.id = le.invoice_id
         LEFT JOIN payments p ON p.id = le.payment_id
         ${customerFilterSql}
         ORDER BY le.customer_id ASC, le.entry_date ASC, le.id ASC`
      )
      .all(...(filters?.customerId ? [filters.customerId] : [])) as Array<Record<string, unknown>>;

    const runningByCustomer = new Map<number, number>();
    let views: LedgerEntryView[] = allRows.map((r) => {
      const cid = Number(r.customer_id);
      const prev = runningByCustomer.has(cid)
        ? runningByCustomer.get(cid)!
        : Number(r.opening_balance_paisa || 0);
      const debit = Number(r.debit_paisa);
      const credit = Number(r.credit_paisa);
      const nextRunning = prev + debit - credit;
      runningByCustomer.set(cid, nextRunning);

      return {
        id: Number(r.id),
        customerId: cid,
        customerName: String(r.customer_name),
        customerAccountNumber: String(r.customer_account_number),
        entryDate: String(r.entry_date),
        entryType: String(r.entry_type) as LedgerEntryView['entryType'],
        invoiceId: r.invoice_id != null ? Number(r.invoice_id) : null,
        invoiceNumber: r.invoice_number != null ? Number(r.invoice_number) : null,
        paymentId: r.payment_id != null ? Number(r.payment_id) : null,
        paymentMethod: r.payment_method ? String(r.payment_method) : null,
        referenceNumber: r.reference_number ? String(r.reference_number) : null,
        description: String(r.description),
        debitPaisa: debit,
        debitFormatted: debit > 0 ? formatPaisa(debit, currency) : '—',
        creditPaisa: credit,
        creditFormatted: credit > 0 ? formatPaisa(credit, currency) : '—',
        runningBalancePaisa: nextRunning,
        runningBalanceFormatted: formatPaisa(nextRunning, currency),
        createdAt: String(r.created_at),
      };
    });

    const todayStr = this.getTodayLocalIso(referenceNow);
    let fromDate = filters?.fromDate || '';
    let toDate = filters?.toDate || '';

    if (filters?.preset === 'today') {
      fromDate = todayStr;
      toDate = todayStr;
    } else if (filters?.preset === 'week') {
      const d = new Date(`${todayStr}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 6);
      fromDate = d.toISOString().slice(0, 10);
      toDate = todayStr;
    } else if (filters?.preset === 'month') {
      fromDate = `${todayStr.slice(0, 7)}-01`;
      toDate = todayStr;
    }

    if (fromDate) views = views.filter((v) => v.entryDate >= fromDate);
    if (toDate) views = views.filter((v) => v.entryDate <= toDate);

    if (filters?.search?.trim()) {
      const q = filters.search.trim().toLowerCase();
      views = views.filter(
        (v) =>
          v.customerName.toLowerCase().includes(q) ||
          v.customerAccountNumber.toLowerCase().includes(q) ||
          (v.invoiceNumber != null && String(v.invoiceNumber).includes(q)) ||
          (v.referenceNumber && v.referenceNumber.toLowerCase().includes(q)) ||
          v.description.toLowerCase().includes(q)
      );
    }

    views.sort((a, b) => (a.entryDate === b.entryDate ? b.id - a.id : b.entryDate.localeCompare(a.entryDate)));
    return views;
  }

  // =========================================================================
  // NOTIFICATIONS (CUSTOMER CENTER & ADMIN MANAGEMENT)
  // =========================================================================

  private mapNotificationRow(r: Record<string, unknown>): NotificationView {
    return {
      id: Number(r.id),
      customerId: Number(r.customer_id),
      customerName: String(r.customer_name),
      customerAccountNumber: String(r.customer_account_number),
      eventType: String(r.event_type) as NotificationEventType,
      title: String(r.title),
      message: String(r.message),
      targetType: r.target_type ? (String(r.target_type) as NotificationView['targetType']) : null,
      targetId: r.target_id != null ? Number(r.target_id) : null,
      isRead: Number(r.is_read) === 1,
      appDeliveryStatus: Number(r.is_read) === 1 ? 'read' : 'persisted',
      smsDeliveryStatus: String(r.sms_delivery_status) as NotificationView['smsDeliveryStatus'],
      smsProviderRef: r.sms_provider_ref ? String(r.sms_provider_ref) : null,
      smsErrorDetail: r.sms_error_detail ? String(r.sms_error_detail) : null,
      createdAt: String(r.created_at),
    };
  }

  public listCustomerNotifications(customer: AuthenticatedCustomer): NotificationView[] {
    const rows = this.db
      .prepare(
        `SELECT n.*, c.name AS customer_name, c.account_number AS customer_account_number
         FROM notifications n
         INNER JOIN customers c ON c.id = n.customer_id
         WHERE n.customer_id = ?
         ORDER BY n.id DESC`
      )
      .all(customer.id) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapNotificationRow(r));
  }

  public markNotificationRead(customer: AuthenticatedCustomer, notificationId: number): void {
    const res = this.db
      .prepare(
        `UPDATE notifications
         SET is_read = 1, app_delivery_status = 'read'
         WHERE id = ? AND customer_id = ?`
      )
      .run(notificationId, customer.id);
    if (res.changes === 0) {
      throw new AppError(404, 'NOTIFICATION_NOT_FOUND', 'Notification not found.');
    }
  }

  public async sendAdminNotification(
    actor: AuthenticatedAdmin,
    input: {
      customerIds: number[] | 'all_active';
      title: string;
      message: string;
    }
  ): Promise<{ sentCount: number }> {
    this.assertAdminPermission(actor, 'send_notifications');
    const title = (input.title || '').trim();
    const message = (input.message || '').trim();
    if (title.length < 2 || message.length < 2) {
      throw new AppError(400, 'INVALID_NOTIFICATION', 'Notification title and message are required.');
    }

    const smsTasks: Array<PendingSmsTask | null> = [];
    const tx = this.db.transaction(() => {
      let targetIds: number[] = [];
      if (input.customerIds === 'all_active') {
        const rows = this.db
          .prepare(`SELECT id FROM customers WHERE status = 'active'`)
          .all() as Array<{ id: number }>;
        targetIds = rows.map((r) => r.id);
      } else if (Array.isArray(input.customerIds) && input.customerIds.length > 0) {
        targetIds = [...new Set(input.customerIds.map(Number))];
      } else {
        throw new AppError(400, 'NO_RECIPIENTS', 'Select at least one customer recipient.');
      }

      for (const cid of targetIds) {
        smsTasks.push(
          this.createNotificationTx({
            customerId: cid,
            eventType: 'Custom Administrative Notice',
            title,
            message,
            targetType: 'account',
            targetId: cid,
            createdByAdminId: actor.id,
          })
        );
      }

      this.writeAuditLogTx({
        actorType: 'admin',
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'SEND_MANUAL_NOTIFICATION',
        entityType: 'notification',
        entityId: targetIds.join(','),
        afterObj: { title, recipientCount: targetIds.length },
      });

      return targetIds.length;
    });

    const sentCount = tx.immediate();
    await this.flushPendingSmsTasks(smsTasks);
    return { sentCount };
  }

  public listAdminNotifications(actor: AuthenticatedAdmin): NotificationView[] {
    if (actor.role !== 'main_admin' && !actor.permissions.includes('send_notifications')) {
      throw new AppError(403, 'FORBIDDEN', 'Insufficient permission to view notification history.');
    }
    const rows = this.db
      .prepare(
        `SELECT n.*, c.name AS customer_name, c.account_number AS customer_account_number
         FROM notifications n
         INNER JOIN customers c ON c.id = n.customer_id
         ORDER BY n.id DESC
         LIMIT 250`
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapNotificationRow(r));
  }

  // =========================================================================
  // ADMIN DASHBOARD STATISTICS & REPORTS (SECTIONS 44 & 48)
  // =========================================================================

  public getAdminDashboardSummary(actor: AuthenticatedAdmin) {
    const currency = this.getCurrencySymbol();

    const custCounts = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total_customers,
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_customers,
          SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked_customers,
          SUM(CASE WHEN status = 'pending_approval' THEN 1 ELSE 0 END) AS pending_registrations,
          COALESCE(SUM(outstanding_balance_paisa), 0) AS total_outstanding_paisa
         FROM customers`
      )
      .get() as Record<string, number>;

    const newOrdersCount = (
      this.db
        .prepare(`SELECT COUNT(*) AS cnt FROM orders WHERE status IN ('Order Received', 'Under Review')`)
        .get() as { cnt: number }
    ).cnt;

    // Pending Invoices = Approved/fulfilling orders that do not yet have a linked invoice
    const pendingInvoicesCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS cnt
           FROM orders o
           LEFT JOIN invoices i ON i.source_order_id = o.id
           WHERE o.status IN ('Confirmed / Partially Approved', 'Preparing', 'Dispatched', 'Delivered')
             AND i.id IS NULL`
        )
        .get() as { cnt: number }
    ).cnt;

    const recentPaymentsRows = this.db
      .prepare(
        `SELECT p.*, c.name AS customer_name, c.account_number AS customer_account_number,
                a.display_name AS created_by_admin_name
         FROM payments p
         INNER JOIN customers c ON c.id = p.customer_id
         INNER JOIN admin_users a ON a.id = p.created_by_admin_id
         ORDER BY p.id DESC LIMIT 6`
      )
      .all() as Array<Record<string, unknown>>;

    const recentNotifRows = this.db
      .prepare(
        `SELECT n.*, c.name AS customer_name, c.account_number AS customer_account_number
         FROM notifications n
         INNER JOIN customers c ON c.id = n.customer_id
         ORDER BY n.id DESC LIMIT 6`
      )
      .all() as Array<Record<string, unknown>>;

    const newOrderRows = this.db
      .prepare(
        `SELECT o.*, c.name AS customer_name, c.account_number AS customer_account_number
         FROM orders o
         INNER JOIN customers c ON c.id = o.customer_id
         WHERE o.status IN ('Order Received', 'Under Review')
         ORDER BY o.id DESC LIMIT 10`
      )
      .all() as Array<Record<string, unknown>>;

    const totalOutstandingPaisa = Number(custCounts.total_outstanding_paisa || 0);
    return {
      totalCustomers: Number(custCounts.total_customers || 0),
      activeCustomers: Number(custCounts.active_customers || 0),
      blockedCustomers: Number(custCounts.blocked_customers || 0),
      pendingRegistrations: Number(custCounts.pending_registrations || 0),
      newOrders: newOrdersCount,
      pendingInvoices: pendingInvoicesCount,
      outstandingAmountPaisa: totalOutstandingPaisa,
      outstandingAmountFormatted: formatPaisa(totalOutstandingPaisa, currency),
      recentPayments: recentPaymentsRows.map((r) => this.mapPaymentRow(r)),
      recentNotifications: recentNotifRows.map((r) => this.mapNotificationRow(r)),
      prominentNewOrders: this.hydrateOrders(newOrderRows),
      adminName: actor.displayName,
    };
  }

  public getReconciledReports(
    actor: AuthenticatedAdmin,
    filters?: { fromDate?: string; toDate?: string }
  ) {
    this.assertAdminPermission(actor, 'view_reports');
    const currency = this.getCurrencySymbol();

    const customerBalances = (
      this.db
        .prepare(
          `SELECT c.*,
            COALESCE((SELECT SUM(debit_paisa) FROM ledger_entries le WHERE le.customer_id = c.id), 0) AS total_debits,
            COALESCE((SELECT SUM(credit_paisa) FROM ledger_entries le WHERE le.customer_id = c.id), 0) AS total_credits
           FROM customers c
           ORDER BY c.outstanding_balance_paisa DESC, c.sequence_number ASC`
        )
        .all() as Array<Record<string, unknown>>
    ).map((r) => ({
      customerId: Number(r.id),
      accountNumber: String(r.account_number),
      name: String(r.name),
      status: String(r.status),
      totalDebitsPaisa: Number(r.total_debits),
      totalDebitsFormatted: formatPaisa(Number(r.total_debits), currency),
      totalCreditsPaisa: Number(r.total_credits),
      totalCreditsFormatted: formatPaisa(Number(r.total_credits), currency),
      outstandingBalancePaisa: Number(r.outstanding_balance_paisa),
      outstandingBalanceFormatted: formatPaisa(Number(r.outstanding_balance_paisa), currency),
    }));

    const orderStatusBreakdown = this.db
      .prepare(`SELECT status, COUNT(*) AS count FROM orders GROUP BY status ORDER BY count DESC`)
      .all() as Array<{ status: string; count: number }>;

    const invoices = this.listInvoicesForAdmin(actor, {
      fromDate: filters?.fromDate,
      toDate: filters?.toDate,
    });
    const payments = this.listPaymentsForAdmin(actor, {
      fromDate: filters?.fromDate,
      toDate: filters?.toDate,
    });

    const totalInvoicedPaisa = invoices.reduce((acc, inv) => acc + inv.grandTotalPaisa, 0);
    const totalPaymentsPaisa = payments.reduce((acc, pay) => acc + pay.amountPaisa, 0);

    return {
      currencySymbol: currency,
      customerBalances,
      outstandingOnly: customerBalances.filter((c) => c.outstandingBalancePaisa !== 0),
      orderStatusBreakdown,
      invoiceSummary: {
        count: invoices.length,
        totalPaisa: totalInvoicedPaisa,
        totalFormatted: formatPaisa(totalInvoicedPaisa, currency),
      },
      paymentSummary: {
        count: payments.length,
        totalPaisa: totalPaymentsPaisa,
        totalFormatted: formatPaisa(totalPaymentsPaisa, currency),
      },
    };
  }

  // =========================================================================
  // SETTINGS, UNRESOLVED DECISIONS REGISTER, AUDIT LOG & BACKUP/RESTORE
  // =========================================================================

  public getAdminSettings(actor: AuthenticatedAdmin) {
    this.assertAdminPermission(actor, 'manage_settings');
    const seqRows = this.db.prepare(`SELECT seq_key, next_val FROM system_sequences`).all() as Array<{
      seq_key: string;
      next_val: number;
    }>;
    const sequences = Object.fromEntries(seqRows.map((s) => [s.seq_key, s.next_val]));
    const hasSmsSecret = Boolean(
      this.getSetting('sms_provider_api_key', '') || process.env.SMS_PROVIDER_API_KEY
    );

    return {
      currencySymbol: this.getCurrencySymbol(),
      timezone: this.getTimeZone(),
      whatsappContactNumber: this.getSetting('whatsapp_contact_number', ''),
      logoDataUrl: this.getSetting('brand_logo_data_url', '') || null,
      invoiceBusinessAddress: this.getSetting('invoice_business_address', ''),
      invoiceBusinessPhone: this.getSetting('invoice_business_phone', ''),
      invoiceAccentColor: this.getSetting('invoice_accent_color', '#EAB308'),
      invoiceFooterNote: this.getSetting('invoice_footer_note', ''),
      otpExpirySeconds: Number(this.getSetting('otp_expiry_seconds', '300')),
      otpMaxAttempts: Number(this.getSetting('otp_max_attempts', '5')),
      otpResendCooldownSeconds: Number(this.getSetting('otp_resend_cooldown_seconds', '60')),
      smsEnabled: this.getSetting('sms_enabled', '0') === '1',
      smsProviderUrl: this.getSetting('sms_provider_url', ''),
      smsSenderId: this.getSetting('sms_sender_id', 'BRB-FEED'),
      smsApiKeyConfigured: hasSmsSecret, // Never return raw secret API key to browser!
      allowPostedFinancialEdits: this.getSetting('allow_posted_financial_edits', '1') === '1',
      sequences,
    };
  }

  public updateAdminSettings(
    actor: AuthenticatedAdmin,
    input: {
      currencySymbol?: string;
      timezone?: string;
      whatsappContactNumber?: string;
      logoDataUrl?: string | null;
      invoiceBusinessAddress?: string;
      invoiceBusinessPhone?: string;
      invoiceAccentColor?: string;
      invoiceFooterNote?: string;
      otpExpirySeconds?: number;
      otpMaxAttempts?: number;
      otpResendCooldownSeconds?: number;
      smsEnabled?: boolean;
      smsProviderUrl?: string;
      smsProviderApiKey?: string;
      smsSenderId?: string;
      allowPostedFinancialEdits?: boolean;
      nextInvoiceSequence?: number;
      nextCustomerSequence?: number;
    }
  ) {
    this.assertAdminPermission(actor, 'manage_settings');

    const tx = this.db.transaction(() => {
      const now = new Date().toISOString();
      const upsert = this.db.prepare(
        `INSERT INTO system_settings (setting_key, setting_value, is_secret, updated_by_admin_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(setting_key) DO UPDATE SET
           setting_value = excluded.setting_value,
           updated_by_admin_id = excluded.updated_by_admin_id,
           updated_at = excluded.updated_at`
      );

      if (input.currencySymbol !== undefined) {
        const c = input.currencySymbol.trim() || 'Rs.';
        upsert.run('currency_symbol', c.slice(0, 12), 0, actor.id, now);
      }
      if (input.timezone !== undefined) {
        upsert.run('timezone', input.timezone.trim() || 'Asia/Karachi', 0, actor.id, now);
      }
      if (input.whatsappContactNumber !== undefined) {
        const w = input.whatsappContactNumber.trim();
        if (w && !isValidMobileNumber(w)) {
          throw new AppError(400, 'INVALID_WHATSAPP', 'Enter a valid WhatsApp phone number or leave empty.');
        }
        upsert.run('whatsapp_contact_number', w ? normalizePakistaniMobile(w) : '', 0, actor.id, now);
      }
      if (input.logoDataUrl !== undefined) {
        const validLogo = this.validateImageDataUrl(input.logoDataUrl);
        upsert.run('brand_logo_data_url', validLogo ?? '', 0, actor.id, now);
      }
      if (input.invoiceBusinessAddress !== undefined) {
        upsert.run('invoice_business_address', input.invoiceBusinessAddress.trim().slice(0, 250), 0, actor.id, now);
      }
      if (input.invoiceBusinessPhone !== undefined) {
        upsert.run('invoice_business_phone', input.invoiceBusinessPhone.trim().slice(0, 60), 0, actor.id, now);
      }
      if (input.invoiceAccentColor !== undefined) {
        const hex = input.invoiceAccentColor.trim();
        if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) {
          throw new AppError(400, 'INVALID_COLOR', 'Invoice accent color must be a 6-digit hex code (e.g. #EAB308).');
        }
        upsert.run('invoice_accent_color', hex, 0, actor.id, now);
      }
      if (input.invoiceFooterNote !== undefined) {
        upsert.run('invoice_footer_note', input.invoiceFooterNote.trim().slice(0, 300), 0, actor.id, now);
      }
      if (input.otpExpirySeconds !== undefined) {
        const v = Math.max(60, Math.min(1800, Math.floor(Number(input.otpExpirySeconds))));
        upsert.run('otp_expiry_seconds', String(v), 0, actor.id, now);
      }
      if (input.otpMaxAttempts !== undefined) {
        const v = Math.max(3, Math.min(10, Math.floor(Number(input.otpMaxAttempts))));
        upsert.run('otp_max_attempts', String(v), 0, actor.id, now);
      }
      if (input.otpResendCooldownSeconds !== undefined) {
        const v = Math.max(15, Math.min(600, Math.floor(Number(input.otpResendCooldownSeconds))));
        upsert.run('otp_resend_cooldown_seconds', String(v), 0, actor.id, now);
      }
      if (input.smsEnabled !== undefined) {
        upsert.run('sms_enabled', input.smsEnabled ? '1' : '0', 0, actor.id, now);
      }
      if (input.smsProviderUrl !== undefined) {
        upsert.run('sms_provider_url', input.smsProviderUrl.trim().slice(0, 300), 0, actor.id, now);
      }
      if (input.smsProviderApiKey !== undefined && input.smsProviderApiKey.trim().length > 0) {
        upsert.run('sms_provider_api_key', input.smsProviderApiKey.trim(), 1, actor.id, now);
      }
      if (input.smsSenderId !== undefined) {
        upsert.run('sms_sender_id', input.smsSenderId.trim().slice(0, 32), 0, actor.id, now);
      }
      if (input.allowPostedFinancialEdits !== undefined) {
        upsert.run('allow_posted_financial_edits', input.allowPostedFinancialEdits ? '1' : '0', 0, actor.id, now);
      }

      if (input.nextInvoiceSequence !== undefined) {
        const maxInv = (
          this.db.prepare(`SELECT COALESCE(MAX(invoice_number), 0) AS m FROM invoices`).get() as { m: number }
        ).m;
        if (!Number.isInteger(input.nextInvoiceSequence) || input.nextInvoiceSequence <= maxInv) {
          throw new AppError(
            422,
            'INVALID_INVOICE_SEQUENCE',
            `Next invoice number must be an integer greater than the highest issued invoice (${maxInv}).`
          );
        }
        this.db
          .prepare(`UPDATE system_sequences SET next_val = ?, updated_at = ? WHERE seq_key = 'invoice_number'`)
          .run(input.nextInvoiceSequence, now);
      }

      if (input.nextCustomerSequence !== undefined) {
        const maxCust = (
          this.db.prepare(`SELECT COALESCE(MAX(sequence_number), 0) AS m FROM customers`).get() as { m: number }
        ).m;
        if (!Number.isInteger(input.nextCustomerSequence) || input.nextCustomerSequence <= maxCust) {
          throw new AppError(
            422,
            'INVALID_CUSTOMER_SEQUENCE',
            `Next customer sequence must be greater than highest issued sequence (${maxCust}).`
          );
        }
        this.db
          .prepare(`UPDATE system_sequences SET next_val = ?, updated_at = ? WHERE seq_key = 'customer_account'`)
          .run(input.nextCustomerSequence, now);
      }

      // Redact secret api key from audit log!
      const sanitizedChanges = { ...input };
      if ('smsProviderApiKey' in sanitizedChanges) {
        sanitizedChanges.smsProviderApiKey = '[REDACTED]';
      }
      if ('logoDataUrl' in sanitizedChanges && sanitizedChanges.logoDataUrl) {
        sanitizedChanges.logoDataUrl = '[IMAGE_DATA_UPDATED]';
      }

      this.writeAuditLogTx({
        actorType: 'admin',
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'UPDATE_SYSTEM_SETTINGS',
        entityType: 'system_settings',
        entityId: 'global',
        afterObj: sanitizedChanges,
      });
    });

    tx.immediate();
    return this.getAdminSettings(actor);
  }

  public listDecisionRegister(): DecisionRegisterItem[] {
    const rows = this.db
      .prepare(
        `SELECT dr.*, a.display_name AS updated_by_admin_name
         FROM decision_register dr
         LEFT JOIN admin_users a ON a.id = dr.updated_by_admin_id
         ORDER BY dr.id ASC`
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: Number(r.id),
      code: String(r.code),
      sectionRef: String(r.section_ref),
      title: String(r.title),
      status: String(r.status) as DecisionRegisterStatus,
      summary: String(r.summary),
      proposedRecommendation: String(r.proposed_recommendation),
      businessConfirmationRequired: String(r.business_confirmation_required),
      updatedByAdminName: r.updated_by_admin_name ? String(r.updated_by_admin_name) : null,
      updatedAt: String(r.updated_at),
    }));
  }

  public updateDecisionRegisterItem(
    actor: AuthenticatedAdmin,
    decisionId: number,
    input: { status: DecisionRegisterStatus; businessConfirmationRequired?: string }
  ): DecisionRegisterItem {
    this.assertAdminPermission(actor, 'manage_settings');
    if (!(DECISION_REGISTER_STATUSES as readonly string[]).includes(input.status)) {
      throw new AppError(400, 'INVALID_DECISION_STATUS', 'Invalid decision register status.');
    }

    const existing = this.db
      .prepare(`SELECT * FROM decision_register WHERE id = ?`)
      .get(decisionId) as Record<string, unknown> | undefined;
    if (!existing) {
      throw new AppError(404, 'DECISION_NOT_FOUND', 'Decision register entry not found.');
    }

    const now = new Date().toISOString();
    const nextNotes =
      input.businessConfirmationRequired !== undefined
        ? input.businessConfirmationRequired.trim()
        : String(existing.business_confirmation_required);

    this.db
      .prepare(
        `UPDATE decision_register
         SET status = ?, business_confirmation_required = ?, updated_by_admin_id = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(input.status, nextNotes, actor.id, now, decisionId);

    this.writeAuditLogTx({
      actorType: 'admin',
      actorId: actor.id,
      actorName: actor.displayName,
      action: 'UPDATE_DECISION_REGISTER',
      entityType: 'decision_register',
      entityId: String(existing.code),
      beforeObj: { status: existing.status },
      afterObj: { status: input.status },
    });

    return this.listDecisionRegister().find((d) => d.id === decisionId)!;
  }

  public listAuditLogs(actor: AuthenticatedAdmin, limit = 150) {
    if (actor.role !== 'main_admin' && !actor.permissions.includes('manage_settings')) {
      throw new AppError(403, 'FORBIDDEN', 'Only authorized administrators can inspect the security audit trail.');
    }
    const rows = this.db
      .prepare(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?`)
      .all(Math.min(500, Math.max(10, limit))) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      actorType: String(r.actor_type),
      actorName: String(r.actor_name),
      action: String(r.action),
      entityType: String(r.entity_type),
      entityId: String(r.entity_id),
      reason: r.reason ? String(r.reason) : null,
      beforeJson: r.before_json ? String(r.before_json) : null,
      afterJson: r.after_json ? String(r.after_json) : null,
      createdAt: String(r.created_at),
    }));
  }

  // =========================================================================
  // BACKUP & RESTORATION WITH SHA-256 INTEGRITY & AES-256-GCM ENCRYPTION
  // =========================================================================

  private static readonly BACKUP_TABLES = [
    'system_sequences',
    'system_settings',
    'admin_users',
    'customers',
    'products',
    'orders',
    'order_requested_items',
    'order_approved_items',
    'order_status_history',
    'invoices',
    'invoice_items',
    'invoice_revisions',
    'payments',
    'payment_revisions',
    'ledger_entries',
    'notifications',
    'decision_register',
    'audit_logs',
  ] as const;

  public exportBackupSnapshot(
    actor: AuthenticatedAdmin,
    options?: { passphrase?: string; notes?: string }
  ): {
    backupUid: string;
    schemaVersion: number;
    sha256Checksum: string;
    isEncrypted: boolean;
    recordCountsSummary: string;
    bundleJson: string;
    createdAt: string;
  } {
    this.assertAdminPermission(actor, 'manage_backups');
    const tablesData: Record<string, unknown[]> = {};
    for (const table of BrbEngine.BACKUP_TABLES) {
      const rows = this.db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
      if (table === 'system_settings') {
        // Strip raw secret SMS API key unless encrypted backup passphrase is provided
        tablesData[table] = rows.map((r) =>
          Number(r.is_secret) === 1 && !options?.passphrase ? { ...r, setting_value: '' } : r
        );
      } else {
        tablesData[table] = rows;
      }
    }

    const countsSummary = `Customers: ${tablesData.customers.length}, Products: ${tablesData.products.length}, Orders: ${tablesData.orders.length}, Invoices: ${tablesData.invoices.length}, Payments: ${tablesData.payments.length}, Ledger: ${tablesData.ledger_entries.length}`;
    const canonicalInnerJson = JSON.stringify({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      tables: tablesData,
    });
    const sha256Checksum = computeSha256Hex(canonicalInnerJson);
    const backupUid = `bkp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const createdAt = new Date().toISOString();
    const passphrase = (options?.passphrase || process.env.BACKUP_ENCRYPTION_SECRET || '').trim();
    const isEncrypted = passphrase.length > 0;

    const payloadField = isEncrypted
      ? encryptBackupPayload(canonicalInnerJson, passphrase)
      : canonicalInnerJson;

    const bundleJson = JSON.stringify(
      {
        application: BRAND_NAMES.applicationName,
        backupUid,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt,
        isEncrypted,
        sha256Checksum,
        recordCountsSummary: countsSummary,
        notes: (options?.notes || '').trim(),
        payload: payloadField,
      },
      null,
      2
    );

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO backup_records (
            backup_uid, sha256_checksum, is_encrypted, record_counts_summary,
            notes, created_by_admin_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          backupUid,
          sha256Checksum,
          isEncrypted ? 1 : 0,
          countsSummary,
          (options?.notes || '').trim(),
          actor.id,
          createdAt
        );

      this.writeAuditLogTx({
        actorType: 'admin',
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'CREATE_BACKUP_SNAPSHOT',
        entityType: 'backup',
        entityId: backupUid,
        afterObj: { sha256Checksum, isEncrypted, recordCountsSummary: countsSummary },
      });
    });
    tx.immediate();

    return {
      backupUid,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      sha256Checksum,
      isEncrypted,
      recordCountsSummary: countsSummary,
      bundleJson,
      createdAt,
    };
  }

  public verifyBackupSnapshot(
    actor: AuthenticatedAdmin,
    bundleJson: string,
    passphrase?: string
  ): {
    valid: true;
    backupUid: string;
    schemaVersion: number;
    sha256Checksum: string;
    recordCountsSummary: string;
    tables: Record<string, Array<Record<string, unknown>>>;
  } {
    this.assertAdminPermission(actor, 'manage_backups');
    let parsedBundle: Record<string, unknown>;
    try {
      parsedBundle = JSON.parse(bundleJson) as Record<string, unknown>;
    } catch {
      throw new AppError(400, 'INVALID_BACKUP_JSON', 'Backup file is not valid JSON.');
    }

    const expectedSha = String(parsedBundle.sha256Checksum || '');
    const isEncrypted = Boolean(parsedBundle.isEncrypted);
    const rawPayload = String(parsedBundle.payload || '');

    let innerJson = rawPayload;
    if (isEncrypted) {
      const secret = (passphrase || process.env.BACKUP_ENCRYPTION_SECRET || '').trim();
      if (!secret) {
        throw new AppError(400, 'PASSPHRASE_REQUIRED', 'This backup is encrypted. Provide the decryption passphrase.');
      }
      try {
        innerJson = decryptBackupPayload(rawPayload, secret);
      } catch {
        throw new AppError(400, 'DECRYPTION_FAILED', 'Backup decryption failed (incorrect passphrase or corrupted ciphertext).');
      }
    }

    const actualSha = computeSha256Hex(innerJson);
    if (!expectedSha || actualSha !== expectedSha) {
      throw new AppError(
        400,
        'CHECKSUM_MISMATCH',
        'Backup SHA-256 integrity verification failed! The snapshot payload has been modified or corrupted.'
      );
    }

    const inner = JSON.parse(innerJson) as {
      schemaVersion: number;
      tables: Record<string, Array<Record<string, unknown>>>;
    };
    if (inner.schemaVersion !== CURRENT_SCHEMA_VERSION || !inner.tables) {
      throw new AppError(400, 'UNSUPPORTED_SCHEMA', `Unsupported backup schema version (${inner.schemaVersion}).`);
    }

    for (const tbl of BrbEngine.BACKUP_TABLES) {
      if (!Array.isArray(inner.tables[tbl])) {
        throw new AppError(400, 'INCOMPLETE_BACKUP', `Backup is missing required table "${tbl}".`);
      }
    }

    if (inner.tables.admin_users.length === 0) {
      throw new AppError(400, 'EMPTY_ADMINS_IN_BACKUP', 'Cannot restore a backup containing zero administrator accounts.');
    }

    return {
      valid: true,
      backupUid: String(parsedBundle.backupUid || 'verified_snapshot'),
      schemaVersion: inner.schemaVersion,
      sha256Checksum: actualSha,
      recordCountsSummary: String(parsedBundle.recordCountsSummary || ''),
      tables: inner.tables,
    };
  }

  public restoreBackupSnapshot(
    actor: AuthenticatedAdmin,
    bundleJson: string,
    options?: { passphrase?: string; confirmOverwrite: boolean }
  ): { restoredBackupUid: string; recordCountsSummary: string } {
    this.assertAdminPermission(actor, 'manage_backups');
    if (!options?.confirmOverwrite) {
      throw new AppError(
        400,
        'CONFIRMATION_REQUIRED',
        'Explicit overwrite confirmation is required before restoring database state.'
      );
    }

    const verified = this.verifyBackupSnapshot(actor, bundleJson, options.passphrase);

    // Disable foreign keys transiently only around atomic full-table replacement, then run PRAGMA foreign_key_check!
    this.db.pragma('foreign_keys = OFF');
    try {
      const tx = this.db.transaction(() => {
        const reverseTables = [...BrbEngine.BACKUP_TABLES].reverse();
        this.db.prepare(`DELETE FROM otp_challenges`).run();
        for (const tbl of reverseTables) {
          this.db.prepare(`DELETE FROM ${tbl}`).run();
        }

        for (const tbl of BrbEngine.BACKUP_TABLES) {
          const rows = verified.tables[tbl];
          if (rows.length === 0) continue;
          const cols = Object.keys(rows[0]);
          const placeholders = cols.map(() => '?').join(', ');
          const stmt = this.db.prepare(
            `INSERT INTO ${tbl} (${cols.join(', ')}) VALUES (${placeholders})`
          );
          for (const r of rows) {
            stmt.run(...cols.map((c) => r[c] ?? null));
          }
        }

        // Reconcile every customer balance against restored ledger entries
        const cids = this.db.prepare(`SELECT id FROM customers`).all() as Array<{ id: number }>;
        for (const c of cids) {
          this.reconcileCustomerBalanceTx(c.id);
        }

        const fkViolations = this.db.pragma('foreign_key_check') as unknown[];
        if (fkViolations.length > 0) {
          throw new AppError(
            400,
            'RESTORE_FK_VIOLATION',
            'Backup restoration aborted: referential integrity check failed.'
          );
        }

        this.writeAuditLogTx({
          actorType: 'admin',
          actorId: actor.id,
          actorName: actor.displayName,
          action: 'RESTORE_BACKUP_SNAPSHOT',
          entityType: 'backup',
          entityId: verified.backupUid,
          afterObj: {
            sha256Checksum: verified.sha256Checksum,
            recordCountsSummary: verified.recordCountsSummary,
          },
        });
      });

      tx.immediate();
    } finally {
      this.db.pragma('foreign_keys = ON');
    }

    return {
      restoredBackupUid: verified.backupUid,
      recordCountsSummary: verified.recordCountsSummary,
    };
  }

  public listBackupHistory(actor: AuthenticatedAdmin) {
    this.assertAdminPermission(actor, 'manage_backups');
    const rows = this.db
      .prepare(
        `SELECT b.*, a.display_name AS created_by_admin_name
         FROM backup_records b
         INNER JOIN admin_users a ON a.id = b.created_by_admin_id
         ORDER BY b.id DESC LIMIT 50`
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: Number(r.id),
      backupUid: String(r.backup_uid),
      sha256Checksum: String(r.sha256_checksum),
      isEncrypted: Number(r.is_encrypted) === 1,
      recordCountsSummary: String(r.record_counts_summary),
      notes: String(r.notes || ''),
      createdByAdminName: String(r.created_by_admin_name),
      createdAt: String(r.created_at),
    }));
  }
}
