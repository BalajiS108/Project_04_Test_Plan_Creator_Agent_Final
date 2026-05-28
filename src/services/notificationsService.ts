import axios from 'axios';

const backendUrl = () => {
  const host = window.location.hostname || 'localhost';
  return `http://${host}:3001`;
};

export interface EmailConfig {
  enabled: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
  fromAddress: string;
  toAddresses: string;
}

export interface WebhookConfig {
  enabled: boolean;
  url: string;
}

export interface NotificationConfig {
  triggerOnSuccess: boolean;
  triggerOnFailure: boolean;
  triggerOnBugCreated: boolean;
  email: EmailConfig;
  slack: WebhookConfig;
  teams: WebhookConfig;
  genericWebhook: WebhookConfig;
}

export const fetchNotificationConfig = async (): Promise<NotificationConfig> => {
  const res = await axios.get(`${backendUrl()}/api/notifications/config`, { timeout: 10000 });
  return res.data;
};

export const saveNotificationConfig = async (config: NotificationConfig): Promise<void> => {
  await axios.post(`${backendUrl()}/api/notifications/config`, config, { timeout: 10000 });
};

export const sendTestNotification = async (): Promise<{ results: { channel: string; ok: boolean; error?: string }[] }> => {
  const res = await axios.post(`${backendUrl()}/api/notifications/test`, {}, { timeout: 30000 });
  return res.data;
};
