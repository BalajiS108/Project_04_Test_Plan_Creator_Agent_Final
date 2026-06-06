import React, { useEffect, useState } from 'react';
import {
  FileText, Download, Clipboard, RefreshCcw, Play,
  CheckCircle2, XCircle, AlertTriangle, Clock,
  ChevronDown, ChevronRight, BarChart3, FileSpreadsheet,
  Zap, Activity, Code2, TrendingUp, Shield, Target,
  FolderOpen, Loader2, Bug, ExternalLink, Sparkles, Bot, Upload, RefreshCw, Link2
} from 'lucide-react';
import { parseTestPlanMarkdown } from '../utils/testPlanParser';
import { pushTestCases, syncExecutionResults, SyncResultPayload, TestManagementProvider } from '../services/jiraTestSync';
import { backendUrl as resolveBackendUrl } from '../services/backendUrl';

interface StepResult {
  step: string;
  result: string;
  passed: boolean;
}

interface TestCaseResult {
  id: number;
  name: string;
  jiraKey: string;
  priority: string;
  status: 'PASS' | 'FAIL' | 'SKIPPED' | 'ERROR';
  steps: StepResult[];
  expectedResult: string;
  actualResult: string;
  duration: number;
  error?: string;
  videoFile?: string;
  testData?: string;
  // Set by the self-healing pass in /api/run-playwright when a test that
  // initially failed was rewritten by the LLM and then passed on re-run.
  healed?: boolean;
  healingFailed?: boolean;
}

interface ExecutionReport {
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    errors: number;
    duration: number;
    executedAt: string;
  };
  results: TestCaseResult[];
}

interface TestPlanViewProps {
  plan: string;
  productName: string;
  llmConfig: any;
  connection?: any;
  projectKey?: string;
  // Opens the Execution History Trends view. Wired from App.tsx so the
  // button lives next to "View HTML Report" instead of in the sidebar.
  onOpenHistory?: () => void;
}

export const TestPlanView: React.FC<TestPlanViewProps> = ({ plan, productName, llmConfig, connection, projectKey, onOpenHistory }) => {
  const [isExecuting, setIsExecuting] = useState(false);
  const [report, setReport] = useState<ExecutionReport | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [reportDownloadUrl, setReportDownloadUrl] = useState<string | null>(null);
  const [htmlReportUrl, setHtmlReportUrl] = useState<string | null>(null);
  const [expandedCases, setExpandedCases] = useState<Set<number>>(new Set());
  const [isPartialReport, setIsPartialReport] = useState(false);
  const [scriptsUrl, setScriptsUrl] = useState<string | null>(null);
  const [generatedScriptPath, setGeneratedScriptPath] = useState<string | null>(null);
  // Script Library — shows the 5 most recently generated specs in tests/generated/.
  // Useful for re-running a past spec without regenerating (which is non-deterministic).
  type ScriptTestEntry = string | { name: string; status?: 'PASS' | 'FAIL' | 'SKIPPED'; duration?: number; error?: string };
  type ScriptLibraryEntry = {
    name: string;
    path: string;
    relativePath: string;
    size: number;
    created: string;
    tests?: ScriptTestEntry[];
    lastRun?: { executedAt: string; passed: number; failed: number; skipped: number; total: number; duration: number };
  };
  const SCRIPT_LIBRARY_VISIBLE = 5;
  const [showScriptLibrary, setShowScriptLibrary] = useState(false);
  const [scriptLibrary, setScriptLibrary] = useState<ScriptLibraryEntry[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [runningScript, setRunningScript] = useState<string | null>(null);
  // Per-spec expansion state — lets the user reveal the test titles
  // inside a saved spec (with their last-run PASS/FAIL status) on demand.
  const [expandedSpecs, setExpandedSpecs] = useState<Set<string>>(new Set());
  const [executionProgress, setExecutionProgress] = useState<{
    currentCase: string;
    currentCaseId?: string;
    currentCaseName?: string;
    progress: number;
    total: number;
    action: string;
  }>({
    currentCase: '',
    progress: 0,
    total: 0,
    action: ''
  });
  const [executionMethod, setExecutionMethod] = useState<'mcp' | 'codegen'>('mcp');
  // Browser visibility — applies to MCP mode, codegen mode, AND Script Library
  // runs. Backend forwards this through to the playwright launch (MCP via
  // MCP_HEADLESS env var, codegen via CodeGenConfig.headless, CLI via --headed).
  // Default true (headed) preserves the original MCP behavior users were used to.
  const [headedMode, setHeadedMode] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return true;
    const saved = localStorage.getItem('tp_headed_mode');
    return saved === null ? true : saved === '1';
  });
  useEffect(() => {
    try { localStorage.setItem('tp_headed_mode', headedMode ? '1' : '0'); } catch { /* noop */ }
  }, [headedMode]);

  // Jira bug creation state
  const [createdBugs, setCreatedBugs] = useState<Record<number, { issueKey: string; issueUrl: string }>>({}); 
  const [creatingBugFor, setCreatingBugFor] = useState<number | null>(null);
  const [bugError, setBugError] = useState<string | null>(null);

  // Auto-heal toggle
  // Default Auto-Heal to ON — if the user forgets to toggle, they still get
  // the benefit of automatic selector recovery on failures. Persisted so an
  // explicit OFF survives reloads.
  const [autoHealEnabled, setAutoHealEnabled] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return true;
    const saved = localStorage.getItem('tp_auto_heal');
    return saved === null ? true : saved === '1';
  });
  useEffect(() => {
    try { localStorage.setItem('tp_auto_heal', autoHealEnabled ? '1' : '0'); } catch { /* noop */ }
  }, [autoHealEnabled]);

  // Concurrency selector (parallel MCP execution). Default 1 = sequential
  // (current behavior preserved). Persisted in localStorage so the user's
  // pick survives reloads. Range 1-5.
  const [concurrency, setConcurrency] = useState<number>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('tp_mcp_concurrency') : null;
    const n = Number(saved);
    return Number.isFinite(n) && n >= 1 && n <= 5 ? n : 1;
  });
  useEffect(() => {
    try { localStorage.setItem('tp_mcp_concurrency', String(concurrency)); } catch { /* quota */ }
  }, [concurrency]);

  // Multi-worker live status (only populated when concurrency > 1 and the
  // backend has parallel mode running). Each entry is one worker slot.
  interface WorkerLiveStatus {
    workerId: number;
    currentCase: string;
    currentCaseId?: string;
    currentCaseName?: string;
    progress: number;
    total: number;
    action?: string;
  }
  const [workerStatuses, setWorkerStatuses] = useState<WorkerLiveStatus[]>([]);

  // Jira test-case sync state
  // Mapping keys are parsed-test-case IDs ("TC-1") OR runtime test IDs ("1");
  // we look up by both forms to bridge the parse/execute boundary.
  const mappingStorageKey = (() => {
    const conn = (connection as any)?.id || 'noconn';
    const proj = projectKey || 'noproj';
    return `tp_jira_tc_mapping::${conn}::${proj}`;
  })();
  const [tcMapping, setTcMapping] = useState<Record<string, string>>({});
  const [jiraBaseUrl, setJiraBaseUrl] = useState<string>('');
  const [isPushing, setIsPushing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [pushSyncMessage, setPushSyncMessage] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);
  // Persisted test-management provider so users don't re-select between sessions
  const [tmProvider, setTmProvider] = useState<TestManagementProvider>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('tp_test_mgmt_provider') : null;
    return (saved === 'xray' ? 'xray' : 'jira-native') as TestManagementProvider;
  });
  useEffect(() => {
    try { localStorage.setItem('tp_test_mgmt_provider', tmProvider); } catch { /* quota */ }
  }, [tmProvider]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(mappingStorageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        setTcMapping(parsed.mapping || {});
        setJiraBaseUrl(parsed.baseUrl || '');
      } else {
        setTcMapping({});
        setJiraBaseUrl('');
      }
    } catch { /* corrupt entry — ignore */ }
  }, [mappingStorageKey]);

  const persistMapping = (mapping: Record<string, string>, baseUrl: string) => {
    try {
      localStorage.setItem(mappingStorageKey, JSON.stringify({ mapping, baseUrl }));
    } catch { /* quota — ignore */ }
  };

  const parsedTestCases = React.useMemo(() => parseTestPlanMarkdown(plan || ''), [plan]);
  const linkedCount = Object.keys(tcMapping).length;

  // Resolve the Jira key for a given execution result.
  //
  // The mapping is keyed by whatever the markdown parser produced as `tcId`
  // (could be "TC-1", "1", "TC-001", or just the test name). The execution
  // report uses a numeric `id` and a `jiraKey` field whose meaning differs
  // per execution mode. We try multiple strategies, falling back from
  // exact-match to positional-by-index to name-based and finally numeric.
  const resolveJiraKey = (tc: TestCaseResult): string | undefined => {
    // 1. Exact match on the result's own jiraKey
    if (tc.jiraKey && tcMapping[tc.jiraKey]) return tcMapping[tc.jiraKey];

    // 2. Positional: the n-th executed test maps to the n-th pushed test
    //    (most reliable because both lists are built from the same plan)
    const positional = parsedTestCases[tc.id - 1];
    if (positional && tcMapping[positional.tcId]) return tcMapping[positional.tcId];

    // 3. Canonical "TC-N" form
    const tcDashId = `TC-${tc.id}`;
    if (tcMapping[tcDashId]) return tcMapping[tcDashId];

    // 4. Case-insensitive scan
    const targets = [tc.jiraKey, tcDashId, String(tc.id)].filter(Boolean).map((s) => s!.toLowerCase());
    for (const [k, v] of Object.entries(tcMapping)) {
      if (targets.includes(k.toLowerCase())) return v;
    }

    // 5. Numeric-only match: "TC-001" matches id=1, "1" matches id=1, etc.
    const numeric = String(tc.id);
    for (const [k, v] of Object.entries(tcMapping)) {
      const stripped = k.replace(/\D/g, '').replace(/^0+/, '') || k.replace(/\D/g, '');
      if (stripped === numeric) return v;
    }

    // 6. Name-based fuzzy match against parsedTestCases as a bridge
    if (tc.name) {
      const cleanName = tc.name.replace(/^TC-?\d+[:\s]*/i, '').trim().toLowerCase();
      if (cleanName) {
        for (const p of parsedTestCases) {
          const pName = p.name.toLowerCase().trim();
          if (pName && (pName === cleanName || pName.includes(cleanName) || cleanName.includes(pName))) {
            if (tcMapping[p.tcId]) return tcMapping[p.tcId];
          }
        }
      }
    }

    return undefined;
  };

  // Format Jira keys for status messages: "KAN-1, KAN-2, KAN-3" up to N,
  // then "+M more" so a long list doesn't blow out the banner.
  const formatJiraKeys = (keys: string[], max: number = 5): string => {
    const unique = Array.from(new Set(keys.filter(Boolean)));
    if (unique.length === 0) return '';
    if (unique.length <= max) return unique.join(', ');
    return `${unique.slice(0, max).join(', ')}, +${unique.length - max} more`;
  };

  const handlePushToJira = async () => {
    if (!connection) {
      setPushSyncMessage({ kind: 'error', text: 'Configure a Jira connection in Settings first.' });
      return;
    }
    if (parsedTestCases.length === 0) {
      setPushSyncMessage({ kind: 'error', text: 'No test cases parsed from the plan. Try regenerating with a table format.' });
      return;
    }

    // Decide whether projectKey looks like a parent issue (e.g. "KAN-5") vs a
    // plain project key ("KAN"). If it's an issue key, push as Sub-tasks.
    const isIssueKey = !!projectKey && /-\d+$/.test(projectKey);
    const cleanProjectKey = isIssueKey ? projectKey!.split('-')[0] : (projectKey || '');
    const parentIssueKey = isIssueKey ? projectKey : undefined;

    if (!cleanProjectKey) {
      setPushSyncMessage({ kind: 'error', text: 'No Jira project key. Go back to Step 2 and enter one.' });
      return;
    }

    // Only push cases that aren't already mapped
    const toPush = parsedTestCases.filter((tc) => !tcMapping[tc.tcId]);
    if (toPush.length === 0) {
      // List ONLY the keys linked to the CURRENT plan's test cases, not the
      // full historical tcMapping (which could include past pushes from
      // other plans for the same project — confusing).
      const existingKeys = formatJiraKeys(parsedTestCases.map((tc) => tcMapping[tc.tcId]).filter(Boolean));
      setPushSyncMessage({
        kind: 'info',
        text: existingKeys
          ? `All ${parsedTestCases.length} test cases already linked to Jira: ${existingKeys}.`
          : `All ${parsedTestCases.length} test cases already linked to Jira.`,
      });
      return;
    }

    setIsPushing(true);
    setPushSyncMessage({ kind: 'info', text: `Pushing ${toPush.length} test case${toPush.length === 1 ? '' : 's'} to Jira...` });
    try {
      const result = await pushTestCases(connection, cleanProjectKey, parentIssueKey, toPush, tmProvider);
      const merged = { ...tcMapping, ...result.mapping };
      setTcMapping(merged);
      setJiraBaseUrl(result.baseUrl);
      persistMapping(merged, result.baseUrl);

      // Newly-created keys come from this push (result.mapping), so users
      // see exactly which Jira issues were just created — not the full
      // historical mapping.
      const newKeys = formatJiraKeys(Object.values(result.mapping));
      if (result.errors.length === 0) {
        setPushSyncMessage({
          kind: 'success',
          text: newKeys
            ? `Pushed ${result.count}/${result.total} test cases to Jira: ${newKeys}.`
            : `Pushed ${result.count}/${result.total} test cases to Jira.`,
        });
      } else {
        setPushSyncMessage({
          kind: 'error',
          text: `Pushed ${result.count}/${result.total}${newKeys ? ` (${newKeys})` : ''}. Errors: ${result.errors.slice(0, 2).map(e => `${e.tcId}: ${e.error}`).join('; ')}${result.errors.length > 2 ? '...' : ''}`,
        });
      }
    } catch (e: any) {
      setPushSyncMessage({ kind: 'error', text: `Failed to push: ${e.response?.data?.error || e.message}` });
    } finally {
      setIsPushing(false);
    }
  };

  const handleSyncResults = async () => {
    if (!connection) {
      setPushSyncMessage({ kind: 'error', text: 'Configure a Jira connection in Settings first.' });
      return;
    }
    if (!report || report.results.length === 0) {
      setPushSyncMessage({ kind: 'error', text: 'No execution results to sync. Run the tests first.' });
      return;
    }

    const payload: SyncResultPayload[] = [];
    const orphans: string[] = [];
    for (const tc of report.results) {
      const jiraKey = resolveJiraKey(tc);
      if (!jiraKey) {
        orphans.push(`TC-${tc.id}`);
        continue;
      }
      payload.push({
        tcId: `TC-${tc.id}`,
        jiraKey,
        status: tc.status,
        duration: tc.duration,
        actualResult: tc.actualResult,
        error: tc.error,
      });
    }

    if (payload.length === 0) {
      // Surface enough detail that the user can see WHY nothing matched.
      const resultLabels = report.results.slice(0, 4).map((tc) => `${tc.jiraKey || `TC-${tc.id}`}/"${tc.name?.slice(0, 30) || ''}"`).join(', ');
      const mappingKeys = Object.keys(tcMapping).slice(0, 4).join(', ');
      const reasonText = linkedCount === 0
        ? 'The Jira mapping is empty for this connection+project. Click Push to Jira first to create the link.'
        : `Could not match any of the ${report.results.length} executed test cases to the ${linkedCount} linked Jira issues. Result IDs: [${resultLabels}${report.results.length > 4 ? '...' : ''}]. Mapping keys: [${mappingKeys}${linkedCount > 4 ? '...' : ''}].`;
      setPushSyncMessage({ kind: 'error', text: reasonText });
      // Also dump full state to the console so we can debug quickly
      // eslint-disable-next-line no-console
      console.warn('[sync] no matches', { mapping: tcMapping, results: report.results.map((r) => ({ id: r.id, jiraKey: r.jiraKey, name: r.name })) });
      return;
    }

    setIsSyncing(true);
    setPushSyncMessage({
      kind: 'info',
      text: `Syncing ${payload.length} result${payload.length === 1 ? '' : 's'}${orphans.length ? ` (${orphans.length} not yet linked)` : ''}...`,
    });
    try {
      // Always transition Jira workflow status as part of sync (best-effort:
      // logs a warning if the project's workflow doesn't expose Done/etc.).
      const result = await syncExecutionResults(connection, payload, tmProvider, projectKey, true);
      const xrayNote = result.testExecutionKey
        ? ` · Xray Test Execution created: ${result.testExecutionKey}`
        : '';
      // Tell the user exactly which Jira issues were updated. Sync includes
      // every issue we sent in the payload minus those that errored — list
      // the ones we actually attempted (errors are reported separately).
      const erroredKeys = new Set(result.errors.map(e => e.jiraKey));
      const syncedKeys = formatJiraKeys(payload.map(p => p.jiraKey).filter(k => !erroredKeys.has(k)));
      if (result.errors.length === 0) {
        setPushSyncMessage({
          kind: 'success',
          text: syncedKeys
            ? `Synced ${result.count}/${result.total} results to Jira: ${syncedKeys}.${xrayNote}`
            : `Synced ${result.count}/${result.total} results to Jira.${xrayNote}`,
        });
      } else {
        setPushSyncMessage({
          kind: 'error',
          text: `Synced ${result.count}/${result.total}${syncedKeys ? ` (${syncedKeys})` : ''}.${xrayNote} Errors: ${result.errors.slice(0, 2).map(e => `${e.jiraKey}: ${e.error}`).join('; ')}${result.errors.length > 2 ? '...' : ''}`,
        });
      }
    } catch (e: any) {
      setPushSyncMessage({ kind: 'error', text: `Failed to sync: ${e.response?.data?.error || e.message}` });
    } finally {
      setIsSyncing(false);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(plan);
    alert("Copied to clipboard!");
  };

  const downloadMarkdown = () => {
    const element = document.createElement("a");
    const file = new Blob([plan], { type: 'text/markdown' });
    element.href = URL.createObjectURL(file);
    element.download = `${productName}_TestPlan.md`;
    document.body.appendChild(element);
    element.click();
  };

  const executeTests = async () => {
    setIsExecuting(true);
    setIsPartialReport(false);
    setExecutionError(null);
    setReport(null);
    setExecutionProgress({ currentCase: 'Starting...', progress: 0, total: 0, action: '' });
    setWorkerStatuses([]);

    const backendUrl = resolveBackendUrl();

    statusIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${backendUrl}/api/execution-status`);
        const data = await res.json();
        if (data.isRunning) {
          setExecutionProgress({
            currentCase: data.currentCase,
            currentCaseId: data.currentCaseId,
            currentCaseName: data.currentCaseName,
            progress: data.progress,
            total: data.total,
            action: data.action || ''
          });
          // Capture per-worker statuses when parallel mode is active
          if (Array.isArray(data.workers) && data.workers.length > 0) {
            setWorkerStatuses(data.workers);
          }
        }
      } catch (e) { }
    }, 1000);

    try {
      if (executionMethod === 'codegen') {
        // Run with Playwright Script Mode now ALWAYS regenerates the
        // .spec.ts from the current plan before running. The old behaviour
        // (reuse last saved spec, regenerate only via a separate "Save
        // Script File" button) confused users into thinking script mode
        // was running stale code. Generating fresh on each run matches
        // the user's mental model: "click Run → produce + execute the
        // script for what's on screen right now". The trade-off is that
        // LLM non-determinism can yield slightly different specs between
        // back-to-back runs — that's acceptable cost for the clearer UX.
        setExecutionProgress({ currentCase: 'Generating Playwright script from current plan…', progress: 0, total: 0, action: 'Asking the LLM to write the test code' });
        const genRes = await fetch(`${backendUrl}/api/generate-scripts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ testCases: plan, llmConfig, productName }),
        });
        const genData = await genRes.json();
        if (!genData.success || !genData.filePath) {
          throw new Error(genData.error || 'Script generation failed — nothing to run.');
        }
        setScriptsUrl(`${backendUrl}${genData.scriptUrl}`);
        setGeneratedScriptPath(genData.filePath || null);
        const scriptToRun: string = genData.fullPath || genData.filePath;
        const scriptDisplay = String(genData.filePath || '').split('/').pop() || 'generated.spec.ts';

        // Refresh Script Library in the background so the just-generated
        // spec shows up at the top of the list when the user opens it.
        fetchScriptLibrary().catch(() => { /* non-fatal */ });

        setExecutionProgress({ currentCase: `Running ${genData.filePath || scriptDisplay}`, progress: 0, total: 0, action: `npx playwright test ${genData.filePath || scriptDisplay}` });
        const runRes = await fetch(`${backendUrl}/api/run-playwright`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scriptPath: scriptToRun,
            headed: headedMode,
            // Self-healing: if any test fails, ask the LLM to rewrite just
            // those tests using the live failure DOM, then re-run them.
            autoHeal: autoHealEnabled,
            llmConfig,
          }),
        });
        const runData = await runRes.json();
        if (runData.report) {
          setReport(runData.report);
          // Explicitly mark as full report — guards against a late
          // stopExecution callback overwriting the title to "Partial".
          setIsPartialReport(false);
          if (runData.report.htmlReportUrl) setHtmlReportUrl(runData.report.htmlReportUrl);
          showBrowserNotification(runData.report);
        } else if (runData.success === false) {
          setExecutionError(runData.error || 'Playwright execution failed.');
        } else {
          // No JSON report parsed — surface the raw output for the user.
          setExecutionError(`Playwright produced no parsable report. Output: ${(runData.output || '').slice(-1000)}`);
        }
      } else {
        // MCP mode: live agent-driven execution
        const response = await fetch(`${backendUrl}/api/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            testCases: plan,
            llmConfig,
            autoHeal: autoHealEnabled,
            // Concurrency forced to 1 — parallel mode disabled in UI until we
            // address LLM-contention bottleneck. Backend still supports >1
            // if called directly. See agent.ts:runAgentParallel.
            concurrency: 1,
            headed: headedMode,
            productName,
          })
        });
        const data = await response.json();
        if (data.success) {
          setReport(data.report);
          // Explicit reset — see comment in codegen branch above.
          setIsPartialReport(false);
          setReportDownloadUrl(data.reportDownloadUrl ? `${backendUrl}${data.reportDownloadUrl}` : null);
          setHtmlReportUrl(data.htmlReportUrl ? `${backendUrl}${data.htmlReportUrl}` : null);
          showBrowserNotification(data.report);
        } else {
          setExecutionError(data.error || 'Execution failed.');
        }
      }
    } catch (err: any) {
      console.error('Execution error:', err);
      setExecutionError(`Failed to connect to backend at ${backendUrl}. Ensure the backend server is running on port 3001.`);
    } finally {
      clearInterval(statusIntervalRef.current);
      setIsExecuting(false);
    }
  };

  // Best-effort desktop notification. Silently no-ops if the user has denied
  // permission or the API isn't available (e.g. unsupported browser).
  const showBrowserNotification = (rep: ExecutionReport) => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    const fire = () => {
      const failed = rep.summary.failed + rep.summary.errors;
      const passed = rep.summary.passed;
      const total = rep.summary.total;
      const title = failed > 0
        ? `❌ ${failed}/${total} tests failed${productName ? ` — ${productName}` : ''}`
        : `✅ ${passed}/${total} tests passed${productName ? ` — ${productName}` : ''}`;
      const body = `Duration ${(rep.summary.duration / 1000).toFixed(1)}s · ${new Date().toLocaleTimeString()}`;
      try {
        new Notification(title, { body, tag: 'test-execution' });
      } catch { /* some browsers throw if permission was revoked between request and create */ }
    };
    if (Notification.permission === 'granted') {
      fire();
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then((perm) => { if (perm === 'granted') fire(); });
    }
  };

  const statusIntervalRef = React.useRef<any>(null);

  const fetchScriptLibrary = async () => {
    const res = await fetch(`${resolveBackendUrl()}/api/list-scripts`);
    const data = await res.json();
    setScriptLibrary(data.scripts || []);
  };

  // User-facing: open the panel and fetch fresh data.
  const openScriptLibrary = async () => {
    setLoadingLibrary(true);
    try {
      await fetchScriptLibrary();
      setShowScriptLibrary(true);
    } catch (e) {
      alert('Failed to load script library');
    } finally {
      setLoadingLibrary(false);
    }
  };

  const runScript = async (scriptPath: string, scriptName: string) => {
    setRunningScript(scriptName);
    setReport(null);
    setIsPartialReport(false);
    setIsExecuting(true);
    // Show the script being run in the "Now executing" banner.
    const relForBanner = scriptPath.replace(/\\/g, '/').replace(/^.*?(tests\/generated\/)/, '$1');
    setGeneratedScriptPath(relForBanner);
    setExecutionProgress({
      currentCase: `Launching: ${scriptName}`,
      currentCaseId: 'SCRIPT',
      currentCaseName: scriptName,
      action: `npx playwright test ${relForBanner}`,
      progress: 0,
      total: 0
    });

    const backendUrl = resolveBackendUrl();

    statusIntervalRef.current = setInterval(async () => {
      try {
        const r = await fetch(`${backendUrl}/api/execution-status`);
        const d = await r.json();
        if (d.isRunning) {
          setExecutionProgress({
            currentCase: d.currentCase,
            currentCaseId: d.currentCaseId,
            currentCaseName: d.currentCaseName,
            progress: d.progress,
            total: d.total,
            action: d.action || ''
          });
        }
      } catch { /* best-effort polling */ }
    }, 1000);

    try {
      const res = await fetch(`${backendUrl}/api/run-playwright`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scriptPath, headed: headedMode, autoHeal: autoHealEnabled, llmConfig })
      });
      const data = await res.json();
      if (data.report) {
        setReport(data.report);
        setIsPartialReport(false);
        showBrowserNotification(data.report);
        setShowScriptLibrary(false);
        if (data.report.htmlReportUrl) setHtmlReportUrl(data.report.htmlReportUrl);
      } else if (data.success === false) {
        setExecutionError(data.error || 'Playwright execution failed.');
      }
    } catch (e: any) {
      console.error('Run script error:', e);
      setExecutionError(`Failed to run ${scriptName}: ${e.message}`);
    } finally {
      clearInterval(statusIntervalRef.current);
      setRunningScript(null);
      setIsExecuting(false);
      setExecutionProgress({ currentCase: '', currentCaseId: '', currentCaseName: '', action: '', progress: 0, total: 0 });
    }
  };

  const stopExecution = async () => {
    try {
      clearInterval(statusIntervalRef.current);
      const backendUrl = resolveBackendUrl();

      // 1. Signal backend to stop (kills both MCP and script-mode processes)
      await fetch(`${backendUrl}/api/stop`, { method: 'POST' });
      setIsExecuting(false);
      setRunningScript(null);
      setExecutionProgress({ currentCase: 'Stopping... fetching partial results', progress: 0, total: 0, action: 'Stopping...' });

      // 2. Wait briefly for in-flight test case to finish writing its result
      await new Promise(r => setTimeout(r, 800));

      // 3. Fetch whatever completed so far
      const partialRes = await fetch(`${backendUrl}/api/partial-results`);
      const partialData = await partialRes.json();

      if (partialData.hasResults) {
        setReport(partialData as ExecutionReport);
        setReportDownloadUrl(partialData.reportDownloadUrl ? `${backendUrl}${partialData.reportDownloadUrl}` : null);
        setHtmlReportUrl(partialData.htmlReportUrl ? partialData.htmlReportUrl : null);
        setIsPartialReport(true);
      } else {
        setExecutionProgress({ currentCase: 'Stopped — no completed tests to show', progress: 0, total: 0, action: '' });
        setTimeout(() => setExecutionProgress({ currentCase: '', progress: 0, total: 0, action: '' }), 2000);
      }
    } catch (e) {
      console.error('Error stopping execution:', e);
      setIsExecuting(false);
      setRunningScript(null);
    }
  };

  // Jira Bug Creation
  const createBugInJira = async (tc: TestCaseResult) => {
    if (!connection) {
      setBugError('No Jira connection configured. Go to Settings → Data Source.');
      return;
    }

    // Smart Project Key Extraction: Try prop first, then extract from jiraKey
    let effectiveProjectKey = projectKey;
    
    // If the projectKey itself looks like an issue key (e.g., KAN-2), strip the suffix
    if (effectiveProjectKey && effectiveProjectKey.includes('-')) {
      effectiveProjectKey = effectiveProjectKey.split('-')[0];
    }

    if (!effectiveProjectKey && tc.jiraKey && tc.jiraKey !== 'N/A' && tc.jiraKey !== 'DEFAULT') {
      // Skip synthetic test-case identifiers — they are not Jira project keys
      const isTestCaseId = /^(TC|TS|TEST|CODEGEN)-?\d*$/i.test(tc.jiraKey);
      if (!isTestCaseId) {
        const match = tc.jiraKey.match(/^([A-Z0-9]+)-/);
        if (match) effectiveProjectKey = match[1];
      }
    }

    if (!effectiveProjectKey) {
      console.warn('⚠️ No project key could be determined for bug creation.', { projectKey, jiraKey: tc.jiraKey });
      setBugError('No project key available. Please enter a Project Key in Step 2 or ensure issues have keys like PROJ-123.');
      return;
    }

    console.log(`🐛 Creating bug for ${tc.id} with project key: ${effectiveProjectKey}`);
    setCreatingBugFor(tc.id);
    setBugError(null);

    const backendUrl = resolveBackendUrl();

    try {
      const res = await fetch(`${backendUrl}/api/jira/create-bug`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection, projectKey: effectiveProjectKey, testCase: tc })
      });
      const data = await res.json();
      if (data.success) {
        setCreatedBugs(prev => ({ ...prev, [tc.id]: { issueKey: data.issueKey, issueUrl: data.issueUrl } }));
      } else {
        setBugError(`Failed to create bug: ${data.error}`);
      }
    } catch (e: any) {
      setBugError(`Error creating bug: ${e.message}`);
    } finally {
      setCreatingBugFor(null);
    }
  };

  const toggleExpand = (id: number) => {
    setExpandedCases(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case 'PASS': return <CheckCircle2 size={18} className="text-emerald-500" />;
      case 'FAIL': return <XCircle size={18} className="text-red-500" />;
      case 'ERROR': return <AlertTriangle size={18} className="text-orange-500" />;
      default: return <Clock size={18} className="text-slate-400" />;
    }
  };

  const statusBadge = (status: string) => {
    const colors: Record<string, string> = {
      PASS: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800',
      FAIL: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800',
      ERROR: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800',
      SKIPPED: 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
    };
    return (
      <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border ${colors[status] || colors.SKIPPED}`}>
        {status}
      </span>
    );
  };

  const priorityBadge = (priority: string) => {
    const colors: Record<string, string> = {
      high: 'text-red-600 bg-red-50 border-red-200',
      medium: 'text-orange-600 bg-orange-50 border-orange-200',
      low: 'text-blue-600 bg-blue-50 border-blue-200',
    };
    return (
      <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-widest border ${colors[priority.toLowerCase()] || colors.medium}`}>
        {priority}
      </span>
    );
  };

  const renderPlanContent = (planText: string) => {
    const lines = planText.split('\n');
    const tableLines = lines.filter(l => l.trim().startsWith('|'));

    if (tableLines.length > 2) {
      const headers = tableLines[0].split('|').map(s => s.trim()).filter((_, i, arr) => !(i === 0 || i === arr.length - 1));
      const rows = tableLines.slice(2).map(line => line.split('|').map(s => s.trim()).filter((_, i, arr) => !(i === 0 || i === arr.length - 1)));

      const preTable = lines.slice(0, lines.indexOf(tableLines[0])).join('\n');
      const postTable = lines.slice(lines.indexOf(tableLines[tableLines.length - 1]) + 1).join('\n');

      return (
        <div className="relative z-10 w-full">
          {preTable.trim() && <pre className="whitespace-pre-wrap font-sans text-slate-700 leading-relaxed text-sm mb-6 dark:text-slate-300">{preTable}</pre>}
          <div className="overflow-x-auto border border-slate-200 dark:border-slate-700 rounded-xl shadow-sm">
            <table className="w-full text-left border-collapse min-w-[800px]">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700">
                  {headers.map((h, i) => <th key={i} className="p-4 text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400 border-r border-slate-200 dark:border-slate-700 last:border-0">{h}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-700 bg-white dark:bg-slate-900/50">
                {rows.map((row, i) => (
                  <tr key={i} className="hover:bg-blue-50/50 dark:hover:bg-slate-800/80 transition-colors">
                    <td className="px-3 py-3 align-top border-r border-slate-200 dark:border-slate-700 w-14">
                      <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-md bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 text-[10px] font-black tracking-wide border border-blue-100 dark:border-blue-800">
                        TC-{i + 1}
                      </span>
                    </td>
                    {row.map((cell, j) => {
                      const safeHtml = String(cell)
                        .replace(/\|/g, '')
                        .replace(/\n/g, '<br/>')
                        .replace(/^-\s+/gm, '• ');
                      return (
                        <td key={j} className="p-4 align-top text-xs leading-relaxed text-slate-700 dark:text-slate-300 border-r border-slate-200 dark:border-slate-700 last:border-0">
                          <div className="space-y-2" dangerouslySetInnerHTML={{ __html: safeHtml }} />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {postTable.trim() && <pre className="whitespace-pre-wrap font-sans text-slate-700 leading-relaxed text-sm mt-6 dark:text-slate-300">{postTable}</pre>}
        </div>
      );
    }

    return (
      <pre className="whitespace-pre-wrap font-sans text-slate-700 leading-relaxed text-sm overflow-x-hidden relative z-10 dark:text-slate-300">
        {planText}
      </pre>
    );
  };

  return (
    <div className="w-full">
      {/* Header Section */}
      <div className="flex justify-between items-center mb-10">
        <div>
          <h2 className="text-3xl font-bold text-slate-800 tracking-tight dark:text-slate-100">
            {report ? (isPartialReport ? '⏸ Partial Execution Report' : 'Execution Report') : 'Standardized Test Plan'}
          </h2>
          <p className="text-slate-500 font-medium tracking-wide dark:text-slate-400">Product: {productName || 'Default Project'}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={copyToClipboard}
            className="flex items-center gap-2 px-4 py-2.5 border border-slate-200 rounded-xl text-xs font-bold hover:bg-slate-50 transition-all text-slate-600 active:scale-95 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <Clipboard size={14} />
            Copy
          </button>
          <button
            onClick={downloadMarkdown}
            className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-xl text-xs font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-200 active:scale-95 dark:shadow-blue-900/30"
          >
            <Download size={14} />
            Download MD
          </button>
          {/* Execution Mode Toggle (MCP Mode / Playwright Script Mode) */}
          <div
            className="inline-flex items-center rounded-xl border border-slate-200 bg-white p-1 shadow-sm dark:border-slate-700 dark:bg-slate-800"
            role="tablist"
            aria-label="Execution Mode"
          >
            <button
              role="tab"
              aria-selected={executionMethod === 'mcp'}
              onClick={() => setExecutionMethod('mcp')}
              disabled={isExecuting}
              title="Live, agent-driven execution via Playwright MCP — supports self-healing on failure"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold tracking-wide transition-all disabled:opacity-50 ${
                executionMethod === 'mcp'
                  ? 'bg-gradient-to-r from-indigo-600 to-blue-600 text-white shadow-md'
                  : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              <Bot size={12} /> MCP Mode
            </button>
            <button
              role="tab"
              aria-selected={executionMethod === 'codegen'}
              onClick={() => setExecutionMethod('codegen')}
              disabled={isExecuting}
              title="Generate & execute reusable Playwright test code (.spec.ts)"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold tracking-wide transition-all disabled:opacity-50 ${
                executionMethod === 'codegen'
                  ? 'bg-gradient-to-r from-violet-600 to-purple-600 text-white shadow-md'
                  : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              <Code2 size={12} /> Playwright Script Mode
            </button>
          </div>

          {/* "Save Script File" removed — Run with Playwright Script Mode
              now generates the .spec.ts on every click, which matches the
              user's mental model. The post-run "Test Script Generated ✓"
              panel still offers a Download link for committing to git. */}
          <button
            onClick={executeTests}
            disabled={isExecuting || !plan}
            title={executionMethod === 'mcp'
              ? 'Run tests live via MCP — auto-heal supported'
              : 'Run tests by generating & executing Playwright code'}
            className={`flex items-center gap-2 px-4 py-2.5 text-white rounded-xl text-xs font-bold transition-all shadow-lg active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed ${
              executionMethod === 'mcp'
                ? 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 shadow-emerald-200 dark:shadow-emerald-900/30'
                : 'bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 shadow-violet-200 dark:shadow-violet-900/30'
            }`}
          >
            {isExecuting ? <RefreshCcw size={14} className="animate-spin" /> : <Play size={14} />}
            {isExecuting
              ? 'Running...'
              : executionMethod === 'mcp' ? 'Run with MCP Mode' : 'Run with Playwright Script Mode'}
          </button>
          {/* Concurrency selector — temporarily hidden after parallel mode
              didn't deliver the expected speedup (LLM contention dominates
              when N MCP servers share one API key). The code path is still
              wired so we can re-enable when the architecture is right.
              To re-enable: remove this `false &&` and the dropdown reappears. */}
          {false && (
            <div
              className={`inline-flex items-center gap-2 px-3 py-2 rounded-xl border bg-white dark:bg-slate-800 ${
                executionMethod === 'mcp' ? 'border-slate-200 dark:border-slate-700' : 'border-slate-100 dark:border-slate-800 opacity-50'
              }`}
            >
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">⚡ Workers</span>
              <select
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value))}
                disabled={isExecuting || executionMethod !== 'mcp'}
                className="bg-transparent text-xs font-bold text-slate-700 dark:text-slate-200 cursor-pointer focus:outline-none disabled:cursor-not-allowed"
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
          )}

          {/* Auto-Heal Toggle — works for MCP, codegen, AND Script Library runs.
              MCP: agent retries failed cases live with corrected selectors.
              Script/Library: after the Playwright run, failed tests are
              rewritten by the LLM using the actual failure DOM, then re-run. */}
          <button
            onClick={() => setAutoHealEnabled(!autoHealEnabled)}
            disabled={isExecuting}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition-all active:scale-95 border disabled:opacity-40 disabled:cursor-not-allowed ${
              autoHealEnabled
                ? 'bg-gradient-to-r from-amber-500 to-orange-500 text-white border-amber-400 shadow-lg shadow-amber-200 dark:shadow-amber-900/30'
                : 'bg-white text-slate-500 border-slate-200 hover:border-amber-300 hover:text-amber-600 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-400 dark:hover:border-amber-600'
            }`}
            title={
              autoHealEnabled
                ? 'After any test failure, the LLM rewrites just those tests using the actual failure DOM and re-runs them. Click to turn OFF.'
                : 'OFF: failed tests stay failed. Click to enable LLM-based self-healing for failed tests.'
            }
          >
            <Sparkles size={14} />
            {autoHealEnabled ? 'Auto-Heal ON' : 'Auto-Heal'}
          </button>

          {/* Headed/Headless Toggle — applies to MCP, codegen, and Script Library runs. */}
          <button
            onClick={() => setHeadedMode(!headedMode)}
            disabled={isExecuting}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition-all active:scale-95 border disabled:opacity-40 disabled:cursor-not-allowed ${
              headedMode
                ? 'bg-gradient-to-r from-sky-500 to-cyan-500 text-white border-sky-400 shadow-lg shadow-sky-200 dark:shadow-sky-900/30'
                : 'bg-white text-slate-500 border-slate-200 hover:border-sky-300 hover:text-sky-600 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-400 dark:hover:border-sky-600'
            }`}
            title={
              headedMode
                ? 'Browser is visible during the run — click to switch to headless (no window, ~20-30% faster).'
                : 'Browser runs hidden (headless, faster) — click to make the browser visible during the run.'
            }
          >
            <Activity size={14} />
            {headedMode ? 'Browser: Headed' : 'Browser: Headless'}
          </button>
          {isExecuting && (
            <button
              onClick={stopExecution}
              className="flex items-center gap-2 px-4 py-2.5 bg-red-600 text-white rounded-xl text-xs font-bold hover:bg-red-700 transition-all shadow-lg shadow-red-200 active:scale-95 dark:shadow-red-900/30"
            >
              <XCircle size={14} />
              Stop
            </button>
          )}

          {/* ── Jira Sync Buttons ─────────────────────────────────────── */}
          <div className="w-full" />

          {/* Test-management provider toggle */}
          <div
            className="inline-flex items-center rounded-xl border border-slate-200 bg-white p-1 dark:border-slate-700 dark:bg-slate-800"
            role="tablist"
            aria-label="Test Management Provider"
            title="How test cases are stored in Jira: native issue types (Sub-task/Task) or Xray-managed Test issues"
          >
            <button
              role="tab"
              aria-selected={tmProvider === 'jira-native'}
              onClick={() => setTmProvider('jira-native')}
              disabled={isPushing || isSyncing}
              className={`px-2.5 py-1 rounded-lg text-[10px] font-bold tracking-wide transition-all disabled:opacity-50 ${
                tmProvider === 'jira-native'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              Jira native
            </button>
            <button
              role="tab"
              aria-selected={tmProvider === 'xray'}
              onClick={() => setTmProvider('xray')}
              disabled={isPushing || isSyncing}
              className={`px-2.5 py-1 rounded-lg text-[10px] font-bold tracking-wide transition-all disabled:opacity-50 ${
                tmProvider === 'xray'
                  ? 'bg-violet-600 text-white shadow-sm'
                  : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              Xray
            </button>
          </div>

          <button
            onClick={handlePushToJira}
            disabled={isPushing || !plan || parsedTestCases.length === 0}
            title={
              !connection
                ? 'Configure a Jira connection in Settings first'
                : parsedTestCases.length === 0
                ? 'Generate a test plan with a markdown table first'
                : tmProvider === 'xray'
                  ? 'Create Xray-typed "Test" issues for each test case'
                  : `Create Jira ${projectKey && /-\d+$/.test(projectKey) ? 'Sub-tasks' : 'issues'} for each test case`
            }
            className="flex items-center gap-2 px-4 py-2.5 bg-white text-blue-700 border border-blue-200 rounded-xl text-xs font-bold hover:bg-blue-50 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-slate-800 dark:text-blue-300 dark:border-blue-800 dark:hover:bg-blue-900/20"
          >
            {isPushing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            {isPushing ? 'Pushing...' : 'Push to Jira'}
          </button>
          <button
            onClick={handleSyncResults}
            disabled={isSyncing || !report || !connection}
            title={
              !connection
                ? 'Configure a Jira connection in Settings first'
                : !report
                ? 'Run tests first — there are no results to sync'
                : linkedCount === 0
                ? 'Push test cases to Jira first so we know where to post comments'
                : 'Adds a PASS/FAIL comment AND transitions each linked Jira issue\'s workflow status (PASS → Done, FAIL → In Progress, falls back gracefully if those transitions don\'t exist in your project).'
            }
            className="flex items-center gap-2 px-4 py-2.5 bg-white text-emerald-700 border border-emerald-200 rounded-xl text-xs font-bold hover:bg-emerald-50 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-slate-800 dark:text-emerald-300 dark:border-emerald-800 dark:hover:bg-emerald-900/20"
          >
            {isSyncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {isSyncing ? 'Syncing...' : 'Sync Results to Jira'}
          </button>
          {linkedCount > 0 && (
            <span
              title={`Linked test cases will receive execution comments when you sync.`}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[10px] font-black uppercase tracking-widest text-slate-600 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300"
            >
              <Link2 size={11} />
              {linkedCount} linked
            </span>
          )}
        </div>
      </div>

      {/* ── Push / Sync status banner ──────────────────────────────────── */}
      {pushSyncMessage && (
        <div
          className={`mb-6 flex items-start justify-between gap-3 px-4 py-3 rounded-xl border text-xs font-medium ${
            pushSyncMessage.kind === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-900/20 dark:border-emerald-800 dark:text-emerald-300'
              : pushSyncMessage.kind === 'error'
                ? 'bg-red-50 border-red-200 text-red-700 dark:bg-red-900/20 dark:border-red-800 dark:text-red-300'
                : 'bg-blue-50 border-blue-200 text-blue-700 dark:bg-blue-900/20 dark:border-blue-800 dark:text-blue-300'
          }`}
        >
          <div className="flex items-start gap-2">
            {pushSyncMessage.kind === 'success' && <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0" />}
            {pushSyncMessage.kind === 'error' && <XCircle size={14} className="mt-0.5 flex-shrink-0" />}
            {pushSyncMessage.kind === 'info' && <Activity size={14} className="mt-0.5 flex-shrink-0" />}
            <span>{pushSyncMessage.text}</span>
          </div>
          <button onClick={() => setPushSyncMessage(null)} className="opacity-60 hover:opacity-100" aria-label="Dismiss">
            <XCircle size={14} />
          </button>
        </div>
      )}

      {/* ── Parallel mode: multi-worker live grid ─────────────────────── */}
      {isExecuting && workerStatuses.length > 1 && (
        <div className="mb-8 bg-gradient-to-r from-indigo-50 to-blue-50 border border-indigo-200 rounded-2xl p-6 dark:from-indigo-900/20 dark:to-blue-900/20 dark:border-indigo-800">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <Zap size={18} className="text-indigo-600 dark:text-indigo-400" />
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-indigo-600 dark:text-indigo-400">Parallel Execution</p>
                <p className="text-sm font-bold text-slate-800 dark:text-slate-100">
                  {workerStatuses.length} worker{workerStatuses.length === 1 ? '' : 's'} active
                </p>
              </div>
            </div>
            <div className="px-3 py-1 bg-white dark:bg-slate-800 rounded-full text-[10px] font-black uppercase tracking-widest text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800">
              Concurrency × {concurrency}
            </div>
          </div>
          <div className="space-y-2">
            {workerStatuses
              .slice()
              .sort((a, b) => a.workerId - b.workerId)
              .map((w) => (
                <div
                  key={w.workerId}
                  className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white border border-indigo-100 dark:bg-slate-900 dark:border-indigo-900/40"
                >
                  <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-indigo-600 text-white text-xs font-black flex-shrink-0">
                    W{w.workerId}
                  </span>
                  <RefreshCcw size={14} className="text-indigo-400 dark:text-indigo-500 animate-spin flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-slate-800 truncate dark:text-slate-100">
                      {w.currentCaseId && <span className="text-indigo-600 dark:text-indigo-400 mr-2">{w.currentCaseId}</span>}
                      {w.currentCaseName || w.currentCase || 'Initializing...'}
                    </p>
                    <p className="text-[11px] text-slate-500 truncate dark:text-slate-400">{w.action || 'Thinking...'}</p>
                  </div>
                  <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 flex-shrink-0">
                    {w.progress}/{w.total}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Codegen "what's running" banner — visible during the entire
          Playwright Script Mode run so the user can verify the exact
          .spec.ts being executed (matches the file under tests/generated/). */}
      {isExecuting && (executionMethod === 'codegen' || runningScript) && generatedScriptPath && (
        <div className="mb-4 flex items-center gap-3 px-4 py-3 rounded-xl bg-violet-50 border border-violet-200 dark:bg-violet-900/20 dark:border-violet-800">
          <Code2 size={14} className="text-violet-600 dark:text-violet-400 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-black uppercase tracking-widest text-violet-700 dark:text-violet-300">Now executing</p>
            <p className="text-[11px] font-mono text-violet-700 dark:text-violet-200 truncate">{generatedScriptPath}</p>
          </div>
          <span className="text-[10px] font-mono bg-slate-900 text-emerald-400 px-2 py-1 rounded hidden md:inline-block whitespace-nowrap">
            npx playwright test {generatedScriptPath}
          </span>
        </div>
      )}

      {/* Execution Progress Bar — sequential mode (single worker) */}
      {isExecuting && workerStatuses.length <= 1 && (
        <div className="mb-8 bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-200 rounded-2xl p-6 dark:from-emerald-900/20 dark:to-teal-900/20 dark:border-emerald-800">
          <div className="flex items-center gap-6">
            <div className="relative flex-shrink-0">
              <div className="w-16 h-16 rounded-full border-4 border-emerald-200 border-t-emerald-600 animate-spin dark:border-emerald-800 dark:border-t-emerald-400" />
              <Zap size={24} className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div className="flex-1">
              <div className="flex justify-between items-end mb-3">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-600 dark:text-emerald-400 mb-1">Live Automation Suite</p>
                  <div className="flex items-center gap-3">
                    <div className="px-2.5 py-1 bg-emerald-600 text-white text-[11px] font-black rounded-lg shadow-lg animate-pulse flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-white animate-ping" />
                      {executionProgress.currentCaseId || 'LIVE'}
                    </div>
                    <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100 transition-all duration-500 truncate max-w-md">
                      {executionProgress.currentCaseName || 'Initializing...'}
                    </h3>
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.8)]" />
                    <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                      {executionProgress.action || 'Thinking...'}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-2xl font-black text-emerald-600 dark:text-emerald-400">
                    {executionProgress.total > 0
                      ? Math.round((executionProgress.progress / executionProgress.total) * 100)
                      : 0}%
                  </span>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                    Test {executionProgress.progress || 0} of {executionProgress.total || 0}
                  </p>
                </div>
              </div>
              <div className="h-4 bg-emerald-100/50 rounded-full overflow-hidden p-1 dark:bg-emerald-900/30">
                <div
                  className="h-full bg-gradient-to-r from-emerald-500 to-teal-500 rounded-full transition-all duration-700 ease-out shadow-[0_0_12px_rgba(16,185,129,0.3)]"
                  style={{ width: `${executionProgress.total > 0 ? (executionProgress.progress / executionProgress.total) * 100 : 5}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Error Alert */}
      {executionError && (
        <div className="mb-8 bg-red-50 border border-red-200 rounded-2xl p-6 flex items-start gap-4 dark:bg-red-900/20 dark:border-red-800">
          <AlertTriangle className="text-red-500 flex-shrink-0 mt-0.5" size={20} />
          <div>
            <p className="font-bold text-red-700 dark:text-red-400">Execution Failed</p>
            <p className="text-sm text-red-600 dark:text-red-300 mt-1">{executionError}</p>
          </div>
        </div>
      )}

      {/* Script Generated Success Panel */}
      {generatedScriptPath && (
        <div className="mb-6 bg-violet-50 border border-violet-200 rounded-2xl p-5 dark:bg-violet-900/20 dark:border-violet-800">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="p-2 bg-violet-100 dark:bg-violet-800/50 rounded-xl flex-shrink-0">
                <Code2 size={16} className="text-violet-600 dark:text-violet-400" />
              </div>
              <div>
                <p className="font-bold text-violet-700 dark:text-violet-300 text-sm">Test Script Generated ✓</p>
                <p className="text-[11px] font-mono text-violet-600 dark:text-violet-400 mt-1 bg-violet-100 dark:bg-violet-900/40 px-2 py-1 rounded-lg border border-violet-200 dark:border-violet-700 inline-block">
                  {generatedScriptPath}
                </p>
                <p className="text-xs text-violet-500 dark:text-violet-400 mt-2">
                  Run it anytime: <span className="font-mono bg-slate-800 text-emerald-400 px-2 py-0.5 rounded text-[11px]">npx playwright test {generatedScriptPath}</span>
                </p>
              </div>
            </div>
            <div className="flex gap-2 flex-shrink-0">
              {scriptsUrl && (
                <a href={scriptsUrl} download className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-600 text-white rounded-lg text-xs font-bold hover:bg-violet-700 transition-all">
                  <Download size={12} /> Download
                </a>
              )}
              <button
                onClick={openScriptLibrary}
                disabled={loadingLibrary}
                title="Browse the 5 most recently saved specs — re-run without regenerating"
                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 text-white rounded-lg text-xs font-bold hover:bg-slate-800 transition-all disabled:opacity-60"
              >
                {loadingLibrary ? <RefreshCcw size={12} className="animate-spin" /> : <FolderOpen size={12} />}
                Saved Specs
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Saved Specs Panel — 5 most recently saved specs in tests/generated/.
          Useful for re-running a past spec without regenerating (LLM output
          is non-deterministic, so the script you just ran is the one the
          backend stored — running it again from here re-runs that exact code).
          Each row expands to reveal the test titles inside, annotated with
          their last-run PASS/FAIL status when known. */}
      {showScriptLibrary && (
        <div className="mb-6 bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-lg dark:bg-slate-900 dark:border-slate-800">
          <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 bg-gradient-to-r from-slate-50 to-slate-100 dark:from-slate-800 dark:to-slate-800/50 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-violet-100 dark:bg-violet-900/30 rounded-lg">
                <FolderOpen size={16} className="text-violet-600" />
              </div>
              <div>
                <h4 className="font-bold text-slate-800 dark:text-slate-100 text-sm">Saved Specs</h4>
                <p className="text-[10px] text-slate-400 font-mono">tests/generated/ · last {SCRIPT_LIBRARY_VISIBLE}</p>
              </div>
            </div>
            <button onClick={() => setShowScriptLibrary(false)} className="px-3 py-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors text-xs font-bold border border-slate-200 dark:border-slate-700 rounded-lg">✕ Close</button>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {(() => {
              if (scriptLibrary.length === 0) {
                return <div className="p-10 text-center text-slate-400">No scripts found in tests/generated/</div>;
              }
              const recent = [...scriptLibrary]
                .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime())
                .slice(0, SCRIPT_LIBRARY_VISIBLE);
              return recent.map((script) => {
                const lr = script.lastRun;
                const isRunning = runningScript === script.name;
                const isExpanded = expandedSpecs.has(script.path);
                // Normalize the two shapes the backend can return: bare string
                // (older saves) or { name, status, duration, error } object.
                const tests = (script.tests || []).map((t) => typeof t === 'string' ? { name: t } : t);
                const hasTests = tests.length > 0;
                const toggleExpand = () => {
                  setExpandedSpecs((prev) => {
                    const next = new Set(prev);
                    if (next.has(script.path)) next.delete(script.path);
                    else next.add(script.path);
                    return next;
                  });
                };
                return (
                  <div key={script.path}>
                    <div className="flex items-center gap-3 px-5 py-3.5 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                      <button
                        onClick={toggleExpand}
                        disabled={!hasTests}
                        title={!hasTests ? 'No tests detected in this spec' : isExpanded ? 'Hide test titles' : 'Show test titles'}
                        className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
                      >
                        {isExpanded
                          ? <ChevronDown size={14} className="text-slate-500" />
                          : <ChevronRight size={14} className="text-slate-500" />}
                      </button>
                      <div className="p-2 bg-violet-50 dark:bg-violet-900/20 rounded-lg flex-shrink-0">
                        <FileText size={14} className="text-violet-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-bold text-slate-800 dark:text-slate-200 truncate">{script.name}</p>
                          {hasTests && (
                            <span className="text-[10px] font-black uppercase tracking-widest text-violet-700 bg-violet-50 px-2 py-0.5 rounded-full border border-violet-100 dark:bg-violet-900/30 dark:text-violet-300 dark:border-violet-800 flex-shrink-0">
                              {tests.length} test{tests.length === 1 ? '' : 's'}
                            </span>
                          )}
                          {lr && (
                            <span
                              title={`Last run ${new Date(lr.executedAt).toLocaleString()} · ${(lr.duration / 1000).toFixed(1)}s`}
                              className="text-[10px] font-black uppercase tracking-widest text-slate-700 bg-white border border-slate-200 px-2 py-0.5 rounded-full flex items-center gap-1.5 flex-shrink-0 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300"
                            >
                              <span className="text-emerald-600 dark:text-emerald-400">✓ {lr.passed}</span>
                              <span className="text-slate-300 dark:text-slate-600">·</span>
                              <span className="text-red-600 dark:text-red-400">✘ {lr.failed}</span>
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] font-mono text-slate-400 truncate">{script.relativePath}</p>
                        <p className="text-[10px] text-slate-400">
                          {new Date(script.created).toLocaleString()} · {(script.size / 1024).toFixed(1)} KB
                        </p>
                      </div>
                      <button
                        onClick={() => runScript(script.path, script.name)}
                        disabled={isExecuting}
                        title={`Re-run this exact spec via npx playwright test ${script.relativePath}`}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-emerald-600 to-teal-600 text-white rounded-lg text-xs font-bold hover:from-emerald-700 hover:to-teal-700 transition-all disabled:opacity-60 flex-shrink-0"
                      >
                        {isRunning
                          ? <><RefreshCcw size={12} className="animate-spin" /> Running...</>
                          : <><Play size={12} /> Run</>}
                      </button>
                    </div>
                    {isExpanded && hasTests && (
                      <ol className="pl-16 pr-5 pb-3 space-y-1 bg-slate-50/50 dark:bg-slate-800/30">
                        {tests.map((t, i) => {
                          const statusIcon = t.status === 'PASS'
                            ? <CheckCircle2 size={12} className="text-emerald-500 flex-shrink-0" />
                            : t.status === 'FAIL'
                              ? <XCircle size={12} className="text-red-500 flex-shrink-0" />
                              : t.status === 'SKIPPED'
                                ? <span className="w-3 h-3 rounded-full bg-slate-300 dark:bg-slate-600 flex-shrink-0" title="Skipped" />
                                : <span className="w-3 h-3 rounded-full border border-slate-300 dark:border-slate-600 flex-shrink-0" title="Not run yet" />;
                          return (
                            <li key={i} className="text-[11px] text-slate-600 dark:text-slate-300 flex items-center gap-2 py-0.5">
                              <span className="text-slate-400 font-mono w-5 flex-shrink-0 text-right">{i + 1}.</span>
                              {statusIcon}
                              <span className="flex-1 truncate" title={t.error || t.name}>{t.name}</span>
                              {typeof t.duration === 'number' && t.duration > 0 && (
                                <span className="text-[10px] text-slate-400 tabular-nums">{(t.duration / 1000).toFixed(1)}s</span>
                              )}
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </div>
                );
              });
            })()}
          </div>
        </div>
      )}

      {/* ═══════════════ EXECUTION REPORT ═══════════════ */}
      {report && (
        <div className="space-y-6 mb-10">

          {/* Summary Dashboard */}
          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-lg dark:bg-slate-900 dark:border-slate-800">
            <div className="px-8 py-5 border-b border-slate-100 flex flex-wrap items-center gap-4 bg-slate-50/50 dark:bg-slate-800/50 dark:border-slate-700">
              <div className="flex items-center gap-3">
                <BarChart3 size={20} className="text-blue-600 dark:text-blue-400" />
                <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">Execution Summary</h3>
                <span className="text-xs text-slate-400 font-medium ml-2">
                  {new Date(report.summary.executedAt).toLocaleString()}
                </span>
              </div>
              
              <div className="ml-auto flex items-center gap-3">
                {/* Execution History Trends — moved here from the sidebar so
                    all report-related actions live together in the report
                    header. Calls back to App.tsx which switches to the
                    HistoryDashboard view. */}
                {onOpenHistory && (
                  <button
                    onClick={onOpenHistory}
                    title="Open the Execution History Trends dashboard (past runs, pass-rate trend, flakiest tests)"
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl text-[10px] font-black uppercase tracking-wider hover:bg-blue-700 transition-all shadow-md active:scale-95"
                  >
                    <TrendingUp size={14} />
                    Execution History Trends
                  </button>
                )}
                {htmlReportUrl && (
                  <a
                    href={htmlReportUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-wider hover:bg-indigo-700 transition-all shadow-md active:scale-95"
                  >
                    <FileText size={14} />
                    View HTML Report
                  </a>
                )}
                {reportDownloadUrl && (
                  <a
                    href={reportDownloadUrl}
                    download
                    className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-xl text-[10px] font-black uppercase tracking-wider hover:bg-emerald-700 transition-all shadow-md active:scale-95"
                  >
                    <FileSpreadsheet size={14} />
                    Export Excel
                  </a>
                )}
              </div>
            </div>

            <div className="p-5">
              {/* Stats Grid */}
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 mb-5">
                <StatCard label="Total" value={report.summary.total} color="blue" />
                <StatCard label="Passed" value={report.summary.passed} color="emerald" />
                <StatCard label="Failed" value={report.summary.failed} color="red" />
                <StatCard label="Errors" value={report.summary.errors} color="orange" />
                <StatCard label="Skipped" value={report.summary.skipped || 0} color="slate" />
                <StatCard label="Duration" value={`${(report.summary.duration / 1000).toFixed(1)}s`} color="purple" />
              </div>

              {/* Pass Rate Bar */}
              <div className="bg-slate-50 rounded-xl p-4 dark:bg-slate-800">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm font-bold text-slate-600 dark:text-slate-300">Pass Rate</span>
                  <span className="text-2xl font-black text-slate-800 dark:text-slate-100">
                    {report.summary.total > 0 ? Math.round((report.summary.passed / report.summary.total) * 100) : 0}%
                  </span>
                </div>
                <div className="h-4 bg-slate-200 rounded-full overflow-hidden dark:bg-slate-700">
                  <div
                    className="h-full rounded-full transition-all duration-1000 ease-out"
                    style={{
                      width: `${report.summary.total > 0 ? (report.summary.passed / report.summary.total) * 100 : 0}%`,
                      background: `linear-gradient(90deg, #10b981, #14b8a6)`
                    }}
                  />
                  {report.summary.failed > 0 && (
                    <div
                      className="h-full rounded-r-full -mt-4"
                      style={{
                        width: `${(report.summary.failed / report.summary.total) * 100}%`,
                        marginLeft: `${(report.summary.passed / report.summary.total) * 100}%`,
                        background: `linear-gradient(90deg, #ef4444, #f97316)`
                      }}
                    />
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Enhanced Analytics Dashboard */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Merged Analytics & Pie Chart */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-lg dark:bg-slate-900 dark:border-slate-800 flex flex-col">
              <div className="px-6 py-4 border-b border-slate-100 bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 dark:border-slate-700">
                <h4 className="font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                  <BarChart3 size={16} className="text-blue-600" />
                  Test Status Analytics
                </h4>
              </div>
              <div className="p-4 flex flex-col md:flex-row items-center gap-5 flex-1">
                {/* Modern Conic-Gradient Pie Chart */}
                <div className="relative w-32 h-32 flex-shrink-0">
                  <div 
                    className="w-full h-full rounded-full shadow-2xl transition-all duration-1000 ease-in-out border-4 border-white dark:border-slate-800"
                    style={{
                      background: (() => {
                        const { passed, failed, errors, total } = report.summary;
                        if (total === 0) return '#f1f5f9';
                        const p = (passed / total) * 100;
                        const f = (failed / total) * 100;
                        const e = (errors / total) * 100;
                        return `conic-gradient(#10b981 0% ${p}%, #f43f5e ${p}% ${p + f}%, #f59e0b ${p + f}% ${p + f + e}%, #64748b ${p + f + e}% 100%)`;
                      })()
                    }}
                  />
                  {/* Glassy Inner Overlay */}
                  <div className="absolute inset-2.5 rounded-full bg-white/90 dark:bg-slate-900/90 backdrop-blur-md flex flex-col items-center justify-center border border-white/50 dark:border-slate-700/50 shadow-inner">
                    <span className="text-xl font-black text-slate-800 dark:text-slate-100 tabular-nums">
                      {Math.round((report.summary.passed / Math.max(report.summary.total, 1)) * 100)}%
                    </span>
                    <span className="text-[8px] font-black text-slate-400 uppercase tracking-[0.2em] mt-0.5">Success</span>
                  </div>
                </div>

                {/* Legend & Stats */}
                <div className="flex-1 w-full min-w-0 space-y-2">
                  <LegendItem label="Passed" count={report.summary.passed} total={report.summary.total} color="emerald" />
                  <LegendItem label="Failed" count={report.summary.failed} total={report.summary.total} color="red" />
                  <LegendItem label="Errors" count={report.summary.errors} total={report.summary.total} color="orange" />
                  {report.summary.skipped > 0 && (
                    <LegendItem label="Skipped" count={report.summary.skipped} total={report.summary.total} color="slate" />
                  )}
                </div>
              </div>
            </div>

            {/* Quality Intelligence Panel */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-lg dark:bg-slate-900 dark:border-slate-800 flex flex-col">
              <div className="px-6 py-4 border-b border-slate-100 bg-gradient-to-r from-violet-50 to-purple-50 dark:from-violet-900/20 dark:to-purple-900/20 dark:border-slate-700">
                <h4 className="font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                  <TrendingUp size={16} className="text-violet-600" />
                  Quality Intelligence
                </h4>
              </div>
              <div className="p-5 space-y-4 flex-1">
                <div className="grid grid-cols-2 gap-3">
                  <MetricCard 
                    label="Suite Duration" 
                    value={`${(report.summary.duration / 1000).toFixed(1)}s`} 
                    icon={<Clock size={14} />}
                    sub="Full suite"
                  />
                  <MetricCard 
                    label="Avg / Test" 
                    value={`${(report.summary.total > 0 ? report.summary.duration / report.summary.total / 1000 : 0).toFixed(1)}s`} 
                    icon={<Zap size={14} />}
                    sub="Per test case"
                  />
                </div>
                <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Quality Metrics</p>
                  <QualityMetric
                    icon={<Shield size={13} />}
                    label="Test Health Score"
                    value={Math.round(((report.summary.passed) / Math.max(report.summary.total,1)) * 100)}
                    color="emerald"
                    suffix="%"
                  />
                  <QualityMetric
                    icon={<Target size={13} />}
                    label="Execution Coverage"
                    value={report.summary.total > 0 ? Math.round(((report.summary.total - report.summary.skipped) / report.summary.total) * 100) : 0}
                    color="blue"
                    suffix="%"
                  />
                  <QualityMetric
                    icon={<Activity size={13} />}
                    label="Error Rate"
                    value={report.summary.total > 0 ? Math.round((report.summary.errors / report.summary.total) * 100) : 0}
                    color="orange"
                    suffix="%"
                  />
                  <div className="mt-3 p-3 bg-violet-50 dark:bg-violet-900/20 rounded-xl border border-violet-100 dark:border-violet-800">
                    <p className="text-[10px] font-black uppercase tracking-widest text-violet-500 mb-1">Recommendation</p>
                    <p className="text-xs text-slate-600 dark:text-slate-300">
                      {report.summary.errors > 0
                        ? `⚠️ ${report.summary.errors} test(s) errored. Review MCP connectivity and selector accuracy.`
                        : report.summary.failed > 0
                        ? `🔍 ${report.summary.failed} test(s) failed. Inspect step details for assertion mismatches.`
                        : '✅ All tests passed. Suite is healthy and ready for CI/CD integration.'}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Detailed Test Case Results */}
          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-lg dark:bg-slate-900 dark:border-slate-800">
            <div className="px-8 py-5 border-b border-slate-100 flex items-center bg-slate-50/50 dark:bg-slate-800/50 dark:border-slate-700">
              <div className="flex items-center gap-3">
                <Activity size={20} className="text-purple-600 dark:text-purple-400" />
                <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">Detailed Results</h3>
                <span className="text-xs text-slate-400 font-medium">({report.results.length} test cases)</span>
              </div>
            </div>

            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {report.results.map(tc => (
                <div key={tc.id} className="group">
                  {/* Test Case Header Row */}
                  <div
                    onClick={() => toggleExpand(tc.id)}
                    className={`px-8 py-5 flex items-center gap-4 cursor-pointer transition-all duration-300 border-l-4 ${
                      tc.status === 'PASS' 
                        ? 'bg-emerald-50/30 border-emerald-500 hover:bg-emerald-50/50 dark:bg-emerald-900/10 dark:border-emerald-600' 
                        : tc.status === 'FAIL'
                          ? 'bg-rose-50/40 border-rose-500 hover:bg-rose-50/60 dark:bg-rose-900/10 dark:border-rose-600'
                          : tc.status === 'ERROR'
                            ? 'bg-amber-50/40 border-amber-500 hover:bg-amber-50/60 dark:bg-amber-900/10 dark:border-amber-600'
                            : 'hover:bg-slate-50 border-transparent dark:hover:bg-slate-800/50'
                    }`}
                  >
                    <div className="flex-shrink-0 transition-transform">
                      {expandedCases.has(tc.id) ? <ChevronDown size={16} className="text-slate-400" /> : <ChevronRight size={16} className="text-slate-400" />}
                    </div>

                    {statusIcon(tc.status)}

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-black text-blue-600 bg-blue-50 px-2 py-0.5 rounded tracking-widest border border-blue-100 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800">
                          {tc.jiraKey}
                        </span>
                        {(() => {
                          const linked = resolveJiraKey(tc);
                          if (!linked) return null;
                          const href = jiraBaseUrl ? `${jiraBaseUrl}/browse/${linked}` : undefined;
                          return href ? (
                            <a
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="text-[10px] font-black text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded tracking-widest border border-indigo-100 hover:bg-indigo-100 transition-colors flex items-center gap-1 dark:bg-indigo-900/30 dark:text-indigo-400 dark:border-indigo-800"
                              title="Linked Jira test-case issue"
                            >
                              <Link2 size={10} /> {linked}
                            </a>
                          ) : (
                            <span className="text-[10px] font-black text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded tracking-widest border border-indigo-100 flex items-center gap-1 dark:bg-indigo-900/30 dark:text-indigo-400 dark:border-indigo-800">
                              <Link2 size={10} /> {linked}
                            </span>
                          );
                        })()}
                        {priorityBadge(tc.priority)}
                      </div>
                      <h4 className="text-sm font-bold text-slate-800 truncate dark:text-slate-200">
                        <span className="opacity-40 mr-1.5">TC-{tc.id}</span>
                        {tc.name.replace(/^TC-\d+[:\s]*/i, '').trim()}
                      </h4>
                    </div>

                    <div className="flex items-center gap-4">
                      <span className="text-xs text-slate-400 font-medium">
                        <Clock size={12} className="inline mr-1" />
                        {(tc.duration / 1000).toFixed(1)}s
                      </span>
                      {/* Healed Badge */}
                      {tc.actualResult?.includes('Healed') && (
                        <span className="px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest bg-amber-50 text-amber-600 border border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800 flex items-center gap-1">
                          <Sparkles size={10} /> Healed
                        </span>
                      )}
                      {/* Created Bug Badge */}
                      {createdBugs[tc.id] && (
                        <a
                          href={createdBugs[tc.id].issueUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest bg-violet-50 text-violet-600 border border-violet-200 dark:bg-violet-900/30 dark:text-violet-400 dark:border-violet-800 flex items-center gap-1 hover:bg-violet-100 transition-colors"
                        >
                          <Bug size={10} /> {createdBugs[tc.id].issueKey}
                        </a>
                      )}
                      {tc.healed && (
                        <span
                          title="This test initially failed; the LLM rewrote it using the actual failure DOM and it passed on re-run."
                          className="px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800 flex items-center gap-1"
                        >
                          🩹 Healed
                        </span>
                      )}
                      {statusBadge(tc.status)}
                    </div>
                  </div>

                  {/* Expanded Detail */}
                  {expandedCases.has(tc.id) && (
                    <div className="px-8 pb-6 bg-slate-50/50 border-t border-slate-100 dark:bg-slate-800/30 dark:border-slate-700">
                      <div className="grid grid-cols-2 gap-6 py-4">
                        <div>
                          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Expected Result</p>
                          <p className="text-sm text-slate-700 dark:text-slate-300">{tc.expectedResult || 'N/A'}</p>
                        </div>
                        <div>
                          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Actual Result</p>
                          <p className="text-sm text-slate-700 dark:text-slate-300">{tc.actualResult || 'N/A'}</p>
                        </div>
                      </div>

                      {tc.testData && (
                        <div className="bg-blue-50/50 border border-blue-100 rounded-lg px-4 py-3 mb-4 dark:bg-blue-900/10 dark:border-blue-800">
                          <p className="text-[10px] font-black uppercase tracking-widest text-blue-600 mb-1 dark:text-blue-400">Test Data</p>
                          <p className="text-sm text-slate-700 dark:text-slate-300">{tc.testData}</p>
                        </div>
                      )}

                      {tc.error && (
                        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 mb-4 dark:bg-red-900/20 dark:border-red-800">
                          <p className="text-xs font-bold text-red-600 dark:text-red-400">Error: {tc.error}</p>
                        </div>
                      )}

                      {/* Step-by-step Results */}
                      {tc.steps.length > 0 && (
                        <div className="mt-2">
                          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">Step-by-Step Execution</p>
                          <div className="space-y-2">
                            {tc.steps.map((step, idx) => {
                              // step.result is multi-line text built by the
                              // backend: each line is either a per-action
                              // marker (✅/❌ <description>) or an "Error: ..."
                              // suffix appended when the step's overall
                              // verdict is FAIL. Rendering it as one blob
                              // hides the failure under the green ticks of
                              // sub-actions that technically succeeded
                              // (e.g. a click that worked but the post-
                              // condition didn't hold). Split + style so
                              // the error pops.
                              const lines = (step.result || '').split('\n').map(l => l.trim()).filter(Boolean);
                              const errorLines = lines.filter(l => /^error[:\s]/i.test(l));
                              const actionLines = lines.filter(l => !/^error[:\s]/i.test(l));
                              return (
                                <div
                                  key={idx}
                                  className={`flex items-start gap-3 px-4 py-3 rounded-lg border ${step.passed
                                    ? 'bg-emerald-50/50 border-emerald-100 dark:bg-emerald-900/10 dark:border-emerald-800'
                                    : 'bg-red-50/50 border-red-100 dark:bg-red-900/10 dark:border-red-800'
                                    }`}
                                >
                                  <div className="flex-shrink-0 mt-0.5">
                                    {step.passed
                                      ? <CheckCircle2 size={14} className="text-emerald-500" />
                                      : <XCircle size={14} className="text-red-500" />
                                    }
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm font-bold text-slate-800 dark:text-slate-200">{step.step}</p>
                                    {actionLines.length > 0 && (
                                      <ul className="mt-1.5 space-y-1 border-l-2 border-slate-200 dark:border-slate-700 pl-3 py-0.5">
                                        {actionLines.map((line, li) => (
                                          <li key={li} className="text-sm text-slate-600 dark:text-slate-400 flex items-start gap-1.5">
                                            <span className="whitespace-pre-wrap">{line}</span>
                                          </li>
                                        ))}
                                      </ul>
                                    )}
                                    {errorLines.length > 0 && (
                                      <div className="mt-2 flex items-start gap-2 px-3 py-2 rounded-md bg-red-100/70 border border-red-200 dark:bg-red-900/30 dark:border-red-800">
                                        <AlertTriangle size={14} className="text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                                        <div className="flex-1 min-w-0">
                                          {errorLines.map((line, li) => (
                                            <p key={li} className="text-xs font-bold text-red-700 dark:text-red-300 whitespace-pre-wrap">
                                              {line.replace(/^error[:\s]+/i, '')}
                                            </p>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Headed Mode Notice */}
                      <div className="mt-6 flex items-center justify-between gap-3 px-4 py-3 bg-blue-50/50 border border-blue-100 rounded-lg dark:bg-blue-900/10 dark:border-blue-800">
                        <div className="flex items-center gap-3">
                          <Activity size={14} className="text-blue-500 animate-pulse" />
                          <p className="text-[10px] font-bold text-blue-600 uppercase tracking-widest dark:text-blue-400">
                            Executed Live in Headed Browser
                          </p>
                        </div>
                      </div>

                      {/* Bug Error Alert */}
                      {bugError && (tc.status === 'FAIL' || tc.status === 'ERROR') && (
                        <div className="mt-3 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5 dark:bg-red-900/20 dark:border-red-800">
                          <p className="text-xs text-red-600 dark:text-red-400">{bugError}</p>
                        </div>
                      )}

                      {/* Create Bug in Jira Button — strictly for FAIL (not ERROR) */}
                      {tc.status === 'FAIL' && (
                        <div className="mt-4 flex items-center gap-3">
                          {createdBugs[tc.id] ? (
                            <a
                              href={createdBugs[tc.id].issueUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-violet-600 to-purple-600 text-white rounded-xl text-xs font-bold hover:from-violet-700 hover:to-purple-700 transition-all shadow-lg shadow-violet-200 active:scale-95 dark:shadow-violet-900/30"
                            >
                              <CheckCircle2 size={14} />
                              {createdBugs[tc.id].issueKey} — View in Jira
                              <ExternalLink size={12} />
                            </a>
                          ) : (
                            <button
                              onClick={(e) => { e.stopPropagation(); createBugInJira(tc); }}
                              disabled={creatingBugFor === tc.id}
                              className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-rose-600 to-pink-600 text-white rounded-xl text-xs font-bold hover:from-rose-700 hover:to-pink-700 transition-all shadow-lg shadow-rose-200 active:scale-95 disabled:opacity-60 dark:shadow-rose-900/30"
                            >
                              {creatingBugFor === tc.id ? (
                                <><Loader2 size={14} className="animate-spin" /> Creating Bug...</>
                              ) : (
                                <><Bug size={14} /> Create Bug in Jira</>
                              )}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════ MARKDOWN PLAN VIEW ═══════════════ */}
      {!report && (
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-lg min-h-[400px] relative overflow-hidden dark:bg-slate-900 dark:border-slate-800">
          <div className="absolute top-0 right-0 p-4 opacity-10 rotate-12 pointer-events-none">
            <FileText size={140} />
          </div>

          {!plan ? (
            <div className="flex flex-col items-center justify-center py-32 opacity-20">
              <RefreshCcw size={48} className="animate-spin mb-4" />
              <p className="font-black uppercase tracking-widest text-xs">Generating Plan...</p>
            </div>
          ) : (
            renderPlanContent(plan)
          )}
        </div>
      )}
    </div>
  );
};

// ── Legend Item Component
const LegendItem: React.FC<{ label: string; count: number; total: number; color: string }> = ({ label, count, total, color }) => {
  const percentage = total > 0 ? Math.round((count / total) * 100) : 0;
  const colorStyles: Record<string, string> = {
    emerald: 'bg-emerald-500',
    red: 'bg-red-500',
    orange: 'bg-orange-500',
    slate: 'bg-slate-400',
  };
  
  return (
    <div className="flex items-center justify-between p-3 bg-slate-50/50 rounded-xl dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800 transition-all hover:border-slate-200 dark:hover:border-slate-700">
      <div className="flex items-center gap-2">
        <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${colorStyles[color]}`} />
        <span className="text-xs font-bold text-slate-600 dark:text-slate-300">{label}</span>
      </div>
      <div className="flex items-center gap-2 ml-2">
        <span className="text-sm font-black text-slate-800 dark:text-slate-100 tabular-nums">{count}</span>
        <span className="text-[10px] font-bold text-slate-400 bg-white dark:bg-slate-900 px-1.5 py-0.5 rounded-full border border-slate-100 dark:border-slate-800 min-w-[36px] text-center">
          {percentage}%
        </span>
      </div>
    </div>
  );
};

// ── Metric Card Component
const MetricCard: React.FC<{ label: string; value: string; icon: React.ReactNode; sub: string }> = ({ label, value, icon, sub }) => {
  return (
    <div className="p-3 bg-white border border-slate-100 rounded-2xl dark:bg-slate-800/40 dark:border-slate-800/60 group hover:border-indigo-200 dark:hover:border-indigo-500/30 transition-all duration-300 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[9px] font-black uppercase tracking-[0.15em] text-slate-400 group-hover:text-indigo-500 transition-colors leading-tight">{label}</span>
        <div className="p-1.5 bg-indigo-50 dark:bg-indigo-900/30 rounded-lg text-indigo-500 shadow-inner">
          {icon}
        </div>
      </div>
      <p className="text-xl font-black text-slate-900 dark:text-slate-100 tabular-nums tracking-tight leading-none">{value}</p>
      <p className="text-[9px] font-bold text-slate-400 mt-1">{sub}</p>
    </div>
  );
};

// ── Reusable Stat Card
const StatCard: React.FC<{ label: string; value: string | number; color: string }> = ({ label, value, color }) => {
  const colorMap: Record<string, string> = {
    blue: 'from-indigo-600 to-blue-600 shadow-indigo-200 dark:shadow-indigo-900/30',
    emerald: 'from-emerald-600 to-teal-600 shadow-emerald-200 dark:shadow-emerald-900/30',
    red: 'from-rose-600 to-pink-600 shadow-rose-200 dark:shadow-rose-900/30',
    orange: 'from-amber-500 to-orange-600 shadow-amber-200 dark:shadow-amber-900/30',
    purple: 'from-violet-600 to-purple-600 shadow-violet-200 dark:shadow-violet-900/30',
  };

  return (
    <div className={`bg-gradient-to-br ${colorMap[color]} rounded-2xl p-2.5 text-white shadow-xl transition-all duration-300 hover:-translate-y-1 hover:scale-[1.02] border border-white/10`}>
      <p className="text-[9px] font-black uppercase tracking-[0.15em] opacity-80 mb-1">{label}</p>
      <p className="text-xl font-black tracking-tight tabular-nums leading-none">{value}</p>
    </div>
  );
};
// ── Quality Metric Row
const QualityMetric: React.FC<{ icon: React.ReactNode; label: string; value: number; color: string; suffix: string }> = ({ icon, label, value, color, suffix }) => {
  const colorMap: Record<string, { bar: string; text: string }> = {
    emerald: { bar: 'from-emerald-500 to-teal-500', text: 'text-emerald-600 dark:text-emerald-400' },
    blue:    { bar: 'from-blue-500 to-indigo-500',  text: 'text-blue-600 dark:text-blue-400' },
    orange:  { bar: 'from-orange-500 to-amber-500', text: 'text-orange-600 dark:text-orange-400' },
  };
  const style = colorMap[color] || colorMap.blue;
  return (
    <div className="space-y-1">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-1.5">
          <span className={`${style.text}`}>{icon}</span>
          <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide">{label}</span>
        </div>
        <span className={`text-xs font-black ${style.text}`}>{value}{suffix}</span>
      </div>
      <div className="h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
        <div className={`h-full bg-gradient-to-r ${style.bar} transition-all duration-1000 ease-out`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
};
