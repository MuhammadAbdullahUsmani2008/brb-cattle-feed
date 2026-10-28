/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { BRAND_NAMES, URDU_MESSAGES } from './shared/types';
import type { CustomerPublicView } from './shared/types';
import {
  adminApi,
  ApiClientError,
  customerApi,
  getAdminToken,
  getCustomerToken,
  publicApi,
  setAdminToken,
  setCustomerToken,
} from './lib/api';
import type { PublicBootstrapInfo } from './lib/api';
import './lib/firebase';
import { CustomerAuthView } from './customer/CustomerAuthView';
import { CustomerPortal } from './customer/CustomerPortal';
import { AdminAuthView } from './admin/AdminAuthView';
import { AdminPortal } from './admin/AdminPortal';
import type { AdminAuthenticatedProfile } from './admin/types';

type ActivePortal = 'customer' | 'admin';

function detectPortalFromPathname(pathname: string): ActivePortal {
  return pathname === '/admin' || pathname.startsWith('/admin/') ? 'admin' : 'customer';
}

const FALLBACK_BOOTSTRAP: PublicBootstrapInfo = {
  hasAnyAdmin: false,
  applicationName: BRAND_NAMES.applicationName,
  mainBusinessHeading: BRAND_NAMES.mainBusinessHeading,
  invoiceHeading: BRAND_NAMES.invoiceHeading,
  logoDataUrl: null,
  whatsappContactNumber: '',
  currencySymbol: 'Rs.',
  timezone: 'Asia/Karachi',
  smsConfigured: false,
  devEnvironment: false,
};

export default function App() {
  const [portal, setPortal] = useState<ActivePortal>(() =>
    detectPortalFromPathname(window.location.pathname)
  );
  const [bootstrap, setBootstrap] = useState<PublicBootstrapInfo | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  // Strictly isolated authentication states (never shared between Customer and Admin)
  const [customerSession, setCustomerSession] = useState<CustomerPublicView | null>(null);
  const [customerBlockedMessage, setCustomerBlockedMessage] = useState<string | null>(null);
  const [customerAuthReady, setCustomerAuthReady] = useState(false);

  const [adminSession, setAdminSession] = useState<AdminAuthenticatedProfile | null>(null);
  const [adminAuthReady, setAdminAuthReady] = useState(false);

  const refreshBootstrap = useCallback(async () => {
    try {
      const info = await publicApi<PublicBootstrapInfo>('/api/public/bootstrap-info');
      setBootstrap(info);
      setBootError(null);
    } catch (err) {
      setBootError(
        err instanceof Error ? err.message : 'Unable to connect to BRB Feed Industry server.'
      );
      setBootstrap((prev) => prev ?? FALLBACK_BOOTSTRAP);
    }
  }, []);

  useEffect(() => {
    void refreshBootstrap();
  }, [refreshBootstrap]);

  // Restore isolated Customer session if present
  useEffect(() => {
    let cancelled = false;
    async function restoreCustomer() {
      const token = getCustomerToken();
      if (!token) {
        if (!cancelled) setCustomerAuthReady(true);
        return;
      }
      try {
        const res = await customerApi<{ customer: CustomerPublicView }>('/api/customer/me');
        if (!cancelled) {
          setCustomerSession(res.customer);
          setCustomerBlockedMessage(null);
        }
      } catch (err) {
        setCustomerToken(null);
        if (!cancelled) {
          setCustomerSession(null);
          if (err instanceof ApiClientError && err.code === 'ACCOUNT_BLOCKED') {
            setCustomerBlockedMessage(err.message || URDU_MESSAGES.accountBlocked);
          }
        }
      } finally {
        if (!cancelled) setCustomerAuthReady(true);
      }
    }
    void restoreCustomer();
    return () => {
      cancelled = true;
    };
  }, []);

  // Restore isolated Administrator session if present
  useEffect(() => {
    let cancelled = false;
    async function restoreAdmin() {
      const token = getAdminToken();
      if (!token) {
        if (!cancelled) setAdminAuthReady(true);
        return;
      }
      try {
        const res = await adminApi<{ admin: AdminAuthenticatedProfile }>('/api/admin/me');
        if (!cancelled) {
          setAdminSession(res.admin);
        }
      } catch {
        setAdminToken(null);
        if (!cancelled) {
          setAdminSession(null);
        }
      } finally {
        if (!cancelled) setAdminAuthReady(true);
      }
    }
    void restoreAdmin();
    return () => {
      cancelled = true;
    };
  }, []);

  // Sync URL navigation (/ vs /admin)
  useEffect(() => {
    const onPopState = () => {
      setPortal(detectPortalFromPathname(window.location.pathname));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const switchPortal = (target: ActivePortal) => {
    const nextPath = target === 'admin' ? '/admin' : '/';
    if (window.location.pathname !== nextPath) {
      window.history.pushState(null, '', nextPath);
    }
    setPortal(target);
  };

  if (!bootstrap || (portal === 'customer' && !customerAuthReady) || (portal === 'admin' && !adminAuthReady)) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        <div className="bg-amber-400 text-slate-950 py-2 px-4 text-center text-xs font-extrabold tracking-wide">
          {BRAND_NAMES.mainBusinessHeading}
        </div>
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center space-y-2">
            <p className="text-sm font-bold text-slate-900">{BRAND_NAMES.applicationName}</p>
            <p className="text-xs text-slate-500">Loading workspace...</p>
          </div>
        </div>
      </div>
    );
  }

  // =========================================================================
  // ADMINISTRATIVE PORTAL (/admin)
  // =========================================================================
  if (portal === 'admin') {
    if (!adminSession) {
      return (
        <div>
          {bootError && (
            <div role="alert" className="bg-rose-600 text-white text-xs px-4 py-2 text-center">
              {bootError}
            </div>
          )}
          <AdminAuthView
            bootstrap={bootstrap}
            onLoginSuccess={(admin, token) => {
              setAdminToken(token);
              setAdminSession(admin);
            }}
            onBootstrapComplete={(admin, token) => {
              setAdminToken(token);
              setAdminSession(admin);
              void refreshBootstrap();
            }}
            onSwitchToCustomerPortal={() => switchPortal('customer')}
          />
        </div>
      );
    }

    return (
      <AdminPortal
        bootstrap={bootstrap}
        admin={adminSession}
        onLogout={() => {
          setAdminToken(null);
          setAdminSession(null);
        }}
        onRefreshBootstrap={() => void refreshBootstrap()}
        onSwitchToCustomerPortal={() => switchPortal('customer')}
      />
    );
  }

  // =========================================================================
  // CUSTOMER PORTAL (/)
  // =========================================================================
  if (!customerSession) {
    return (
      <div>
        {bootError && (
          <div role="alert" className="bg-rose-600 text-white text-xs px-4 py-2 text-center">
            {bootError}
          </div>
        )}
        <CustomerAuthView
          bootstrap={bootstrap}
          blockedMessage={customerBlockedMessage}
          onClearBlocked={() => setCustomerBlockedMessage(null)}
          onLoginSuccess={(customer, token) => {
            setCustomerToken(token);
            setCustomerBlockedMessage(null);
            setCustomerSession(customer);
          }}
          onSwitchToAdminPortal={() => switchPortal('admin')}
        />
      </div>
    );
  }

  return (
    <CustomerPortal
      bootstrap={bootstrap}
      initialCustomer={customerSession}
      onLogout={() => {
        setCustomerToken(null);
        setCustomerSession(null);
      }}
      onBlocked={(urduMessage) => {
        setCustomerToken(null);
        setCustomerSession(null);
        setCustomerBlockedMessage(urduMessage || URDU_MESSAGES.accountBlocked);
      }}
    />
  );
}
