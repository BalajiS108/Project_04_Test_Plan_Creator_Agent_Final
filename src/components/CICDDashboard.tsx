import React, { useEffect, useState } from 'react';
import {
  ChevronLeft, Workflow, Loader2, RefreshCw, Play, ExternalLink,
  CheckCircle2, XCircle, Clock, AlertTriangle, ShieldCheck, Save, Settings as SettingsIcon,
} from 'lucide-react';
import {
  fetchCicdConfig, saveCicdConfig, testCicdConnection,
  fetchRecentRuns, triggerWorkflow, listCicdWorkflows,
  CICDConfigView, RunSummary,
} from '../services/cicdService';

interface CICDDashboardProps {
  onBack: () => void;
}

export const CICDDashboard: React.FC<CICDDashboardProps> = ({ onBack }) => {
  const [config, setConfig] = useState<CICDConfigView | null>(null);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [isLoadingConfig, setIsLoadingConfig] = useState(true);
  const [isLoadingRuns, setIsLoadingRuns] = useState(false);
  const [isTriggering, setIsTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [triggerReason, setTriggerReason] = useState('');

  // Setup form state
  const [formOwner, setFormOwner] = useState('');
  const [formRepo, setFormRepo] = useState('');
  const [formToken, setFormToken] = useState('');
  const [formWorkflow, setFormWorkflow] = useState('e2e-tests.yml');
  const [formBranch, setFormBranch] = useState('main');
  const [isSaving, setIsSaving] = useState(false);
  const [isTestingConn, setIsTestingConn] = useState(false);
  const [availableWorkflows, setAvailableWorkflows] = useState<{ name: string; path: string }[]>([]);

  const loadConfig = async () => {
    setIsLoadingConfig(true);
    try {
      const c = await fetchCicdConfig();
      setConfig(c);
      setFormOwner(c.owner);
      setFormRepo(c.repo);
      setFormWorkflow(c.workflowFile);
      setFormBranch(c.defaultBranch);
      setFormToken(c.tokenSet ? '••••••••' : '');
      // Open the setup form on first visit
      if (!c.owner || !c.repo || !c.tokenSet) setShowSettings(true);
    } catch (e: any) {
      setError(`Could not load config: ${e.response?.data?.error || e.message}`);
    } finally {
      setIsLoadingConfig(false);
    }
  };

  const loadRuns = async () => {
    if (!config || !config.owner || !config.repo || !config.tokenSet) return;
    setIsLoadingRuns(true);
    setError(null);
    try {
      const r = await fetchRecentRuns(20);
      setRuns(r);
    } catch (e: any) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setIsLoadingRuns(false);
    }
  };

  useEffect(() => { loadConfig(); }, []);
  useEffect(() => { loadRuns(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [config?.owner, config?.repo, config?.workflowFile, config?.tokenSet]);

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const saved = await saveCicdConfig({
        owner: formOwner.trim(),
        repo: formRepo.trim(),
        // Only send token if user typed something new (not the placeholder)
        token: formToken && formToken !== '••••••••' ? formToken : undefined,
        workflowFile: formWorkflow.trim() || 'e2e-tests.yml',
        defaultBranch: formBranch.trim() || 'main',
      });
      setConfig(saved);
      setSuccess('CI/CD settings saved.');
      setShowSettings(false);
    } catch (e: any) {
      setError(`Save failed: ${e.response?.data?.error || e.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestConn = async () => {
    setIsTestingConn(true);
    setError(null);
    setSuccess(null);
    try {
      // Save first so the test uses what's currently typed
      if (formToken && formToken !== '••••••••') {
        await saveCicdConfig({
          owner: formOwner.trim(),
          repo: formRepo.trim(),
          token: formToken,
          workflowFile: formWorkflow.trim() || 'e2e-tests.yml',
          defaultBranch: formBranch.trim() || 'main',
        });
      }
      const result = await testCicdConnection();
      if (result.ok) {
        setSuccess(`Connected as ${result.login || 'unknown'}.`);
        // While we're at it, fetch workflows to help pick one
        try {
          const wfs = await listCicdWorkflows();
          setAvailableWorkflows(wfs.map((w) => ({ name: w.name, path: w.path })));
        } catch { /* swallow */ }
      } else {
        setError(`Connection failed: ${result.error}`);
      }
    } catch (e: any) {
      setError(`Test failed: ${e.response?.data?.error || e.message}`);
    } finally {
      setIsTestingConn(false);
    }
  };

  const handleTrigger = async () => {
    setIsTriggering(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await triggerWorkflow(undefined, triggerReason || 'Triggered from UI');
      setSuccess(`Pipeline triggered on "${result.branch}". GitHub takes ~5s to register the run — click Refresh shortly.`);
      // Poll once after a short delay so the new run appears
      setTimeout(() => { loadRuns(); }, 5000);
    } catch (e: any) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setIsTriggering(false);
    }
  };

  if (isLoadingConfig) {
    return (
      <div className="w-full max-w-6xl mx-auto py-32 flex flex-col items-center text-slate-400 dark:text-slate-500">
        <Loader2 size={32} className="animate-spin mb-4" />
        <p className="text-sm font-medium">Loading CI/CD config...</p>
      </div>
    );
  }

  const configured = !!(config && config.owner && config.repo && config.tokenSet);
  const summary = (() => {
    if (!runs) return null;
    const recent = runs.slice(0, 30);
    const completed = recent.filter((r) => r.status === 'completed');
    const successful = completed.filter((r) => r.conclusion === 'success').length;
    const failed = completed.filter((r) => r.conclusion === 'failure').length;
    const running = recent.filter((r) => r.status !== 'completed').length;
    const passRate = completed.length > 0 ? Math.round((successful / completed.length) * 100) : 0;
    return { total: recent.length, successful, failed, running, passRate };
  })();

  return (
    <div className="w-full max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="p-2 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800" title="Back to wizard">
            <ChevronLeft size={16} />
          </button>
          <div>
            <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
              <Workflow size={20} /> CI/CD
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
              GitHub Actions runs for this project's workflow.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {configured && (
            <button
              onClick={() => setShowSettings((v) => !v)}
              className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-bold ${showSettings ? 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'}`}
            >
              <SettingsIcon size={14} /> Settings
            </button>
          )}
          {configured && (
            <button onClick={loadRuns} disabled={isLoadingRuns} className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200 text-slate-600 text-xs font-bold hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
              {isLoadingRuns ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Refresh
            </button>
          )}
        </div>
      </div>

      {success && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm dark:bg-emerald-900/20 dark:border-emerald-800 dark:text-emerald-300 flex items-start justify-between gap-3">
          <div className="flex gap-2 items-start"><CheckCircle2 size={14} className="mt-0.5" />{success}</div>
          <button onClick={() => setSuccess(null)} className="opacity-60 hover:opacity-100"><XCircle size={14} /></button>
        </div>
      )}
      {error && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm dark:bg-red-900/20 dark:border-red-800 dark:text-red-300 flex items-start justify-between gap-3">
          <div className="flex gap-2 items-start"><XCircle size={14} className="mt-0.5" />{error}</div>
          <button onClick={() => setError(null)} className="opacity-60 hover:opacity-100"><XCircle size={14} /></button>
        </div>
      )}

      {/* Settings form (shown when unconfigured or when toggled) */}
      {(showSettings || !configured) && (
        <div className="bg-white border border-slate-200 rounded-2xl p-6 mb-6 dark:bg-slate-900 dark:border-slate-800">
          <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 mb-4 flex items-center gap-2">
            <SettingsIcon size={14} /> GitHub repository connection
          </h3>
          {!configured && (
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
              Connect to a GitHub repository that contains the <code className="font-mono">.github/workflows/e2e-tests.yml</code> file. You need a Personal Access Token with <strong>repo</strong> + <strong>workflow</strong> scopes — generate one at <a className="text-blue-600 hover:underline" href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noopener noreferrer">github.com/settings/tokens</a>.
            </p>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>GitHub Owner / Org</Label>
              <input type="text" value={formOwner} onChange={(e) => setFormOwner(e.target.value)} placeholder="e.g. yourusername" className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-medium focus:ring-2 focus:ring-blue-500 outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100" />
            </div>
            <div>
              <Label>Repository Name</Label>
              <input type="text" value={formRepo} onChange={(e) => setFormRepo(e.target.value)} placeholder="e.g. test-plan-agent" className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-medium focus:ring-2 focus:ring-blue-500 outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100" />
            </div>
            <div className="md:col-span-2">
              <Label>Personal Access Token</Label>
              <input type="password" value={formToken} onChange={(e) => setFormToken(e.target.value)} placeholder="ghp_..." className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 font-mono text-sm focus:ring-2 focus:ring-blue-500 outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100" />
              <p className="text-[10px] text-slate-400 mt-1">Stored encrypted on the backend, never sent to the browser.</p>
            </div>
            <div>
              <Label>Workflow File</Label>
              <input list="workflow-list" type="text" value={formWorkflow} onChange={(e) => setFormWorkflow(e.target.value)} placeholder="e2e-tests.yml" className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 font-mono text-sm focus:ring-2 focus:ring-blue-500 outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100" />
              <datalist id="workflow-list">
                {availableWorkflows.map((w) => <option key={w.path} value={w.path.split('/').pop()} />)}
              </datalist>
            </div>
            <div>
              <Label>Default Branch</Label>
              <input type="text" value={formBranch} onChange={(e) => setFormBranch(e.target.value)} placeholder="main" className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 font-mono text-sm focus:ring-2 focus:ring-blue-500 outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100" />
            </div>
          </div>
          <div className="flex items-center gap-3 mt-4">
            <button onClick={handleTestConn} disabled={isTestingConn || !formToken || !formOwner || !formRepo} className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-200 text-slate-600 text-xs font-bold hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
              {isTestingConn ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
              Test Connection
            </button>
            <button onClick={handleSave} disabled={isSaving || !formOwner || !formRepo} className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 text-white text-xs font-bold hover:bg-blue-700 disabled:opacity-50">
              {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save
            </button>
          </div>
        </div>
      )}

      {configured && !showSettings && (
        <>
          {summary && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <SummaryTile label="Recent Runs" value={summary.total} accent="blue" />
              <SummaryTile label="Successful" value={summary.successful} accent="emerald" />
              <SummaryTile label="Failed" value={summary.failed} accent="red" />
              <SummaryTile label="Pass Rate" value={`${summary.passRate}%`} accent="violet" />
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-2xl p-6 mb-6 dark:bg-slate-900 dark:border-slate-800">
            <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 mb-3 flex items-center gap-2">
              <Play size={14} /> Trigger pipeline manually
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">Runs the workflow on branch <span className="font-mono">{config?.defaultBranch}</span> via <code>workflow_dispatch</code>.</p>
            <div className="flex items-center gap-3">
              <input
                type="text"
                value={triggerReason}
                onChange={(e) => setTriggerReason(e.target.value)}
                placeholder="Reason (optional)"
                className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm font-medium focus:ring-2 focus:ring-blue-500 outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
              />
              <button onClick={handleTrigger} disabled={isTriggering} className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 disabled:opacity-50">
                {isTriggering ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                Run pipeline
              </button>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden dark:bg-slate-900 dark:border-slate-800">
            <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">Recent runs</h3>
              {runs && <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{runs.length}</span>}
            </div>
            {!runs ? (
              <div className="py-16 text-center text-slate-400 dark:text-slate-500 text-sm">
                <Loader2 size={20} className="inline animate-spin mr-2" /> Loading runs…
              </div>
            ) : runs.length === 0 ? (
              <div className="py-16 text-center text-slate-400 dark:text-slate-500 text-sm">
                No runs yet — push to the repo or click "Run pipeline" above.
              </div>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-[500px] overflow-y-auto">
                {runs.map((r) => <RunRow key={r.id} run={r} />)}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

/* ──────────────────────────────────────────────────────────────────── */

const Label: React.FC<React.PropsWithChildren> = ({ children }) => (
  <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2 dark:text-slate-400">{children}</p>
);

const SummaryTile: React.FC<{ label: string; value: string | number; accent: string }> = ({ label, value, accent }) => {
  const cls: Record<string, string> = {
    blue: 'text-blue-600 dark:text-blue-400',
    emerald: 'text-emerald-600 dark:text-emerald-400',
    red: 'text-red-600 dark:text-red-400',
    violet: 'text-violet-600 dark:text-violet-400',
  };
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4 dark:bg-slate-900 dark:border-slate-800">
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">{label}</p>
      <p className={`text-2xl font-black ${cls[accent]}`}>{value}</p>
    </div>
  );
};

const RunRow: React.FC<{ run: RunSummary }> = ({ run }) => {
  const icon = (() => {
    if (run.status !== 'completed') return <Clock size={14} className="text-amber-500 animate-pulse" />;
    if (run.conclusion === 'success') return <CheckCircle2 size={14} className="text-emerald-500" />;
    if (run.conclusion === 'failure') return <XCircle size={14} className="text-red-500" />;
    if (run.conclusion === 'cancelled') return <AlertTriangle size={14} className="text-slate-400" />;
    return <AlertTriangle size={14} className="text-orange-500" />;
  })();
  const statusLabel = run.status === 'completed' ? (run.conclusion || 'completed') : run.status;
  const eventColor: Record<string, string> = {
    push: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800',
    pull_request: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-900/30 dark:text-violet-400 dark:border-violet-800',
    schedule: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800',
    workflow_dispatch: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800',
  };
  return (
    <a href={run.htmlUrl} target="_blank" rel="noopener noreferrer" className="px-6 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/40 flex items-center gap-4 transition-colors">
      {icon}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-slate-800 truncate dark:text-slate-200">
          {run.displayTitle || run.name}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded border ${eventColor[run.event] || 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700'}`}>
            {run.event}
          </span>
          <span className="text-[10px] text-slate-400 dark:text-slate-500">{run.branch}</span>
          <span className="text-[10px] text-slate-400 dark:text-slate-500">·</span>
          <span className="text-[10px] text-slate-400 dark:text-slate-500">{formatDate(run.createdAt)}</span>
          {run.actor && (
            <>
              <span className="text-[10px] text-slate-400 dark:text-slate-500">·</span>
              <span className="text-[10px] text-slate-500 dark:text-slate-400">{run.actor}</span>
            </>
          )}
        </div>
      </div>
      <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded ${
        statusLabel === 'success' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
        : statusLabel === 'failure' ? 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400'
        : 'bg-slate-50 text-slate-700 dark:bg-slate-800 dark:text-slate-400'
      }`}>
        {statusLabel}
      </span>
      {run.durationMs != null && (
        <span className="text-[10px] text-slate-400 dark:text-slate-500 w-12 text-right">{(run.durationMs / 1000).toFixed(0)}s</span>
      )}
      <ExternalLink size={12} className="text-slate-300 dark:text-slate-600" />
    </a>
  );
};

function formatDate(iso: string): string {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
