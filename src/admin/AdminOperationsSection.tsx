import React, { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  Cloud,
  CloudDownload,
  CloudUpload,
  DatabaseBackup,
  Download,
  FileSpreadsheet,
  KeyRound,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import type { User } from 'firebase/auth';
import {
  ADMIN_PERMISSIONS,
  ADMIN_ROLES,
  DECISION_REGISTER_STATUSES,
} from '../shared/types';
import type {
  AdminPermission,
  AdminRole,
  CustomerPublicView,
  DecisionRegisterItem,
  DecisionRegisterStatus,
  NotificationView,
} from '../shared/types';
import { getDefaultPermissionsForRole } from '../shared/domain';
import {
  adminApi,
  readImageFileAsDataUrl,
  triggerTextFileDownload,
} from '../lib/api';
import {
  downloadCloudBackupBundle,
  FIREBASE_PROJECT_ID,
  FIRESTORE_DATABASE_ID,
  listCloudBackups,
  signInFirebaseCloudAdmin,
  signOutFirebaseCloudAdmin,
  subscribeFirebaseAdminUser,
  uploadBackupSnapshotToCloud,
} from '../lib/firebase';
import type { CloudBackupHeaderView } from '../lib/firebase';
import {
  BrbLogo,
  ConfirmDialog,
  EmptyStateBox,
  InlineAlert,
} from '../components/Branding';
import type {
  AdminAuthenticatedProfile,
  AdminSettingsResponse,
  AuditLogView,
  BackupHistoryItem,
  OperationsSubSection,
  StaffAccountView,
} from './types';

interface ReconciledCustomerBalanceRow {
  customerId: number;
  accountNumber: string;
  name: string;
  status: string;
  totalDebitsPaisa: number;
  totalDebitsFormatted: string;
  totalCreditsPaisa: number;
  totalCreditsFormatted: string;
  outstandingBalancePaisa: number;
  outstandingBalanceFormatted: string;
}

interface ReconciledReportsResponse {
  currencySymbol: string;
  customerBalances: ReconciledCustomerBalanceRow[];
  outstandingOnly: ReconciledCustomerBalanceRow[];
  orderStatusBreakdown: Array<{ status: string; count: number }>;
  invoiceSummary: {
    count: number;
    totalPaisa: number;
    totalFormatted: string;
  };
  paymentSummary: {
    count: number;
    totalPaisa: number;
    totalFormatted: string;
  };
}

interface ExportedSnapshotBundle {
  backupUid: string;
  schemaVersion: number;
  sha256Checksum: string;
  isEncrypted: boolean;
  recordCountsSummary: string;
  bundleJson: string;
  createdAt: string;
}

const SUB_TABS: Array<{ id: OperationsSubSection; label: string }> = [
  { id: 'notifications', label: 'Notifications & SMS' },
  { id: 'reports', label: 'Reconciled Reports' },
  { id: 'settings', label: 'Settings & Branding' },
  { id: 'staff', label: 'Staff & RBAC' },
  { id: 'decisions', label: 'Decisions Register' },
  { id: 'audit', label: 'Audit Trail' },
  { id: 'backups', label: 'Backup & Cloud Vault' },
];

export function AdminOperationsSection({
  admin,
  subSection,
  onChangeSubSection,
  onSettingsUpdated,
  onDataChanged,
}: {
  admin: AdminAuthenticatedProfile;
  subSection: OperationsSubSection;
  onChangeSubSection: (sub: OperationsSubSection) => void;
  onSettingsUpdated: () => void;
  onDataChanged: () => void;
}) {
  const [banner, setBanner] = useState<{
    tone: 'success' | 'error' | 'info' | 'warning';
    message: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  // Notifications state
  const [notifications, setNotifications] = useState<NotificationView[]>([]);
  const [activeCustomers, setActiveCustomers] = useState<CustomerPublicView[]>([]);
  const [notifTargetMode, setNotifTargetMode] = useState<'all_active' | 'selected'>('all_active');
  const [selectedRecipientIds, setSelectedRecipientIds] = useState<number[]>([]);
  const [notifTitle, setNotifTitle] = useState('');
  const [notifMessage, setNotifMessage] = useState('');
  const [sendingNotif, setSendingNotif] = useState(false);

  // Reports state
  const [reportFromDate, setReportFromDate] = useState('');
  const [reportToDate, setReportToDate] = useState('');
  const [showOutstandingOnly, setShowOutstandingOnly] = useState(false);
  const [reports, setReports] = useState<ReconciledReportsResponse | null>(null);

  // Settings state
  const [settings, setSettings] = useState<AdminSettingsResponse | null>(null);
  const [currencySymbol, setCurrencySymbol] = useState('Rs.');
  const [timezone, setTimezone] = useState('Asia/Karachi');
  const [whatsappContactNumber, setWhatsappContactNumber] = useState('');
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const [invoiceBusinessAddress, setInvoiceBusinessAddress] = useState('');
  const [invoiceBusinessPhone, setInvoiceBusinessPhone] = useState('');
  const [invoiceAccentColor, setInvoiceAccentColor] = useState('#EAB308');
  const [invoiceFooterNote, setInvoiceFooterNote] = useState('');
  const [otpExpirySeconds, setOtpExpirySeconds] = useState(300);
  const [otpMaxAttempts, setOtpMaxAttempts] = useState(5);
  const [otpResendCooldownSeconds, setOtpResendCooldownSeconds] = useState(60);
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [smsProviderUrl, setSmsProviderUrl] = useState('');
  const [smsSenderId, setSmsSenderId] = useState('BRB-FEED');
  const [smsProviderApiKeyInput, setSmsProviderApiKeyInput] = useState('');
  const [allowPostedFinancialEdits, setAllowPostedFinancialEdits] = useState(true);
  const [nextCustomerSequenceInput, setNextCustomerSequenceInput] = useState('');
  const [nextInvoiceSequenceInput, setNextInvoiceSequenceInput] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);

  // Staff RBAC state
  const [staffList, setStaffList] = useState<StaffAccountView[]>([]);
  const [staffModalOpen, setStaffModalOpen] = useState(false);
  const [staffUsername, setStaffUsername] = useState('');
  const [staffEmail, setStaffEmail] = useState('');
  const [staffDisplayName, setStaffDisplayName] = useState('');
  const [staffMobile, setStaffMobile] = useState('');
  const [staffPassword, setStaffPassword] = useState('');
  const [staffRole, setStaffRole] = useState<AdminRole>('order_staff');
  const [staffPermissions, setStaffPermissions] = useState<AdminPermission[]>(
    getDefaultPermissionsForRole('order_staff')
  );
  const [staffTwoFactor, setStaffTwoFactor] = useState(false);
  const [creatingStaff, setCreatingStaff] = useState(false);

  // Decisions Register state
  const [decisions, setDecisions] = useState<DecisionRegisterItem[]>([]);
  const [decisionEdits, setDecisionEdits] = useState<
    Record<number, { status: DecisionRegisterStatus; notes: string }>
  >({});
  const [savingDecisionId, setSavingDecisionId] = useState<number | null>(null);

  // Audit Log state
  const [auditLogs, setAuditLogs] = useState<AuditLogView[]>([]);
  const [auditSearch, setAuditSearch] = useState('');
  const [expandedAuditId, setExpandedAuditId] = useState<number | null>(null);

  // Backups & Cloud Vault state
  const [backupHistory, setBackupHistory] = useState<BackupHistoryItem[]>([]);
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [exportNotes, setExportNotes] = useState('');
  const [latestExportedBundle, setLatestExportedBundle] = useState<ExportedSnapshotBundle | null>(
    null
  );
  const [exportingBackup, setExportingBackup] = useState(false);

  const [restoreJsonInput, setRestoreJsonInput] = useState('');
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [dryRunResult, setDryRunResult] = useState<{
    backupUid: string;
    schemaVersion: number;
    sha256Checksum: string;
    recordCountsSummary: string;
  } | null>(null);
  const [verifyingBackup, setVerifyingBackup] = useState(false);
  const [confirmRestoreOpen, setConfirmRestoreOpen] = useState(false);
  const [confirmOverwriteChecked, setConfirmOverwriteChecked] = useState(false);
  const [restoringBackup, setRestoringBackup] = useState(false);

  // Firebase Cloud Vault state
  const [cloudUser, setCloudUser] = useState<User | null>(null);
  const [cloudBackups, setCloudBackups] = useState<CloudBackupHeaderView[]>([]);
  const [cloudBusy, setCloudBusy] = useState(false);

  useEffect(() => {
    const unsub = subscribeFirebaseAdminUser((u) => {
      setCloudUser(u);
    });
    return () => unsub();
  }, []);

  const populateSettingsDraft = useCallback((res: AdminSettingsResponse) => {
    setSettings(res);
    setCurrencySymbol(res.currencySymbol);
    setTimezone(res.timezone);
    setWhatsappContactNumber(res.whatsappContactNumber);
    setLogoDataUrl(res.logoDataUrl);
    setInvoiceBusinessAddress(res.invoiceBusinessAddress);
    setInvoiceBusinessPhone(res.invoiceBusinessPhone);
    setInvoiceAccentColor(res.invoiceAccentColor);
    setInvoiceFooterNote(res.invoiceFooterNote);
    setOtpExpirySeconds(res.otpExpirySeconds);
    setOtpMaxAttempts(res.otpMaxAttempts);
    setOtpResendCooldownSeconds(res.otpResendCooldownSeconds);
    setSmsEnabled(res.smsEnabled);
    setSmsProviderUrl(res.smsProviderUrl);
    setSmsSenderId(res.smsSenderId);
    setSmsProviderApiKeyInput('');
    setAllowPostedFinancialEdits(res.allowPostedFinancialEdits);
    setNextCustomerSequenceInput(
      res.sequences.customer_account ? String(res.sequences.customer_account) : ''
    );
    setNextInvoiceSequenceInput(
      res.sequences.invoice_number ? String(res.sequences.invoice_number) : ''
    );
  }, []);

  const loadCurrentSubSection = useCallback(async () => {
    setLoading(true);
    setBanner(null);
    try {
      if (subSection === 'notifications') {
        const [notifRes, custRes] = await Promise.all([
          adminApi<{ notifications: NotificationView[] }>('/api/admin/notifications'),
          adminApi<{ customers: CustomerPublicView[] }>('/api/admin/customers?status=active').catch(
            () => ({ customers: [] })
          ),
        ]);
        setNotifications(notifRes.notifications);
        setActiveCustomers(custRes.customers);
      } else if (subSection === 'reports') {
        const params = new URLSearchParams();
        if (reportFromDate) params.set('fromDate', reportFromDate);
        if (reportToDate) params.set('toDate', reportToDate);
        const qs = params.toString();
        const repRes = await adminApi<ReconciledReportsResponse>(
          `/api/admin/reports${qs ? `?${qs}` : ''}`
        );
        setReports(repRes);
      } else if (subSection === 'settings') {
        const setRes = await adminApi<AdminSettingsResponse>('/api/admin/settings');
        populateSettingsDraft(setRes);
      } else if (subSection === 'staff') {
        const stRes = await adminApi<{ staff: StaffAccountView[] }>('/api/admin/staff');
        setStaffList(stRes.staff);
      } else if (subSection === 'decisions') {
        const decRes = await adminApi<{ decisions: DecisionRegisterItem[] }>(
          '/api/admin/decisions'
        );
        setDecisions(decRes.decisions);
        const edits: Record<number, { status: DecisionRegisterStatus; notes: string }> = {};
        for (const item of decRes.decisions) {
          edits[item.id] = {
            status: item.status,
            notes: item.businessConfirmationRequired,
          };
        }
        setDecisionEdits(edits);
      } else if (subSection === 'audit') {
        const audRes = await adminApi<{ logs: AuditLogView[] }>('/api/admin/audit-logs');
        setAuditLogs(audRes.logs);
      } else if (subSection === 'backups') {
        const bkpRes = await adminApi<{ backups: BackupHistoryItem[] }>('/api/admin/backups');
        setBackupHistory(bkpRes.backups);
        if (cloudUser) {
          const cList = await listCloudBackups().catch(() => []);
          setCloudBackups(cList);
        }
      }
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Unable to load operational section.',
      });
    } finally {
      setLoading(false);
    }
  }, [subSection, reportFromDate, reportToDate, populateSettingsDraft, cloudUser]);

  useEffect(() => {
    void loadCurrentSubSection();
  }, [loadCurrentSubSection]);

  // ---------------------------------------------------------------------------
  // Notifications Handlers
  // ---------------------------------------------------------------------------
  const toggleRecipient = (cid: number) => {
    setSelectedRecipientIds((prev) =>
      prev.includes(cid) ? prev.filter((id) => id !== cid) : [...prev, cid]
    );
  };

  const handleSendManualNotification = async (e: React.FormEvent) => {
    e.preventDefault();
    setBanner(null);
    setSendingNotif(true);
    try {
      const payload = {
        customerIds: notifTargetMode === 'all_active' ? ('all_active' as const) : selectedRecipientIds,
        title: notifTitle.trim(),
        message: notifMessage.trim(),
      };
      const res = await adminApi<{ sentCount: number }>('/api/admin/notifications', {
        method: 'POST',
        body: payload,
      });
      setNotifTitle('');
      setNotifMessage('');
      setSelectedRecipientIds([]);
      setBanner({
        tone: 'success',
        message: `Notification persisted to ${res.sentCount} customer account(s).`,
      });
      onDataChanged();
      await loadCurrentSubSection();
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Failed to send notification.',
      });
    } finally {
      setSendingNotif(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Reports CSV Export
  // ---------------------------------------------------------------------------
  const handleExportCustomerBalancesCsv = () => {
    if (!reports) return;
    const rows = showOutstandingOnly ? reports.outstandingOnly : reports.customerBalances;
    const header = [
      'Account Number',
      'Customer Name',
      'Status',
      'Total Debits',
      'Total Credits',
      'Outstanding Balance',
    ];
    const escapeCsv = (val: string) => `"${String(val).replace(/"/g, '""')}"`;
    const csvLines = [
      header.map(escapeCsv).join(','),
      ...rows.map((r) =>
        [
          r.accountNumber,
          r.name,
          r.status,
          r.totalDebitsFormatted,
          r.totalCreditsFormatted,
          r.outstandingBalanceFormatted,
        ]
          .map(escapeCsv)
          .join(',')
      ),
    ];
    triggerTextFileDownload(
      `BRB-Reconciled-Customer-Balances-${new Date().toISOString().slice(0, 10)}.csv`,
      csvLines.join('\n'),
      'text/csv;charset=utf-8'
    );
  };

  // ---------------------------------------------------------------------------
  // Settings & Branding Handlers
  // ---------------------------------------------------------------------------
  const handleLogoFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await readImageFileAsDataUrl(file, 700);
      setLogoDataUrl(dataUrl);
      setBanner({
        tone: 'info',
        message: 'Official logo staged. Click "Save System Settings" to apply across portals and invoices.',
      });
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Unable to read logo image file.',
      });
    } finally {
      e.target.value = '';
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setBanner(null);
    setSavingSettings(true);
    try {
      const body: Record<string, unknown> = {
        currencySymbol: currencySymbol.trim(),
        timezone: timezone.trim(),
        whatsappContactNumber: whatsappContactNumber.trim(),
        logoDataUrl,
        invoiceBusinessAddress: invoiceBusinessAddress.trim(),
        invoiceBusinessPhone: invoiceBusinessPhone.trim(),
        invoiceAccentColor: invoiceAccentColor.trim(),
        invoiceFooterNote: invoiceFooterNote.trim(),
        otpExpirySeconds: Number(otpExpirySeconds),
        otpMaxAttempts: Number(otpMaxAttempts),
        otpResendCooldownSeconds: Number(otpResendCooldownSeconds),
        smsEnabled,
        smsProviderUrl: smsProviderUrl.trim(),
        smsSenderId: smsSenderId.trim(),
        allowPostedFinancialEdits,
      };
      if (smsProviderApiKeyInput.trim()) {
        body.smsProviderApiKey = smsProviderApiKeyInput.trim();
      }
      if (
        settings &&
        nextCustomerSequenceInput.trim() &&
        Number(nextCustomerSequenceInput) !== settings.sequences.customer_account
      ) {
        body.nextCustomerSequence = Number(nextCustomerSequenceInput);
      }
      if (
        settings &&
        nextInvoiceSequenceInput.trim() &&
        Number(nextInvoiceSequenceInput) !== settings.sequences.invoice_number
      ) {
        body.nextInvoiceSequence = Number(nextInvoiceSequenceInput);
      }

      const updated = await adminApi<AdminSettingsResponse>('/api/admin/settings', {
        method: 'PUT',
        body,
      });
      populateSettingsDraft(updated);
      onSettingsUpdated();
      setBanner({
        tone: 'success',
        message: 'Branding, numbering sequences, and SMS/OTP settings saved.',
      });
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Unable to save settings.',
      });
    } finally {
      setSavingSettings(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Staff RBAC Handlers
  // ---------------------------------------------------------------------------
  const handleStaffRoleSelect = (role: AdminRole) => {
    setStaffRole(role);
    setStaffPermissions(getDefaultPermissionsForRole(role));
  };

  const toggleStaffPermission = (perm: AdminPermission) => {
    if (staffRole === 'main_admin') return;
    setStaffPermissions((prev) =>
      prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm]
    );
  };

  const handleCreateStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    setBanner(null);
    setCreatingStaff(true);
    try {
      await adminApi('/api/admin/staff', {
        method: 'POST',
        body: {
          username: staffUsername.trim(),
          email: staffEmail.trim(),
          displayName: staffDisplayName.trim(),
          mobileNumber: staffMobile.trim() || undefined,
          password: staffPassword,
          role: staffRole,
          permissions: staffPermissions,
          twoFactorEnabled: staffTwoFactor,
        },
      });
      setStaffModalOpen(false);
      setStaffUsername('');
      setStaffEmail('');
      setStaffDisplayName('');
      setStaffMobile('');
      setStaffPassword('');
      setBanner({ tone: 'success', message: 'Staff account created with RBAC permissions.' });
      await loadCurrentSubSection();
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Failed to create staff account.',
      });
    } finally {
      setCreatingStaff(false);
    }
  };

  const handleToggleStaffState = async (
    staff: StaffAccountView,
    patch: { isActive?: boolean; twoFactorEnabled?: boolean }
  ) => {
    setBanner(null);
    try {
      const res = await adminApi<{ staff: StaffAccountView[] }>(`/api/admin/staff/${staff.id}`, {
        method: 'PUT',
        body: patch,
      });
      setStaffList(res.staff);
      setBanner({
        tone: 'success',
        message: `Updated staff account "${staff.displayName}".`,
      });
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Failed to update staff account.',
      });
    }
  };

  // ---------------------------------------------------------------------------
  // Decisions Register Handlers
  // ---------------------------------------------------------------------------
  const handleSaveDecision = async (decisionId: number) => {
    const draft = decisionEdits[decisionId];
    if (!draft) return;
    setSavingDecisionId(decisionId);
    setBanner(null);
    try {
      const res = await adminApi<{ decision: DecisionRegisterItem }>(
        `/api/admin/decisions/${decisionId}`,
        {
          method: 'PUT',
          body: {
            status: draft.status,
            businessConfirmationRequired: draft.notes,
          },
        }
      );
      setDecisions((prev) => prev.map((d) => (d.id === decisionId ? res.decision : d)));
      setBanner({
        tone: 'success',
        message: `Decision ${res.decision.code} status updated and logged to audit trail.`,
      });
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Unable to update decision register item.',
      });
    } finally {
      setSavingDecisionId(null);
    }
  };

  // ---------------------------------------------------------------------------
  // Backup, Verify, Restore & Cloud Vault Handlers
  // ---------------------------------------------------------------------------
  const handleExportSnapshot = async (e: React.FormEvent) => {
    e.preventDefault();
    setBanner(null);
    setExportingBackup(true);
    try {
      const snap = await adminApi<ExportedSnapshotBundle>('/api/admin/backups/export', {
        method: 'POST',
        body: {
          passphrase: exportPassphrase.trim() || undefined,
          notes: exportNotes.trim() || undefined,
        },
      });
      setLatestExportedBundle(snap);
      triggerTextFileDownload(
        `BRB-Backup-${snap.backupUid}.json`,
        snap.bundleJson,
        'application/json'
      );
      setBanner({
        tone: 'success',
        message: `Snapshot ${snap.backupUid} exported (SHA-256 ${snap.sha256Checksum.slice(0, 16)}...).`,
      });
      await loadCurrentSubSection();
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Backup export failed.',
      });
    } finally {
      setExportingBackup(false);
    }
  };

  const handleLoadRestoreFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setRestoreJsonInput(text);
      setDryRunResult(null);
      setBanner({
        tone: 'info',
        message: `Loaded backup file "${file.name}" (${text.length.toLocaleString()} bytes). Run Dry-Run Verify before restoring.`,
      });
    } catch {
      setBanner({ tone: 'error', message: 'Unable to read selected backup JSON file.' });
    } finally {
      e.target.value = '';
    }
  };

  const handleVerifyBackupDryRun = async () => {
    if (!restoreJsonInput.trim()) {
      setBanner({ tone: 'error', message: 'Load or paste a backup JSON bundle first.' });
      return;
    }
    setBanner(null);
    setVerifyingBackup(true);
    try {
      const res = await adminApi<{
        valid: boolean;
        backupUid: string;
        schemaVersion: number;
        sha256Checksum: string;
        recordCountsSummary: string;
      }>('/api/admin/backups/verify', {
        method: 'POST',
        body: {
          bundleJson: restoreJsonInput,
          passphrase: restorePassphrase.trim() || undefined,
        },
      });
      setDryRunResult(res);
      setBanner({
        tone: 'success',
        message: `Dry-run integrity check passed: SHA-256 checksum and schema v${res.schemaVersion} verified.`,
      });
    } catch (err) {
      setDryRunResult(null);
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Backup verification failed.',
      });
    } finally {
      setVerifyingBackup(false);
    }
  };

  const handleExecuteRestore = async () => {
    if (!confirmOverwriteChecked) {
      setBanner({
        tone: 'error',
        message: 'Check the explicit overwrite confirmation box before restoring.',
      });
      return;
    }
    setRestoringBackup(true);
    setBanner(null);
    try {
      const res = await adminApi<{ restoredBackupUid: string; recordCountsSummary: string }>(
        '/api/admin/backups/restore',
        {
          method: 'POST',
          body: {
            bundleJson: restoreJsonInput,
            passphrase: restorePassphrase.trim() || undefined,
            confirmOverwrite: true,
          },
        }
      );
      setConfirmRestoreOpen(false);
      setConfirmOverwriteChecked(false);
      onDataChanged();
      onSettingsUpdated();
      setBanner({
        tone: 'success',
        message: `Database restored from ${res.restoredBackupUid} (${res.recordCountsSummary}) with reconciled customer balances.`,
      });
      await loadCurrentSubSection();
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Database restoration failed.',
      });
    } finally {
      setRestoringBackup(false);
    }
  };

  const handleSignInCloudVault = async () => {
    setCloudBusy(true);
    setBanner(null);
    try {
      await signInFirebaseCloudAdmin();
      const cList = await listCloudBackups();
      setCloudBackups(cList);
      setBanner({
        tone: 'success',
        message: 'Connected to Google Cloud Firestore Backup Vault.',
      });
    } catch (err) {
      setBanner({
        tone: 'error',
        message:
          err instanceof Error ? err.message : 'Google Sign-In for Cloud Backup Vault failed.',
      });
    } finally {
      setCloudBusy(false);
    }
  };

  const handleUploadLatestToCloud = async () => {
    setCloudBusy(true);
    setBanner(null);
    try {
      let snap = latestExportedBundle;
      if (!snap) {
        snap = await adminApi<ExportedSnapshotBundle>('/api/admin/backups/export', {
          method: 'POST',
          body: {
            passphrase: exportPassphrase.trim() || undefined,
            notes: exportNotes.trim() || 'Cloud Vault Sync',
          },
        });
        setLatestExportedBundle(snap);
      }
      const cloudId = await uploadBackupSnapshotToCloud({
        backupUid: snap.backupUid,
        schemaVersion: snap.schemaVersion,
        recordCountsSummary: snap.recordCountsSummary,
        sha256Checksum: snap.sha256Checksum,
        notes: exportNotes.trim() || 'BRB Cloud Vault Snapshot',
        bundleJson: snap.bundleJson,
      });
      const [cList, bkpRes] = await Promise.all([
        listCloudBackups(),
        adminApi<{ backups: BackupHistoryItem[] }>('/api/admin/backups'),
      ]);
      setCloudBackups(cList);
      setBackupHistory(bkpRes.backups);
      setBanner({
        tone: 'success',
        message: `Uploaded snapshot "${cloudId}" to Cloud Firestore Backup Vault.`,
      });
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Cloud backup upload failed.',
      });
    } finally {
      setCloudBusy(false);
    }
  };

  const handlePullCloudBackup = async (backupId: string, downloadFile: boolean) => {
    setCloudBusy(true);
    setBanner(null);
    try {
      const json = await downloadCloudBackupBundle(backupId);
      setRestoreJsonInput(json);
      setDryRunResult(null);
      if (downloadFile) {
        triggerTextFileDownload(`BRB-Cloud-${backupId}.json`, json, 'application/json');
      }
      setBanner({
        tone: 'success',
        message: `Retrieved "${backupId}" from Cloud Firestore Vault and staged in Restore Inspector.`,
      });
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Unable to download cloud backup.',
      });
    } finally {
      setCloudBusy(false);
    }
  };

  const filteredAuditLogs = auditLogs.filter((log) => {
    const q = auditSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      log.action.toLowerCase().includes(q) ||
      log.actorName.toLowerCase().includes(q) ||
      log.entityType.toLowerCase().includes(q) ||
      log.entityId.toLowerCase().includes(q) ||
      (log.reason || '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold text-slate-950">
            Operations, Governance &amp; System Controls
          </h1>
          <p className="text-xs sm:text-sm text-slate-600 mt-0.5">
            Notifications, reconciled balance sheets, branding, staff RBAC, Part 2 Decisions
            Register, audit trail, and verified backups.
          </p>
        </div>

        {/* Sub-navigation segmented buttons */}
        <div
          role="tablist"
          aria-label="Operations sections"
          className="flex items-center gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-slate-100 p-1"
        >
          {SUB_TABS.map((t) => {
            const active = subSection === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onChangeSubSection(t.id)}
                className={`min-h-[36px] rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-white text-slate-950 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {banner && (
        <InlineAlert
          tone={banner.tone}
          message={banner.message}
          onDismiss={() => setBanner(null)}
        />
      )}

      {/* =================================================================== */}
      {/* 1. NOTIFICATIONS & HONEST SMS DELIVERY STATUS                       */}
      {/* =================================================================== */}
      {subSection === 'notifications' && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          <form
            onSubmit={handleSendManualNotification}
            className="xl:col-span-5 rounded-xl border border-slate-200 bg-white p-5 space-y-4"
          >
            <div>
              <h2 className="text-base font-bold text-slate-950">Send Customer Notice</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Delivers immediately to the customer In-App Notification Center and dispatches SMS
                only when a live SMS gateway is configured.
              </p>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-700">Recipients</label>
              <div className="flex items-center gap-2 p-1 bg-slate-100 rounded-lg">
                <button
                  type="button"
                  onClick={() => setNotifTargetMode('all_active')}
                  className={`flex-1 min-h-[36px] rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                    notifTargetMode === 'all_active'
                      ? 'bg-white text-slate-950 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  All Active Customers ({activeCustomers.length})
                </button>
                <button
                  type="button"
                  onClick={() => setNotifTargetMode('selected')}
                  className={`flex-1 min-h-[36px] rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                    notifTargetMode === 'selected'
                      ? 'bg-white text-slate-950 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Select Specific ({selectedRecipientIds.length})
                </button>
              </div>
            </div>

            {notifTargetMode === 'selected' && (
              <div className="max-h-44 overflow-y-auto rounded-lg border border-slate-200 divide-y divide-slate-100">
                {activeCustomers.length === 0 ? (
                  <p className="p-3 text-xs text-slate-500">No active customers available.</p>
                ) : (
                  activeCustomers.map((c) => (
                    <label
                      key={c.id}
                      className="flex items-center justify-between gap-3 px-3 py-2 text-xs hover:bg-slate-50 cursor-pointer"
                    >
                      <span className="truncate font-medium text-slate-800">
                        {c.name} · <span className="font-mono">{c.accountNumber}</span>
                      </span>
                      <input
                        type="checkbox"
                        checked={selectedRecipientIds.includes(c.id)}
                        onChange={() => toggleRecipient(c.id)}
                        className="h-4 w-4 rounded border-slate-300 text-slate-900"
                      />
                    </label>
                  ))
                )}
              </div>
            )}

            <div>
              <label
                htmlFor="notif-title"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Notice Title
              </label>
              <input
                id="notif-title"
                type="text"
                required
                value={notifTitle}
                onChange={(e) => setNotifTitle(e.target.value)}
                placeholder="e.g. Eid Dispatch Schedule Update"
                className="w-full min-h-[40px] rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-hidden"
              />
            </div>

            <div>
              <label
                htmlFor="notif-message"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Message (English or Urdu)
              </label>
              <textarea
                id="notif-message"
                rows={4}
                required
                value={notifMessage}
                onChange={(e) => setNotifMessage(e.target.value)}
                placeholder="Enter official BRB announcement or account notice..."
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-hidden"
              />
            </div>

            <button
              type="submit"
              disabled={sendingNotif}
              className="w-full min-h-[42px] inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              <Send className="h-3.5 w-3.5" aria-hidden="true" />
              {sendingNotif ? 'Dispatching...' : 'Send Official Notification'}
            </button>
          </form>

          <div className="xl:col-span-7 rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-slate-200">
              <div>
                <h2 className="text-base font-bold text-slate-950">
                  Notification &amp; SMS Delivery Log
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Honest channel tracking: App persistence vs. live SMS gateway status.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void loadCurrentSubSection()}
                className="min-h-[36px] inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                Refresh
              </button>
            </div>

            {loading ? (
              <div className="p-6 text-xs text-slate-500">Loading notification log...</div>
            ) : notifications.length === 0 ? (
              <div className="p-6">
                <EmptyStateBox
                  title="No notifications logged yet"
                  description="Automated order, invoice, payment, and registration notices will appear here with channel statuses."
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600">
                      <th className="py-2.5 px-4">Customer</th>
                      <th className="py-2.5 px-4">Event &amp; Message</th>
                      <th className="py-2.5 px-4">App Channel</th>
                      <th className="py-2.5 px-4">SMS Gateway</th>
                      <th className="py-2.5 px-4 text-right">Timestamp</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {notifications.map((n) => (
                      <tr key={n.id} className="hover:bg-slate-50/80 align-top">
                        <td className="py-3 px-4 whitespace-nowrap">
                          <div className="font-semibold text-slate-900">{n.customerName}</div>
                          <div className="font-mono text-[11px] text-slate-500">
                            {n.customerAccountNumber}
                          </div>
                        </td>
                        <td className="py-3 px-4 max-w-md">
                          <div className="font-semibold text-slate-900">
                            {n.title}{' '}
                            <span className="font-normal text-slate-500">· {n.eventType}</span>
                          </div>
                          <p
                            dir={/[\u0600-\u06FF]/.test(n.message) ? 'rtl' : undefined}
                            className={`mt-1 text-slate-700 ${
                              /[\u0600-\u06FF]/.test(n.message)
                                ? 'font-urdu text-sm leading-relaxed text-right'
                                : 'leading-relaxed'
                            }`}
                          >
                            {n.message}
                          </p>
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap text-slate-700">
                          {n.appDeliveryStatus === 'read' ? 'Read in App' : 'Persisted in App'}
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <span
                            className={
                              n.smsDeliveryStatus === 'delivered' ||
                              n.smsDeliveryStatus === 'submitted'
                                ? 'text-emerald-700 font-semibold'
                                : n.smsDeliveryStatus === 'failed'
                                  ? 'text-rose-700 font-semibold'
                                  : 'text-slate-500'
                            }
                          >
                            {n.smsDeliveryStatus === 'not_configured'
                              ? 'SMS Not Configured'
                              : n.smsDeliveryStatus}
                          </span>
                          {n.smsErrorDetail && (
                            <div className="text-[11px] text-rose-600 max-w-[180px] truncate">
                              {n.smsErrorDetail}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-[11px] text-slate-500 whitespace-nowrap">
                          {n.createdAt.slice(0, 16).replace('T', ' ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* 2. RECONCILED FINANCIAL & OPERATIONAL REPORTS                       */}
      {/* =================================================================== */}
      {subSection === 'reports' && (
        <div className="space-y-6">
          <div className="rounded-xl border border-slate-200 bg-white p-5 flex flex-wrap items-end justify-between gap-4">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label
                  htmlFor="rep-from"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Invoices/Payments From
                </label>
                <input
                  id="rep-from"
                  type="date"
                  value={reportFromDate}
                  onChange={(e) => setReportFromDate(e.target.value)}
                  className="min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="rep-to" className="block text-xs font-semibold text-slate-700 mb-1">
                  To Date
                </label>
                <input
                  id="rep-to"
                  type="date"
                  value={reportToDate}
                  onChange={(e) => setReportToDate(e.target.value)}
                  className="min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono text-slate-900"
                />
              </div>
              {(reportFromDate || reportToDate) && (
                <button
                  type="button"
                  onClick={() => {
                    setReportFromDate('');
                    setReportToDate('');
                  }}
                  className="min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                >
                  Reset Dates
                </button>
              )}
            </div>

            <div className="flex items-center gap-3">
              <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showOutstandingOnly}
                  onChange={(e) => setShowOutstandingOnly(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-slate-900"
                />
                Non-Zero Balances Only
              </label>
              <button
                type="button"
                disabled={!reports}
                onClick={handleExportCustomerBalancesCsv}
                className="min-h-[38px] inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden="true" />
                Export Balances CSV
              </button>
            </div>
          </div>

          {reports && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="rounded-xl border border-slate-200 bg-white p-5">
                  <p className="text-xs font-medium text-slate-500">
                    Invoiced Total ({reports.invoiceSummary.count} invoices)
                  </p>
                  <p className="mt-1.5 text-2xl font-extrabold font-mono tabular-nums text-slate-950">
                    {reports.invoiceSummary.totalFormatted}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-5">
                  <p className="text-xs font-medium text-slate-500">
                    Payments Received ({reports.paymentSummary.count} receipts)
                  </p>
                  <p className="mt-1.5 text-2xl font-extrabold font-mono tabular-nums text-emerald-700">
                    {reports.paymentSummary.totalFormatted}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-5">
                  <p className="text-xs font-medium text-slate-500">
                    Orders Across Lifecycle ({reports.orderStatusBreakdown.reduce((s, o) => s + o.count, 0)})
                  </p>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-700">
                    {reports.orderStatusBreakdown.length === 0 ? (
                      <span className="text-slate-400">No orders yet</span>
                    ) : (
                      reports.orderStatusBreakdown.map((o, idx) => (
                        <span key={o.status} className="whitespace-nowrap">
                          {idx > 0 && <span className="mr-2 text-slate-300">·</span>}
                          {o.status}:{' '}
                          <strong className="font-mono tabular-nums">{o.count}</strong>
                        </span>
                      ))
                    )}
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200">
                  <h2 className="text-base font-bold text-slate-950">
                    Reconciled Customer Receivable Statement
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Every customer’s outstanding balance is reconciled directly against cumulative
                    ledger debits minus credits.
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600">
                        <th className="py-2.5 px-4">Account Number</th>
                        <th className="py-2.5 px-4">Customer Name</th>
                        <th className="py-2.5 px-4">Status</th>
                        <th className="py-2.5 px-4 text-right">Total Debits</th>
                        <th className="py-2.5 px-4 text-right">Total Credits</th>
                        <th className="py-2.5 px-4 text-right">Net Outstanding</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {(showOutstandingOnly
                        ? reports.outstandingOnly
                        : reports.customerBalances
                      ).map((row) => (
                        <tr key={row.customerId} className="hover:bg-slate-50/80">
                          <td className="py-2.5 px-4 font-mono font-semibold text-slate-900 whitespace-nowrap">
                            {row.accountNumber}
                          </td>
                          <td className="py-2.5 px-4 font-medium text-slate-900">{row.name}</td>
                          <td className="py-2.5 px-4 text-slate-600 whitespace-nowrap">
                            {row.status}
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-800 whitespace-nowrap">
                            {row.totalDebitsFormatted}
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono tabular-nums text-emerald-700 whitespace-nowrap">
                            {row.totalCreditsFormatted}
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono tabular-nums font-bold text-slate-950 whitespace-nowrap">
                            {row.outstandingBalanceFormatted}
                          </td>
                        </tr>
                      ))}
                      {(showOutstandingOnly
                        ? reports.outstandingOnly
                        : reports.customerBalances
                      ).length === 0 && (
                        <tr>
                          <td colSpan={6} className="py-8 text-center text-xs text-slate-500">
                            No matching customer balance records.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* =================================================================== */}
      {/* 3. SETTINGS, BRANDING, SEQUENCES & WRITE-ONLY SMS GATEWAY           */}
      {/* =================================================================== */}
      {subSection === 'settings' && (
        <form onSubmit={handleSaveSettings} className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Official Branding & Logo Card */}
            <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
              <div>
                <h2 className="text-base font-bold text-slate-950">
                  Official BRB Logo &amp; Invoice Branding
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Upload the official BRB logo PNG/JPEG to replace the Temporary Logo Placeholder
                  across Customer Login, Dashboards, and Page-1 PDF Invoices.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
                <BrbLogo logoDataUrl={logoDataUrl} size="lg" />
                <div className="flex flex-wrap items-center gap-2">
                  <label className="min-h-[38px] inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 cursor-pointer whitespace-nowrap">
                    <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                    {logoDataUrl ? 'Replace Official Logo' : 'Upload Official Logo'}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={handleLogoFileChange}
                      className="sr-only"
                    />
                  </label>
                  {logoDataUrl && (
                    <button
                      type="button"
                      onClick={() => setLogoDataUrl(null)}
                      className="min-h-[38px] rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-rose-700 hover:bg-rose-50 whitespace-nowrap"
                    >
                      Remove Logo
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="set-whatsapp"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    Registration WhatsApp Number
                  </label>
                  <input
                    id="set-whatsapp"
                    type="text"
                    value={whatsappContactNumber}
                    onChange={(e) => setWhatsappContactNumber(e.target.value)}
                    placeholder="e.g. +923001234567"
                    className="w-full min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono text-slate-900"
                  />
                </div>
                <div>
                  <label
                    htmlFor="set-inv-phone"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    Invoice Business Phone
                  </label>
                  <input
                    id="set-inv-phone"
                    type="text"
                    value={invoiceBusinessPhone}
                    onChange={(e) => setInvoiceBusinessPhone(e.target.value)}
                    placeholder="Official mill office phone"
                    className="w-full min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="set-inv-addr"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Invoice Business Address
                </label>
                <input
                  id="set-inv-addr"
                  type="text"
                  value={invoiceBusinessAddress}
                  onChange={(e) => setInvoiceBusinessAddress(e.target.value)}
                  placeholder="Official mill location printed under BRB Cattle Feed & Oil Mills"
                  className="w-full min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label
                    htmlFor="set-accent"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    Invoice Top Line Hex
                  </label>
                  <input
                    id="set-accent"
                    type="text"
                    value={invoiceAccentColor}
                    onChange={(e) => setInvoiceAccentColor(e.target.value)}
                    className="w-full min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono text-slate-900"
                  />
                </div>
                <div>
                  <label
                    htmlFor="set-currency"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    Currency Symbol
                  </label>
                  <input
                    id="set-currency"
                    type="text"
                    value={currencySymbol}
                    onChange={(e) => setCurrencySymbol(e.target.value)}
                    className="w-full min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono text-slate-900"
                  />
                </div>
                <div>
                  <label
                    htmlFor="set-tz"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    Business Timezone
                  </label>
                  <input
                    id="set-tz"
                    type="text"
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                    className="w-full min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono text-slate-900"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="set-footer"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Invoice Footer Note
                </label>
                <input
                  id="set-footer"
                  type="text"
                  value={invoiceFooterNote}
                  onChange={(e) => setInvoiceFooterNote(e.target.value)}
                  className="w-full min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900"
                />
              </div>
            </div>

            {/* Sequences, Accounting Governance & Write-Only SMS Gateway */}
            <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
              <div>
                <h2 className="text-base font-bold text-slate-950">
                  Sequences, Accounting Controls &amp; SMS Gateway
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Secret SMS API keys are write-only and never sent back to browser clients.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="seq-cust"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    Next Customer ID Sequence (BRB-C-ID#)
                  </label>
                  <input
                    id="seq-cust"
                    type="number"
                    min={131}
                    value={nextCustomerSequenceInput}
                    onChange={(e) => setNextCustomerSequenceInput(e.target.value)}
                    className="w-full min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono tabular-nums text-slate-900"
                  />
                </div>
                <div>
                  <label
                    htmlFor="seq-inv"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    Next Sequential Invoice Number
                  </label>
                  <input
                    id="seq-inv"
                    type="number"
                    min={1}
                    value={nextInvoiceSequenceInput}
                    onChange={(e) => setNextInvoiceSequenceInput(e.target.value)}
                    className="w-full min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono tabular-nums text-slate-900"
                  />
                </div>
              </div>

              <label className="flex items-start gap-2.5 rounded-lg border border-slate-200 bg-slate-50 p-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowPostedFinancialEdits}
                  onChange={(e) => setAllowPostedFinancialEdits(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-slate-900"
                />
                <span className="text-xs text-slate-700 leading-relaxed">
                  <strong className="text-slate-900">
                    Allow Authorized Edits to Posted Invoices &amp; Payments:
                  </strong>{' '}
                  Requires <code className="font-mono">edit_financial_records</code> permission, a
                  mandatory reason, immutable revision snapshots, and full ledger recalculation.
                </span>
              </label>

              <div className="pt-2 border-t border-slate-200 space-y-3">
                <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-900 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={smsEnabled}
                    onChange={(e) => setSmsEnabled(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-slate-900"
                  />
                  Enable Live External SMS Gateway Dispatch
                </label>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="sms-url"
                      className="block text-xs font-semibold text-slate-700 mb-1"
                    >
                      SMS Provider HTTPS Endpoint
                    </label>
                    <input
                      id="sms-url"
                      type="url"
                      value={smsProviderUrl}
                      onChange={(e) => setSmsProviderUrl(e.target.value)}
                      placeholder="https://api.sms-gateway.example/send"
                      className="w-full min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono text-slate-900"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="sms-sender"
                      className="block text-xs font-semibold text-slate-700 mb-1"
                    >
                      Approved Sender ID / Mask
                    </label>
                    <input
                      id="sms-sender"
                      type="text"
                      value={smsSenderId}
                      onChange={(e) => setSmsSenderId(e.target.value)}
                      className="w-full min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono text-slate-900"
                    />
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="sms-key"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    SMS Provider API Key (Write-Only{' '}
                    {settings?.smsApiKeyConfigured ? '· Currently Configured' : '· Not Set'})
                  </label>
                  <input
                    id="sms-key"
                    type="password"
                    autoComplete="new-password"
                    value={smsProviderApiKeyInput}
                    onChange={(e) => setSmsProviderApiKeyInput(e.target.value)}
                    placeholder={
                      settings?.smsApiKeyConfigured
                        ? 'Leave blank to keep existing secret key'
                        : 'Enter provider secret key'
                    }
                    className="w-full min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono text-slate-900"
                  />
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label
                      htmlFor="otp-exp"
                      className="block text-[11px] font-semibold text-slate-700 mb-1"
                    >
                      OTP Expiry (sec)
                    </label>
                    <input
                      id="otp-exp"
                      type="number"
                      min={60}
                      max={1800}
                      value={otpExpirySeconds}
                      onChange={(e) => setOtpExpirySeconds(Number(e.target.value))}
                      className="w-full min-h-[36px] rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-mono tabular-nums"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="otp-att"
                      className="block text-[11px] font-semibold text-slate-700 mb-1"
                    >
                      Max Attempts
                    </label>
                    <input
                      id="otp-att"
                      type="number"
                      min={3}
                      max={10}
                      value={otpMaxAttempts}
                      onChange={(e) => setOtpMaxAttempts(Number(e.target.value))}
                      className="w-full min-h-[36px] rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-mono tabular-nums"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="otp-cool"
                      className="block text-[11px] font-semibold text-slate-700 mb-1"
                    >
                      Resend Cooldown (s)
                    </label>
                    <input
                      id="otp-cool"
                      type="number"
                      min={15}
                      max={600}
                      value={otpResendCooldownSeconds}
                      onChange={(e) => setOtpResendCooldownSeconds(Number(e.target.value))}
                      className="w-full min-h-[36px] rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-mono tabular-nums"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={savingSettings}
              className="min-h-[42px] inline-flex items-center gap-2 rounded-lg bg-slate-900 px-5 py-2.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              {savingSettings ? 'Saving System Settings...' : 'Save System Settings'}
            </button>
          </div>
        </form>
      )}

      {/* =================================================================== */}
      {/* 4. STAFF ACCOUNTS & LEAST-PRIVILEGE RBAC                            */}
      {/* =================================================================== */}
      {subSection === 'staff' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-bold text-slate-950">
                Administrative Staff &amp; Role-Based Access Control
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Logged in as <strong className="text-slate-800">{admin.displayName}</strong> (
                {admin.role}). Permissions are strictly enforced on every backend route.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setStaffModalOpen(true)}
              className="min-h-[40px] inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add Staff Account
            </button>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600">
                    <th className="py-2.5 px-4">Name &amp; Username</th>
                    <th className="py-2.5 px-4">Email &amp; Mobile</th>
                    <th className="py-2.5 px-4">Role</th>
                    <th className="py-2.5 px-4">2FA</th>
                    <th className="py-2.5 px-4">Status</th>
                    <th className="py-2.5 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {staffList.map((st) => (
                    <tr key={st.id} className="hover:bg-slate-50/80">
                      <td className="py-3 px-4 whitespace-nowrap">
                        <div className="font-semibold text-slate-900">{st.displayName}</div>
                        <div className="font-mono text-[11px] text-slate-500">@{st.username}</div>
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <div className="text-slate-800">{st.email}</div>
                        <div className="font-mono text-[11px] text-slate-500">
                          {st.mobileNumber || 'No mobile'}
                        </div>
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <div className="font-mono font-semibold text-slate-900">{st.role}</div>
                        <div className="text-[11px] text-slate-500">
                          {st.role === 'main_admin'
                            ? 'All 14 permissions'
                            : `${st.permissions.length} permission(s)`}
                        </div>
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap text-slate-700">
                        {st.twoFactorEnabled ? 'Enabled' : 'Off'}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span
                          className={
                            st.isActive
                              ? 'text-emerald-700 font-semibold'
                              : 'text-rose-700 font-semibold'
                          }
                        >
                          {st.isActive ? 'Active' : 'Disabled'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap space-x-2">
                        <button
                          type="button"
                          onClick={() =>
                            void handleToggleStaffState(st, {
                              twoFactorEnabled: !st.twoFactorEnabled,
                            })
                          }
                          className="min-h-[34px] rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                        >
                          {st.twoFactorEnabled ? 'Disable 2FA' : 'Enable 2FA'}
                        </button>
                        {st.id !== admin.id && (
                          <button
                            type="button"
                            onClick={() =>
                              void handleToggleStaffState(st, { isActive: !st.isActive })
                            }
                            className="min-h-[34px] rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                          >
                            {st.isActive ? 'Deactivate' : 'Activate'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {staffList.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-xs text-slate-500">
                        No staff accounts loaded.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {staffModalOpen && (
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="create-staff-title"
              className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 backdrop-blur-xs p-4"
            >
              <form
                onSubmit={handleCreateStaff}
                className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-xl space-y-4"
              >
                <h3 id="create-staff-title" className="text-lg font-bold text-slate-950">
                  Create Staff Account (Least-Privilege RBAC)
                </h3>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="st-name"
                      className="block text-xs font-semibold text-slate-700 mb-1"
                    >
                      Display Name
                    </label>
                    <input
                      id="st-name"
                      type="text"
                      required
                      value={staffDisplayName}
                      onChange={(e) => setStaffDisplayName(e.target.value)}
                      className="w-full min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="st-user"
                      className="block text-xs font-semibold text-slate-700 mb-1"
                    >
                      Username
                    </label>
                    <input
                      id="st-user"
                      type="text"
                      required
                      value={staffUsername}
                      onChange={(e) => setStaffUsername(e.target.value)}
                      className="w-full min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="st-email"
                      className="block text-xs font-semibold text-slate-700 mb-1"
                    >
                      Email Address
                    </label>
                    <input
                      id="st-email"
                      type="email"
                      required
                      value={staffEmail}
                      onChange={(e) => setStaffEmail(e.target.value)}
                      className="w-full min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="st-mobile"
                      className="block text-xs font-semibold text-slate-700 mb-1"
                    >
                      Mobile Number (for OTP)
                    </label>
                    <input
                      id="st-mobile"
                      type="text"
                      value={staffMobile}
                      onChange={(e) => setStaffMobile(e.target.value)}
                      placeholder="03001234567"
                      className="w-full min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="st-role"
                      className="block text-xs font-semibold text-slate-700 mb-1"
                    >
                      Staff Role
                    </label>
                    <select
                      id="st-role"
                      value={staffRole}
                      onChange={(e) => handleStaffRoleSelect(e.target.value as AdminRole)}
                      className="w-full min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                    >
                      {ADMIN_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label
                      htmlFor="st-pass"
                      className="block text-xs font-semibold text-slate-700 mb-1"
                    >
                      Initial Password (min 8 chars)
                    </label>
                    <input
                      id="st-pass"
                      type="password"
                      required
                      minLength={8}
                      value={staffPassword}
                      onChange={(e) => setStaffPassword(e.target.value)}
                      className="w-full min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                    />
                  </div>
                </div>

                <div>
                  <span className="block text-xs font-semibold text-slate-700 mb-1.5">
                    Explicit Backend Permissions
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 max-h-44 overflow-y-auto">
                    {ADMIN_PERMISSIONS.map((perm) => (
                      <label
                        key={perm}
                        className="inline-flex items-center gap-2 text-xs text-slate-800 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          disabled={staffRole === 'main_admin'}
                          checked={
                            staffRole === 'main_admin' || staffPermissions.includes(perm)
                          }
                          onChange={() => toggleStaffPermission(perm)}
                          className="h-3.5 w-3.5 rounded border-slate-300 text-slate-900"
                        />
                        <span className="font-mono text-[11px]">{perm}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={staffTwoFactor}
                    onChange={(e) => setStaffTwoFactor(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-slate-900"
                  />
                  Require Two-Step OTP Verification on Login
                </label>

                <div className="flex items-center justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setStaffModalOpen(false)}
                    className="min-h-[40px] rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={creatingStaff}
                    className="min-h-[40px] rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                  >
                    {creatingStaff ? 'Creating...' : 'Create Staff Account'}
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      )}

      {/* =================================================================== */}
      {/* 5. PART 2 UNRESOLVED DECISIONS REGISTER (DEC-5.1 .. DEC-5.8)        */}
      {/* =================================================================== */}
      {subSection === 'decisions' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-base font-bold text-slate-950">
              Part 2 — Unresolved Business &amp; Operational Decisions Register
            </h2>
            <p className="text-xs text-slate-600 mt-1 leading-relaxed">
              Tracks every open business confirmation item from Sections 5.1–5.8 without silently
              inventing policies. Update statuses as BRB management confirms operational parameters.
            </p>
          </div>

          <div className="space-y-4">
            {decisions.map((d) => {
              const edit = decisionEdits[d.id] || {
                status: d.status,
                notes: d.businessConfirmationRequired,
              };
              return (
                <div
                  key={d.id}
                  className="rounded-xl border border-slate-200 bg-white p-5 space-y-3"
                >
                  <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2">
                    <div>
                      <span className="font-mono text-xs font-bold text-slate-900">{d.code}</span>
                      <span className="mx-2 text-slate-300">·</span>
                      <span className="text-xs text-slate-500">Section {d.sectionRef}</span>
                      <h3 className="text-sm font-bold text-slate-950 mt-0.5">{d.title}</h3>
                    </div>
                    <span className="text-xs text-slate-500 whitespace-nowrap">
                      Last updated {d.updatedAt.slice(0, 10)}
                      {d.updatedByAdminName ? ` by ${d.updatedByAdminName}` : ''}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-slate-700 leading-relaxed">
                    <div>
                      <p className="font-semibold text-slate-900 mb-0.5">Context Summary</p>
                      <p>{d.summary}</p>
                    </div>
                    <div>
                      <p className="font-semibold text-slate-900 mb-0.5">
                        Safe Technical Implementation
                      </p>
                      <p>{d.proposedRecommendation}</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-12 gap-3 pt-2 border-t border-slate-100 items-end">
                    <div className="md:col-span-4">
                      <label
                        htmlFor={`dec-status-${d.id}`}
                        className="block text-[11px] font-semibold text-slate-700 mb-1"
                      >
                        Governance Status
                      </label>
                      <select
                        id={`dec-status-${d.id}`}
                        value={edit.status}
                        onChange={(e) =>
                          setDecisionEdits((prev) => ({
                            ...prev,
                            [d.id]: {
                              ...edit,
                              status: e.target.value as DecisionRegisterStatus,
                            },
                          }))
                        }
                        className="w-full min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-900"
                      >
                        {DECISION_REGISTER_STATUSES.map((st) => (
                          <option key={st} value={st}>
                            {st}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="md:col-span-6">
                      <label
                        htmlFor={`dec-notes-${d.id}`}
                        className="block text-[11px] font-semibold text-slate-700 mb-1"
                      >
                        Business Confirmation Required / Resolution Notes
                      </label>
                      <input
                        id={`dec-notes-${d.id}`}
                        type="text"
                        value={edit.notes}
                        onChange={(e) =>
                          setDecisionEdits((prev) => ({
                            ...prev,
                            [d.id]: {
                              ...edit,
                              notes: e.target.value,
                            },
                          }))
                        }
                        className="w-full min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-900"
                      />
                    </div>
                    <div className="md:col-span-2 flex justify-end">
                      <button
                        type="button"
                        disabled={savingDecisionId === d.id}
                        onClick={() => void handleSaveDecision(d.id)}
                        className="w-full min-h-[38px] rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                      >
                        {savingDecisionId === d.id ? 'Saving...' : 'Update Status'}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* 6. IMMUTABLE SECURITY & FINANCIAL AUDIT LOG                         */}
      {/* =================================================================== */}
      {subSection === 'audit' && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-5 py-4 border-b border-slate-200">
            <div>
              <h2 className="text-base font-bold text-slate-950">
                Security, Auth &amp; Financial Audit Trail
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Immutable trace of logins, approvals, account blocks, order reductions, financial
                revisions, and backups (secrets redacted).
              </p>
            </div>
            <div className="relative w-full sm:w-72">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400"
                aria-hidden="true"
              />
              <input
                type="search"
                aria-label="Search audit trail"
                value={auditSearch}
                onChange={(e) => setAuditSearch(e.target.value)}
                placeholder="Search action, actor, entity..."
                className="w-full min-h-[38px] rounded-lg border border-slate-300 pl-9 pr-3 py-1.5 text-xs text-slate-900"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600">
                  <th className="py-2.5 px-4">ID</th>
                  <th className="py-2.5 px-4">Actor</th>
                  <th className="py-2.5 px-4">Action</th>
                  <th className="py-2.5 px-4">Entity</th>
                  <th className="py-2.5 px-4">Reason / Detail</th>
                  <th className="py-2.5 px-4 text-right">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {filteredAuditLogs.map((log) => {
                  const expanded = expandedAuditId === log.id;
                  return (
                    <React.Fragment key={log.id}>
                      <tr className="hover:bg-slate-50/80">
                        <td className="py-2.5 px-4 font-mono tabular-nums text-slate-500">
                          #{log.id}
                        </td>
                        <td className="py-2.5 px-4 whitespace-nowrap">
                          <span className="font-medium text-slate-900">{log.actorName}</span>{' '}
                          <span className="text-slate-400">· {log.actorType}</span>
                        </td>
                        <td className="py-2.5 px-4 font-mono text-[11px] font-semibold text-slate-900 whitespace-nowrap">
                          {log.action}
                        </td>
                        <td className="py-2.5 px-4 font-mono text-[11px] text-slate-600 whitespace-nowrap">
                          {log.entityType}:{log.entityId}
                        </td>
                        <td className="py-2.5 px-4">
                          <div className="flex items-center gap-2">
                            <span className="text-slate-700 truncate max-w-xs">
                              {log.reason || '—'}
                            </span>
                            {(log.beforeJson || log.afterJson) && (
                              <button
                                type="button"
                                onClick={() => setExpandedAuditId(expanded ? null : log.id)}
                                className="text-[11px] font-semibold text-slate-900 underline hover:no-underline whitespace-nowrap shrink-0"
                              >
                                {expanded ? 'Hide Snapshot' : 'Inspect Diff'}
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums text-[11px] text-slate-500 whitespace-nowrap">
                          {log.createdAt.slice(0, 19).replace('T', ' ')}
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="bg-slate-50">
                          <td colSpan={6} className="p-4">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px] font-mono">
                              <div>
                                <p className="font-sans font-semibold text-slate-700 mb-1">
                                  Before State
                                </p>
                                <pre className="rounded-lg border border-slate-200 bg-white p-2.5 overflow-x-auto text-slate-700">
                                  {log.beforeJson || 'null'}
                                </pre>
                              </div>
                              <div>
                                <p className="font-sans font-semibold text-slate-700 mb-1">
                                  After State
                                </p>
                                <pre className="rounded-lg border border-slate-200 bg-white p-2.5 overflow-x-auto text-slate-700">
                                  {log.afterJson || 'null'}
                                </pre>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
                {filteredAuditLogs.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-xs text-slate-500">
                      No matching audit log events.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* 7. INTEGRITY-VERIFIED BACKUP, RESTORE & CLOUD FIRESTORE VAULT       */}
      {/* =================================================================== */}
      {subSection === 'backups' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Export Snapshot Card */}
            <form
              onSubmit={handleExportSnapshot}
              className="rounded-xl border border-slate-200 bg-white p-5 space-y-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold text-slate-950">
                    1. Export Integrity-Verified Snapshot
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Generates a full 18-table relational snapshot signed with SHA-256 and optional
                    AES-256-GCM encryption.
                  </p>
                </div>
                <DatabaseBackup className="h-5 w-5 text-slate-500 shrink-0" aria-hidden="true" />
              </div>

              <div>
                <label
                  htmlFor="bkp-pass"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Optional AES-256-GCM Encryption Passphrase
                </label>
                <input
                  id="bkp-pass"
                  type="password"
                  autoComplete="new-password"
                  value={exportPassphrase}
                  onChange={(e) => setExportPassphrase(e.target.value)}
                  placeholder="Leave blank for unencrypted SHA-256 signed JSON"
                  className="w-full min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                />
              </div>

              <div>
                <label
                  htmlFor="bkp-notes"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Snapshot Notes
                </label>
                <input
                  id="bkp-notes"
                  type="text"
                  value={exportNotes}
                  onChange={(e) => setExportNotes(e.target.value)}
                  placeholder="e.g. Month-end closing snapshot"
                  className="w-full min-h-[38px] rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                />
              </div>

              <button
                type="submit"
                disabled={exportingBackup}
                className="w-full min-h-[42px] inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                {exportingBackup ? 'Generating Snapshot...' : 'Export & Download Backup JSON'}
              </button>
            </form>

            {/* Dry-Run Verify & Atomic Restore Card */}
            <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold text-slate-950">
                    2. Dry-Run Verify &amp; Atomic Restore
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Verifies SHA-256 checksum, schema compatibility, foreign keys, and reconciles
                    all customer balances atomically.
                  </p>
                </div>
                <ShieldCheck className="h-5 w-5 text-slate-500 shrink-0" aria-hidden="true" />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label className="min-h-[38px] inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer whitespace-nowrap">
                  <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                  Load Backup JSON File
                  <input
                    type="file"
                    accept="application/json,.json"
                    onChange={handleLoadRestoreFile}
                    className="sr-only"
                  />
                </label>
                {latestExportedBundle && (
                  <button
                    type="button"
                    onClick={() => {
                      setRestoreJsonInput(latestExportedBundle.bundleJson);
                      setDryRunResult(null);
                    }}
                    className="min-h-[38px] rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                  >
                    Stage Latest Export ({latestExportedBundle.backupUid.slice(0, 14)})
                  </button>
                )}
              </div>

              <div>
                <label
                  htmlFor="res-pass"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Decryption Passphrase (if encrypted)
                </label>
                <div className="relative">
                  <KeyRound
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400"
                    aria-hidden="true"
                  />
                  <input
                    id="res-pass"
                    type="password"
                    autoComplete="new-password"
                    value={restorePassphrase}
                    onChange={(e) => setRestorePassphrase(e.target.value)}
                    placeholder="Enter passphrase if snapshot is encrypted"
                    className="w-full min-h-[38px] rounded-lg border border-slate-300 pl-9 pr-3 py-1.5 text-xs"
                  />
                </div>
              </div>

              {dryRunResult && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-950 space-y-1">
                  <p className="font-bold">
                    Dry-Run Passed · Schema v{dryRunResult.schemaVersion} ·{' '}
                    <span className="font-mono">{dryRunResult.backupUid}</span>
                  </p>
                  <p>{dryRunResult.recordCountsSummary}</p>
                  <p className="font-mono text-[11px] truncate">
                    SHA-256: {dryRunResult.sha256Checksum}
                  </p>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2.5 pt-1">
                <button
                  type="button"
                  disabled={verifyingBackup || !restoreJsonInput.trim()}
                  onClick={() => void handleVerifyBackupDryRun()}
                  className="flex-1 min-h-[40px] rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-900 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
                >
                  {verifyingBackup ? 'Verifying...' : 'Dry-Run Verify Integrity'}
                </button>
                <button
                  type="button"
                  disabled={!restoreJsonInput.trim()}
                  onClick={() => {
                    setConfirmOverwriteChecked(false);
                    setConfirmRestoreOpen(true);
                  }}
                  className="flex-1 min-h-[40px] rounded-lg bg-rose-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50 whitespace-nowrap"
                >
                  Restore &amp; Overwrite DB
                </button>
              </div>
            </div>
          </div>

          {/* Cloud Firestore Off-Host Backup Vault */}
          <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-slate-950">
                  3. Google Cloud Firestore Off-Host Backup Vault
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Project <span className="font-mono">{FIREBASE_PROJECT_ID}</span> · Database{' '}
                  <span className="font-mono">{FIRESTORE_DATABASE_ID}</span>
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {!cloudUser ? (
                  <button
                    type="button"
                    disabled={cloudBusy}
                    onClick={() => void handleSignInCloudVault()}
                    className="min-h-[38px] inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                  >
                    <Cloud className="h-3.5 w-3.5" aria-hidden="true" />
                    Sign In with Admin Google Account
                  </button>
                ) : (
                  <>
                    <span className="text-xs text-slate-600">
                      Signed in as <strong className="text-slate-900">{cloudUser.email}</strong>
                    </span>
                    <button
                      type="button"
                      disabled={cloudBusy}
                      onClick={() => void handleUploadLatestToCloud()}
                      className="min-h-[38px] inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                    >
                      <CloudUpload className="h-3.5 w-3.5" aria-hidden="true" />
                      {cloudBusy ? 'Syncing...' : 'Sync Snapshot to Cloud Vault'}
                    </button>
                    <button
                      type="button"
                      disabled={cloudBusy}
                      onClick={() => void signOutFirebaseCloudAdmin()}
                      className="min-h-[38px] rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                    >
                      Sign Out Cloud
                    </button>
                  </>
                )}
              </div>
            </div>

            {cloudUser && cloudBackups.length > 0 && (
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600">
                      <th className="py-2 px-3">Cloud Backup ID</th>
                      <th className="py-2 px-3">Summary</th>
                      <th className="py-2 px-3">Chunks</th>
                      <th className="py-2 px-3">SHA-256</th>
                      <th className="py-2 px-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {cloudBackups.map((cb) => (
                      <tr key={cb.backupId} className="hover:bg-slate-50">
                        <td className="py-2.5 px-3 font-mono font-semibold text-slate-900 whitespace-nowrap">
                          {cb.backupId}
                        </td>
                        <td className="py-2.5 px-3 text-slate-700">{cb.recordCountsSummary}</td>
                        <td className="py-2.5 px-3 font-mono tabular-nums text-slate-600">
                          {cb.payloadChunkCount}
                        </td>
                        <td className="py-2.5 px-3 font-mono text-[11px] text-slate-500">
                          {cb.sha256Checksum.slice(0, 14)}...
                        </td>
                        <td className="py-2.5 px-3 text-right whitespace-nowrap space-x-2">
                          <button
                            type="button"
                            disabled={cloudBusy}
                            onClick={() => void handlePullCloudBackup(cb.backupId, false)}
                            className="min-h-[32px] inline-flex items-center gap-1 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap"
                          >
                            <CloudDownload className="h-3.5 w-3.5" aria-hidden="true" />
                            Stage Restore
                          </button>
                          <button
                            type="button"
                            disabled={cloudBusy}
                            onClick={() => void handlePullCloudBackup(cb.backupId, true)}
                            className="min-h-[32px] rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                          >
                            Download JSON
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Local Backup Export History */}
          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200">
              <h2 className="text-base font-bold text-slate-950">Snapshot Export History</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600">
                    <th className="py-2.5 px-4">Snapshot UID</th>
                    <th className="py-2.5 px-4">Record Counts</th>
                    <th className="py-2.5 px-4">Protection</th>
                    <th className="py-2.5 px-4">SHA-256 Checksum</th>
                    <th className="py-2.5 px-4">Created By</th>
                    <th className="py-2.5 px-4 text-right">Created At</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {backupHistory.map((b) => (
                    <tr key={b.id} className="hover:bg-slate-50/80">
                      <td className="py-2.5 px-4 font-mono font-semibold text-slate-900 whitespace-nowrap">
                        {b.backupUid}
                      </td>
                      <td className="py-2.5 px-4 text-slate-700">{b.recordCountsSummary}</td>
                      <td className="py-2.5 px-4 whitespace-nowrap text-slate-700">
                        {b.isEncrypted ? 'AES-256-GCM + SHA-256' : 'SHA-256 Signed'}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-[11px] text-slate-500 whitespace-nowrap">
                        {b.sha256Checksum.slice(0, 18)}...
                      </td>
                      <td className="py-2.5 px-4 whitespace-nowrap text-slate-700">
                        {b.createdByAdminName}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-[11px] text-slate-500 whitespace-nowrap">
                        {b.createdAt.slice(0, 16).replace('T', ' ')}
                      </td>
                    </tr>
                  ))}
                  {backupHistory.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-xs text-slate-500">
                        No backup snapshots generated yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <ConfirmDialog
            open={confirmRestoreOpen}
            title="Confirm Full Database Overwrite Restoration"
            description="Restoring a snapshot atomically replaces customers, products, orders, invoices, payments, and ledger records with the verified snapshot state. Export a current backup first if needed."
            confirmLabel="Overwrite & Restore Database"
            destructive
            busy={restoringBackup}
            onConfirm={() => void handleExecuteRestore()}
            onCancel={() => setConfirmRestoreOpen(false)}
          >
            <label className="flex items-start gap-2.5 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-950 cursor-pointer">
              <input
                type="checkbox"
                checked={confirmOverwriteChecked}
                onChange={(e) => setConfirmOverwriteChecked(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-rose-400 text-rose-700"
              />
              <span>
                I confirm that I want to overwrite the live BRB database with this verified backup
                bundle and recalculate all customer balances.
              </span>
            </label>
          </ConfirmDialog>
        </div>
      )}
    </div>
  );
}
