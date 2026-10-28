import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const CURRENT_SCHEMA_VERSION = 1;

const MIGRATION_V1_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_sequences (
  seq_key TEXT PRIMARY KEY,
  next_val INTEGER NOT NULL CHECK (next_val >= 1),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  is_secret INTEGER NOT NULL DEFAULT 0,
  updated_by_admin_id INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  mobile_number TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  two_factor_enabled INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_number TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sequence_number INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  business_name TEXT NOT NULL DEFAULT '',
  mobile_number TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  status TEXT NOT NULL DEFAULT 'unregistered',
  opening_balance_paisa INTEGER NOT NULL DEFAULT 0,
  outstanding_balance_paisa INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  blocked_at TEXT,
  blocked_by_admin_id INTEGER REFERENCES admin_users(id),
  approved_at TEXT,
  approved_by_admin_id INTEGER REFERENCES admin_users(id),
  rejected_reason TEXT,
  created_by_admin_id INTEGER REFERENCES admin_users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customers_account ON customers(account_number);
CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
CREATE INDEX IF NOT EXISTS idx_customers_mobile ON customers(mobile_number);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('customer', 'admin')),
  customer_id INTEGER REFERENCES customers(id),
  admin_id INTEGER REFERENCES admin_users(id),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_token ON auth_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_customer ON auth_sessions(customer_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_admin ON auth_sessions(admin_id);

CREATE TABLE IF NOT EXISTS otp_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL CHECK (target_type IN ('customer', 'admin')),
  target_id INTEGER NOT NULL,
  mobile_or_email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('customer_registration', 'customer_password_reset', 'admin_2fa', 'admin_password_reset')),
  otp_digest TEXT NOT NULL,
  attempts_used INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  expires_at TEXT NOT NULL,
  resend_available_at TEXT NOT NULL,
  consumed_at TEXT,
  sms_status TEXT NOT NULL DEFAULT 'not_configured',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_otp_target_purpose ON otp_challenges(target_type, target_id, purpose);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('BRB Cattle Feed', 'BRB Oil Mill')),
  packing_weight TEXT NOT NULL,
  usage TEXT NOT NULL CHECK (usage IN ('Milk', 'Meat', 'Both')),
  short_description TEXT NOT NULL,
  full_details TEXT NOT NULL,
  image_data_url TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_archived INTEGER NOT NULL DEFAULT 0,
  created_by_admin_id INTEGER REFERENCES admin_users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_category_archived ON products(category, is_archived);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT NOT NULL UNIQUE,
  sequence_number INTEGER NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  approved_by_admin_id INTEGER REFERENCES admin_users(id),
  approved_at TEXT,
  cancelled_by_type TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at DESC);

CREATE TABLE IF NOT EXISTS order_requested_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name_snapshot TEXT NOT NULL,
  category_snapshot TEXT NOT NULL,
  packing_snapshot TEXT NOT NULL,
  requested_qty INTEGER NOT NULL CHECK (requested_qty > 0)
);

CREATE INDEX IF NOT EXISTS idx_order_req_items_order ON order_requested_items(order_id);

CREATE TABLE IF NOT EXISTS order_approved_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  requested_item_id INTEGER REFERENCES order_requested_items(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name_snapshot TEXT NOT NULL,
  category_snapshot TEXT NOT NULL,
  packing_snapshot TEXT NOT NULL,
  requested_qty INTEGER,
  approved_qty INTEGER NOT NULL CHECK (approved_qty >= 0),
  is_added_by_brb INTEGER NOT NULL DEFAULT 0,
  reduction_reason TEXT,
  added_by_admin_id INTEGER REFERENCES admin_users(id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_app_items_order ON order_approved_items(order_id);

CREATE TABLE IF NOT EXISTS order_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('customer', 'admin', 'system')),
  actor_id INTEGER,
  actor_name TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_history_order ON order_status_history(order_id);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number INTEGER NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  source_order_id INTEGER UNIQUE REFERENCES orders(id),
  invoice_date TEXT NOT NULL,
  currency_symbol TEXT NOT NULL DEFAULT 'Rs.',
  grand_total_paisa INTEGER NOT NULL CHECK (grand_total_paisa > 0),
  notes TEXT NOT NULL DEFAULT '',
  branding_snapshot_json TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  revision_count INTEGER NOT NULL DEFAULT 0,
  created_by_admin_id INTEGER NOT NULL REFERENCES admin_users(id),
  updated_by_admin_id INTEGER REFERENCES admin_users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id, invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(invoice_date DESC);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  product_id INTEGER REFERENCES products(id),
  product_name TEXT NOT NULL,
  packing_weight TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  rate_paisa INTEGER NOT NULL CHECK (rate_paisa > 0),
  line_total_paisa INTEGER NOT NULL CHECK (line_total_paisa > 0)
);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);

CREATE TABLE IF NOT EXISTS invoice_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  revision_number INTEGER NOT NULL,
  previous_snapshot_json TEXT NOT NULL,
  new_snapshot_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  edited_by_admin_id INTEGER NOT NULL REFERENCES admin_users(id),
  edited_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_number TEXT NOT NULL UNIQUE,
  sequence_number INTEGER NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  amount_paisa INTEGER NOT NULL CHECK (amount_paisa > 0),
  payment_date TEXT NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('Cash', 'Bank Transfer', 'Cheque', 'Online Payment', 'Other')),
  reference_number TEXT NOT NULL DEFAULT '',
  remarks TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT UNIQUE,
  revision_count INTEGER NOT NULL DEFAULT 0,
  created_by_admin_id INTEGER NOT NULL REFERENCES admin_users(id),
  updated_by_admin_id INTEGER REFERENCES admin_users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id, payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_payments_reference ON payments(reference_number);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(payment_date DESC);

CREATE TABLE IF NOT EXISTS payment_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  revision_number INTEGER NOT NULL,
  previous_snapshot_json TEXT NOT NULL,
  new_snapshot_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  edited_by_admin_id INTEGER NOT NULL REFERENCES admin_users(id),
  edited_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  entry_date TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('invoice', 'payment', 'opening_balance', 'adjustment')),
  invoice_id INTEGER UNIQUE REFERENCES invoices(id),
  payment_id INTEGER UNIQUE REFERENCES payments(id),
  description TEXT NOT NULL,
  debit_paisa INTEGER NOT NULL DEFAULT 0 CHECK (debit_paisa >= 0),
  credit_paisa INTEGER NOT NULL DEFAULT 0 CHECK (credit_paisa >= 0),
  created_by_admin_id INTEGER REFERENCES admin_users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_customer_date ON ledger_entries(customer_id, entry_date ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_ledger_entry_date ON ledger_entries(entry_date DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  is_read INTEGER NOT NULL DEFAULT 0,
  app_delivery_status TEXT NOT NULL DEFAULT 'persisted',
  sms_delivery_status TEXT NOT NULL DEFAULT 'not_configured',
  sms_provider_ref TEXT,
  sms_error_detail TEXT,
  idempotency_key TEXT UNIQUE,
  created_by_admin_id INTEGER REFERENCES admin_users(id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_customer ON notifications(customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS decision_register (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  section_ref TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  proposed_recommendation TEXT NOT NULL,
  business_confirmation_required TEXT NOT NULL,
  updated_by_admin_id INTEGER REFERENCES admin_users(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'customer', 'system')),
  actor_id INTEGER,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  reason TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS backup_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  backup_uid TEXT NOT NULL UNIQUE,
  sha256_checksum TEXT NOT NULL,
  is_encrypted INTEGER NOT NULL DEFAULT 0,
  record_counts_summary TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_by_admin_id INTEGER NOT NULL REFERENCES admin_users(id),
  created_at TEXT NOT NULL
);
`;

const INITIAL_SETTINGS: Array<[string, string, number]> = [
  ['currency_symbol', 'Rs.', 0],
  ['timezone', 'Asia/Karachi', 0],
  ['whatsapp_contact_number', '', 0],
  ['brand_logo_data_url', '', 0],
  ['invoice_business_address', '', 0],
  ['invoice_business_phone', '', 0],
  ['invoice_accent_color', '#EAB308', 0],
  ['invoice_footer_note', '', 0],
  ['otp_expiry_seconds', '300', 0],
  ['otp_max_attempts', '5', 0],
  ['otp_resend_cooldown_seconds', '60', 0],
  ['sms_enabled', '0', 0],
  ['sms_provider_url', '', 0],
  ['sms_provider_api_key', '', 1],
  ['sms_sender_id', 'BRB-FEED', 0],
  ['allow_posted_financial_edits', '1', 0],
];

const INITIAL_DECISIONS = [
  {
    code: 'DEC-5.1',
    sectionRef: 'Section 5.1',
    title: 'Customer Account Assignment & Pre-Registration Ownership',
    status: 'Proposed technical decision',
    summary:
      'Sequential customer account numbers start at BRB-C-ID131, and customer registration requires entering an assigned BRB Account Number.',
    proposedRecommendation:
      'BRB Administrators create eligible customer records (atomically allocating BRB-C-ID131, BRB-C-ID132... and binding their verified mobile number). Customers then register with that BRB Account Number + Mobile Number + Password -> Mobile OTP -> Admin Approval -> Active.',
    businessConfirmationRequired:
      'Confirm whether all customers are pre-registered by BRB staff after WhatsApp inquiry, or whether an alternative identity verification step is needed.',
  },
  {
    code: 'DEC-5.2',
    sectionRef: 'Section 5.2',
    title: 'Production Hosting, Database Persistence & Storage Infrastructure',
    status: 'Proposed technical decision',
    summary:
      'Application runs Express + ACID relational SQLite (WAL + strict foreign keys) paired with provisioned Firebase Firestore cloud snapshot backup.',
    proposedRecommendation:
      'Use relational ACID transactions on the backend for ledger/sequence integrity and sync encrypted/checksummed snapshots to Cloud Firestore; provision dedicated persistent disk or managed PostgreSQL before public Cloud Run horizontal scaling.',
    businessConfirmationRequired:
      'Confirm final production hosting topology, persistent volume/database instance, and scheduled off-site storage owner.',
  },
  {
    code: 'DEC-5.3',
    sectionRef: 'Section 5.3',
    title: 'Pakistani Mobile OTP & SMS Gateway Provider',
    status: 'Blocked by an external dependency',
    summary:
      'Real SMS/OTP HTTP integration boundary is implemented, but provider URL, credentials, sender ID, and Pakistani telco templates are not supplied.',
    proposedRecommendation:
      'Configure an approved Pakistani corporate SMS gateway (e.g., Jazz/Telenor/Zong aggregator) in Admin Settings. Until configured, SMS status honestly records "not_configured".',
    businessConfirmationRequired:
      'Supply production SMS provider endpoint, secret API key, registered masking Sender ID, and approved Urdu/English message templates.',
  },
  {
    code: 'DEC-5.4',
    sectionRef: 'Section 5.4',
    title: 'Staff & Administrator Least-Privilege Role Matrix',
    status: 'Requires business confirmation',
    summary:
      'Five proposed RBAC profiles implemented: Main Administrator, Customer-Management Staff, Order-Management Staff, Invoice/Payment Staff, and Read-Only Reporting Staff.',
    proposedRecommendation:
      'Restrict financial edits, customer blocking, staff management, settings, and backup restoration exclusively to Main Administrator until BRB management signs off on delegated permissions.',
    businessConfirmationRequired:
      'Confirm exact staff roles and whether finance staff may edit posted invoices/payments or only create new ones.',
  },
  {
    code: 'DEC-5.5',
    sectionRef: 'Section 5.5',
    title: 'Accounting Policies (Opening Balances, Overpayments, Adjustments & Tax)',
    status: 'Requires business confirmation',
    summary:
      'Ledger tracks Invoice Debits and Payment Credits in exact integer paisa with zero invented taxes or auto-allocations.',
    proposedRecommendation:
      'Overpayments render transparently as negative (credit) outstanding balances; authorized invoice/payment edits require a mandatory reason, preserve immutable revision snapshots, and atomically update the corresponding ledger entry without double-posting.',
    businessConfirmationRequired:
      'Confirm migration policy for historical opening balances, whether posted invoices should use credit/debit adjustment notes instead of in-place revision, and tax treatment.',
  },
  {
    code: 'DEC-5.6',
    sectionRef: 'Section 5.6',
    title: 'Order-to-Invoice Cardinality & Post-Confirmation Order Revisions',
    status: 'Proposed technical decision',
    summary:
      'Supports both Order-Linked Invoices (Method A) and Independent Offline Invoices (Method B).',
    proposedRecommendation:
      'Enforce 1-to-1 Order-to-Invoice linkage by default to prevent accidental duplicate invoicing of approved quantities, while allowing unlimited independent invoices for offline/partial dispatches.',
    businessConfirmationRequired:
      'Confirm whether split deliveries from a single order should generate multiple partial invoices or whether a confirmed order can be administratively reversed.',
  },
  {
    code: 'DEC-5.7',
    sectionRef: 'Section 5.7',
    title: 'Currency, Timezone & 12-Month Customer Ledger Boundary',
    status: 'Proposed technical decision',
    summary:
      'Defaults configured to Currency "Rs." and Timezone "Asia/Karachi" with rolling 12-month backend cutoff on customer ledger queries.',
    proposedRecommendation:
      'Retain configurable currency symbol and IANA timezone in Admin Settings; enforce 12-month boundary in SQL for customer endpoints while retaining full multi-year history for administrators.',
    businessConfirmationRequired:
      'Confirm formal fiscal-year cutoff rules and whether invoice dates may be backdated into closed months.',
  },
  {
    code: 'DEC-5.8',
    sectionRef: 'Section 5.8',
    title: 'Production Domain, Backup Retention & Deployment Sign-Off',
    status: 'Requires business confirmation',
    summary:
      'Current environment is an AI Studio development/preview environment, not a signed-off public production deployment.',
    proposedRecommendation:
      'Complete acceptance verification, configure production SMS secrets and official BRB logo, verify off-site backup restoration, and assign an operational owner prior to onboarding live customer data.',
    businessConfirmationRequired:
      'Confirm production custom domain, backup schedule/retention window, and authorized deployment owner.',
  },
];

export function openBrbDatabase(dbFilePath?: string): Database.Database {
  const resolvedPath =
    dbFilePath || process.env.BRB_DB_PATH || path.resolve('data', 'brb_feed_industry.sqlite');

  if (resolvedPath !== ':memory:') {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  runMigrationsAndDefaults(db);
  return db;
}

export function runMigrationsAndDefaults(db: Database.Database): void {
  const migrateTx = db.transaction(() => {
    db.exec(MIGRATION_V1_SQL);
    const now = new Date().toISOString();

    db.prepare(
      `INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)`
    ).run(CURRENT_SCHEMA_VERSION, now);

    // Initialize atomic sequences starting at BRB-C-ID131, Order 1001, Invoice 5001, Payment 1001
    const insertSeq = db.prepare(
      `INSERT OR IGNORE INTO system_sequences (seq_key, next_val, updated_at) VALUES (?, ?, ?)`
    );
    insertSeq.run('customer_account', 131, now);
    insertSeq.run('order_number', 1001, now);
    insertSeq.run('invoice_number', 5001, now);
    insertSeq.run('payment_number', 1001, now);

    const insertSetting = db.prepare(
      `INSERT OR IGNORE INTO system_settings (setting_key, setting_value, is_secret, updated_at) VALUES (?, ?, ?, ?)`
    );
    for (const [key, val, isSecret] of INITIAL_SETTINGS) {
      insertSetting.run(key, val, isSecret, now);
    }

    const insertDecision = db.prepare(`
      INSERT OR IGNORE INTO decision_register (
        code, section_ref, title, status, summary,
        proposed_recommendation, business_confirmation_required, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const d of INITIAL_DECISIONS) {
      insertDecision.run(
        d.code,
        d.sectionRef,
        d.title,
        d.status,
        d.summary,
        d.proposedRecommendation,
        d.businessConfirmationRequired,
        now
      );
    }
  });

  migrateTx.immediate();
}
