import React, { useEffect, useState } from 'react';
import { X, ShieldCheck, Database, Cpu, Zap, Loader2, CheckCircle2, AlertCircle, Bell, Send, Sun, Moon, Palette } from 'lucide-react';
import { ALMProvider, LLMProvider, Connection, LLMConfig } from '../types';
import { verifyJiraConnection } from '../services/jiraService';
import { verifyOllama, verifyGroq, verifyOpenAI, verifyGemini } from '../services/llmService';
import {
  fetchNotificationConfig,
  saveNotificationConfig as saveNotifConfig,
  sendTestNotification,
  NotificationConfig,
} from '../services/notificationsService';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  connections: Connection[];
  onSaveConnections: (conns: Connection[]) => void;
  llmConfig: LLMConfig | null;
  onSaveLLM: (config: LLMConfig) => void;
  // Appearance tab — theme toggle moved here from the sidebar.
  isDarkMode: boolean;
  onToggleTheme: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  connections,
  onSaveConnections,
  llmConfig: initialLlmConfig,
  onSaveLLM,
  isDarkMode,
  onToggleTheme,
}) => {
  const [activeTab, setActiveTab] = useState<'jira' | 'llm' | 'notify' | 'appearance'>('jira');
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ status: 'success' | 'error' | 'warning', message: string } | null>(null);

  // Notification config — loaded lazily when the user enters the tab
  const [notifConfig, setNotifConfig] = useState<NotificationConfig | null>(null);
  const [notifLoading, setNotifLoading] = useState(false);
  const [notifSaving, setNotifSaving] = useState(false);
  const [notifTesting, setNotifTesting] = useState(false);

  useEffect(() => {
    if (activeTab !== 'notify' || notifConfig) return;
    setNotifLoading(true);
    fetchNotificationConfig()
      .then(setNotifConfig)
      .catch((e) => setTestResult({ status: 'error', message: `Failed to load notification config: ${e.message}` }))
      .finally(() => setNotifLoading(false));
  }, [activeTab, notifConfig]);

  const updateNotif = (patch: Partial<NotificationConfig>) =>
    setNotifConfig((prev) => (prev ? { ...prev, ...patch } : prev));
  const updateNotifEmail = (patch: Partial<NotificationConfig['email']>) =>
    setNotifConfig((prev) => (prev ? { ...prev, email: { ...prev.email, ...patch } } : prev));
  const updateNotifChannel = (
    channel: 'slack' | 'teams' | 'genericWebhook',
    patch: Partial<NotificationConfig['slack']>
  ) =>
    setNotifConfig((prev) => (prev ? { ...prev, [channel]: { ...prev[channel], ...patch } } : prev));

  const handleSaveNotifications = async () => {
    if (!notifConfig) return;
    setNotifSaving(true);
    setTestResult(null);
    try {
      await saveNotifConfig(notifConfig);
      setTestResult({ status: 'success', message: 'Notification settings saved.' });
    } catch (e: any) {
      setTestResult({ status: 'error', message: `Save failed: ${e.message}` });
    } finally {
      setNotifSaving(false);
    }
  };

  const handleSendTestNotification = async () => {
    setNotifTesting(true);
    setTestResult(null);
    try {
      // Save first so the latest values are used
      if (notifConfig) await saveNotifConfig(notifConfig);
      const { results } = await sendTestNotification();
      const okList = results.filter((r) => r.ok).map((r) => r.channel);
      const failList = results.filter((r) => !r.ok && r.error !== 'disabled');
      if (okList.length === 0 && failList.length === 0) {
        setTestResult({ status: 'warning', message: 'No channels are enabled. Toggle at least one.' });
      } else if (okList.length > 0 && failList.length === 0) {
        setTestResult({ status: 'success', message: `Sent to: ${okList.join(', ')}` });
      } else {
        const failMsg = failList.map((f) => `${f.channel}: ${f.error}`).join('; ');
        setTestResult({
          status: okList.length > 0 ? 'warning' : 'error',
          message: `${okList.length > 0 ? `Sent to ${okList.join(', ')}. ` : ''}Failed: ${failMsg}`,
        });
      }
    } catch (e: any) {
      setTestResult({ status: 'error', message: `Test failed: ${e.message}` });
    } finally {
      setNotifTesting(false);
    }
  };

  // Form State for Jira/ADO
  const [jiraForm, setJiraForm] = useState<Partial<Connection>>(
    connections[0] || { type: 'Jira', name: 'BSS_QA', url: '', email: '', apiToken: '' }
  );

  // Form State for LLM
  const [llmForm, setLlmForm] = useState<LLMConfig>(
    initialLlmConfig || { provider: 'Ollama', apiKey: '', baseUrl: 'http://localhost:11434', model: 'llama3' }
  );

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      let result: any;
      if (activeTab === 'jira') {
        result = await verifyJiraConnection(jiraForm as any);
        // Normalize: ensure there's always a message to display
        if (result.status === 'success' && !result.message) {
          result.message = '✅ Connection established successfully!';
        }
      } else {
        if (llmForm.provider === 'Ollama') {
          result = await verifyOllama(llmForm.baseUrl, llmForm.model, llmForm.apiKey);
        } else if (llmForm.provider === 'OpenAI') {
          result = await verifyOpenAI(llmForm.apiKey);
        } else if (llmForm.provider === 'Groq') {
          result = await verifyGroq(llmForm.apiKey);
        } else if (llmForm.provider === 'Gemini') {
          result = await verifyGemini(llmForm.apiKey);
        }
      }
      setTestResult(result as any);
    } catch (error: any) {
      setTestResult({ status: 'error', message: error.message });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSave = () => {
    if (activeTab === 'jira') {
      const newConn = { ...jiraForm, id: jiraForm.id || crypto.randomUUID() } as Connection;
      onSaveConnections([newConn]); // For now, single connection support
    } else {
      onSaveLLM(llmForm);
    }
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-300" onClick={onClose}></div>

      <div className="bg-white w-full max-w-2xl rounded-[2.5rem] shadow-2xl relative overflow-hidden flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-300">
        {/* Modal Header */}
        <div className="px-10 py-8 border-b border-slate-100 flex justify-between items-center bg-white sticky top-0 z-10">
          <div>
            <h2 className="text-2xl font-black text-slate-800 tracking-tight">Connectivity</h2>
            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-[0.2em] mt-1">Configure your AI & ALM Integrations</p>
          </div>
          <button onClick={onClose} className="p-3 hover:bg-slate-50 rounded-2xl transition-all text-slate-400 hover:text-slate-600 active:scale-95">
            <X size={20} />
          </button>
        </div>

        {/* Modal Tabs */}
        <div className="flex bg-slate-100/50 p-1.5 gap-1 m-8 rounded-2xl border border-slate-100/50">
          <button
            onClick={() => { setActiveTab('jira'); setTestResult(null); }}
            className={`flex-1 flex items-center justify-center gap-2.5 py-3 rounded-xl transition-all duration-300 font-black text-[11px] uppercase tracking-widest ${activeTab === 'jira' ? 'bg-white shadow-md text-blue-600 translate-y-[-1px]' : 'text-slate-400 hover:text-slate-500'
              }`}
          >
            <Database size={15} />
            Data Source
          </button>
          <button
            onClick={() => { setActiveTab('llm'); setTestResult(null); }}
            className={`flex-1 flex items-center justify-center gap-2.5 py-3 rounded-xl transition-all duration-300 font-black text-[11px] uppercase tracking-widest ${activeTab === 'llm' ? 'bg-white shadow-md text-blue-600 translate-y-[-1px]' : 'text-slate-400 hover:text-slate-500'
              }`}
          >
            <Cpu size={15} />
            LLM Brain
          </button>
          <button
            onClick={() => { setActiveTab('notify'); setTestResult(null); }}
            className={`flex-1 flex items-center justify-center gap-2.5 py-3 rounded-xl transition-all duration-300 font-black text-[11px] uppercase tracking-widest ${activeTab === 'notify' ? 'bg-white shadow-md text-blue-600 translate-y-[-1px]' : 'text-slate-400 hover:text-slate-500'
              }`}
          >
            <Bell size={15} />
            Notifications
          </button>
          <button
            onClick={() => { setActiveTab('appearance'); setTestResult(null); }}
            className={`flex-1 flex items-center justify-center gap-2.5 py-3 rounded-xl transition-all duration-300 font-black text-[11px] uppercase tracking-widest ${activeTab === 'appearance' ? 'bg-white shadow-md text-blue-600 translate-y-[-1px]' : 'text-slate-400 hover:text-slate-500'
              }`}
          >
            <Palette size={15} />
            Appearance
          </button>
        </div>

        {/* Modal Body */}
        <div className="px-10 pb-10 overflow-y-auto flex-1">
          {activeTab === 'appearance' ? (
            <div className="space-y-6">
              <div>
                <label className="block text-[9px] font-black uppercase tracking-[0.3em] text-slate-400 mb-3 ml-1">Theme</label>
                <div className="flex gap-3">
                  <button
                    onClick={() => { if (isDarkMode) onToggleTheme(); }}
                    className={`flex-1 flex items-center gap-3 px-5 py-4 rounded-xl border-2 transition-all ${
                      !isDarkMode
                        ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <Sun size={18} />
                    <div className="text-left">
                      <p className="text-sm font-bold">Light</p>
                      <p className="text-[10px] text-slate-400 dark:text-slate-500">Bright backgrounds</p>
                    </div>
                  </button>
                  <button
                    onClick={() => { if (!isDarkMode) onToggleTheme(); }}
                    className={`flex-1 flex items-center gap-3 px-5 py-4 rounded-xl border-2 transition-all ${
                      isDarkMode
                        ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <Moon size={18} />
                    <div className="text-left">
                      <p className="text-sm font-bold">Dark</p>
                      <p className="text-[10px] text-slate-400 dark:text-slate-500">Reduced eye strain</p>
                    </div>
                  </button>
                </div>
                <p className="text-[11px] text-slate-400 mt-3 ml-1">Your choice is saved to localStorage and applied immediately.</p>
              </div>
            </div>
          ) : activeTab === 'notify' ? (
            notifLoading || !notifConfig ? (
              <div className="flex items-center justify-center py-20 text-slate-400">
                <Loader2 size={20} className="animate-spin mr-2" /> Loading notification settings...
              </div>
            ) : (
              <div className="space-y-8">
                <div>
                  <p className="text-[9px] font-black uppercase tracking-[0.3em] text-slate-400 mb-3">Triggers</p>
                  <div className="grid grid-cols-3 gap-3">
                    {(['triggerOnSuccess', 'triggerOnFailure', 'triggerOnBugCreated'] as const).map((k) => (
                      <label key={k} className={`flex items-center gap-3 p-4 rounded-2xl border cursor-pointer transition-all ${
                        notifConfig[k]
                          ? 'bg-blue-50 border-blue-200'
                          : 'bg-slate-50/50 border-slate-200'
                      }`}>
                        <input
                          type="checkbox"
                          checked={notifConfig[k]}
                          onChange={(e) => updateNotif({ [k]: e.target.checked } as any)}
                          className="h-4 w-4"
                        />
                        <span className="text-xs font-bold text-slate-700">
                          {k === 'triggerOnSuccess' ? 'On Success' : k === 'triggerOnFailure' ? 'On Failure' : 'Bug Created'}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Email */}
                <div className="rounded-2xl border border-slate-200 p-5 space-y-4">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={notifConfig.email.enabled}
                      onChange={(e) => updateNotifEmail({ enabled: e.target.checked })}
                      className="h-4 w-4"
                    />
                    <span className="text-xs font-black uppercase tracking-widest text-slate-700">Email (SMTP)</span>
                  </label>
                  {notifConfig.email.enabled && (
                    <div className="grid grid-cols-2 gap-4">
                      <input
                        type="text"
                        placeholder="SMTP Host (e.g. smtp.gmail.com)"
                        value={notifConfig.email.smtpHost}
                        onChange={(e) => updateNotifEmail({ smtpHost: e.target.value })}
                        className="bg-slate-50/50 border border-slate-200 rounded-xl px-4 py-3 text-xs font-bold"
                      />
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          placeholder="Port"
                          value={notifConfig.email.smtpPort}
                          onChange={(e) => updateNotifEmail({ smtpPort: Number(e.target.value) })}
                          className="w-24 bg-slate-50/50 border border-slate-200 rounded-xl px-4 py-3 text-xs font-bold"
                        />
                        <label className="flex items-center gap-2 text-xs font-bold text-slate-600">
                          <input
                            type="checkbox"
                            checked={notifConfig.email.smtpSecure}
                            onChange={(e) => updateNotifEmail({ smtpSecure: e.target.checked })}
                            className="h-4 w-4"
                          />
                          TLS/SSL
                        </label>
                      </div>
                      <input
                        type="text"
                        placeholder="SMTP Username"
                        value={notifConfig.email.smtpUser}
                        onChange={(e) => updateNotifEmail({ smtpUser: e.target.value })}
                        className="bg-slate-50/50 border border-slate-200 rounded-xl px-4 py-3 text-xs font-bold"
                      />
                      <input
                        type="password"
                        placeholder="SMTP Password / App Password"
                        value={notifConfig.email.smtpPass}
                        onChange={(e) => updateNotifEmail({ smtpPass: e.target.value })}
                        className="bg-slate-50/50 border border-slate-200 rounded-xl px-4 py-3 text-xs font-bold"
                      />
                      <input
                        type="text"
                        placeholder="From address"
                        value={notifConfig.email.fromAddress}
                        onChange={(e) => updateNotifEmail({ fromAddress: e.target.value })}
                        className="bg-slate-50/50 border border-slate-200 rounded-xl px-4 py-3 text-xs font-bold"
                      />
                      <input
                        type="text"
                        placeholder="To (comma-separated)"
                        value={notifConfig.email.toAddresses}
                        onChange={(e) => updateNotifEmail({ toAddresses: e.target.value })}
                        className="bg-slate-50/50 border border-slate-200 rounded-xl px-4 py-3 text-xs font-bold col-span-2"
                      />
                    </div>
                  )}
                </div>

                {/* Slack */}
                <div className="rounded-2xl border border-slate-200 p-5 space-y-4">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={notifConfig.slack.enabled}
                      onChange={(e) => updateNotifChannel('slack', { enabled: e.target.checked })}
                      className="h-4 w-4"
                    />
                    <span className="text-xs font-black uppercase tracking-widest text-slate-700">Slack (Incoming Webhook)</span>
                  </label>
                  {notifConfig.slack.enabled && (
                    <input
                      type="text"
                      placeholder="https://hooks.slack.com/services/..."
                      value={notifConfig.slack.url}
                      onChange={(e) => updateNotifChannel('slack', { url: e.target.value })}
                      className="w-full bg-slate-50/50 border border-slate-200 rounded-xl px-4 py-3 text-xs font-bold font-mono"
                    />
                  )}
                </div>

                {/* Teams */}
                <div className="rounded-2xl border border-slate-200 p-5 space-y-4">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={notifConfig.teams.enabled}
                      onChange={(e) => updateNotifChannel('teams', { enabled: e.target.checked })}
                      className="h-4 w-4"
                    />
                    <span className="text-xs font-black uppercase tracking-widest text-slate-700">Microsoft Teams (Webhook)</span>
                  </label>
                  {notifConfig.teams.enabled && (
                    <input
                      type="text"
                      placeholder="https://yourorg.webhook.office.com/..."
                      value={notifConfig.teams.url}
                      onChange={(e) => updateNotifChannel('teams', { url: e.target.value })}
                      className="w-full bg-slate-50/50 border border-slate-200 rounded-xl px-4 py-3 text-xs font-bold font-mono"
                    />
                  )}
                </div>

                {/* Generic */}
                <div className="rounded-2xl border border-slate-200 p-5 space-y-4">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={notifConfig.genericWebhook.enabled}
                      onChange={(e) => updateNotifChannel('genericWebhook', { enabled: e.target.checked })}
                      className="h-4 w-4"
                    />
                    <span className="text-xs font-black uppercase tracking-widest text-slate-700">Generic Webhook</span>
                  </label>
                  {notifConfig.genericWebhook.enabled && (
                    <input
                      type="text"
                      placeholder="https://your-service.example.com/webhook"
                      value={notifConfig.genericWebhook.url}
                      onChange={(e) => updateNotifChannel('genericWebhook', { url: e.target.value })}
                      className="w-full bg-slate-50/50 border border-slate-200 rounded-xl px-4 py-3 text-xs font-bold font-mono"
                    />
                  )}
                </div>
              </div>
            )
          ) : activeTab === 'jira' ? (
            <div className="space-y-8">
              <div className="grid grid-cols-2 gap-6">
                <div className="col-span-1">
                  <label className="block text-[9px] font-black uppercase tracking-[0.3em] text-slate-400 mb-3 ml-1">Platform</label>
                  <select
                    value={jiraForm.type}
                    onChange={(e) => setJiraForm({ ...jiraForm, type: e.target.value as ALMProvider })}
                    className="w-full bg-slate-50/50 border border-slate-200 rounded-2xl px-5 py-4 font-bold text-xs text-slate-700 outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500/30 transition-all appearance-none cursor-pointer"
                  >
                    <option>Jira</option>
                    <option>ADO</option>
                    <option>X-Ray</option>
                  </select>
                </div>
                <div className="col-span-1">
                  <label className="block text-[9px] font-black uppercase tracking-[0.3em] text-slate-400 mb-3 ml-1">Label</label>
                  <input
                    type="text"
                    value={jiraForm.name}
                    onChange={(e) => setJiraForm({ ...jiraForm, name: e.target.value })}
                    placeholder="e.g. BSS_QA"
                    className="w-full bg-slate-50/50 border border-slate-200 rounded-2xl px-5 py-4 font-bold text-xs outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500/30 transition-all"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[9px] font-black uppercase tracking-[0.3em] text-slate-400 mb-3 ml-1">Instance URL</label>
                <input
                  type="text"
                  value={jiraForm.url}
                  onChange={(e) => setJiraForm({ ...jiraForm, url: e.target.value })}
                  placeholder="https://your-domain.atlassian.net"
                  className="w-full bg-slate-50/50 border border-slate-200 rounded-2xl px-5 py-4 font-bold text-xs outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500/30 transition-all"
                />
              </div>

              <div className="grid grid-cols-2 gap-6">
                <div>
                  <label className="block text-[9px] font-black uppercase tracking-[0.3em] text-slate-400 mb-3 ml-1">Auth Email</label>
                  <input
                    type="text"
                    value={jiraForm.email}
                    onChange={(e) => setJiraForm({ ...jiraForm, email: e.target.value })}
                    placeholder="admin@example.com"
                    className="w-full bg-slate-50/50 border border-slate-200 rounded-2xl px-5 py-4 font-bold text-xs outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500/30 transition-all"
                  />
                </div>
                <div>
                  <label className="block text-[9px] font-black uppercase tracking-[0.3em] text-slate-400 mb-3 ml-1">API Token</label>
                  <input
                    type="password"
                    value={jiraForm.apiToken}
                    onChange={(e) => setJiraForm({ ...jiraForm, apiToken: e.target.value })}
                    placeholder="••••••••••••"
                    className="w-full bg-slate-50/50 border border-slate-200 rounded-2xl px-5 py-4 font-bold text-xs outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500/30 transition-all"
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-8">
              <div>
                <label className="block text-[9px] font-black uppercase tracking-[0.3em] text-slate-400 mb-4 ml-1">Intelligence Provider</label>
                <div className="grid grid-cols-4 gap-4">
                  {(['Ollama', 'Groq', 'OpenAI', 'Gemini'] as LLMProvider[]).map(p => (
                    <button
                      key={p}
                      onClick={() => {
                        const defaultModels: Record<string, string> = {
                          'Ollama': 'llama3',
                          'Groq': 'llama3-70b-8192',
                          'OpenAI': 'gpt-4o',
                          'Gemini': 'gemini-1.5-pro'
                        };
                        const isDefaultModel = Object.values(defaultModels).includes(llmForm.model) || llmForm.model === '';
                        setLlmForm({
                          ...llmForm,
                          provider: p,
                          model: isDefaultModel ? defaultModels[p] : llmForm.model,
                          baseUrl: p === 'Ollama' ? 'http://localhost:11434' : ''
                        });
                        setTestResult(null);
                      }}
                      className={`py-5 border rounded-2xl font-black text-[10px] uppercase tracking-widest transition-all duration-300 ${llmForm.provider === p
                          ? 'bg-blue-600 border-blue-600 text-white shadow-xl shadow-blue-100 -translate-y-1'
                          : 'bg-slate-50/50 border-slate-200 text-slate-400 hover:border-blue-300 hover:text-blue-500'
                        }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-6">
                {llmForm.provider === 'Ollama' ? (
                  <div className="space-y-6 animate-in fade-in duration-300">
                    <div className="grid grid-cols-2 gap-6">
                      <div>
                        <label className="block text-[9px] font-black uppercase tracking-[0.3em] text-slate-400 mb-3 ml-1">Endpoint URL</label>
                        <input
                          type="text"
                          value={llmForm.baseUrl}
                          onChange={(e) => setLlmForm({ ...llmForm, baseUrl: e.target.value })}
                          placeholder="http://localhost:11434"
                          className="w-full bg-slate-50/50 border border-slate-200 rounded-2xl px-5 py-4 font-bold text-xs outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500/30 transition-all"
                        />
                      </div>
                      <div>
                        <label className="block text-[9px] font-black uppercase tracking-[0.3em] text-slate-400 mb-3 ml-1">Model Name</label>
                        <input
                          type="text"
                          value={llmForm.model}
                          onChange={(e) => setLlmForm({ ...llmForm, model: e.target.value })}
                          placeholder="e.g. llama3"
                          className="w-full bg-slate-50/50 border border-slate-200 rounded-2xl px-5 py-4 font-bold text-xs outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500/30 transition-all font-mono"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-[9px] font-black uppercase tracking-[0.3em] text-slate-400 mb-3 ml-1">Optional API Key / Token</label>
                      <input
                        type="password"
                        value={llmForm.apiKey}
                        onChange={(e) => setLlmForm({ ...llmForm, apiKey: e.target.value })}
                        placeholder="Leave empty for local Ollama"
                        className="w-full bg-slate-50/50 border border-slate-200 rounded-2xl px-5 py-4 font-bold text-xs outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500/30 transition-all"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-6 animate-in fade-in duration-300">
                    <div>
                      <label className="block text-[9px] font-black uppercase tracking-[0.3em] text-slate-400 mb-3 ml-1">Security API Key</label>
                      <input
                        type="password"
                        value={llmForm.apiKey}
                        onChange={(e) => setLlmForm({ ...llmForm, apiKey: e.target.value })}
                        placeholder={llmForm.provider === 'Groq' ? 'gsk_••••••••••••' : llmForm.provider === 'Gemini' ? 'AIza••••••••••••' : 'sk-••••••••••••'}
                        className="w-full bg-slate-50/50 border border-slate-200 rounded-2xl px-5 py-4 font-bold text-xs outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500/30 transition-all"
                      />
                    </div>
                    <div>
                      <label className="block text-[9px] font-black uppercase tracking-[0.3em] text-slate-400 mb-3 ml-1">Model Name</label>
                      <input
                        type="text"
                        value={llmForm.model}
                        onChange={(e) => setLlmForm({ ...llmForm, model: e.target.value })}
                        placeholder={llmForm.provider === 'Groq' ? 'llama3-70b-8192' : llmForm.provider === 'Gemini' ? 'gemini-1.5-pro' : 'gpt-4'}
                        className="w-full bg-slate-50/50 border border-slate-200 rounded-2xl px-5 py-4 font-bold text-xs outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500/30 transition-all font-mono"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Test Status Feedback */}
          {testResult && (
            <div className={`mt-8 p-5 rounded-2xl border flex items-start gap-4 animate-in slide-in-from-top-4 duration-500 ${testResult.status === 'success'
                ? 'bg-emerald-50 border-emerald-100 text-emerald-800'
                : testResult.status === 'warning'
                  ? 'bg-amber-50 border-amber-100 text-amber-800'
                  : 'bg-rose-50 border-rose-100 text-rose-800'
              }`}>
              <div className="mt-0.5">
                {testResult.status === 'success' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
              </div>
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest mb-1">Handshake Status</p>
                <p className="text-sm font-bold leading-relaxed">{testResult.message || (testResult.status === 'success' ? 'Connection established successfully!' : 'Connection failed.')}</p>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-10 py-8 border-t border-slate-100 flex gap-4 bg-slate-50/50">
          {activeTab === 'appearance' ? (
            // Theme saves on click via onToggleTheme — no Save/Test buttons needed.
            <button
              onClick={onClose}
              className="flex-1 bg-gradient-to-r from-blue-600 to-blue-700 text-white py-4 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] hover:shadow-xl hover:shadow-blue-200 transition-all flex items-center justify-center gap-2 active:scale-95"
            >
              Done
            </button>
          ) : activeTab === 'notify' ? (
            <>
              <button
                onClick={handleSendTestNotification}
                disabled={notifTesting || !notifConfig}
                className="flex-[0.4] border border-slate-200 bg-white py-4 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] text-slate-500 hover:text-blue-600 hover:border-blue-200 hover:bg-blue-50/30 transition-all flex items-center justify-center gap-3 active:scale-95 disabled:opacity-50"
              >
                {notifTesting ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
                Send Test
              </button>
              <button
                onClick={handleSaveNotifications}
                disabled={notifSaving || !notifConfig}
                className="flex-1 bg-gradient-to-r from-blue-600 to-blue-700 text-white py-4 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] hover:shadow-xl hover:shadow-blue-200 transition-all flex items-center justify-center gap-2 active:scale-95 group disabled:opacity-60"
              >
                {notifSaving ? <Loader2 size={16} className="animate-spin" /> : null}
                Save Notification Settings
                <Zap size={16} className="group-hover:fill-current" />
              </button>
            </>
          ) : (
            <>
              <button
                onClick={handleTestConnection}
                disabled={isTesting}
                className="flex-[0.4] border border-slate-200 bg-white py-4 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] text-slate-500 hover:text-blue-600 hover:border-blue-200 hover:bg-blue-50/30 transition-all flex items-center justify-center gap-3 active:scale-95 disabled:opacity-50"
              >
                {isTesting ? <Loader2 size={18} className="animate-spin" /> : <ShieldCheck size={18} />}
                Test
              </button>
              <button
                onClick={handleSave}
                className="flex-1 bg-gradient-to-r from-blue-600 to-blue-700 text-white py-4 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] hover:shadow-xl hover:shadow-blue-200 transition-all flex items-center justify-center gap-2 active:scale-95 group"
              >
                Save Configuration
                <Zap size={16} className="group-hover:fill-current" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
