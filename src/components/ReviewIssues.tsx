import React from 'react';
import { RefreshCcw, FileText, CheckCircle2, ChevronRight, Info, Loader2 } from 'lucide-react';
import { Connection, JiraIssue } from '../types';

interface ReviewIssuesProps {
  activeConnection: Connection | null;
  issues: JiraIssue[];
  additionalContext: string;
  setAdditionalContext: (v: string) => void;
  // The URL of the application under test. Distinct from the Jira host
  // (which is where stories are read from, not where the app runs).
  // Optional — when blank, the generator leaves URLs out instead of guessing.
  applicationUrl: string;
  setApplicationUrl: (v: string) => void;
  outputType: 'plan' | 'cases';
  setOutputType: (v: 'plan' | 'cases') => void;
  onGenerate: () => void;
  isGenerating: boolean;
  sourceLabel?: string;
  inputSource?: string;
}

export const ReviewIssues: React.FC<ReviewIssuesProps> = ({
  activeConnection,
  issues,
  additionalContext,
  setAdditionalContext,
  applicationUrl,
  setApplicationUrl,
  outputType,
  setOutputType,
  onGenerate,
  isGenerating,
  sourceLabel,
  inputSource,
}) => {
  const sourceCaption =
    inputSource && inputSource !== 'jira'
      ? `${inputSource.toUpperCase()} · ${sourceLabel || 'requirements'}`
      : activeConnection ? `${activeConnection.name} (${activeConnection.url})` : 'No connection';
  return (
    <div className="w-full max-w-4xl mx-auto space-y-8">
      {/* Active Filter Summary */}

      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3 overflow-hidden">
          <div className="bg-white p-2 rounded-lg border border-slate-200 text-slate-600 shadow-sm flex-shrink-0">
             <RefreshCcw size={16} />
          </div>
          <p className="text-sm text-slate-600 truncate font-semibold">
            {sourceCaption}
          </p>
        </div>
        <button className="flex items-center gap-2 text-slate-800 font-bold text-xs bg-white border border-slate-200 px-4 py-2 rounded-lg hover:bg-slate-50 transition-all">
          <RefreshCcw size={14} />
          Refresh Issues
        </button>
      </div>

      {/* Application URL — the page-under-test, NOT the Jira host */}
      <div className="bg-white border border-slate-200 rounded-2xl p-8 shadow-sm">
        <div className="flex justify-between items-center mb-2">
          <h3 className="text-lg font-bold text-slate-800">Application URL</h3>
          <span className="text-[10px] font-black uppercase tracking-widest text-emerald-700 bg-emerald-50 px-2 py-1 rounded">Optional</span>
        </div>
        <p className="text-sm text-slate-500 mb-3 font-medium">
          URL of the application the tests will run against (e.g. <span className="font-mono text-xs">https://app.example.com</span>).
          Leave blank if no specific URL applies — the generator will mark it as <span className="font-mono text-xs">[URL not provided]</span> rather than inventing one.
        </p>
        <input
          type="text"
          value={applicationUrl}
          onChange={(e) => setApplicationUrl(e.target.value)}
          placeholder="https://your-app.example.com"
          className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 placeholder:text-slate-400 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none transition-all font-medium font-mono text-sm"
        />
        <p className="text-[11px] text-slate-400 mt-2">
          NOTE: this is the app under test, NOT your Jira host. If you generate from Jira and leave this blank, the test cases won't mention a URL (you can edit them later or set it here before regenerating).
        </p>
      </div>

      {/* Additional Context & Notes */}
      <div className="bg-white border border-slate-200 rounded-2xl p-8 shadow-sm">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-bold text-slate-800">Additional Context & Notes</h3>
          <span className="text-[10px] font-black uppercase tracking-widest text-blue-600 bg-blue-50 px-2 py-1 rounded">Refining Logic</span>
        </div>
        <p className="text-sm text-slate-500 mb-4 font-medium">Add any additional context, special requirements, or constraints for the final generation.</p>
        <textarea
          rows={4}
          value={additionalContext}
          onChange={(e) => setAdditionalContext(e.target.value)}
          placeholder="Add any additional context about the testing approach, special requirements, constraints, team structure, or specific areas of focus..."
          className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 placeholder:text-slate-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all font-medium resize-none"
        ></textarea>
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 dark:border-amber-900/40 dark:bg-amber-950/20">
          <p className="text-[11px] font-bold text-amber-700 dark:text-amber-300 uppercase tracking-wide mb-1">Want more test cases?</p>
          <p className="text-[12px] text-slate-700 dark:text-slate-300 leading-relaxed">
            The generator only produces cases it can justify from the source. To get more, list extra scenarios here — e.g.{' '}
            <em>"Also test: locked-out user, invalid password, empty username field, special characters in username, password &gt; 50 chars."</em>{' '}
            Each scenario you describe becomes its own grounded test case.
          </p>
        </div>
      </div>

      {/* Review Section */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
        <div className="px-8 py-6 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
            <div>
              <h3 className="text-lg font-bold text-slate-800">
                Review {inputSource === 'jira' || !inputSource ? 'Jira Issues' : 'Requirements'} ({issues.length})
              </h3>
              <p className="text-xs text-slate-500 font-medium">
                {inputSource === 'jira' || !inputSource
                  ? 'Issues that will be used to generate the test plan'
                  : 'Requirement chunks that will be used to generate the test plan'}
              </p>
           </div>
           <div className="flex items-center gap-2">
              <span className="bg-slate-200 text-slate-600 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest">
                {issues.length > 0 ? 'Ready to Process' : 'Empty List'}
              </span>
           </div>
        </div>
        
        <div className="p-0 max-h-[400px] overflow-y-auto">
          {issues.length > 0 ? (
            <div className="divide-y divide-slate-100">
              {issues.map(issue => (
                <div key={issue.id} className="p-6 hover:bg-slate-50 transition-colors group">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2">
                         <span className="text-[10px] font-black text-blue-600 bg-blue-50 px-2 py-0.5 rounded tracking-widest border border-blue-100">{issue.key}</span>
                         <span className="text-[10px] font-black text-slate-500 bg-slate-100 px-2 py-0.5 rounded tracking-widest border border-slate-200">{issue.status}</span>
                      </div>
                      <h4 className="text-sm font-bold text-slate-800 leading-tight truncate">{issue.summary}</h4>
                    </div>
                    <div className="bg-emerald-50 text-emerald-600 p-1.5 rounded-lg opacity-40 group-hover:opacity-100 transition-opacity">
                       <CheckCircle2 size={16} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-16 text-center">
                <div className="bg-slate-100 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4 text-slate-300 border-2 border-dashed border-slate-200">
                  <FileText size={24} />
                </div>
                <p className="text-slate-400 font-bold mb-1 uppercase tracking-widest text-[10px]">No issues selected</p>
                <p className="text-sm text-slate-400 max-w-xs mx-auto">Go back to fetch issues to populate this list.</p>
            </div>
          )}
        </div>

        <div className="p-8 bg-slate-50/50 border-t border-slate-100 dark:bg-slate-800/50 dark:border-slate-700">
           <div className="flex gap-4 mb-6">
              <button
                onClick={() => setOutputType('plan')}
                className={`flex-1 py-4 rounded-xl font-bold transition-all border-2 flex items-center justify-center gap-2 ${
                  outputType === 'plan' 
                    ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' 
                    : 'border-slate-200 bg-white text-slate-500 hover:border-blue-200 dark:bg-slate-800 dark:border-slate-600 dark:text-slate-400'
                }`}
              >
                <FileText size={18} />
                Test Plan
              </button>
              <button
                onClick={() => setOutputType('cases')}
                className={`flex-1 py-4 rounded-xl font-bold transition-all border-2 flex items-center justify-center gap-2 ${
                  outputType === 'cases' 
                    ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' 
                    : 'border-slate-200 bg-white text-slate-500 hover:border-blue-200 dark:bg-slate-800 dark:border-slate-600 dark:text-slate-400'
                }`}
              >
                <CheckCircle2 size={18} />
                Detailed Test Cases
              </button>
           </div>
           
           <button 
             onClick={onGenerate}
             disabled={isGenerating || issues.length === 0}
             className="w-full bg-gradient-to-r from-blue-600 to-blue-700 text-white py-5 rounded-2xl font-black hover:shadow-xl transition-all shadow-lg shadow-blue-200 flex items-center justify-center gap-3 text-lg active:scale-[0.98] disabled:opacity-50"
           >
              {isGenerating ? <Loader2 size={24} className="animate-spin" /> : <RefreshCcw size={24} />}
              {outputType === 'plan' ? 'Generate Standardized Plan' : 'Generate Test Cases'}
           </button>
        </div>
      </div>
    </div>
  );
};
