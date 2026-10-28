export const BRAND_NAMES = {
  applicationName: 'BRB Feed Industry',
  mainBusinessHeading: 'BRB CATTLE FEEDS & OIL MILLS',
  invoiceHeading: 'BRB Cattle Feed & Oil Mills',
} as const;

export const URDU_MESSAGES = {
  whatsappRegistrationHelp: 'اپنا BRB اکاؤنٹ نمبر معلوم کرنے کے لیے اس نمبر پر واٹس ایپ میسج کریں۔',
  accountBlocked: 'آپ کا اکاؤنٹ فی الحال Block ہے۔ براہِ کرم BRB سے رابطہ کریں۔',
  newInvoiceAddedTemplate: (formattedAmount: string) =>
    `آپ کے اکاؤنٹ میں ${formattedAmount} کی نئی Invoice شامل کی گئی ہے۔`,
} as const;

export const PRODUCT_CATEGORIES = ['BRB Cattle Feed', 'BRB Oil Mill'] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

export const PRODUCT_USAGES = ['Milk', 'Meat', 'Both'] as const;
export type ProductUsage = (typeof PRODUCT_USAGES)[number];

export const ORDER_STATUSES = [
  'Order Received',
  'Under Review',
  'Confirmed / Partially Approved',
  'Preparing',
  'Dispatched',
  'Delivered',
  'Cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const CUSTOMER_CANCELLABLE_STATUSES: readonly OrderStatus[] = [
  'Order Received',
  'Under Review',
] as const;

export const PAYMENT_METHODS = [
  'Cash',
  'Bank Transfer',
  'Cheque',
  'Online Payment',
  'Other',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const CUSTOMER_ACCOUNT_STATUSES = [
  'unregistered',
  'pending_otp',
  'pending_approval',
  'active',
  'rejected',
  'blocked',
] as const;
export type CustomerAccountStatus = (typeof CUSTOMER_ACCOUNT_STATUSES)[number];

export const ADMIN_ROLES = [
  'main_admin',
  'customer_staff',
  'order_staff',
  'finance_staff',
  'report_viewer',
] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const ADMIN_PERMISSIONS = [
  'manage_customers',
  'approve_registrations',
  'block_customers',
  'manage_products',
  'manage_orders',
  'manage_invoices',
  'edit_financial_records',
  'manage_payments',
  'view_full_ledger',
  'send_notifications',
  'view_reports',
  'manage_staff',
  'manage_settings',
  'manage_backups',
] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

export const DECISION_REGISTER_STATUSES = [
  'Confirmed by the specification',
  'Proposed technical decision',
  'Requires business confirmation',
  'Blocked by an external dependency',
  'Implemented and verified',
] as const;
export type DecisionRegisterStatus = (typeof DECISION_REGISTER_STATUSES)[number];

export const NOTIFICATION_EVENTS = [
  'Registration Approved',
  'Registration Rejected',
  'Account Blocked',
  'Account Unblocked',
  'Order Received',
  'Order Under Review',
  'Order Confirmed / Partially Approved',
  'Order Preparing',
  'Order Dispatched',
  'Order Delivered',
  'Approved Order',
  'New Invoice Added',
  'Invoice Edited / Updated',
  'Payment Received',
  'Payment Edited / Updated',
  'Password Reset / Changed',
  'Custom Administrative Notice',
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENTS)[number];

export type SmsDeliveryStatus =
  | 'not_configured'
  | 'queued'
  | 'submitted'
  | 'delivered'
  | 'failed';

export interface CustomerPublicView {
  id: number;
  accountNumber: string;
  name: string;
  businessName: string;
  mobileNumber: string;
  city: string;
  status: CustomerAccountStatus;
  outstandingBalancePaisa: number;
  outstandingBalanceFormatted: string;
  blockedReason: string | null;
  createdAt: string;
}

export interface ProductCustomerView {
  id: number;
  name: string;
  category: ProductCategory;
  packingWeight: string;
  usage: ProductUsage;
  shortDescription: string;
  fullDetails: string;
  imageUrl: string | null;
  isActive: boolean;
}

export interface ProductAdminView extends ProductCustomerView {
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OrderRequestedItemView {
  id: number;
  productId: number;
  productNameSnapshot: string;
  categorySnapshot: ProductCategory;
  packingSnapshot: string;
  requestedQty: number;
}

export interface OrderApprovedItemView {
  id: number;
  requestedItemId: number | null;
  productId: number;
  productNameSnapshot: string;
  categorySnapshot: ProductCategory;
  packingSnapshot: string;
  requestedQty: number | null;
  approvedQty: number;
  isAddedByBrb: boolean;
  reductionReason: string | null;
  addedByAdminName: string | null;
}

export interface OrderStatusHistoryView {
  id: number;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  actorType: 'customer' | 'admin' | 'system';
  actorName: string;
  note: string | null;
  createdAt: string;
}

export interface OrderView {
  id: number;
  orderNumber: string;
  customerId: number;
  customerName: string;
  customerAccountNumber: string;
  status: OrderStatus;
  requestedItems: OrderRequestedItemView[];
  approvedItems: OrderApprovedItemView[];
  statusHistory: OrderStatusHistoryView[];
  approvedByAdminName: string | null;
  approvedAt: string | null;
  linkedInvoiceId: number | null;
  linkedInvoiceNumber: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceLineItemView {
  id: number;
  productId: number | null;
  productName: string;
  packingWeight: string;
  quantity: number;
  ratePaisa: number;
  rateFormatted: string;
  lineTotalPaisa: number;
  lineTotalFormatted: string;
}

export interface InvoiceView {
  id: number;
  invoiceNumber: number;
  customerId: number;
  customerName: string;
  customerAccountNumber: string;
  sourceOrderId: number | null;
  sourceOrderNumber: string | null;
  invoiceDate: string;
  currencySymbol: string;
  grandTotalPaisa: number;
  grandTotalFormatted: string;
  notes: string;
  brandingSnapshot: {
    invoiceHeading: string;
    logoDataUrl: string | null;
    businessAddress: string;
    businessPhone: string;
    accentColor: string;
    footerNote: string;
  };
  items: InvoiceLineItemView[];
  revisionCount: number;
  createdByAdminName: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentView {
  id: number;
  paymentNumber: string;
  customerId: number;
  customerName: string;
  customerAccountNumber: string;
  amountPaisa: number;
  amountFormatted: string;
  paymentDate: string;
  paymentMethod: PaymentMethod;
  referenceNumber: string;
  remarks: string;
  revisionCount: number;
  createdByAdminName: string;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntryView {
  id: number;
  customerId: number;
  customerName: string;
  customerAccountNumber: string;
  entryDate: string;
  entryType: 'invoice' | 'payment' | 'opening_balance' | 'adjustment';
  invoiceId: number | null;
  invoiceNumber: number | null;
  paymentId: number | null;
  paymentMethod: string | null;
  referenceNumber: string | null;
  description: string;
  debitPaisa: number;
  debitFormatted: string;
  creditPaisa: number;
  creditFormatted: string;
  runningBalancePaisa: number;
  runningBalanceFormatted: string;
  createdAt: string;
}

export interface NotificationView {
  id: number;
  customerId: number;
  customerName: string;
  customerAccountNumber: string;
  eventType: NotificationEventType;
  title: string;
  message: string;
  targetType: 'invoice' | 'payment' | 'order' | 'account' | null;
  targetId: number | null;
  isRead: boolean;
  appDeliveryStatus: 'persisted' | 'read';
  smsDeliveryStatus: SmsDeliveryStatus;
  smsProviderRef: string | null;
  smsErrorDetail: string | null;
  createdAt: string;
}

export interface DecisionRegisterItem {
  id: number;
  code: string;
  sectionRef: string;
  title: string;
  status: DecisionRegisterStatus;
  summary: string;
  proposedRecommendation: string;
  businessConfirmationRequired: string;
  updatedByAdminName: string | null;
  updatedAt: string;
}
