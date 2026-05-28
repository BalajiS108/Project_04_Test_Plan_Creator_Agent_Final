import React from 'react';
import { Activity, Construction, Terminal } from 'lucide-react';

/**
 * Performance Testing module — placeholder while the JMeter CLI integration
 * is being built. The next turn will wire this page to a backend endpoint
 * that spawns `jmeter -n -t plan.jmx -l result.jtl`, streams progress, and
 * surfaces aggregate metrics (avg/p95 response time, throughput, error %).
 *
 * Until then the page documents what's coming so users see the surface area
 * we'll fill, and isn't presented as a working feature.
 */

interface PerformanceTestingProps {
  onBack?: () => void;
}

export const PerformanceTesting: React.FC<PerformanceTestingProps> = () => {
  return (
    <div className="w-full max-w-4xl mx-auto p-6">
      <div className="bg-white border border-slate-200 rounded-2xl p-8 shadow-sm dark:bg-slate-900 dark:border-slate-800">
        <div className="flex items-center gap-3 mb-5">
          <div className="bg-gradient-to-br from-orange-500 to-amber-500 p-2.5 rounded-xl text-white shadow-md">
            <Activity size={20} />
          </div>
          <div>
            <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">Performance Testing</h2>
            <p className="text-[11px] uppercase tracking-widest text-slate-400 font-bold mt-0.5">Load &amp; throughput via Apache JMeter</p>
          </div>
        </div>

        <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 mb-6 dark:border-amber-900/40 dark:bg-amber-950/20">
          <div className="flex items-start gap-3">
            <Construction size={18} className="text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-xs font-black uppercase tracking-wide text-amber-700 dark:text-amber-300 mb-1">Coming next turn</p>
              <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
                The JMeter CLI integration is queued for the next build pass. The plan: upload a <span className="font-mono text-xs">.jmx</span> test plan (or generate one from your URL + concurrency/duration), the backend spawns <span className="font-mono text-xs">jmeter -n -t plan.jmx -l result.jtl</span>, parses the JTL output, and surfaces aggregate metrics here.
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">What this will support</h3>
          <ul className="text-sm text-slate-600 dark:text-slate-300 space-y-2 list-disc list-inside leading-relaxed">
            <li><strong>HTTP/HTTPS load tests</strong> against any URL with configurable virtual users, ramp-up, and duration</li>
            <li><strong>Aggregate metrics</strong>: avg / median / p95 / p99 response time, throughput (req/sec), error %</li>
            <li><strong>Per-endpoint breakdown</strong> when the test plan hits multiple URLs</li>
            <li><strong>JTL export</strong> so results can be opened in JMeter's GUI or fed to other tools</li>
          </ul>
        </div>

        <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-700 dark:bg-slate-800/40">
          <div className="flex items-start gap-3">
            <Terminal size={16} className="text-slate-500 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300 mb-1">Prerequisite for the full integration</p>
              <p className="text-[12px] text-slate-600 dark:text-slate-400 leading-relaxed">
                Apache JMeter must be installed on the machine running the backend. Verify with <span className="font-mono">jmeter -v</span>. The backend will look for it on PATH first, then fall back to <span className="font-mono">$JMETER_HOME/bin/jmeter</span>.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
