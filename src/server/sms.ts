import type { SmsDeliveryStatus } from '../shared/types.ts';

export interface SmsProviderConfig {
  providerUrl: string;
  apiKey: string;
  senderId: string;
  enabled: boolean;
}

export interface SmsDispatchResult {
  status: SmsDeliveryStatus;
  providerRef: string | null;
  errorDetail: string | null;
}

/**
 * Configurable SMS & OTP Gateway boundary.
 * Never claims delivery when provider credentials are missing or when the HTTP call fails.
 */
export async function dispatchSmsViaProvider(
  config: SmsProviderConfig,
  recipientMobile: string,
  messageBody: string,
  idempotencyKey: string
): Promise<SmsDispatchResult> {
  const providerUrl = (config.providerUrl || process.env.SMS_PROVIDER_URL || '').trim();
  const apiKey = (config.apiKey || process.env.SMS_PROVIDER_API_KEY || '').trim();
  const senderId = (config.senderId || process.env.SMS_SENDER_ID || 'BRB-FEED').trim();

  if (!config.enabled || !providerUrl || !apiKey) {
    return {
      status: 'not_configured',
      providerRef: null,
      errorDetail:
        'SMS gateway credentials (Provider URL / API Key) are not configured. Configure an authorized Pakistani SMS gateway in Admin Settings.',
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(providerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        to: recipientMobile,
        sender_id: senderId,
        message: messageBody,
        idempotency_key: idempotencyKey,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      return {
        status: 'failed',
        providerRef: null,
        errorDetail: `SMS provider responded with HTTP ${response.status}.`,
      };
    }

    let providerRef: string | null = null;
    let confirmedDelivered = false;
    try {
      const json = (await response.json()) as Record<string, unknown>;
      if (typeof json.messageId === 'string') providerRef = json.messageId;
      else if (typeof json.id === 'string') providerRef = json.id;
      if (json.status === 'delivered') confirmedDelivered = true;
    } catch {
      // Non-JSON 2xx acknowledgement means submitted to gateway, not yet confirmed delivered
    }

    return {
      status: confirmedDelivered ? 'delivered' : 'submitted',
      providerRef,
      errorDetail: null,
    };
  } catch (err) {
    return {
      status: 'failed',
      providerRef: null,
      errorDetail: err instanceof Error ? err.message : 'SMS gateway network error.',
    };
  }
}

export function isIsolatedDevOtpAllowed(): boolean {
  return process.env.NODE_ENV !== 'production';
}
