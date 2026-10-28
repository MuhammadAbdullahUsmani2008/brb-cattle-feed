import type {
  AdminPermission,
  AdminRole,
  InvoiceView,
  NotificationView,
  OrderView,
  PaymentView,
} from '../shared/types';

export type AdminNavSection =
  | 'dashboard'
  | 'customers'
  | 'products'
  | 'orders'
  | 'finance'
  | 'operations';

export type FinanceSubSection = 'invoices' | 'payments' | 'ledger';
export type OperationsSubSection =
  | 'notifications'
  | 'reports'
  | 'settings'
  | 'staff'
  | 'decisions'
  | 'audit'
  | 'backups';

export interface AdminAuthenticatedProfile {
  id: number;
  username: string;
  email: string;
  displayName: string;
  mobileNumber: string;
  role: AdminRole;
  permissions: AdminPermission[];
  twoFactorEnabled: boolean;
}

export interface AdminDashboardSummary {
  totalCustomers: number;
  activeCustomers: number;
  blockedCustomers: number;
  pendingRegistrations: number;
  newOrders: number;
  pendingInvoices: number;
  outstandingAmountPaisa: number;
  outstandingAmountFormatted: string;
  recentPayments: PaymentView[];
  recentNotifications: NotificationView[];
  prominentNewOrders: OrderView[];
  adminName: string;
}

export interface StaffAccountView {
  id: number;
  username: string;
  email: string;
  displayName: string;
  mobileNumber: string;
  role: AdminRole;
  permissions: AdminPermission[];
  twoFactorEnabled: boolean;
  isActive: boolean;
  createdAt: string;
}

export interface AdminSettingsResponse {
  currencySymbol: string;
  timezone: string;
  whatsappContactNumber: string;
  logoDataUrl: string | null;
  invoiceBusinessAddress: string;
  invoiceBusinessPhone: string;
  invoiceAccentColor: string;
  invoiceFooterNote: string;
  otpExpirySeconds: number;
  otpMaxAttempts: number;
  otpResendCooldownSeconds: number;
  smsEnabled: boolean;
  smsProviderUrl: string;
  smsSenderId: string;
  smsApiKeyConfigured: boolean;
  allowPostedFinancialEdits: boolean;
  sequences: Record<string, number>;
}

export interface AuditLogView {
  id: number;
  actorType: string;
  actorName: string;
  action: string;
  entityType: string;
  entityId: string;
  reason: string | null;
  beforeJson: string | null;
  afterJson: string | null;
  createdAt: string;
}

export interface BackupHistoryItem {
  id: number;
  backupUid: string;
  sha256Checksum: string;
  isEncrypted: boolean;
  recordCountsSummary: string;
  notes: string;
  createdByAdminName: string;
  createdAt: string;
}
