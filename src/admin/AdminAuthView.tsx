import React, { useState } from 'react';
import { ArrowLeft, KeyRound, Lock, ShieldCheck } from 'lucide-react';
import { BRAND_NAMES } from '../shared/types';
import { publicApi } from '../lib/api';
import type { PublicBootstrapInfo } from '../lib/api';
import { BrbLogo, InlineAlert } from '../components/Branding';
import type { AdminAuthenticatedProfile } from './types';

type AdminAuthMode = 'login' | 'two_factor' | 'forgot_request' | 'forgot_reset';

export function AdminAuthView({
  bootstrap,
  onLoginSuccess,
  onBootstrapComplete,
  onSwitchToCustomerPortal,
}: {
  bootstrap: PublicBootstrapInfo;
  onLoginSuccess: (admin: AdminAuthenticatedProfile, token: string) => void;
  onBootstrapComplete: (admin: AdminAuthenticatedProfile, token: string) => void;
  onSwitchToCustomerPortal: () => void;
}) {
  const [mode, setMode] = useState<AdminAuthMode>('login');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  const [devSandboxOtp, setDevSandboxOtp] = useState<string | null>(null);

  // Initial Main Admin Bootstrap Wizard fields (only used when hasAnyAdmin === false)
  const [setupUsername, setSetupUsername] = useState('brb_admin');
  const [setupEmail, setSetupEmail] = useState('muhammadabdullahusmani9670@gmail.com');
  const [setupDisplayName, setSetupDisplayName] = useState('Main Administrator');
  const [setupMobile, setSetupMobile] = useState('');
  const [setupPassword, setSetupPassword] = useState('');
  const [setupCustomerSeq, setSetupCustomerSeq] = useState(131);
  const [setupInvoiceSeq, setSetupInvoiceSeq] = useState(5001);
  const [setupTwoFactor, setSetupTwoFactor] = useState(false);

  // Login & 2FA fields
  const [loginIdentifier, setLoginIdentifier] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [twoFactorChallengeId, setTwoFactorChallengeId] = useState<number | null>(null);
  const [twoFactorMasked, setTwoFactorMasked] = useState('');
  const [twoFactorOtp, setTwoFactorOtp] = useState('');

  // Forgot password fields
  const [resetIdentifier, setResetIdentifier] = useState('');
  const [resetOtp, setResetOtp] = useState('');
  const [resetNewPassword, setResetNewPassword] = useState('');
  const [resetConfirmPassword, setResetConfirmPassword] = useState('');

  const clearMessages = () => {
    setErrorMsg(null);
    setInfoMsg(null);
  };

  const handleBootstrapSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearMessages();
    setBusy(true);
    try {
      const res = await publicApi<{ admin: AdminAuthenticatedProfile; token: string }>(
        '/api/admin/auth/bootstrap',
        {
          method: 'POST',
          body: {
            username: setupUsername.trim(),
            email: setupEmail.trim(),
            displayName: setupDisplayName.trim(),
            mobileNumber: setupMobile.trim() || undefined,
            password: setupPassword,
            startingCustomerSeq: Number(setupCustomerSeq),
            startingInvoiceNumber: Number(setupInvoiceSeq),
            twoFactorEnabled: setupTwoFactor,
          },
        }
      );
      onBootstrapComplete(res.admin, res.token);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Initial administrator setup failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    clearMessages();
    setDevSandboxOtp(null);
    setBusy(true);
    try {
      const res = await publicApi<
        | { requiresTwoFactor: false; admin: AdminAuthenticatedProfile; token: string }
        | {
            requiresTwoFactor: true;
            challengeId: number;
            maskedDestination: string;
            smsStatus: string;
            devSandboxOtp?: string;
          }
      >('/api/admin/auth/login', {
        method: 'POST',
        body: {
          identifier: loginIdentifier.trim(),
          password: loginPassword,
        },
      });

      if (res.requiresTwoFactor) {
        setTwoFactorChallengeId(res.challengeId);
        setTwoFactorMasked(res.maskedDestination);
        setDevSandboxOtp(res.devSandboxOtp || null);
        setMode('two_factor');
      } else {
        onLoginSuccess(res.admin, res.token);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Administrator sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyTwoFactor = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!twoFactorChallengeId) return;
    clearMessages();
    setBusy(true);
    try {
      const res = await publicApi<{ admin: AdminAuthenticatedProfile; token: string }>(
        '/api/admin/auth/verify-2fa',
        {
          method: 'POST',
          body: {
            challengeId: twoFactorChallengeId,
            otp: twoFactorOtp.trim(),
          },
        }
      );
      onLoginSuccess(res.admin, res.token);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Two-step verification failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleForgotRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    clearMessages();
    setDevSandboxOtp(null);
    setBusy(true);
    try {
      const res = await publicApi<{
        acknowledged: true;
        challengeId?: number;
        smsStatus?: string;
        devSandboxOtp?: string;
      }>('/api/admin/auth/forgot-password', {
        method: 'POST',
        body: { identifier: resetIdentifier.trim() },
      });
      setDevSandboxOtp(res.devSandboxOtp || null);
      setMode('forgot_reset');
      setInfoMsg('If an active staff/admin account matches, enter the 6-digit recovery OTP below.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Recovery request failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleForgotComplete = async (e: React.FormEvent) => {
    e.preventDefault();
    clearMessages();
    setBusy(true);
    try {
      await publicApi<{ updated: boolean }>('/api/admin/auth/reset-password', {
        method: 'POST',
        body: {
          identifier: resetIdentifier.trim(),
          otp: resetOtp.trim(),
          newPassword: resetNewPassword,
          confirmPassword: resetConfirmPassword,
        },
      });
      setDevSandboxOtp(null);
      setLoginIdentifier(resetIdentifier);
      setMode('login');
      setInfoMsg('Administrator password updated. Sign in with your new password.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Password recovery failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Bar */}
      <header className="border-b border-slate-800 px-6 py-4 flex items-center justify-between gap-8">
        <span className="text-base sm:text-lg font-extrabold tracking-tight text-white whitespace-nowrap shrink-0">
          {BRAND_NAMES.invoiceHeading} · Administration
        </span>
        <button
          type="button"
          onClick={onSwitchToCustomerPortal}
          className="min-h-[40px] px-3.5 py-1.5 rounded-lg border border-slate-700 text-xs font-semibold text-slate-200 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
        >
          ← Customer Portal
        </button>
      </header>

      <main className="flex-1 mx-auto w-full max-w-6xl px-4 sm:px-6 py-8 lg:py-12 flex items-center">
        <div className="w-full grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-stretch">
          {/* Left 5 Cols: Administrative Console Summary */}
          <section className="lg:col-span-5 rounded-2xl border border-slate-800 bg-slate-900/90 p-6 sm:p-8 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-3.5">
                <BrbLogo logoDataUrl={bootstrap.logoDataUrl} size="md" />
                <div>
                  <h1 className="text-xl font-extrabold text-white tracking-tight">
                    {BRAND_NAMES.invoiceHeading}
                  </h1>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Enterprise Management &amp; Accounting Console
                  </p>
                </div>
              </div>

              <p className="mt-6 text-sm text-slate-300 leading-relaxed tracking-wide">
                Authorized administrative portal for customer account provisioning, registration
                approvals, order quantity verification, sequential invoicing, ledger accounting, and
                reconciled reporting.
              </p>

              <dl className="mt-8 divide-y divide-slate-800 border-t border-b border-slate-800 text-xs">
                <div className="py-3 flex items-center justify-between gap-4">
                  <dt className="text-slate-400">Session Boundary</dt>
                  <dd className="font-semibold text-slate-200">Isolated Staff RBAC</dd>
                </div>
                <div className="py-3 flex items-center justify-between gap-4">
                  <dt className="text-slate-400">Accounting Engine</dt>
                  <dd className="font-mono tabular-nums text-amber-300 font-semibold">
                    ACID Double-Checked Ledger
                  </dd>
                </div>
                <div className="py-3 flex items-center justify-between gap-4">
                  <dt className="text-slate-400">Audit &amp; Backups</dt>
                  <dd className="text-slate-200">SHA-256 + Cloud Firestore Vault</dd>
                </div>
              </dl>
            </div>

            <p className="mt-8 text-xs text-slate-500">
              Customer credentials cannot sign in to this administrative interface.
            </p>
          </section>

          {/* Right 7 Cols: Controlled First-Run Setup OR Separate Admin Login */}
          <section className="lg:col-span-7 rounded-2xl border border-slate-200 bg-white text-slate-900 p-6 sm:p-8 flex flex-col justify-center">
            {errorMsg && (
              <div className="mb-5">
                <InlineAlert tone="error" message={errorMsg} onDismiss={() => setErrorMsg(null)} />
              </div>
            )}
            {infoMsg && (
              <div className="mb-5">
                <InlineAlert tone="info" message={infoMsg} onDismiss={() => setInfoMsg(null)} />
              </div>
            )}
            {devSandboxOtp && (
              <div className="mb-5 rounded-xl border border-amber-300 bg-amber-50 p-3.5 text-xs text-amber-950 flex items-center justify-between gap-3">
                <span>
                  Development Sandbox Admin OTP:{' '}
                  <strong className="font-mono tabular-nums">{devSandboxOtp}</strong>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (mode === 'two_factor') setTwoFactorOtp(devSandboxOtp);
                    if (mode === 'forgot_reset') setResetOtp(devSandboxOtp);
                  }}
                  className="px-2.5 py-1 rounded-md bg-amber-400 text-slate-950 font-semibold whitespace-nowrap shrink-0"
                >
                  Use {devSandboxOtp}
                </button>
              </div>
            )}

            {!bootstrap.hasAnyAdmin ? (
              /* CONTROLLED ONE-TIME INITIAL MAIN ADMINISTRATOR SETUP (Section 42) */
              <div>
                <div className="flex items-center gap-2.5 text-amber-700 text-xs font-bold mb-1">
                  <ShieldCheck className="h-4 w-4" />
                  <span>One-Time Initial System Provisioning</span>
                </div>
                <h2 className="text-xl sm:text-2xl font-extrabold text-slate-950">
                  Initialize Main Administrator Account
                </h2>
                <p className="mt-1 text-xs text-slate-600 leading-relaxed">
                  No administrator accounts exist yet. Create the Main Administrator credentials and
                  confirm initial customer &amp; invoice sequences. This setup wizard locks
                  permanently once completed.
                </p>

                <form onSubmit={handleBootstrapSubmit} className="mt-5 space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div>
                      <label
                        htmlFor="setup-username"
                        className="block text-xs font-semibold text-slate-700 mb-1"
                      >
                        Admin Username
                      </label>
                      <input
                        id="setup-username"
                        type="text"
                        required
                        minLength={3}
                        value={setupUsername}
                        onChange={(e) => setSetupUsername(e.target.value)}
                        className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3.5 py-2 text-sm font-mono text-slate-900 focus:border-slate-900 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="setup-display-name"
                        className="block text-xs font-semibold text-slate-700 mb-1"
                      >
                        Full Display Name
                      </label>
                      <input
                        id="setup-display-name"
                        type="text"
                        required
                        minLength={2}
                        value={setupDisplayName}
                        onChange={(e) => setSetupDisplayName(e.target.value)}
                        className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3.5 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div>
                      <label
                        htmlFor="setup-email"
                        className="block text-xs font-semibold text-slate-700 mb-1"
                      >
                        Administrator Email
                      </label>
                      <input
                        id="setup-email"
                        type="email"
                        required
                        value={setupEmail}
                        onChange={(e) => setSetupEmail(e.target.value)}
                        className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3.5 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="setup-mobile"
                        className="block text-xs font-semibold text-slate-700 mb-1"
                      >
                        Mobile Number (Optional, for SMS 2FA)
                      </label>
                      <input
                        id="setup-mobile"
                        type="tel"
                        placeholder="03001234567"
                        value={setupMobile}
                        onChange={(e) => setSetupMobile(e.target.value)}
                        className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3.5 py-2 text-sm font-mono tabular-nums text-slate-900 focus:border-slate-900 focus:outline-none"
                      />
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="setup-password"
                      className="block text-xs font-semibold text-slate-700 mb-1"
                    >
                      Strong Administrator Password (Min 8 characters)
                    </label>
                    <input
                      id="setup-password"
                      type="password"
                      required
                      minLength={8}
                      placeholder="Create Main Admin password"
                      value={setupPassword}
                      onChange={(e) => setSetupPassword(e.target.value)}
                      className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3.5 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 pt-1">
                    <div>
                      <label
                        htmlFor="setup-cust-seq"
                        className="block text-xs font-semibold text-slate-700 mb-1"
                      >
                        Starting Customer ID Sequence (BRB-C-ID...)
                      </label>
                      <input
                        id="setup-cust-seq"
                        type="number"
                        min={1}
                        required
                        value={setupCustomerSeq}
                        onChange={(e) => setSetupCustomerSeq(Number(e.target.value || 131))}
                        className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3.5 py-2 text-sm font-mono tabular-nums text-slate-900 focus:border-slate-900 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="setup-inv-seq"
                        className="block text-xs font-semibold text-slate-700 mb-1"
                      >
                        Starting Invoice Number
                      </label>
                      <input
                        id="setup-inv-seq"
                        type="number"
                        min={1}
                        required
                        value={setupInvoiceSeq}
                        onChange={(e) => setSetupInvoiceSeq(Number(e.target.value || 5001))}
                        className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3.5 py-2 text-sm font-mono tabular-nums text-slate-900 focus:border-slate-900 focus:outline-none"
                      />
                    </div>
                  </div>

                  <label className="flex items-center gap-2.5 text-xs text-slate-700 pt-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={setupTwoFactor}
                      onChange={(e) => setSetupTwoFactor(e.target.checked)}
                      className="h-4 w-4 rounded border-slate-300 text-slate-900"
                    />
                    <span>Enable Two-Step OTP Verification on every Administrator Login</span>
                  </label>

                  <button
                    type="submit"
                    disabled={busy}
                    className="w-full min-h-[48px] rounded-xl bg-slate-900 px-5 py-3 text-sm font-bold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                  >
                    {busy
                      ? 'Provisioning Main Administrator...'
                      : 'Complete Initial Setup & Enter Admin Console'}
                  </button>
                </form>
              </div>
            ) : mode === 'login' ? (
              /* SEPARATE ADMIN LOGIN SCREEN (Section 42) */
              <div>
                <h2 className="text-xl sm:text-2xl font-extrabold text-slate-950">
                  Administrator Login
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  Enter your staff username or email address and password.
                </p>

                <form onSubmit={handleAdminLogin} className="mt-6 space-y-4">
                  <div>
                    <label
                      htmlFor="admin-login-id"
                      className="block text-xs font-semibold text-slate-700 mb-1.5"
                    >
                      Username / Email
                    </label>
                    <input
                      id="admin-login-id"
                      type="text"
                      required
                      autoComplete="username"
                      placeholder="brb_admin or email@domain.com"
                      value={loginIdentifier}
                      onChange={(e) => setLoginIdentifier(e.target.value)}
                      className="w-full min-h-[46px] rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label
                        htmlFor="admin-login-pw"
                        className="block text-xs font-semibold text-slate-700"
                      >
                        Password
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          clearMessages();
                          setResetIdentifier(loginIdentifier);
                          setMode('forgot_request');
                        }}
                        className="text-xs font-semibold text-slate-700 hover:text-slate-950 underline underline-offset-2 whitespace-nowrap shrink-0"
                      >
                        Forgot Password
                      </button>
                    </div>
                    <input
                      id="admin-login-pw"
                      type="password"
                      required
                      autoComplete="current-password"
                      placeholder="Enter administrator password"
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      className="w-full min-h-[46px] rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={busy}
                    className="w-full min-h-[48px] inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-bold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                  >
                    <Lock className="h-4 w-4" aria-hidden="true" />
                    {busy ? 'Authenticating...' : 'Login'}
                  </button>
                </form>

                <p className="mt-5 text-xs text-slate-500">
                  OTP / Two-Step Verification automatically prompts after password check when
                  enabled for your staff account.
                </p>
              </div>
            ) : mode === 'two_factor' ? (
              /* TWO-STEP VERIFICATION */
              <div>
                <h2 className="text-xl font-extrabold text-slate-950">
                  OTP / Two-Step Verification
                </h2>
                <p className="mt-1 text-xs text-slate-600">
                  Enter the 6-digit verification code sent to{' '}
                  <span className="font-mono font-semibold text-slate-900">{twoFactorMasked}</span>.
                </p>

                <form onSubmit={handleVerifyTwoFactor} className="mt-5 space-y-4">
                  <div>
                    <label
                      htmlFor="admin-2fa-otp"
                      className="block text-xs font-semibold text-slate-700 mb-1.5"
                    >
                      6-Digit Verification Code
                    </label>
                    <input
                      id="admin-2fa-otp"
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      required
                      placeholder="123456"
                      value={twoFactorOtp}
                      onChange={(e) => setTwoFactorOtp(e.target.value.replace(/\D/g, ''))}
                      className="w-full min-h-[48px] rounded-xl border border-slate-300 px-4 py-2.5 text-center font-mono text-lg font-bold tracking-widest tabular-nums text-slate-950 focus:border-slate-900 focus:outline-none"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={busy}
                    className="w-full min-h-[48px] rounded-xl bg-slate-900 px-4 py-3 text-sm font-bold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                  >
                    {busy ? 'Verifying...' : 'Verify & Enter Console'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      clearMessages();
                      setMode('login');
                    }}
                    className="w-full min-h-[42px] rounded-xl border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    Back to Login
                  </button>
                </form>
              </div>
            ) : mode === 'forgot_request' ? (
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-extrabold text-slate-950">Admin Password Recovery</h2>
                  <button
                    type="button"
                    onClick={() => {
                      clearMessages();
                      setMode('login');
                    }}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-slate-600 hover:text-slate-900"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Back
                  </button>
                </div>

                <form onSubmit={handleForgotRequest} className="space-y-4">
                  <div>
                    <label
                      htmlFor="admin-reset-id"
                      className="block text-xs font-semibold text-slate-700 mb-1.5"
                    >
                      Admin Username or Email
                    </label>
                    <input
                      id="admin-reset-id"
                      type="text"
                      required
                      value={resetIdentifier}
                      onChange={(e) => setResetIdentifier(e.target.value)}
                      className="w-full min-h-[46px] rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={busy}
                    className="w-full min-h-[48px] rounded-xl bg-slate-900 px-4 py-3 text-sm font-bold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                  >
                    {busy ? 'Requesting Recovery OTP...' : 'Send Recovery OTP'}
                  </button>
                </form>
              </div>
            ) : (
              <div>
                <h2 className="text-xl font-extrabold text-slate-950">Set New Admin Password</h2>
                <form onSubmit={handleForgotComplete} className="mt-5 space-y-4">
                  <div>
                    <label
                      htmlFor="admin-reset-otp"
                      className="block text-xs font-semibold text-slate-700 mb-1.5"
                    >
                      6-Digit Recovery OTP
                    </label>
                    <input
                      id="admin-reset-otp"
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      required
                      value={resetOtp}
                      onChange={(e) => setResetOtp(e.target.value.replace(/\D/g, ''))}
                      className="w-full min-h-[46px] rounded-xl border border-slate-300 px-3.5 py-2.5 text-center font-mono font-bold tracking-widest tabular-nums text-slate-900 focus:border-slate-900 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="admin-reset-pw"
                      className="block text-xs font-semibold text-slate-700 mb-1.5"
                    >
                      New Password (Min 8 characters)
                    </label>
                    <input
                      id="admin-reset-pw"
                      type="password"
                      minLength={8}
                      required
                      value={resetNewPassword}
                      onChange={(e) => setResetNewPassword(e.target.value)}
                      className="w-full min-h-[46px] rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="admin-reset-confirm"
                      className="block text-xs font-semibold text-slate-700 mb-1.5"
                    >
                      Confirm New Password
                    </label>
                    <input
                      id="admin-reset-confirm"
                      type="password"
                      minLength={8}
                      required
                      value={resetConfirmPassword}
                      onChange={(e) => setResetConfirmPassword(e.target.value)}
                      className="w-full min-h-[46px] rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={busy}
                    className="w-full min-h-[48px] inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-bold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                  >
                    <KeyRound className="h-4 w-4" />
                    {busy ? 'Updating...' : 'Update Admin Password'}
                  </button>
                </form>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
