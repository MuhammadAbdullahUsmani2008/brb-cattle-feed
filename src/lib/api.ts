export const CUSTOMER_SESSION_STORAGE_KEY = 'brb_customer_auth_token_v1';
export const ADMIN_SESSION_STORAGE_KEY = 'brb_admin_auth_token_v1';

export class ApiClientError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function getCustomerToken(): string | null {
  try {
    return window.localStorage.getItem(CUSTOMER_SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setCustomerToken(token: string | null): void {
  try {
    if (token) {
      window.localStorage.setItem(CUSTOMER_SESSION_STORAGE_KEY, token);
    } else {
      window.localStorage.removeItem(CUSTOMER_SESSION_STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota issues
  }
}

export function getAdminToken(): string | null {
  try {
    return window.localStorage.getItem(ADMIN_SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setAdminToken(token: string | null): void {
  try {
    if (token) {
      window.localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, token);
    } else {
      window.localStorage.removeItem(ADMIN_SESSION_STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota issues
  }
}

async function requestJson<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
    token?: string | null;
  } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  const res = await fetch(path, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }

  if (!res.ok) {
    const errObj = (parsed.error as { code?: string; message?: string } | undefined) || {};
    throw new ApiClientError(
      res.status,
      errObj.code || `HTTP_${res.status}`,
      errObj.message || `Request failed (${res.status}).`
    );
  }

  return parsed as T;
}

export function publicApi<T>(
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown } = {}
): Promise<T> {
  return requestJson<T>(path, options);
}

export function customerApi<T>(
  path: string,
  options: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown } = {}
): Promise<T> {
  return requestJson<T>(path, {
    ...options,
    token: getCustomerToken(),
  });
}

export function adminApi<T>(
  path: string,
  options: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown } = {}
): Promise<T> {
  return requestJson<T>(path, {
    ...options,
    token: getAdminToken(),
  });
}

export async function downloadAuthenticatedPdf(params: {
  portal: 'customer' | 'admin';
  invoiceId: number;
  invoiceNumber: number;
}): Promise<void> {
  const token = params.portal === 'customer' ? getCustomerToken() : getAdminToken();
  const endpoint =
    params.portal === 'customer'
      ? `/api/customer/invoices/${params.invoiceId}/pdf`
      : `/api/admin/invoices/${params.invoiceId}/pdf`;

  const res = await fetch(endpoint, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!res.ok) {
    let message = 'Unable to download invoice PDF.';
    let code = `HTTP_${res.status}`;
    try {
      const data = (await res.json()) as { error?: { code?: string; message?: string } };
      if (data.error?.message) message = data.error.message;
      if (data.error?.code) code = data.error.code;
    } catch {
      // Ignore non-JSON error body
    }
    throw new ApiClientError(res.status, code, message);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `BRB-Invoice-${params.invoiceNumber}.pdf`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function triggerTextFileDownload(filename: string, content: string, mimeType = 'application/json'): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Converts a user-selected image file into a validated PNG/JPEG data URL under 1.5MB.
 */
export async function readImageFileAsDataUrl(file: File, maxDimension = 900): Promise<string> {
  if (!/^image\/(png|jpeg|jpg|webp)$/i.test(file.type)) {
    throw new Error('Please choose a PNG, JPEG, or WebP image file.');
  }
  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read selected image file.'));
    reader.readAsDataURL(file);
  });

  if (rawDataUrl.length < 400_000 && /^data:image\/(png|jpeg|jpg|webp);base64,/i.test(rawDataUrl)) {
    return rawDataUrl;
  }

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Selected file could not be decoded as an image.'));
    el.src = rawDataUrl;
  });

  const scale = Math.min(1, maxDimension / Math.max(img.width || 1, img.height || 1));
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return rawDataUrl;
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL('image/png');
}

export interface PublicBootstrapInfo {
  hasAnyAdmin: boolean;
  applicationName: string;
  mainBusinessHeading: string;
  invoiceHeading: string;
  logoDataUrl: string | null;
  whatsappContactNumber: string;
  currencySymbol: string;
  timezone: string;
  smsConfigured: boolean;
  devEnvironment: boolean;
}
