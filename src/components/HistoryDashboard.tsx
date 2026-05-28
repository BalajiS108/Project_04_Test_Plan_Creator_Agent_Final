import React, { useEffect, useMemo, useState } from 'react';
import {
  History, BarChart3, Loader2, RefreshCw, Trash2, ChevronLeft,
  CheckCircle2, XCircle, AlertTriangle, Clock, Activity, TrendingUp, Zap,
} from 'lucide-react';
import {
  listRuns, deleteRun, fetchStats, getRun,
  RunMeta, StoredRun, HistoryStats,
} from '../services/historyService';

interface HistoryDashboardProps {
  onBack: () => void;
}

export const HistoryDashboard: React.FC<HistoryDashboardProps> = ({ onBack }) => {
  const [runs, setRuns] = useState<RunMeta[] | null>(null);
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<StoredRun | null>(null);
  const [loadingRun, setLoadingRun] = useState<string | null>(null);

  const refresh = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [r, s] = await Promise.all([listRuns(200), fetchStats()]);
      setRuns(r);
      setStats(s);
    } catch (e: any) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const handleSelect = async (id: string) => {
    setLoadingRun(id);
    try {
      const run = await getRun(id);
      setSelectedRun(run);
    } catch (e: any) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoadingRun(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this run from history? This cannot be undone.')) return;
    try {
      await deleteRun(id);
      if (selectedRun?.id === id) setSelectedRun(null);
      await refresh();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message);
    }
  };

  if (isLoading && !runs) {
    return (
      <div className="w-full max-w-6xl mx-auto py-32 flex flex-col items-center text-slate-400 dark:text-slate-500">
        <Loader2 size={32} className="animate-spin mb-4" />
        <p className="text-sm font-medium">Loading run history...</p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-6xl mx-auto">
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
              <History size={20} /> Run History
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
              Every test execution is captured here for trend analysis.
            </p>
          </div>
        </div>
        <button
          onClick={refresh}
          disabled={isLoading}
          className="flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-200 text-slate-600 text-xs font-bold hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          {isLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-6 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm dark:bg-red-900/20 dark:border-red-800 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Top-level stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <StatTile label="Total Runs" value={stats.totalRuns} icon={Activity} accent="blue" />
          <StatTile label="Avg Pass Rate" value={`${stats.averagePassRate}%`} icon={CheckCircle2} accent="emerald" />
          <StatTile label="Last 7 Days" value={stats.runs7d} icon={Clock} accent="slate" />
          <StatTile label="Last 30 Days" value={stats.runs30d} icon={TrendingUp} accent="violet" />
        </div>
      )}

      {/* Trend chart */}
      {stats && stats.trend.length > 1 && (
        <div className="bg-white border border-slate-200 rounded-2xl p-6 mb-8 dark:bg-slate-900 dark:border-slate-800">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                <BarChart3 size={14} /> Pass-rate trend
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">Daily aggregate, last 30 days</p>
            </div>
          </div>
          <Sparkline points={stats.trend.map((t) => ({ x: t.date, y: t.passRate }))} />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Flakiest */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 dark:bg-slate-900 dark:border-slate-800">
          <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2 mb-3">
            <Zap size={14} className="text-amber-500" /> Flakiest tests
          </h3>
          {!stats || stats.flakiest.length === 0 ? (
            <p className="text-xs text-slate-400 dark:text-slate-500">No flaky tests detected yet.</p>
          ) : (
            <div className="space-y-2">
              {stats.flakiest.map((t, i) => (
                <div key={i} className="flex items-center justify-between gap-3 py-2 border-b border-slate-100 last:border-0 dark:border-slate-800">
                  <p className="text-xs text-slate-700 truncate dark:text-slate-300">{t.name}</p>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-[10px] text-emerald-600 dark:text-emerald-400">✓ {t.passes}</span>
                    <span className="text-[10px] text-red-600 dark:text-red-400">✗ {t.fails}</span>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-100 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800">
                      {t.flakiness}%
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Slowest */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 dark:bg-slate-900 dark:border-slate-800">
          <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2 mb-3">
            <Clock size={14} className="text-violet-500" /> Slowest tests
          </h3>
          {!stats || stats.slowest.length === 0 ? (
            <p className="text-xs text-slate-400 dark:text-slate-500">No data yet.</p>
          ) : (
            <div className="space-y-2">
              {stats.slowest.map((t, i) => (
                <div key={i} className="flex items-center justify-between gap-3 py-2 border-b border-slate-100 last:border-0 dark:border-slate-800">
                  <p className="text-xs text-slate-700 truncate dark:text-slate-300">{t.name}</p>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-violet-50 text-violet-700 border border-violet-100 dark:bg-violet-900/30 dark:text-violet-400 dark:border-violet-800">
                    {(t.avgDuration / 1000).toFixed(1)}s avg
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Recent runs */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden dark:bg-slate-900 dark:border-slate-800">
        <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center dark:border-slate-800">
          <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">Recent runs</h3>
          {runs && <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{runs.length}</span>}
        </div>
        {!runs || runs.length === 0 ? (
          <div className="py-16 text-center text-slate-400 dark:text-slate-500 text-sm">
            No runs yet — execute a test plan to populate history.
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-[480px] overflow-y-auto">
            {runs.map((r) => (
              <div
                key={r.id}
                className="px-6 py-3 hover:bg-slate-50 cursor-pointer flex items-center gap-4 dark:hover:bg-slate-800/40"
                onClick={() => handleSelect(r.id)}
              >
                <StatusDot passRate={r.passRate} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-slate-800 truncate dark:text-slate-200">{r.productName}</p>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500">
                    {formatDate(r.executedAt)} · {r.mode}{r.source ? ` · ${r.source}` : ''}
                  </p>
                </div>
                <span className="text-xs font-bold text-emerald-600 dark:text-emerald-400">✓ {r.passed}</span>
                <span className="text-xs font-bold text-red-600 dark:text-red-400">✗ {r.failed}</span>
                <span className="text-xs text-slate-500 dark:text-slate-400">{(r.duration / 1000).toFixed(1)}s</span>
                <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                  r.passRate === 100
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                    : r.passRate >= 70
                      ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                      : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                }`}>
                  {r.passRate}%
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(r.id); }}
                  className="p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                  title="Delete this run"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Run detail modal */}
      {selectedRun && (
        <RunDetailModal
          run={selectedRun}
          onClose={() => setSelectedRun(null)}
          loading={loadingRun === selectedRun.id}
        />
      )}
    </div>
  );
};

/* ────────────────────────────────────────────────────────────────────── */

const StatTile: React.FC<{ label: string; value: string | number; icon: any; accent: string }> = ({ label, value, icon: Icon, accent }) => {
  const colorMap: Record<string, string> = {
    blue: 'text-blue-600 dark:text-blue-400',
    emerald: 'text-emerald-600 dark:text-emerald-400',
    violet: 'text-violet-600 dark:text-violet-400',
    slate: 'text-slate-600 dark:text-slate-400',
  };
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4 dark:bg-slate-900 dark:border-slate-800">
      <div className="flex items-center gap-2 mb-2 text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500">
        <Icon size={12} className={colorMap[accent]} /> {label}
      </div>
      <p className={`text-2xl font-black ${colorMap[accent]}`}>{value}</p>
    </div>
  );
};

const StatusDot: React.FC<{ passRate: number }> = ({ passRate }) => {
  const cls =
    passRate === 100 ? 'bg-emerald-500'
    : passRate >= 70 ? 'bg-amber-500'
    : 'bg-red-500';
  return <span className={`w-2 h-2 rounded-full ${cls} flex-shrink-0`} />;
};

const Sparkline: React.FC<{ points: { x: string; y: number }[] }> = ({ points }) => {
  // Coordinate system. We pad more on the left for Y-axis labels and at the
  // bottom for X-axis labels so the chart is actually readable instead of
  // being a bare sparkline.
  const width = 800;
  const height = 220;
  const padLeft = 48;     // room for Y labels "0%" / "50%" / "100%"
  const padRight = 16;
  const padTop = 16;
  const padBottom = 56;   // room for rotated date labels + axis title
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const maxY = 100;
  const minY = 0;

  const xFor = (i: number) => padLeft + (i * plotW) / Math.max(points.length - 1, 1);
  const yFor = (v: number) => padTop + plotH - ((v - minY) / (maxY - minY)) * plotH;

  const path = useMemo(() => {
    if (points.length === 0) return '';
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(1)} ${yFor(p.y).toFixed(1)}`).join(' ');
  }, [points]);

  // Y-axis tick values
  const yTicks = [0, 25, 50, 75, 100];
  // X-axis tick selection — show every point if ≤ 10, else first/last + 3 interior
  const xTickIndices: number[] = (() => {
    if (points.length <= 10) return points.map((_, i) => i);
    const N = 5;
    return Array.from({ length: N }, (_, k) => Math.round((k * (points.length - 1)) / (N - 1)));
  })();
  // Compact date — strip leading year if all points share it
  const compactDate = (s: string) => s.length >= 10 ? s.slice(5) : s;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-56" role="img" aria-label="Pass rate trend chart">
      {/* Y axis gridlines + labels */}
      {yTicks.map((t) => {
        const y = yFor(t);
        return (
          <g key={`yt-${t}`}>
            <line x1={padLeft} x2={width - padRight} y1={y} y2={y} stroke="currentColor" strokeWidth="0.5" strokeDasharray={t === 0 ? '' : '2 3'} className="text-slate-200 dark:text-slate-700" />
            <text x={padLeft - 6} y={y + 3} textAnchor="end" className="fill-slate-500 dark:fill-slate-400" fontSize="11">{t}%</text>
          </g>
        );
      })}

      {/* X axis line */}
      <line x1={padLeft} x2={width - padRight} y1={yFor(0)} y2={yFor(0)} stroke="currentColor" strokeWidth="1" className="text-slate-300 dark:text-slate-600" />

      {/* X tick marks + date labels */}
      {xTickIndices.map((i) => {
        const x = xFor(i);
        return (
          <g key={`xt-${i}`}>
            <line x1={x} x2={x} y1={yFor(0)} y2={yFor(0) + 4} stroke="currentColor" strokeWidth="0.5" className="text-slate-400" />
            <text x={x} y={yFor(0) + 18} textAnchor="middle" className="fill-slate-500 dark:fill-slate-400" fontSize="10">
              {compactDate(points[i].x)}
            </text>
          </g>
        );
      })}

      {/* Axis titles */}
      <text x={padLeft + plotW / 2} y={height - 6} textAnchor="middle" className="fill-slate-600 dark:fill-slate-300 font-bold" fontSize="11">Date (MM-DD)</text>
      <text x={12} y={padTop + plotH / 2} textAnchor="middle" transform={`rotate(-90 12 ${padTop + plotH / 2})`} className="fill-slate-600 dark:fill-slate-300 font-bold" fontSize="11">Pass rate (%)</text>

      {/* Trend line */}
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-500" />

      {/* Data points */}
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={xFor(i)} cy={yFor(p.y)} r="3" className="text-blue-500" fill="currentColor" />
          <title>{p.x}: {p.y}% pass</title>
        </g>
      ))}
    </svg>
  );
};

const RunDetailModal: React.FC<{ run: StoredRun; onClose: () => void; loading?: boolean }> = ({ run, onClose, loading }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-slate-900/50 backdrop-blur-sm">
    <div className="bg-white dark:bg-slate-900 w-full max-w-4xl rounded-2xl shadow-2xl max-h-[85vh] overflow-hidden flex flex-col">
      <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center">
        <div>
          <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">{run.productName}</h3>
          <p className="text-[10px] text-slate-500 dark:text-slate-400">{formatDate(run.executedAt)} · {run.mode}</p>
        </div>
        <button onClick={onClose} className="p-2 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
          <XCircle size={18} />
        </button>
      </div>
      <div className="px-6 py-4 grid grid-cols-6 gap-3 border-b border-slate-100 dark:border-slate-800">
        <Mini label="Total" value={run.total} />
        <Mini label="Passed" value={run.passed} accent="emerald" />
        <Mini label="Failed" value={run.failed} accent="red" />
        <Mini label="Errors" value={run.errors} accent="orange" />
        <Mini label="Skipped" value={run.skipped} accent="slate" />
        <Mini label="Duration" value={`${(run.duration / 1000).toFixed(1)}s`} accent="violet" />
      </div>
      <div className="flex-1 overflow-y-auto p-6 space-y-2">
        {loading && <div className="flex items-center justify-center py-12 text-slate-400"><Loader2 size={20} className="animate-spin mr-2" /> Loading...</div>}
        {!loading && run.results.length === 0 && (
          <p className="text-sm text-slate-400 dark:text-slate-500">No per-test details captured for this run.</p>
        )}
        {!loading && run.results.map((tc: any) => (
          <div key={tc.id} className="flex items-center gap-3 px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800">
            {tc.status === 'PASS' ? <CheckCircle2 size={14} className="text-emerald-500" />
              : tc.status === 'FAIL' ? <XCircle size={14} className="text-red-500" />
              : <AlertTriangle size={14} className="text-orange-500" />}
            <span className="text-[10px] font-black text-blue-600 bg-blue-50 px-2 py-0.5 rounded tracking-widest dark:bg-blue-900/30 dark:text-blue-400">
              {tc.jiraKey || `TC-${tc.id}`}
            </span>
            <p className="flex-1 text-xs text-slate-700 truncate dark:text-slate-300">{tc.name}</p>
            <span className="text-[10px] text-slate-400">{((tc.duration || 0) / 1000).toFixed(1)}s</span>
          </div>
        ))}
      </div>
    </div>
  </div>
);

const Mini: React.FC<{ label: string; value: string | number; accent?: string }> = ({ label, value, accent = 'blue' }) => {
  const cls: Record<string, string> = {
    blue: 'text-blue-600 dark:text-blue-400',
    emerald: 'text-emerald-600 dark:text-emerald-400',
    red: 'text-red-600 dark:text-red-400',
    orange: 'text-orange-600 dark:text-orange-400',
    slate: 'text-slate-600 dark:text-slate-400',
    violet: 'text-violet-600 dark:text-violet-400',
  };
  return (
    <div className="text-center">
      <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">{label}</p>
      <p className={`text-lg font-black ${cls[accent]}`}>{value}</p>
    </div>
  );
};

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}
