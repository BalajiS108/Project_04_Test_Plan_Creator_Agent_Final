import React from 'react';
import { Settings, Plus, ExternalLink, ShieldCheck, AlertCircle } from 'lucide-react';
import { Connection } from '../types';

interface JiraConnectionProps {
  activeConnection: Connection | null;
  connections: Connection[];
  onSelectConnection: (id: string) => void;
  onAddConnection: () => void;
  onContinue: () => void;
}

export const JiraConnection: React.FC<JiraConnectionProps> = ({ activeConnection, connections, onSelectConnection, onAddConnection, onContinue }) => {
  return (
    <div className="w-full max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-2">
        <h2 className="text-2xl font-bold text-slate-800">Jira Connection</h2>
      </div>
      <p className="text-slate-500 mb-8 font-medium">Connect to your Jira instance to fetch requirements and user stories.</p>

      <div className="space-y-6">
        <div>
          <label className="block text-sm font-bold text-slate-700 mb-2 uppercase tracking-wider">Select Jira Connection</label>
          <div className="relative">
            <select 
              value={activeConnection?.id || ''}
              onChange={(e) => onSelectConnection(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3.5 appearance-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all font-medium text-slate-700"
            >
               <option value="" disabled>Choose a connection...</option>
               {connections.map(c => (
                 <option key={c.id} value={c.id}>
                   {c.name} ({c.url})
                 </option>
               ))}
            </select>
            <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400">
                <ExternalLink size={18} />
            </div>
          </div>
        </div>

        <button 
          onClick={onAddConnection}
          className="flex items-center gap-2 text-blue-600 font-bold hover:bg-blue-50 px-4 py-2 rounded-lg transition-all border border-transparent hover:border-blue-100"
        >
          <Settings size={18} />
          Add / Manage Connections
        </button>

        <div className="pt-8 border-t border-slate-100">
           <button 
             onClick={onContinue}
             className="w-full bg-blue-600 text-white py-4 rounded-xl font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-200 flex items-center justify-center gap-2 text-lg"
           >
              Continue to Fetch Issues
           </button>
        </div>
      </div>
    </div>
  );
};
