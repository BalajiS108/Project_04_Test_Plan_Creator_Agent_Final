import React, { useEffect, useState } from 'react';
import {
  ChevronLeft, Play, Plus, Trash2, FileCode, Loader2, CheckCircle2, XCircle, AlertTriangle,
  ChevronDown, ChevronRight, Code2, ListChecks, Upload, Activity, Save, FolderOpen, Variable, Layers, Table2,
} from 'lucide-react';
import {
  parseOpenApi, runApiTests,
  listSuites, getSuite, saveSuite, deleteSuite,
  ApiTest, ApiTestResult, ApiAssertion, AssertionType, HttpMethod,
  ApiExtraction, ApiDatasetRow, SuiteListEntry,
} from '../services/apiTestingService';

interface ApiTestingProps {
  onBack: () => void;
}

const METHOD_COLOR: Record<HttpMethod, string> = {
  GET: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800',
  POST: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800',
  PUT: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800',
  PATCH: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-900/30 dark:text-violet-400 dark:border-violet-800',
  DELETE: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-900/30 dark:text-rose-400 dark:border-rose-800',
  HEAD: 'bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
  OPTIONS: 'bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
};

const ASSERTION_LABELS: Record<AssertionType, string> = {
  status: 'Status equals',
  statusRange: 'Status in range',
  header: 'Header contains',
  jsonPath: 'JSON path equals',
  jsonPathExists: 'JSON path exists',
  bodyContains: 'Body contains',
  responseTimeBelow: 'Response time below (ms)',
};

const newId = () => `tc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

const emptyTest = (): ApiTest => ({
  id: newId(),
  name: 'New API Test',
  method: 'GET',
  url: 'https://httpbin.org/get',
  headers: { Accept: 'application/json' },
  assertions: [{ type: 'status', expected: 200 }],
  timeoutMs: 15000,
});

export const ApiTesting: React.FC<ApiTestingProps> = ({ onBack }) => {
  const [tests, setTests] = useState<ApiTest[]>([emptyTest()]);
  const [results, setResults] = useState<Record<string, ApiTestResult>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [specText, setSpecText] = useState('');
  const [specBaseUrl, setSpecBaseUrl] = useState('');
  const [isParsing, setIsParsing] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSpec, setShowSpec] = useState(false);

  // Suite + environment state
  const [suites, setSuites] = useState<SuiteListEntry[]>([]);
  const [loadedSuiteName, setLoadedSuiteName] = useState<string>('');
  const [environments, setEnvironments] = useState<Record<string, Record<string, string>>>({ default: {} });
  const [activeEnv, setActiveEnv] = useState('default');
  const [showEnv, setShowEnv] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Fetch the list of saved suites on mount + after save/delete
  const refreshSuites = async () => {
    try { setSuites(await listSuites()); } catch { /* ignore */ }
  };
  useEffect(() => { refreshSuites(); }, []);

  const loadSuite = async (name: string) => {
    if (!name) return;
    setError(null);
    try {
      const s = await getSuite(name);
      setTests(s.tests || []);
      setEnvironments(s.environments && Object.keys(s.environments).length > 0 ? s.environments : { default: {} });
      setActiveEnv(s.activeEnvironment && (s.environments?.[s.activeEnvironment]) ? s.activeEnvironment : Object.keys(s.environments || { default: {} })[0] || 'default');
      setLoadedSuiteName(s.name);
      setResults({});
      setExpanded({});
    } catch (e: any) {
      setError(`Failed to load suite: ${e.response?.data?.error || e.message}`);
    }
  };

  const saveCurrentSuite = async () => {
    // Prompt for a name if this isn't a previously loaded suite
    const name = loadedSuiteName || (window.prompt('Suite name:', '') || '').trim();
    if (!name) return;
    setIsSaving(true);
    setError(null);
    try {
      await saveSuite({
        name,
        tests,
        environments,
        activeEnvironment: activeEnv,
        updatedAt: new Date().toISOString(),
      });
      setLoadedSuiteName(name);
      await refreshSuites();
    } catch (e: any) {
      setError(`Save failed: ${e.response?.data?.error || e.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const removeSuite = async () => {
    if (!loadedSuiteName) return;
    if (!confirm(`Delete suite "${loadedSuiteName}"? This cannot be undone.`)) return;
    try {
      await deleteSuite(loadedSuiteName);
      setLoadedSuiteName('');
      await refreshSuites();
    } catch (e: any) {
      setError(`Delete failed: ${e.response?.data?.error || e.message}`);
    }
  };

  const renameEnv = (oldName: string, newName: string) => {
    if (!newName.trim() || newName === oldName) return;
    setEnvironments((cur) => {
      const next: Record<string, Record<string, string>> = {};
      for (const [k, v] of Object.entries(cur)) next[k === oldName ? newName : k] = v;
      return next;
    });
    if (activeEnv === oldName) setActiveEnv(newName);
  };

  const updateEnvVar = (envName: string, key: string, value: string) => {
    setEnvironments((cur) => ({
      ...cur,
      [envName]: { ...(cur[envName] || {}), [key]: value },
    }));
  };
  const removeEnvVar = (envName: string, key: string) => {
    setEnvironments((cur) => {
      const next = { ...(cur[envName] || {}) };
      delete next[key];
      return { ...cur, [envName]: next };
    });
  };

  const envVarsForRun = environments[activeEnv] || {};

  const updateTest = (id: string, patch: Partial<ApiTest>) => {
    setTests((cur) => cur.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };

  const removeTest = (id: string) => {
    setTests((cur) => cur.filter((t) => t.id !== id));
    setResults((cur) => { const { [id]: _drop, ...rest } = cur; return rest; });
  };

  const onParse = async () => {
    if (!specText.trim()) { setError('Paste a spec first.'); return; }
    setIsParsing(true);
    setError(null);
    try {
      const r = await parseOpenApi(specText, specBaseUrl.trim() || undefined);
      if (!r.success) {
        setError(r.error || 'Failed to parse spec');
        return;
      }
      if (r.tests.length === 0) {
        setError('Spec parsed, but no operations were found.');
        return;
      }
      setTests(r.tests);
      setResults({});
      setShowSpec(false);
    } catch (e: any) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setIsParsing(false);
    }
  };

  const runAll = async () => {
    if (tests.length === 0) return;
    setIsRunning(true);
    setError(null);
    setResults({});
    try {
      const { results: r } = await runApiTests(tests, envVarsForRun);
      const map: Record<string, ApiTestResult> = {};
      for (const res of r) map[res.id] = res;
      setResults(map);
      // Auto-expand any failed tests so the user sees them right away
      const failedIds = r.filter((x) => x.status !== 'PASS').map((x) => x.id);
      if (failedIds.length > 0) {
        setExpanded((cur) => ({ ...cur, ...Object.fromEntries(failedIds.map((id) => [id, true])) }));
      }
    } catch (e: any) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setIsRunning(false);
    }
  };

  const runOne = async (test: ApiTest) => {
    setIsRunning(true);
    setError(null);
    try {
      const { results: r } = await runApiTests([test], envVarsForRun);
      setResults((cur) => ({ ...cur, [test.id]: r[0] }));
      setExpanded((cur) => ({ ...cur, [test.id]: true }));
    } catch (e: any) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setIsRunning(false);
    }
  };

  const summary = (() => {
    const r = Object.values(results);
    return {
      total: r.length,
      passed: r.filter((x) => x.status === 'PASS').length,
      failed: r.filter((x) => x.status === 'FAIL').length,
      errors: r.filter((x) => x.status === 'ERROR').length,
    };
  })();

  return (
    <div className="w-full max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-2 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
            title="Back to wizard"
          >
            <ChevronLeft size={16} />
          </button>
          <div>
            <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
              <Code2 size={20} /> API Testing
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
              Build API tests by hand or auto-scaffold from an OpenAPI / Swagger spec.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSpec((v) => !v)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-200 text-slate-600 text-xs font-bold hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <FileCode size={14} />
            {showSpec ? 'Hide Spec' : 'Import OpenAPI'}
          </button>
          <button
            onClick={() => setTests((c) => [...c, emptyTest()])}
            className="flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-200 text-slate-600 text-xs font-bold hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <Plus size={14} /> Add Test
          </button>
          <button
            onClick={runAll}
            disabled={isRunning || tests.length === 0}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 text-white text-xs font-bold hover:bg-blue-700 disabled:opacity-50"
          >
            {isRunning ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {isRunning ? 'Running...' : `Run All (${tests.length})`}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-6 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm dark:bg-red-900/20 dark:border-red-800 dark:text-red-300">
          {error}
        </div>
      )}

      {/* ── Suite + Environment toolbar ────────────────────────────── */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4 mb-6 dark:bg-slate-900 dark:border-slate-800">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[180px]">
            <Label><FolderOpen size={11} className="inline mr-1" /> Load Suite</Label>
            <select
              value={loadedSuiteName}
              onChange={(e) => { loadSuite(e.target.value); }}
              className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs font-bold dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
            >
              <option value="">— No suite loaded —</option>
              {suites.map((s) => (
                <option key={s.name} value={s.name}>{s.name} ({s.testCount})</option>
              ))}
            </select>
          </div>

          <div className="flex-1 min-w-[180px]">
            <Label><Layers size={11} className="inline mr-1" /> Environment</Label>
            <div className="flex gap-2">
              <select
                value={activeEnv}
                onChange={(e) => setActiveEnv(e.target.value)}
                className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs font-bold dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
              >
                {Object.keys(environments).map((env) => (
                  <option key={env} value={env}>{env}</option>
                ))}
              </select>
              <button
                onClick={() => {
                  const name = (window.prompt('New environment name:', '') || '').trim();
                  if (!name) return;
                  setEnvironments((cur) => ({ ...cur, [name]: {} }));
                  setActiveEnv(name);
                }}
                className="px-2 py-2 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
                title="Add a new environment"
              >
                <Plus size={14} />
              </button>
            </div>
          </div>

          <button
            onClick={() => setShowEnv((v) => !v)}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold border ${
              showEnv
                ? 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-800'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700 dark:hover:bg-slate-700'
            }`}
            title="Show/hide environment variables editor"
          >
            <Variable size={14} />
            Vars ({Object.keys(envVarsForRun).length})
          </button>

          <button
            onClick={saveCurrentSuite}
            disabled={isSaving || tests.length === 0}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold bg-white text-slate-600 border border-slate-200 hover:bg-slate-50 disabled:opacity-50 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700 dark:hover:bg-slate-700"
            title={loadedSuiteName ? `Save changes to "${loadedSuiteName}"` : 'Save as new suite'}
          >
            {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {loadedSuiteName ? 'Save' : 'Save as...'}
          </button>

          {loadedSuiteName && (
            <button
              onClick={removeSuite}
              className="p-2 rounded-lg border border-slate-200 text-slate-400 hover:text-red-600 hover:bg-red-50 dark:border-slate-700 dark:hover:bg-red-900/20"
              title={`Delete suite "${loadedSuiteName}"`}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>

        {/* Environment variable editor */}
        {showEnv && (
          <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-800">
            <div className="flex items-center justify-between mb-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">
                Variables for <span className="font-mono text-blue-600 dark:text-blue-400">{activeEnv}</span> — reference as <code className="font-mono">{'{{env.NAME}}'}</code>
              </p>
              <button
                onClick={() => {
                  const k = (window.prompt('Variable name (e.g. baseUrl, token):', '') || '').trim();
                  if (!k) return;
                  updateEnvVar(activeEnv, k, '');
                }}
                className="px-2 py-1 text-[10px] font-bold text-slate-500 hover:text-blue-600 flex items-center gap-1"
              >
                <Plus size={11} /> Add Variable
              </button>
            </div>
            <div className="space-y-2">
              {Object.entries(envVarsForRun).length === 0 ? (
                <p className="text-[11px] text-slate-400 italic">No variables yet. Click <strong>Add Variable</strong> to define one.</p>
              ) : (
                Object.entries(envVarsForRun).map(([k, v]) => (
                  <div key={k} className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-slate-500 w-32 truncate">{k}</span>
                    <input
                      type="text"
                      value={v}
                      onChange={(e) => updateEnvVar(activeEnv, k, e.target.value)}
                      className="flex-1 bg-slate-50 border border-slate-200 rounded px-2 py-1 font-mono text-[11px] dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
                    />
                    <button
                      onClick={() => removeEnvVar(activeEnv, k)}
                      className="p-1 rounded text-slate-400 hover:text-red-600"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))
              )}
            </div>
            {Object.keys(environments).length > 1 && (
              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  onClick={() => {
                    const newName = (window.prompt('Rename environment:', activeEnv) || '').trim();
                    if (newName) renameEnv(activeEnv, newName);
                  }}
                  className="text-[10px] font-bold text-slate-500 hover:text-blue-600"
                >
                  Rename
                </button>
                <button
                  onClick={() => {
                    if (!confirm(`Delete environment "${activeEnv}"?`)) return;
                    setEnvironments((cur) => {
                      const { [activeEnv]: _drop, ...rest } = cur;
                      return rest;
                    });
                    setActiveEnv(Object.keys(environments).filter((e) => e !== activeEnv)[0] || 'default');
                  }}
                  className="text-[10px] font-bold text-slate-500 hover:text-red-600"
                >
                  Delete Environment
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Spec import */}
      {showSpec && (
        <div className="mb-6 bg-white border border-slate-200 rounded-2xl p-6 dark:bg-slate-900 dark:border-slate-800">
          <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 mb-3 flex items-center gap-2">
            <Upload size={14} /> OpenAPI 3 / Swagger 2 (YAML or JSON)
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-3">
            <textarea
              rows={8}
              value={specText}
              onChange={(e) => setSpecText(e.target.value)}
              placeholder={`openapi: 3.0.0\ninfo:\n  title: Sample API\npaths:\n  /users:\n    get:\n      ...`}
              className="md:col-span-2 w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 font-mono text-xs focus:ring-2 focus:ring-blue-500 outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
            />
            <div>
              <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2 dark:text-slate-400">Base URL Override (Optional)</label>
              <input
                type="text"
                value={specBaseUrl}
                onChange={(e) => setSpecBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-medium focus:ring-2 focus:ring-blue-500 outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
              />
            </div>
            <div className="flex items-end justify-end">
              <button
                onClick={onParse}
                disabled={isParsing || !specText.trim()}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-violet-600 text-white text-xs font-bold hover:bg-violet-700 disabled:opacity-50"
              >
                {isParsing ? <Loader2 size={14} className="animate-spin" /> : <FileCode size={14} />}
                Generate Tests from Spec
              </button>
            </div>
          </div>
          <p className="text-[11px] text-slate-400">
            Replaces the current test list. Path parameters become editable placeholders (e.g. <code className="font-mono">:userId</code>).
          </p>
        </div>
      )}

      {/* Summary tiles */}
      {summary.total > 0 && (
        <div className="grid grid-cols-4 gap-3 mb-6">
          <SummaryTile label="Run" value={summary.total} accent="slate" />
          <SummaryTile label="Passed" value={summary.passed} accent="emerald" />
          <SummaryTile label="Failed" value={summary.failed} accent="red" />
          <SummaryTile label="Errors" value={summary.errors} accent="orange" />
        </div>
      )}

      {/* Test list */}
      {tests.length === 0 ? (
        <div className="py-16 text-center text-sm text-slate-400 dark:text-slate-500">
          No tests yet. Click <strong>Add Test</strong> or <strong>Import OpenAPI</strong> to begin.
        </div>
      ) : (
        <div className="space-y-3">
          {tests.map((t) => (
            <TestCard
              key={t.id}
              test={t}
              result={results[t.id]}
              expanded={!!expanded[t.id]}
              onToggle={() => setExpanded((c) => ({ ...c, [t.id]: !c[t.id] }))}
              onChange={(patch) => updateTest(t.id, patch)}
              onRemove={() => removeTest(t.id)}
              onRunOne={() => runOne(t)}
              disabled={isRunning}
            />
          ))}
        </div>
      )}
    </div>
  );
};

/* ─────────────────────────────────────────────────────────────────── */

const SummaryTile: React.FC<{ label: string; value: number; accent: string }> = ({ label, value, accent }) => {
  const cls: Record<string, string> = {
    slate: 'text-slate-600 dark:text-slate-400',
    emerald: 'text-emerald-600 dark:text-emerald-400',
    red: 'text-red-600 dark:text-red-400',
    orange: 'text-orange-600 dark:text-orange-400',
  };
  return (
    <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 dark:bg-slate-900 dark:border-slate-800">
      <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">{label}</p>
      <p className={`text-2xl font-black ${cls[accent]}`}>{value}</p>
    </div>
  );
};

interface TestCardProps {
  test: ApiTest;
  result?: ApiTestResult;
  expanded: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<ApiTest>) => void;
  onRemove: () => void;
  onRunOne: () => void;
  disabled: boolean;
}

const TestCard: React.FC<TestCardProps> = ({ test, result, expanded, onToggle, onChange, onRemove, onRunOne, disabled }) => {
  const statusBadge = !result
    ? null
    : result.status === 'PASS' ? <CheckCircle2 size={14} className="text-emerald-500" />
    : result.status === 'FAIL' ? <XCircle size={14} className="text-red-500" />
    : <AlertTriangle size={14} className="text-orange-500" />;

  return (
    <div className="bg-white border border-slate-200 rounded-2xl dark:bg-slate-900 dark:border-slate-800">
      <div className="flex items-center gap-3 px-5 py-3">
        <button onClick={onToggle} className="text-slate-400 flex-shrink-0">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <span className={`px-2 py-0.5 rounded text-[10px] font-black tracking-wider border flex-shrink-0 ${METHOD_COLOR[test.method]}`}>
          {test.method}
        </span>
        <p className="flex-1 text-sm font-bold text-slate-800 truncate dark:text-slate-200">{test.name}</p>
        {test.dataset && test.dataset.length > 0 && (
          <span
            className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-widest bg-violet-50 text-violet-700 border border-violet-200 dark:bg-violet-900/30 dark:text-violet-400 dark:border-violet-800 flex items-center gap-1"
            title={`This test will run ${test.dataset.length} times — once per dataset row`}
          >
            <Table2 size={10} /> ×{test.dataset.length}
          </span>
        )}
        <p className="text-[11px] text-slate-400 font-mono truncate max-w-[280px]" title={test.url}>{test.url}</p>
        {result && (
          <>
            {statusBadge}
            <span className="text-[10px] text-slate-400">{result.durationMs}ms</span>
          </>
        )}
        <button
          onClick={onRunOne}
          disabled={disabled}
          className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-50 dark:bg-blue-900/30 dark:text-blue-300"
        >
          Run
        </button>
        <button onClick={onRemove} className="p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20" title="Delete test">
          <Trash2 size={14} />
        </button>
      </div>

      {expanded && (
        <div className="border-t border-slate-100 dark:border-slate-800 p-5 space-y-4">
          {/* Request */}
          <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
            <div>
              <Label>Method</Label>
              <select
                value={test.method}
                onChange={(e) => onChange({ method: e.target.value as HttpMethod })}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs font-bold dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
              >
                {(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as HttpMethod[]).map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
            <div className="md:col-span-5">
              <Label>URL</Label>
              <input
                type="text"
                value={test.url}
                onChange={(e) => onChange({ url: e.target.value })}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-mono text-xs dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
              />
            </div>
            <div className="md:col-span-3">
              <Label>Name</Label>
              <input
                type="text"
                value={test.name}
                onChange={(e) => onChange({ name: e.target.value })}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
              />
            </div>
            <div className="md:col-span-3">
              <Label>Headers (JSON)</Label>
              <input
                type="text"
                value={JSON.stringify(test.headers || {})}
                onChange={(e) => {
                  try { onChange({ headers: JSON.parse(e.target.value) }); } catch { /* keep typing */ }
                }}
                placeholder='{"Authorization":"Bearer ..."}'
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-mono text-xs dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
              />
            </div>
            <div className="md:col-span-6">
              <Label>Body (JSON or string, leave empty for GET/HEAD)</Label>
              <textarea
                rows={3}
                value={typeof test.body === 'string' ? test.body : (test.body == null ? '' : JSON.stringify(test.body, null, 2))}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v.trim()) { onChange({ body: undefined }); return; }
                  try { onChange({ body: JSON.parse(v) }); } catch { onChange({ body: v }); }
                }}
                placeholder='{"key":"value"}'
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-mono text-xs dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
              />
            </div>
          </div>

          {/* Assertions */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label><ListChecks size={11} className="inline mr-1" /> Assertions ({test.assertions.length})</Label>
              <button
                onClick={() => onChange({ assertions: [...test.assertions, { type: 'status', expected: 200 }] })}
                className="px-2 py-1 text-[10px] font-bold text-slate-500 hover:text-blue-600 flex items-center gap-1"
              >
                <Plus size={11} /> Add
              </button>
            </div>
            <div className="space-y-2">
              {test.assertions.map((a, i) => (
                <AssertionRow
                  key={i}
                  assertion={a}
                  onChange={(patch) => {
                    const next = [...test.assertions];
                    next[i] = { ...next[i], ...patch };
                    onChange({ assertions: next });
                  }}
                  onRemove={() => onChange({ assertions: test.assertions.filter((_, idx) => idx !== i) })}
                />
              ))}
              {test.assertions.length === 0 && (
                <p className="text-[11px] text-slate-400 italic">No assertions — the test will be marked PASS if the request succeeds (status 2xx).</p>
              )}
            </div>
          </div>

          {/* Extractions */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label><Variable size={11} className="inline mr-1" /> Extract from response ({(test.extractions || []).length})</Label>
              <button
                onClick={() => onChange({ extractions: [...(test.extractions || []), { name: '', source: 'jsonPath', path: '' }] })}
                className="px-2 py-1 text-[10px] font-bold text-slate-500 hover:text-blue-600 flex items-center gap-1"
              >
                <Plus size={11} /> Add
              </button>
            </div>
            <div className="space-y-2">
              {(test.extractions || []).map((ex, i) => (
                <ExtractionRow
                  key={i}
                  extraction={ex}
                  onChange={(patch) => {
                    const next = [...(test.extractions || [])];
                    next[i] = { ...next[i], ...patch };
                    onChange({ extractions: next });
                  }}
                  onRemove={() => onChange({ extractions: (test.extractions || []).filter((_, idx) => idx !== i) })}
                />
              ))}
              {(!test.extractions || test.extractions.length === 0) && (
                <p className="text-[11px] text-slate-400 italic">
                  Capture values like an auth token or new resource ID so later tests can reference them as <code className="font-mono">{'{{name}}'}</code>.
                </p>
              )}
            </div>
          </div>

          {/* Dataset (parametrized rows) */}
          <DatasetBlock
            dataset={test.dataset || []}
            onChange={(next) => onChange({ dataset: next.length > 0 ? next : undefined })}
          />

          {/* Result */}
          {result && (
            <div className="border-t border-slate-100 pt-4 dark:border-slate-800">
              <div className="flex items-center gap-2 mb-2">
                <Activity size={12} className="text-slate-400" />
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Execution Result</p>
                <span className={`text-[10px] font-black uppercase tracking-widest ${
                  result.status === 'PASS' ? 'text-emerald-600' : result.status === 'FAIL' ? 'text-red-600' : 'text-orange-600'
                }`}>{result.status}</span>
                {result.httpStatus !== undefined && (
                  <span className="text-[10px] text-slate-500">HTTP {result.httpStatus}</span>
                )}
                <span className="text-[10px] text-slate-500">{result.durationMs}ms</span>
              </div>

              <div className="space-y-1.5 mb-3">
                {result.steps.map((s, i) => (
                  <div key={i} className={`px-3 py-2 rounded-lg border text-xs flex items-start gap-2 ${
                    s.passed
                      ? 'bg-emerald-50/50 border-emerald-100 dark:bg-emerald-900/10 dark:border-emerald-800'
                      : 'bg-red-50/50 border-red-100 dark:bg-red-900/10 dark:border-red-800'
                  }`}>
                    {s.passed ? <CheckCircle2 size={12} className="text-emerald-500 mt-0.5" /> : <XCircle size={12} className="text-red-500 mt-0.5" />}
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-slate-700 dark:text-slate-200">{s.label}</p>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">{s.detail}</p>
                    </div>
                  </div>
                ))}
              </div>

              {result.extracted && Object.keys(result.extracted).length > 0 && (
                <div className="mb-3 px-3 py-2 rounded-lg border border-violet-200 bg-violet-50/40 dark:border-violet-800 dark:bg-violet-900/10">
                  <p className="text-[10px] font-black uppercase tracking-widest text-violet-700 dark:text-violet-300 mb-1.5 flex items-center gap-1">
                    <Variable size={11} /> Extracted (available to next tests as {'{{name}}'})
                  </p>
                  <div className="space-y-0.5">
                    {Object.entries(result.extracted).map(([k, v]) => (
                      <div key={k} className="font-mono text-[11px] flex gap-2">
                        <span className="text-violet-700 dark:text-violet-300">{k}</span>
                        <span className="text-slate-500">=</span>
                        <span className="text-slate-700 dark:text-slate-300 truncate">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {result.responsePreview?.bodyExcerpt && (
                <details className="rounded-lg border border-slate-200 dark:border-slate-700">
                  <summary className="px-3 py-2 text-[10px] font-black uppercase tracking-widest text-slate-500 cursor-pointer">
                    Response body preview
                  </summary>
                  <pre className="px-3 py-2 bg-slate-50 dark:bg-slate-800/50 text-[11px] font-mono whitespace-pre-wrap text-slate-700 dark:text-slate-300 max-h-[200px] overflow-y-auto">
                    {result.responsePreview.bodyExcerpt}
                  </pre>
                </details>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const Label: React.FC<React.PropsWithChildren> = ({ children }) => (
  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">{children}</p>
);

/**
 * Editable table of dataset rows. Columns are the union of all keys across
 * the rows; users can add or remove columns and rows freely. Each cell maps
 * to one variable that the runner will substitute as {{key}} for that row.
 */
const DatasetBlock: React.FC<{
  dataset: ApiDatasetRow[];
  onChange: (next: ApiDatasetRow[]) => void;
}> = ({ dataset, onChange }) => {
  const columns = React.useMemo(() => {
    const cols = new Set<string>();
    for (const r of dataset) for (const k of Object.keys(r)) cols.add(k);
    // Always show `case` first if present
    return Array.from(cols).sort((a, b) => (a === 'case' ? -1 : b === 'case' ? 1 : a.localeCompare(b)));
  }, [dataset]);

  const addColumn = () => {
    const name = (window.prompt('Variable name (referenced as {{name}}):', '') || '').trim();
    if (!name) return;
    const next = dataset.map((r) => ({ ...r, [name]: r[name] ?? '' }));
    if (next.length === 0) next.push({ [name]: '' });
    onChange(next);
  };

  const addRow = () => {
    const blank: ApiDatasetRow = {};
    for (const c of columns) blank[c] = '';
    onChange([...dataset, blank]);
  };

  const removeRow = (idx: number) => {
    onChange(dataset.filter((_, i) => i !== idx));
  };

  const removeColumn = (col: string) => {
    onChange(dataset.map((r) => {
      const { [col]: _drop, ...rest } = r;
      return rest;
    }));
  };

  const updateCell = (rowIdx: number, col: string, value: string) => {
    onChange(dataset.map((r, i) => (i === rowIdx ? { ...r, [col]: value } : r)));
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <Label>
          <Table2 size={11} className="inline mr-1" />
          Dataset — parametrized rows ({dataset.length})
        </Label>
        <div className="flex items-center gap-1">
          <button
            onClick={addColumn}
            className="px-2 py-1 text-[10px] font-bold text-slate-500 hover:text-blue-600 flex items-center gap-1"
          >
            <Plus size={11} /> Variable
          </button>
          <button
            onClick={addRow}
            disabled={columns.length === 0}
            className="px-2 py-1 text-[10px] font-bold text-slate-500 hover:text-blue-600 flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
            title={columns.length === 0 ? 'Add at least one variable first' : 'Add a row'}
          >
            <Plus size={11} /> Row
          </button>
        </div>
      </div>

      {dataset.length === 0 || columns.length === 0 ? (
        <p className="text-[11px] text-slate-400 italic">
          Run this test once per row of data. Add a variable like <code className="font-mono">email</code> and reference it as <code className="font-mono">{'{{email}}'}</code> in the URL, headers, or body. A column named <code className="font-mono">case</code> labels each row in results.
        </p>
      ) : (
        <div className="overflow-x-auto border border-slate-200 rounded-lg dark:border-slate-700">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
                {columns.map((col) => (
                  <th key={col} className="px-3 py-2 text-left font-bold text-slate-600 dark:text-slate-300">
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-mono">{col}</span>
                      <button
                        onClick={() => removeColumn(col)}
                        className="text-slate-400 hover:text-red-600"
                        title={`Remove "${col}" column`}
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  </th>
                ))}
                <th className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {dataset.map((row, rIdx) => (
                <tr key={rIdx} className="bg-white dark:bg-slate-900">
                  {columns.map((col) => (
                    <td key={col} className="px-2 py-1">
                      <input
                        type="text"
                        value={String(row[col] ?? '')}
                        onChange={(e) => updateCell(rIdx, col, e.target.value)}
                        className="w-full bg-transparent font-mono text-[11px] px-1 py-0.5 rounded focus:bg-slate-50 focus:outline focus:outline-1 focus:outline-blue-300 dark:focus:bg-slate-800 dark:text-slate-100"
                      />
                    </td>
                  ))}
                  <td className="px-1">
                    <button
                      onClick={() => removeRow(rIdx)}
                      className="p-1 rounded text-slate-400 hover:text-red-600"
                      title="Remove this row"
                    >
                      <Trash2 size={11} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

const ExtractionRow: React.FC<{
  extraction: ApiExtraction;
  onChange: (patch: Partial<ApiExtraction>) => void;
  onRemove: () => void;
}> = ({ extraction, onChange, onRemove }) => (
  <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-800/50">
    <input
      type="text"
      value={extraction.name}
      onChange={(e) => onChange({ name: e.target.value })}
      placeholder="variable name"
      className="w-40 bg-white border border-slate-200 rounded px-2 py-1 font-mono text-[11px] dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100"
    />
    <span className="text-[11px] text-slate-400">=</span>
    <select
      value={extraction.source}
      onChange={(e) => onChange({ source: e.target.value as ApiExtraction['source'], path: undefined, headerName: undefined })}
      className="bg-white border border-slate-200 rounded px-2 py-1 text-[11px] font-bold dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100"
    >
      <option value="jsonPath">body.jsonPath</option>
      <option value="header">header</option>
      <option value="status">HTTP status</option>
    </select>
    {extraction.source === 'jsonPath' && (
      <input
        type="text"
        value={extraction.path || ''}
        onChange={(e) => onChange({ path: e.target.value })}
        placeholder="data.token"
        className="flex-1 bg-white border border-slate-200 rounded px-2 py-1 font-mono text-[11px] dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100"
      />
    )}
    {extraction.source === 'header' && (
      <input
        type="text"
        value={extraction.headerName || ''}
        onChange={(e) => onChange({ headerName: e.target.value })}
        placeholder="x-request-id"
        className="flex-1 bg-white border border-slate-200 rounded px-2 py-1 font-mono text-[11px] dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100"
      />
    )}
    {extraction.source === 'status' && (
      <span className="flex-1 text-[11px] text-slate-400 italic">captures HTTP status code</span>
    )}
    <button onClick={onRemove} className="p-1 rounded text-slate-400 hover:text-red-600">
      <Trash2 size={12} />
    </button>
  </div>
);

const AssertionRow: React.FC<{
  assertion: ApiAssertion;
  onChange: (patch: Partial<ApiAssertion>) => void;
  onRemove: () => void;
}> = ({ assertion, onChange, onRemove }) => (
  <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-800/50">
    <select
      value={assertion.type}
      onChange={(e) => onChange({ type: e.target.value as AssertionType, expected: undefined, path: undefined, range: undefined, expectedMs: undefined })}
      className="bg-white border border-slate-200 rounded px-2 py-1 text-[11px] font-bold dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100"
    >
      {Object.entries(ASSERTION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
    </select>

    {(assertion.type === 'header' || assertion.type === 'jsonPath' || assertion.type === 'jsonPathExists') && (
      <input
        type="text"
        value={assertion.type === 'header' ? (assertion.name || '') : (assertion.path || '')}
        onChange={(e) => onChange(assertion.type === 'header' ? { name: e.target.value } : { path: e.target.value })}
        placeholder={assertion.type === 'header' ? 'header name' : 'json.path.to.value'}
        className="flex-1 bg-white border border-slate-200 rounded px-2 py-1 font-mono text-[11px] dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100"
      />
    )}

    {assertion.type === 'statusRange' ? (
      <select
        value={assertion.range || '2xx'}
        onChange={(e) => onChange({ range: e.target.value as any })}
        className="bg-white border border-slate-200 rounded px-2 py-1 text-[11px] font-bold dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100"
      >
        <option value="2xx">2xx</option>
        <option value="3xx">3xx</option>
        <option value="4xx">4xx</option>
        <option value="5xx">5xx</option>
      </select>
    ) : assertion.type === 'responseTimeBelow' ? (
      <input
        type="number"
        value={assertion.expectedMs ?? 1000}
        onChange={(e) => onChange({ expectedMs: Number(e.target.value) })}
        className="w-32 bg-white border border-slate-200 rounded px-2 py-1 font-mono text-[11px] dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100"
      />
    ) : assertion.type === 'jsonPathExists' ? null : (
      <input
        type="text"
        value={assertion.expected ?? ''}
        onChange={(e) => onChange({ expected: e.target.value })}
        placeholder="expected value"
        className="flex-1 bg-white border border-slate-200 rounded px-2 py-1 font-mono text-[11px] dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100"
      />
    )}

    <button onClick={onRemove} className="p-1 rounded text-slate-400 hover:text-red-600">
      <Trash2 size={12} />
    </button>
  </div>
);
