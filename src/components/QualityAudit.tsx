import React, { useState } from 'react';
import {
  ChevronLeft, ShieldCheck, Image as ImageIcon, AlertTriangle, CheckCircle2,
  Loader2, Globe, ExternalLink, Activity,
} from 'lucide-react';
import {
  runVisualAudit, runA11yAudit,
  VisualAuditResult, A11yAuditResult,
} from '../services/auditService';

interface QualityAuditProps {
  onBack: () => void;
}

const IMPACT_COLOR: Record<string, string> = {
  critical: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800',
  serious: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800',
  moderate: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800',
  minor: 'bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
};

export const QualityAudit: React.FC<QualityAuditProps> = ({ onBack }) => {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [fullPage, setFullPage] = useState(false);

  const [visualResult, setVisualResult] = useState<VisualAuditResult | null>(null);
  const [a11yResult, setA11yResult] = useState<A11yAuditResult | null>(null);

  const [isVisualRunning, setIsVisualRunning] = useState(false);
  const [isA11yRunning, setIsA11yRunning] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const targetUrl = url.trim();
  const canRun = targetUrl.length > 0;

  const handleVisual = async (setBaseline = false) => {
    if (!canRun) return;
    setIsVisualRunning(true);
    setError(null);
    try {
      const r = await runVisualAudit(targetUrl, { name: name.trim() || undefined, fullPage, setBaseline });
      setVisualResult(r);
      if (!r.success && r.error) setError(`Visual audit failed: ${r.error}`);
    } catch (e: any) {
      setError(`Visual audit failed: ${e.response?.data?.error || e.message}`);
    } finally {
      setIsVisualRunning(false);
    }
  };

  const handleA11y = async () => {
    if (!canRun) return;
    setIsA11yRunning(true);
    setError(null);
    try {
      const r = await runA11yAudit(targetUrl);
      setA11yResult(r);
      if (!r.success && r.error) setError(`Accessibility audit failed: ${r.error}`);
    } catch (e: any) {
      setError(`Accessibility audit failed: ${e.response?.data?.error || e.message}`);
    } finally {
      setIsA11yRunning(false);
    }
  };

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
              <ShieldCheck size={20} /> Quality Audit
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
              Run visual-regression and accessibility checks on any URL.
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-6 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm dark:bg-red-900/20 dark:border-red-800 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Target form */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 mb-6 dark:bg-slate-900 dark:border-slate-800">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2">
            <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2 dark:text-slate-400">Target URL</label>
            <div className="relative">
              <Globe size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/page"
                className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-9 pr-4 py-3 text-sm font-medium focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
              />
            </div>
          </div>
          <div>
            <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2 dark:text-slate-400">Label (Optional)</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. login-page"
              className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-medium focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
            />
            <p className="text-[10px] text-slate-400 mt-1">Label + URL uniquely identifies the baseline.</p>
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-xs font-bold text-slate-600 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={fullPage}
                onChange={(e) => setFullPage(e.target.checked)}
                className="h-4 w-4"
              />
              Capture full page (not just viewport)
            </label>
          </div>
        </div>
      </div>

      {/* Two-panel layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* ───── Visual Regression Panel ───── */}
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden dark:bg-slate-900 dark:border-slate-800">
          <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center dark:border-slate-800">
            <div className="flex items-center gap-2">
              <ImageIcon size={16} className="text-violet-500" />
              <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">Visual Regression</h3>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleVisual(true)}
                disabled={!canRun || isVisualRunning}
                title="Capture the current screenshot as the new baseline"
                className="px-3 py-1.5 rounded-lg text-[11px] font-bold border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Set Baseline
              </button>
              <button
                onClick={() => handleVisual(false)}
                disabled={!canRun || isVisualRunning}
                className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 flex items-center gap-1.5"
              >
                {isVisualRunning ? <Loader2 size={12} className="animate-spin" /> : <Activity size={12} />}
                {isVisualRunning ? 'Capturing...' : 'Run Visual Check'}
              </button>
            </div>
          </div>

          <div className="p-6">
            {!visualResult && !isVisualRunning && (
              <p className="text-xs text-slate-400 dark:text-slate-500 py-12 text-center">
                Run a visual check to capture a baseline. Subsequent runs compute a pixel-level diff.
              </p>
            )}

            {visualResult && visualResult.success && (
              <>
                {!visualResult.baselineExisted ? (
                  <div className="px-4 py-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs mb-4 flex items-start gap-2 dark:bg-emerald-900/20 dark:border-emerald-800 dark:text-emerald-300">
                    <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0" />
                    <span>Baseline captured. Run again to detect changes.</span>
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-3 mb-4">
                    <DiffStat label="Diff pixels" value={(visualResult.diffPixels ?? 0).toLocaleString()} accent="violet" />
                    <DiffStat label="Total pixels" value={(visualResult.totalPixels ?? 0).toLocaleString()} accent="slate" />
                    <DiffStat
                      label="Diff %"
                      value={`${(visualResult.diffPercent ?? 0).toFixed(2)}%`}
                      accent={
                        (visualResult.diffPercent ?? 0) === 0 ? 'emerald'
                        : (visualResult.diffPercent ?? 0) < 0.5 ? 'amber'
                        : 'red'
                      }
                    />
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {visualResult.baselineUrl && (
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Baseline</p>
                      <img src={visualResult.baselineUrl} alt="baseline" className="w-full rounded-lg border border-slate-200 dark:border-slate-700" />
                    </div>
                  )}
                  {visualResult.currentUrl && (
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Current</p>
                      <img src={visualResult.currentUrl} alt="current" className="w-full rounded-lg border border-slate-200 dark:border-slate-700" />
                    </div>
                  )}
                  {visualResult.diffUrl && (
                    <div className="sm:col-span-2">
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Diff (red = changed)</p>
                      <img src={visualResult.diffUrl} alt="diff" className="w-full rounded-lg border border-slate-200 dark:border-slate-700" />
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {/* ───── Accessibility Panel ───── */}
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden dark:bg-slate-900 dark:border-slate-800">
          <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center dark:border-slate-800">
            <div className="flex items-center gap-2">
              <ShieldCheck size={16} className="text-emerald-500" />
              <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">Accessibility (axe-core)</h3>
            </div>
            <button
              onClick={handleA11y}
              disabled={!canRun || isA11yRunning}
              className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1.5"
            >
              {isA11yRunning ? <Loader2 size={12} className="animate-spin" /> : <Activity size={12} />}
              {isA11yRunning ? 'Scanning...' : 'Run A11y Scan'}
            </button>
          </div>

          <div className="p-6">
            {!a11yResult && !isA11yRunning && (
              <p className="text-xs text-slate-400 dark:text-slate-500 py-12 text-center">
                Run an accessibility scan to detect WCAG 2.1 AA violations.
              </p>
            )}

            {a11yResult && a11yResult.success && (
              <>
                <div className="grid grid-cols-4 gap-2 mb-4">
                  <SeverityTile label="Critical" value={a11yResult.counts.critical} impact="critical" />
                  <SeverityTile label="Serious" value={a11yResult.counts.serious} impact="serious" />
                  <SeverityTile label="Moderate" value={a11yResult.counts.moderate} impact="moderate" />
                  <SeverityTile label="Minor" value={a11yResult.counts.minor} impact="minor" />
                </div>

                <div className="flex justify-between text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-3">
                  <span>{a11yResult.violationCount} violations</span>
                  <span>{a11yResult.passes} passes · {a11yResult.inapplicable} N/A</span>
                </div>

                {a11yResult.violations.length === 0 ? (
                  <div className="px-4 py-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs flex items-center gap-2 dark:bg-emerald-900/20 dark:border-emerald-800 dark:text-emerald-300">
                    <CheckCircle2 size={14} /> No violations detected on this page.
                  </div>
                ) : (
                  <div className="space-y-2 max-h-[420px] overflow-y-auto">
                    {a11yResult.violations.map((v) => (
                      <div key={v.id} className="border border-slate-200 rounded-xl p-3 dark:border-slate-700">
                        <div className="flex items-start gap-2 mb-1">
                          <AlertTriangle size={14} className="text-orange-500 mt-0.5 flex-shrink-0" />
                          <p className="text-xs font-bold text-slate-800 dark:text-slate-200 flex-1">{v.help}</p>
                          <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded border ${IMPACT_COLOR[v.impact || 'minor']}`}>
                            {v.impact || 'minor'}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-2">{v.description}</p>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-[10px] text-slate-400">Affected: {v.nodeCount} {v.nodeCount === 1 ? 'element' : 'elements'}</span>
                          <a
                            href={v.helpUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] text-blue-500 hover:underline flex items-center gap-1"
                          >
                            Learn more <ExternalLink size={10} />
                          </a>
                        </div>
                        {v.sampleSelectors.length > 0 && (
                          <div className="bg-slate-50 dark:bg-slate-800 rounded-md p-2 font-mono text-[10px] text-slate-600 dark:text-slate-300 space-y-0.5">
                            {v.sampleSelectors.map((sel, i) => (
                              <div key={i} className="truncate">{sel}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/* ───────────────────────────────────────────────────────────────────── */

const DiffStat: React.FC<{ label: string; value: string; accent: string }> = ({ label, value, accent }) => {
  const cls: Record<string, string> = {
    violet: 'text-violet-600 dark:text-violet-400',
    slate: 'text-slate-600 dark:text-slate-400',
    emerald: 'text-emerald-600 dark:text-emerald-400',
    amber: 'text-amber-600 dark:text-amber-400',
    red: 'text-red-600 dark:text-red-400',
  };
  return (
    <div className="px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800/50">
      <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">{label}</p>
      <p className={`text-base font-black ${cls[accent]}`}>{value}</p>
    </div>
  );
};

const SeverityTile: React.FC<{ label: string; value: number; impact: 'critical' | 'serious' | 'moderate' | 'minor' }> = ({ label, value, impact }) => (
  <div className={`px-2 py-2 rounded-xl border text-center ${IMPACT_COLOR[impact]}`}>
    <p className="text-[9px] font-black uppercase tracking-widest opacity-80">{label}</p>
    <p className="text-xl font-black">{value}</p>
  </div>
);
