import React, { useState } from 'react';
import { ArrowLeft, KeyRound, Lock, MessageSquare, Phone, ShieldAlert, UserCheck, UserPlus } from 'lucide-react';
import { BRAND_NAMES, URDU_MESSAGES } from '../shared/types';
import type { CustomerPublicView } from '../shared/types';
import { ApiClientError, publicApi } from '../lib/api';
import type { PublicBootstrapInfo } from '../lib/api';
import { BrbLogo, InlineAlert } from '../components/Branding';

type AuthScreenMode =
  | 'login'
  | 'register'
  | 'register_otp'
  | 'register_pending_approval'
  | 'forgot_request'
  | 'forgot_verify'
  | 'forgot_done';

export function CustomerAuthView({
  bootstrap,
  blockedMessage,
  onClearBlocked,
  onLoginSuccess,
  onSwitchToAdminPortal,
}: {
  bootstrap: PublicBootstrapInfo;
  blockedMessage: string | null;
  onClearBlocked: () => void;
  onLoginSuccess: (customer: CustomerPublicView, token: string) => void;
  onSwitchToAdminPortal: () => void;
}) {
  const [mode, setMode] = useState<AuthScreenMode>('login');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isUrduError, setIsUrduError] = useState(false);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  const [devSandboxOtp, setDevSandboxOtp] = useState<string | null>(null);

  // Login state
  const [loginAccount, setLoginAccount] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  // Registration state
  const [regAccount, setRegAccount] = useState('');
  const [regMobile, setRegMobile] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regConfirmPassword, setRegConfirmPassword] = useState('');
  const [regOtp, setRegOtp] = useState('');

  // Forgot password state
  const [resetAccount, setResetAccount] = useState('');
  const [resetMobile, setResetMobile] = useState('');
  const [resetOtp, setResetOtp] = useState('');
  const [resetNewPassword, setResetNewPassword] = useState('');
  const [resetConfirmPassword, setResetConfirmPassword] = useState('');

  const clearFeedback = () => {
    setErrorMsg(null);
    setIsUrduError(false);
    setInfoMsg(null);
    onClearBlocked();
  };

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFeedback();
    setBusy(true);
    try {
      const res = await publicApi<{ customer: CustomerPublicView; token: string }>(
        '/api/customer/auth/login',
        {
          method: 'POST',
          body: {
            accountNumber: loginAccount.trim(),
            password: loginPassword,
          },
        }
      );
      onLoginSuccess(res.customer, res.token);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'ACCOUNT_BLOCKED') {
        setIsUrduError(true);
        setErrorMsg(URDU_MESSAGES.accountBlocked);
      } else {
        setErrorMsg(err instanceof Error ? err.message : 'Unable to sign in.');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleRegisterStart = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFeedback();
    setDevSandboxOtp(null);
    setBusy(true);
    try {
      const res = await publicApi<{
        challengeId: number;
        accountNumber: string;
        smsStatus: string;
        devSandboxOtp?: string;
      }>('/api/customer/auth/register', {
        method: 'POST',
        body: {
          accountNumber: regAccount.trim(),
          mobileNumber: regMobile.trim(),
          password: regPassword,
          confirmPassword: regConfirmPassword,
        },
      });
      setRegAccount(res.accountNumber);
      setDevSandboxOtp(res.devSandboxOtp || null);
      setMode('register_otp');
      setInfoMsg(
        res.smsStatus === 'not_configured'
          ? 'OTP challenge generated. External SMS gateway is currently not configured.'
          : 'A 6-digit verification code has been dispatched to your registered mobile number.'
      );
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'ACCOUNT_BLOCKED') {
        setIsUrduError(true);
        setErrorMsg(URDU_MESSAGES.accountBlocked);
      } else {
        setErrorMsg(err instanceof Error ? err.message : 'Registration failed.');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyRegistrationOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFeedback();
    setBusy(true);
    try {
      await publicApi<{ status: string; message: string }>('/api/customer/auth/verify-otp', {
        method: 'POST',
        body: {
          accountNumber: regAccount.trim(),
          otp: regOtp.trim(),
        },
      });
      setDevSandboxOtp(null);
      setRegOtp('');
      setMode('register_pending_approval');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'OTP verification failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleForgotRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFeedback();
    setDevSandboxOtp(null);
    setBusy(true);
    try {
      const res = await publicApi<{
        acknowledged: true;
        smsStatus?: string;
        devSandboxOtp?: string;
      }>('/api/customer/auth/forgot-password', {
        method: 'POST',
        body: {
          accountNumber: resetAccount.trim(),
          mobileNumber: resetMobile.trim(),
        },
      });
      setDevSandboxOtp(res.devSandboxOtp || null);
      setMode('forgot_verify');
      setInfoMsg(
        'If your BRB Account Number and Mobile Number match an active customer record, a 6-digit OTP is now ready for verification.'
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to initiate password recovery.');
    } finally {
      setBusy(false);
    }
  };

  const handleForgotComplete = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFeedback();
    setBusy(true);
    try {
      await publicApi<{ updated: boolean }>('/api/customer/auth/reset-password', {
        method: 'POST',
        body: {
          accountNumber: resetAccount.trim(),
          mobileNumber: resetMobile.trim(),
          otp: resetOtp.trim(),
          newPassword: resetNewPassword,
          confirmPassword: resetConfirmPassword,
        },
      });
      setDevSandboxOtp(null);
      setResetOtp('');
      setResetNewPassword('');
      setResetConfirmPassword('');
      setMode('forgot_done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Password update failed.');
    } finally {
      setBusy(false);
    }
  };

  const whatsappDigits = bootstrap.whatsappContactNumber.replace(/\D/g, '');
  const whatsappHref = whatsappDigits
    ? `https://wa.me/${whatsappDigits.startsWith('0') ? `92${whatsappDigits.slice(1)}` : whatsappDigits}`
    : null;

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      {/* Mandatory Customer Login Yellow Strip with Black Text (Section 10) */}
      <header className="w-full bg-amber-400 border-b border-amber-500/60 px-4 py-3 text-center">
        <p className="text-sm sm:text-base font-extrabold tracking-tight text-slate-950">
          {BRAND_NAMES.mainBusinessHeading}
        </p>
      </header>

      <main className="flex-1 mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:py-12 flex items-center">
        <div className="w-full grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-stretch">
          {/* Left Column: BRB Brand Identity & Dealer Information */}
          <section className="lg:col-span-6 flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-6 sm:p-8">
            <div>
              <div className="flex items-center gap-4">
                <BrbLogo logoDataUrl={bootstrap.logoDataUrl} size="lg" />
                <div>
                  <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-slate-950 text-balance">
                    {BRAND_NAMES.invoiceHeading}
                  </h1>
                  <p className="mt-0.5 text-sm text-slate-600">
                    Registered Customer Ordering &amp; Account Portal
                  </p>
                </div>
              </div>

              <p className="mt-6 text-sm sm:text-base text-slate-600 leading-relaxed">
                Place multi-product orders across BRB Cattle Feed and BRB Oil Mill lines, compare
                requested and approved quantities transparently, download official invoices, and
                review your 12-month account ledger.
              </p>

              <dl className="mt-8 divide-y divide-slate-100 border-t border-b border-slate-100 text-sm">
                <div className="py-3.5 flex items-baseline justify-between gap-4">
                  <dt className="font-medium text-slate-700">Product Lines</dt>
                  <dd className="text-slate-600 text-right">BRB Cattle Feed · BRB Oil Mill</dd>
                </div>
                <div className="py-3.5 flex items-baseline justify-between gap-4">
                  <dt className="font-medium text-slate-700">Account Format</dt>
                  <dd className="font-mono tabular-nums text-slate-900 font-semibold">BRB-C-ID131+</dd>
                </div>
                <div className="py-3.5 flex items-baseline justify-between gap-4">
                  <dt className="font-medium text-slate-700">Registration Workflow</dt>
                  <dd className="text-slate-600 text-right">Mobile OTP · Admin Approval</dd>
                </div>
              </dl>
            </div>

            <div className="mt-8 pt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
              <span>{BRAND_NAMES.applicationName}</span>
              <button
                type="button"
                onClick={onSwitchToAdminPortal}
                className="min-h-[40px] px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-700 hover:text-slate-950 hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0"
              >
                Staff / Administrator Sign In →
              </button>
            </div>
          </section>

          {/* Right Column: Customer Authentication Card */}
          <section className="lg:col-span-6 rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 flex flex-col justify-center">
            {/* Global Blocked Account Urdu Notice */}
            {blockedMessage && (
              <div className="mb-5 rounded-xl border border-rose-300 bg-rose-50 p-4">
                <div className="flex items-center gap-2 text-rose-800 text-xs font-semibold mb-1.5">
                  <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>Account Access Restricted</span>
                </div>
                <p dir="rtl" className="font-urdu text-base font-semibold text-rose-950 text-right">
                  {blockedMessage}
                </p>
              </div>
            )}

            {errorMsg && (
              <div className="mb-5">
                <InlineAlert
                  tone="error"
                  message={errorMsg}
                  isUrdu={isUrduError}
                  onDismiss={() => setErrorMsg(null)}
                />
              </div>
            )}

            {infoMsg && (
              <div className="mb-5">
                <InlineAlert tone="info" message={infoMsg} onDismiss={() => setInfoMsg(null)} />
              </div>
            )}

            {devSandboxOtp && (
              <div className="mb-5 rounded-xl border border-amber-300 bg-amber-50 p-3.5 text-xs text-amber-950">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">
                    Development Preview OTP (SMS Gateway Not Configured)
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (mode === 'register_otp') setRegOtp(devSandboxOtp);
                      if (mode === 'forgot_verify') setResetOtp(devSandboxOtp);
                    }}
                    className="px-2.5 py-1 rounded-md bg-amber-400 text-slate-950 font-semibold hover:bg-amber-300 transition-colors whitespace-nowrap shrink-0"
                  >
                    Use {devSandboxOtp}
                  </button>
                </div>
                <p className="mt-1 text-amber-900">
                  Verification code:{' '}
                  <span className="font-mono font-bold tabular-nums">{devSandboxOtp}</span>. Never
                  shown in production.
                </p>
              </div>
            )}

            {/* 1. CUSTOMER LOGIN */}
            {mode === 'login' && (
              <div>
                <div className="flex items-center gap-3 mb-6">
                  <div className="sm:hidden">
                    <BrbLogo logoDataUrl={bootstrap.logoDataUrl} size="sm" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-slate-950">Customer Sign In</h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Sign in with your assigned BRB Account Number and password.
                    </p>
                  </div>
                </div>

                <form onSubmit={handleLoginSubmit} className="space-y-4">
                  <div>
                    <label
                      htmlFor="cust-login-account"
                      className="block text-xs font-semibold text-slate-700 mb-1.5"
                    >
                      Account Number / Username
                    </label>
                    <input
                      id="cust-login-account"
                      type="text"
                      required
                      autoComplete="username"
                      placeholder="BRB-C-ID131"
                      value={loginAccount}
                      onChange={(e) => setLoginAccount(e.target.value)}
                      className="w-full min-h-[46px] rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-mono tabular-nums text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label
                        htmlFor="cust-login-password"
                        className="block text-xs font-semibold text-slate-700"
                      >
                        Password
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          clearFeedback();
                          setResetAccount(loginAccount);
                          setMode('forgot_request');
                        }}
                        className="text-xs font-semibold text-slate-700 hover:text-slate-950 underline underline-offset-2 whitespace-nowrap shrink-0"
                      >
                        Forgot Password?
                      </button>
                    </div>
                    <input
                      id="cust-login-password"
                      type="password"
                      required
                      autoComplete="current-password"
                      placeholder="Enter your password"
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      className="w-full min-h-[46px] rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={busy}
                    className="w-full min-h-[48px] rounded-xl bg-amber-400 px-4 py-3 text-sm font-extrabold text-slate-950 hover:bg-amber-300 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                  >
                    {busy ? 'Signing In...' : 'LOGIN'}
                  </button>
                </form>

                <div className="mt-6 pt-5 border-t border-slate-200 text-center">
                  <button
                    type="button"
                    onClick={() => {
                      clearFeedback();
                      setMode('register');
                    }}
                    className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl border border-slate-300 bg-white text-sm font-semibold text-slate-900 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                  >
                    <UserPlus className="h-4 w-4" aria-hidden="true" />
                    New Customer? Register Here
                  </button>
                </div>
              </div>
            )}

            {/* 2. CUSTOMER REGISTRATION (Step 1) */}
            {mode === 'register' && (
              <div>
                <div className="flex items-center justify-between gap-2 mb-5">
                  <div>
                    <h2 className="text-xl font-bold text-slate-950">Customer Registration</h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Step 1 of 3 · Verify your BRB Account Number &amp; Mobile Number
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      clearFeedback();
                      setMode('login');
                    }}
                    className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Back to Login
                  </button>
                </div>

                <form onSubmit={handleRegisterStart} className="space-y-4">
                  <div>
                    <label
                      htmlFor="reg-account"
                      className="block text-xs font-semibold text-slate-700 mb-1.5"
                    >
                      BRB Account Number
                    </label>
                    <input
                      id="reg-account"
                      type="text"
                      required
                      placeholder="BRB-C-ID131"
                      value={regAccount}
                      onChange={(e) => setRegAccount(e.target.value)}
                      className="w-full min-h-[46px] rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-mono tabular-nums text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="reg-mobile"
                      className="block text-xs font-semibold text-slate-700 mb-1.5"
                    >
                      Mobile Number
                    </label>
                    <input
                      id="reg-mobile"
                      type="tel"
                      required
                      placeholder="03001234567"
                      value={regMobile}
                      onChange={(e) => setRegMobile(e.target.value)}
                      className="w-full min-h-[46px] rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-mono tabular-nums text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div>
                      <label
                        htmlFor="reg-password"
                        className="block text-xs font-semibold text-slate-700 mb-1.5"
                      >
                        Create Password
                      </label>
                      <input
                        id="reg-password"
                        type="password"
                        required
                        minLength={6}
                        placeholder="Min 6 characters"
                        value={regPassword}
                        onChange={(e) => setRegPassword(e.target.value)}
                        className="w-full min-h-[46px] rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="reg-confirm"
                        className="block text-xs font-semibold text-slate-700 mb-1.5"
                      >
                        Confirm Password
                      </label>
                      <input
                        id="reg-confirm"
                        type="password"
                        required
                        minLength={6}
                        placeholder="Re-enter password"
                        value={regConfirmPassword}
                        onChange={(e) => setRegConfirmPassword(e.target.value)}
                        className="w-full min-h-[46px] rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={busy}
                    className="w-full min-h-[48px] rounded-xl bg-slate-900 px-4 py-3 text-sm font-bold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                  >
                    {busy ? 'Sending Mobile OTP...' : 'Register'}
                  </button>
                </form>

                {/* Mandatory Bottom Registration Urdu Help Notice (Section 11) */}
                <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50/70 p-4">
                  <p dir="rtl" className="font-urdu text-sm sm:text-base font-medium text-slate-900 text-right">
                    {URDU_MESSAGES.whatsappRegistrationHelp}
                  </p>
                  <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-700">
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <MessageSquare className="h-3.5 w-3.5 text-emerald-700 shrink-0" />
                      {bootstrap.whatsappContactNumber ? (
                        <span>
                          WhatsApp:{' '}
                          <span className="font-mono font-bold tabular-nums text-slate-950">
                            {bootstrap.whatsappContactNumber}
                          </span>
                        </span>
                      ) : (
                        <span className="text-slate-600">
                          Official WhatsApp contact number will appear once configured by BRB Admin
                        </span>
                      )}
                    </span>
                    {whatsappHref && (
                      <a
                        href={whatsappHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-h-[36px] inline-flex items-center px-3 py-1.5 rounded-lg bg-emerald-700 text-white font-semibold hover:bg-emerald-800 transition-colors whitespace-nowrap shrink-0"
                      >
                        Message on WhatsApp
                      </a>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* 3. CUSTOMER REGISTRATION OTP VERIFICATION (Step 2) */}
            {mode === 'register_otp' && (
              <div>
                <h2 className="text-xl font-bold text-slate-950">Verify Mobile OTP</h2>
                <p className="mt-1 text-xs text-slate-600">
                  Step 2 of 3 · Enter the 6-digit OTP for{' '}
                  <span className="font-mono font-semibold text-slate-900">{regAccount}</span>.
                </p>

                <form onSubmit={handleVerifyRegistrationOtp} className="mt-5 space-y-4">
                  <div>
                    <label
                      htmlFor="reg-otp-code"
                      className="block text-xs font-semibold text-slate-700 mb-1.5"
                    >
                      6-Digit Mobile OTP
                    </label>
                    <input
                      id="reg-otp-code"
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      required
                      placeholder="123456"
                      value={regOtp}
                      onChange={(e) => setRegOtp(e.target.value.replace(/\D/g, ''))}
                      className="w-full min-h-[48px] rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-center text-lg font-mono font-bold tracking-widest tabular-nums text-slate-950 focus:border-slate-900 focus:outline-none"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={busy}
                    className="w-full min-h-[48px] rounded-xl bg-slate-900 px-4 py-3 text-sm font-bold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                  >
                    {busy ? 'Verifying OTP...' : 'Verify OTP & Submit for Approval'}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      clearFeedback();
                      setMode('register');
                    }}
                    className="w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                  >
                    Back to Registration Details
                  </button>
                </form>
              </div>
            )}

            {/* 4. PENDING ADMIN APPROVAL CONFIRMATION (Step 3) */}
            {mode === 'register_pending_approval' && (
              <div className="text-center py-4">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-800">
                  <UserCheck className="h-6 w-6" aria-hidden="true" />
                </div>
                <h2 className="mt-4 text-xl font-bold text-slate-950">
                  Mobile Verified · Pending Admin Approval
                </h2>
                <p className="mt-2 text-sm text-slate-600 leading-relaxed">
                  Your mobile number for account{' '}
                  <span className="font-mono font-semibold text-slate-900">{regAccount}</span> has
                  been verified. BRB Administration will review and activate your account shortly.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    clearFeedback();
                    setLoginAccount(regAccount);
                    setMode('login');
                  }}
                  className="mt-6 min-h-[46px] px-6 py-2.5 rounded-xl bg-slate-900 text-sm font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                >
                  Return to Customer Login
                </button>
              </div>
            )}

            {/* 5. FORGOT PASSWORD — REQUEST OTP */}
            {mode === 'forgot_request' && (
              <div>
                <div className="flex items-center justify-between gap-2 mb-5">
                  <div>
                    <h2 className="text-xl font-bold text-slate-950">Reset Customer Password</h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Enter your BRB Account Number and registered Mobile Number to receive an OTP.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      clearFeedback();
                      setMode('login');
                    }}
                    className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Back
                  </button>
                </div>

                <form onSubmit={handleForgotRequest} className="space-y-4">
                  <div>
                    <label
                      htmlFor="reset-account"
                      className="block text-xs font-semibold text-slate-700 mb-1.5"
                    >
                      BRB Account Number
                    </label>
                    <input
                      id="reset-account"
                      type="text"
                      required
                      placeholder="BRB-C-ID131"
                      value={resetAccount}
                      onChange={(e) => setResetAccount(e.target.value)}
                      className="w-full min-h-[46px] rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-mono tabular-nums text-slate-900 focus:border-slate-900 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="reset-mobile"
                      className="block text-xs font-semibold text-slate-700 mb-1.5"
                    >
                      Registered Mobile Number
                    </label>
                    <input
                      id="reset-mobile"
                      type="tel"
                      required
                      placeholder="03001234567"
                      value={resetMobile}
                      onChange={(e) => setResetMobile(e.target.value)}
                      className="w-full min-h-[46px] rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-mono tabular-nums text-slate-900 focus:border-slate-900 focus:outline-none"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={busy}
                    className="w-full min-h-[48px] inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-bold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                  >
                    <Phone className="h-4 w-4" aria-hidden="true" />
                    {busy ? 'Sending OTP...' : 'Send Recovery OTP'}
                  </button>
                </form>
              </div>
            )}

            {/* 6. FORGOT PASSWORD — VERIFY OTP & SET NEW PASSWORD */}
            {mode === 'forgot_verify' && (
              <div>
                <h2 className="text-xl font-bold text-slate-950">Enter OTP &amp; New Password</h2>
                <p className="mt-1 text-xs text-slate-500">
                  Account: <span className="font-mono font-semibold text-slate-900">{resetAccount}</span>
                </p>

                <form onSubmit={handleForgotComplete} className="mt-5 space-y-4">
                  <div>
                    <label
                      htmlFor="reset-otp-input"
                      className="block text-xs font-semibold text-slate-700 mb-1.5"
                    >
                      6-Digit OTP Code
                    </label>
                    <input
                      id="reset-otp-input"
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      required
                      placeholder="123456"
                      value={resetOtp}
                      onChange={(e) => setResetOtp(e.target.value.replace(/\D/g, ''))}
                      className="w-full min-h-[46px] rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-center font-mono text-base font-bold tracking-widest tabular-nums text-slate-900 focus:border-slate-900 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="reset-new-pw"
                      className="block text-xs font-semibold text-slate-700 mb-1.5"
                    >
                      New Password
                    </label>
                    <input
                      id="reset-new-pw"
                      type="password"
                      required
                      minLength={6}
                      placeholder="Min 6 characters"
                      value={resetNewPassword}
                      onChange={(e) => setResetNewPassword(e.target.value)}
                      className="w-full min-h-[46px] rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="reset-confirm-pw"
                      className="block text-xs font-semibold text-slate-700 mb-1.5"
                    >
                      Confirm New Password
                    </label>
                    <input
                      id="reset-confirm-pw"
                      type="password"
                      required
                      minLength={6}
                      placeholder="Confirm password"
                      value={resetConfirmPassword}
                      onChange={(e) => setResetConfirmPassword(e.target.value)}
                      className="w-full min-h-[46px] rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={busy}
                    className="w-full min-h-[48px] inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-bold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                  >
                    <KeyRound className="h-4 w-4" aria-hidden="true" />
                    {busy ? 'Updating Password...' : 'Update Password'}
                  </button>
                </form>
              </div>
            )}

            {/* 7. PASSWORD UPDATED CONFIRMATION */}
            {mode === 'forgot_done' && (
              <div className="text-center py-4">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-800">
                  <Lock className="h-6 w-6" aria-hidden="true" />
                </div>
                <h2 className="mt-4 text-xl font-bold text-slate-950">Password Updated</h2>
                <p className="mt-2 text-sm text-slate-600">
                  Your BRB customer password has been updated and previous active sessions have been
                  signed out.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    clearFeedback();
                    setLoginAccount(resetAccount);
                    setMode('login');
                  }}
                  className="mt-6 min-h-[46px] px-6 py-2.5 rounded-xl bg-amber-400 text-sm font-extrabold text-slate-950 hover:bg-amber-300 transition-colors whitespace-nowrap shrink-0"
                >
                  Continue to Login
                </button>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
