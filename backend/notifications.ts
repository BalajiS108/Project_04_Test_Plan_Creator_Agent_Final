import nodemailer from 'nodemailer';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH = path.join(__dirname, 'notifications-config.json');

export interface EmailConfig {
    enabled: boolean;
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
    smtpUser: string;
    smtpPass: string;
    fromAddress: string;
    toAddresses: string;  // comma-separated
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

const DEFAULT_CONFIG: NotificationConfig = {
    triggerOnSuccess: true,
    triggerOnFailure: true,
    triggerOnBugCreated: true,
    email: {
        enabled: false,
        smtpHost: '',
        smtpPort: 587,
        smtpSecure: false,
        smtpUser: '',
        smtpPass: '',
        fromAddress: '',
        toAddresses: '',
    },
    slack: { enabled: false, url: '' },
    teams: { enabled: false, url: '' },
    genericWebhook: { enabled: false, url: '' },
};

export function loadNotificationConfig(): NotificationConfig {
    try {
        if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        // Shallow-merge so newly-added fields fall back to defaults
        return {
            ...DEFAULT_CONFIG,
            ...parsed,
            email: { ...DEFAULT_CONFIG.email, ...(parsed.email || {}) },
            slack: { ...DEFAULT_CONFIG.slack, ...(parsed.slack || {}) },
            teams: { ...DEFAULT_CONFIG.teams, ...(parsed.teams || {}) },
            genericWebhook: { ...DEFAULT_CONFIG.genericWebhook, ...(parsed.genericWebhook || {}) },
        };
    } catch (e) {
        console.warn('Could not load notification config — using defaults:', (e as Error).message);
        return { ...DEFAULT_CONFIG };
    }
}

export function saveNotificationConfig(config: NotificationConfig) {
    // Never persist `smtpPass` in plaintext if empty value is provided — keep
    // existing one so users can re-save other fields without re-entering creds.
    const existing = loadNotificationConfig();
    const merged: NotificationConfig = {
        ...config,
        email: {
            ...config.email,
            smtpPass: config.email.smtpPass || existing.email.smtpPass,
        },
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
}

export type NotificationEventKind = 'execution-complete' | 'execution-failed' | 'bug-created' | 'test';

export interface NotificationEvent {
    kind: NotificationEventKind;
    title: string;
    summary: string;     // single-line summary used as preview text
    details?: string;    // longer message body
    fields?: { label: string; value: string }[];   // structured key/value pairs
    link?: { label: string; url: string };
}

interface SendResult {
    channel: string;
    ok: boolean;
    error?: string;
}

async function sendEmail(cfg: EmailConfig, event: NotificationEvent): Promise<SendResult> {
    if (!cfg.enabled) return { channel: 'email', ok: false, error: 'disabled' };
    if (!cfg.smtpHost || !cfg.toAddresses) return { channel: 'email', ok: false, error: 'incomplete config' };

    try {
        const transporter = nodemailer.createTransport({
            host: cfg.smtpHost,
            port: cfg.smtpPort || 587,
            secure: !!cfg.smtpSecure,
            auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined,
        });

        const fieldsHtml = (event.fields || [])
            .map((f) => `<tr><td style="padding:6px 12px;color:#475569;font-weight:600">${escapeHtml(f.label)}</td><td style="padding:6px 12px;color:#0f172a">${escapeHtml(f.value)}</td></tr>`)
            .join('');

        const html = `
            <div style="font-family:Segoe UI,system-ui,sans-serif;max-width:600px;margin:auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
                <div style="padding:20px 24px;background:#0f172a;color:#fff">
                    <h2 style="margin:0;font-size:18px">${escapeHtml(event.title)}</h2>
                    <p style="margin:6px 0 0;color:#cbd5e1;font-size:13px">${escapeHtml(event.summary)}</p>
                </div>
                ${event.details ? `<div style="padding:18px 24px;color:#334155;font-size:14px;line-height:1.6">${escapeHtml(event.details).replace(/\n/g, '<br/>')}</div>` : ''}
                ${fieldsHtml ? `<table style="width:100%;font-size:13px;border-top:1px solid #f1f5f9">${fieldsHtml}</table>` : ''}
                ${event.link ? `<div style="padding:18px 24px;background:#f8fafc"><a href="${escapeHtml(event.link.url)}" style="display:inline-block;padding:10px 18px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px">${escapeHtml(event.link.label)}</a></div>` : ''}
                <div style="padding:12px 24px;font-size:11px;color:#94a3b8;background:#f8fafc;border-top:1px solid #e2e8f0">Sent by Intelligent Test Planning Agent</div>
            </div>
        `;

        await transporter.sendMail({
            from: cfg.fromAddress || cfg.smtpUser,
            to: cfg.toAddresses,
            subject: event.title,
            text: `${event.summary}\n\n${event.details || ''}`,
            html,
        });
        return { channel: 'email', ok: true };
    } catch (e: any) {
        return { channel: 'email', ok: false, error: e.message };
    }
}

async function sendSlack(cfg: WebhookConfig, event: NotificationEvent): Promise<SendResult> {
    // Treat "enabled checkbox on but URL empty" the same as disabled — the
    // frontend filters 'disabled' out of the test-result failure list, so
    // unconfigured channels stop showing up as red errors.
    if (!cfg.enabled || !cfg.url) return { channel: 'slack', ok: false, error: 'disabled' };
    try {
        const blocks: any[] = [
            { type: 'header', text: { type: 'plain_text', text: event.title.slice(0, 150) } },
            { type: 'section', text: { type: 'mrkdwn', text: event.summary } },
        ];
        if (event.fields && event.fields.length > 0) {
            blocks.push({
                type: 'section',
                fields: event.fields.slice(0, 10).map((f) => ({
                    type: 'mrkdwn',
                    text: `*${f.label}*\n${f.value}`,
                })),
            });
        }
        if (event.details) {
            blocks.push({
                type: 'section',
                text: { type: 'mrkdwn', text: '```' + event.details.slice(0, 2500) + '```' },
            });
        }
        if (event.link) {
            blocks.push({
                type: 'actions',
                elements: [{
                    type: 'button',
                    text: { type: 'plain_text', text: event.link.label },
                    url: event.link.url,
                }],
            });
        }
        await axios.post(cfg.url, { text: event.title, blocks }, { timeout: 10000 });
        return { channel: 'slack', ok: true };
    } catch (e: any) {
        return { channel: 'slack', ok: false, error: e.message };
    }
}

async function sendTeams(cfg: WebhookConfig, event: NotificationEvent): Promise<SendResult> {
    if (!cfg.enabled || !cfg.url) return { channel: 'teams', ok: false, error: 'disabled' };
    try {
        const card: any = {
            '@type': 'MessageCard',
            '@context': 'http://schema.org/extensions',
            themeColor: event.kind === 'execution-failed' ? 'D7263D' : event.kind === 'bug-created' ? 'F18F01' : '2E86AB',
            summary: event.title,
            title: event.title,
            sections: [
                { text: event.summary },
            ],
        };
        if (event.fields && event.fields.length > 0) {
            card.sections.push({
                facts: event.fields.map((f) => ({ name: f.label, value: f.value })),
            });
        }
        if (event.details) {
            card.sections.push({ text: '```' + event.details.slice(0, 2500) + '```' });
        }
        if (event.link) {
            card.potentialAction = [{
                '@type': 'OpenUri',
                name: event.link.label,
                targets: [{ os: 'default', uri: event.link.url }],
            }];
        }
        await axios.post(cfg.url, card, { timeout: 10000 });
        return { channel: 'teams', ok: true };
    } catch (e: any) {
        return { channel: 'teams', ok: false, error: e.message };
    }
}

async function sendGenericWebhook(cfg: WebhookConfig, event: NotificationEvent): Promise<SendResult> {
    if (!cfg.enabled || !cfg.url) return { channel: 'webhook', ok: false, error: 'disabled' };
    try {
        await axios.post(cfg.url, { event, timestamp: new Date().toISOString() }, { timeout: 10000 });
        return { channel: 'webhook', ok: true };
    } catch (e: any) {
        return { channel: 'webhook', ok: false, error: e.message };
    }
}

function escapeHtml(s: string) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function shouldDispatch(cfg: NotificationConfig, kind: NotificationEventKind): boolean {
    if (kind === 'test') return true;
    if (kind === 'execution-complete' && !cfg.triggerOnSuccess) return false;
    if (kind === 'execution-failed' && !cfg.triggerOnFailure) return false;
    if (kind === 'bug-created' && !cfg.triggerOnBugCreated) return false;
    return true;
}

/**
 * Fan out an event to every enabled channel. Each channel runs in parallel
 * and a failure on one does not block the others.
 */
export async function dispatchNotification(event: NotificationEvent): Promise<SendResult[]> {
    const cfg = loadNotificationConfig();
    if (!shouldDispatch(cfg, event.kind)) {
        return [{ channel: 'all', ok: false, error: `trigger for "${event.kind}" disabled` }];
    }
    const results = await Promise.all([
        sendEmail(cfg.email, event),
        sendSlack(cfg.slack, event),
        sendTeams(cfg.teams, event),
        sendGenericWebhook(cfg.genericWebhook, event),
    ]);
    results.forEach((r) => {
        if (r.ok) console.log(`📣 Notification sent via ${r.channel}`);
        else if (r.error !== 'disabled') console.warn(`⚠️ ${r.channel} notification failed: ${r.error}`);
    });
    return results;
}
