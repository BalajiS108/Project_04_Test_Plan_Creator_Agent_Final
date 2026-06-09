import React, { useState, useEffect } from 'react'
import { Briefcase, Settings, ChevronRight, Database, Search, ClipboardCheck, FileText, CheckCircle2, ShieldCheck, Code2, LogOut, User as UserIcon, Workflow, Activity } from 'lucide-react'
import { JiraConnection } from './components/JiraConnection'
import { FetchIssues } from './components/FetchIssues'
import { ReviewIssues } from './components/ReviewIssues'
import { TestPlanView } from './components/TestPlanView'
import { SettingsModal } from './components/SettingsModal'
import { HistoryDashboard } from './components/HistoryDashboard'
import { QualityAudit } from './components/QualityAudit'
import { ApiTesting } from './components/ApiTesting'
import { CICDDashboard } from './components/CICDDashboard'
import { PerformanceTesting } from './components/PerformanceTesting'
import { LoginScreen } from './components/LoginScreen'
import { fetchAuthStatus, restoreSession, clearSession, installAuthInterceptor, registerUnauthorizedHandler, AuthUser } from './services/authService'
import { Connection, LLMConfig, JiraIssue, InputSourceType } from './types'
import { fetchJiraIssues } from './services/jiraFetcher'
import { fetchFromBrd, fetchFromHtml, fetchFromFigma } from './services/inputSources'
import { generateTestPlanResult } from './services/llmNavigator'

function App() {
  const [step, setStep] = useState(1)
  const [view, setView] = useState<'wizard' | 'history' | 'audit' | 'apitest' | 'cicd' | 'perf'>('wizard')
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)

  // Auth state (only meaningful when the backend's AUTH_ENABLED is true)
  const [authReady, setAuthReady] = useState(false)
  const [authEnabled, setAuthEnabled] = useState(false)
  const [authBootstrap, setAuthBootstrap] = useState(false)
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  // Banner shown on the login screen when a 401 bounced the user back (e.g.
  // expired token). Cleared on successful sign-in.
  const [authNotice, setAuthNotice] = useState<string | null>(null)
  const [connections, setConnections] = useState<Connection[]>([])
  const [activeConnection, setActiveConnection] = useState<Connection | null>(null)
  const [llmConfig, setLlmConfig] = useState<LLMConfig | null>(null)
  const [fetchedIssues, setFetchedIssues] = useState<JiraIssue[]>([])
  const [generatedPlan, setGeneratedPlan] = useState<string>('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [productName, setProductName] = useState('')
  const [projectKey, setProjectKey] = useState('')
  const [sprintVersion, setSprintVersion] = useState('')
  const [additionalContext, setAdditionalContext] = useState('')
  // The URL of the application under test — passed to the LLM as the
  // Source URL placeholder. Optional. Distinct from activeConnection.url
  // (which is where stories are READ from, not where the app runs).
  const [applicationUrl, setApplicationUrl] = useState('')
  const [outputType, setOutputType] = useState<'plan' | 'cases'>('plan')
  const [isDarkMode, setIsDarkMode] = useState(false)

  // Multi-source input state
  const [inputSource, setInputSource] = useState<InputSourceType>('jira')
  const [isFetching, setIsFetching] = useState(false)
  const [sourceLabel, setSourceLabel] = useState<string>('')   // e.g. uploaded filename, URL, figma doc name
  const [brdFile, setBrdFile] = useState<File | null>(null)
  // Multi-page HTML input — one row per page being tested.
  // Each row may contribute its own URL (used in Preconditions of derived test cases)
  // and/or its own pasted HTML (used as the content source for that page).
  const [htmlPages, setHtmlPages] = useState<{ id: string; url: string; html: string }[]>([
    { id: 'p1', url: '', html: '' },
  ])
  const [figmaUrl, setFigmaUrl] = useState('')
  const [figmaToken, setFigmaToken] = useState('')

  // Boot: ask the backend if auth is enabled, then restore any saved session.
  // If auth is off, the rest of the app behaves identically to before.
  useEffect(() => {
    let cancelled = false;
    // Bounce the user to the login screen (with a reason) whenever any authed
    // request 401s because the stored token expired/was invalidated.
    installAuthInterceptor();
    registerUnauthorizedHandler((reason) => {
      setAuthUser(null);
      setAuthNotice(reason);
    });
    (async () => {
      try {
        const status = await fetchAuthStatus();
        if (cancelled) return;
        setAuthEnabled(status.enabled);
        setAuthBootstrap(status.enabled && !status.anyUserExists);
        if (status.enabled) {
          const session = restoreSession();
          if (session) setAuthUser(session.user);
        }
      } catch {
        // Backend not reachable yet — let the rest of the app retry on its own
        // calls; treat as auth-off so the UI doesn't get stuck.
      } finally {
        if (!cancelled) setAuthReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleAuthenticated = (user: AuthUser) => {
    setAuthUser(user);
    setAuthBootstrap(false);
    setAuthNotice(null);
  };

  const handleLogout = () => {
    clearSession();
    setAuthUser(null);
  };

  // Load from local storage on init
  useEffect(() => {
    const savedConnections = localStorage.getItem('tp_connections')
    const savedLlm = localStorage.getItem('tp_llm_config')
    const savedProduct = localStorage.getItem('tp_product_name')
    const savedProject = localStorage.getItem('tp_project_key')
    const savedSprint = localStorage.getItem('tp_sprint_version')
    const savedContext = localStorage.getItem('tp_additional_context')

    if (savedConnections) {
      const conns = JSON.parse(savedConnections);
      setConnections(conns);
      if (conns.length > 0) setActiveConnection(conns[0]);
    }
    if (savedLlm) setLlmConfig(JSON.parse(savedLlm))
    if (savedProduct) setProductName(savedProduct)
    if (savedProject) setProjectKey(savedProject)
    if (savedSprint) setSprintVersion(savedSprint)
    if (savedContext) setAdditionalContext(savedContext)

    // Auto-detect system preference if no saved theme
    const savedTheme = localStorage.getItem('tp_theme')
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (savedTheme === 'dark' || (!savedTheme && prefersDark)) {
      setIsDarkMode(true);
      document.documentElement.classList.add('dark');
    }
  }, [])

  // Auto-save project setup
  useEffect(() => {
    localStorage.setItem('tp_product_name', productName);
    localStorage.setItem('tp_project_key', projectKey);
    localStorage.setItem('tp_sprint_version', sprintVersion);
    localStorage.setItem('tp_additional_context', additionalContext);
  }, [productName, projectKey, sprintVersion, additionalContext]);

  const toggleTheme = () => {
    const newTheme = !isDarkMode ? 'dark' : 'light';
    setIsDarkMode(!isDarkMode);
    if (newTheme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('tp_theme', newTheme);
  };

  const handleSelectConnection = (id: string) => {
    const conn = connections.find(c => c.id === id);
    if (conn) setActiveConnection(conn);
  };

  // Once we reach step 4, mount TestPlanView once and keep it mounted for
  // the lifetime of the session so navigating to History Trends and back
  // doesn't blow away the execution report. The unmount/remount we used
  // to do dropped report, htmlReportUrl, error banners, expanded rows etc.
  const [hasReachedTestPlan, setHasReachedTestPlan] = useState(false);
  useEffect(() => { if (step === 4) setHasReachedTestPlan(true); }, [step]);

  const renderStep = () => {
    switch (step) {
      case 1: return <JiraConnection
        activeConnection={activeConnection}
        connections={connections}
        onSelectConnection={handleSelectConnection}
        onAddConnection={() => setIsSettingsOpen(true)}
        onContinue={() => setStep(2)}
      />;
      case 2: return <FetchIssues
        activeConnection={activeConnection}
        productName={productName}
        setProductName={setProductName}
        projectKey={projectKey}
        setProjectKey={setProjectKey}
        sprintVersion={sprintVersion}
        setSprintVersion={setSprintVersion}
        additionalContext={additionalContext}
        setAdditionalContext={setAdditionalContext}
        inputSource={inputSource}
        setInputSource={setInputSource}
        brdFile={brdFile}
        setBrdFile={setBrdFile}
        htmlPages={htmlPages}
        setHtmlPages={setHtmlPages}
        figmaUrl={figmaUrl}
        setFigmaUrl={setFigmaUrl}
        figmaToken={figmaToken}
        setFigmaToken={setFigmaToken}
        isFetching={isFetching}
        onFetch={handleFetchIssues}
        onBack={() => setStep(1)}
      />;
      case 3: return <ReviewIssues
        activeConnection={activeConnection}
        issues={fetchedIssues}
        additionalContext={additionalContext}
        setAdditionalContext={setAdditionalContext}
        applicationUrl={applicationUrl}
        setApplicationUrl={setApplicationUrl}
        outputType={outputType}
        setOutputType={setOutputType}
        onGenerate={handleGeneratePlan}
        isGenerating={isGenerating}
        sourceLabel={sourceLabel}
        inputSource={inputSource}
      />;
      // case 4 (TestPlanView) is rendered persistently outside this switch
      // — see the render block below.
      case 4: return null;
      default: return <JiraConnection
        activeConnection={activeConnection}
        connections={connections}
        onSelectConnection={handleSelectConnection}
        onAddConnection={() => setIsSettingsOpen(true)}
        onContinue={() => setStep(2)}
      />;
    }
  }

  const handleFetchIssues = async () => {
    // Per-source validation up front — fail fast with a clear message rather
    // than dispatching a request that will 4xx server-side.
    if (inputSource === 'jira' && !activeConnection) {
      alert("Please configure a Jira connection first!");
      return;
    }
    if (inputSource === 'brd' && !brdFile) {
      alert("Please select a BRD file to upload.");
      return;
    }
    if (inputSource === 'html' && !htmlPages.some(p => p.url.trim() || p.html.trim())) {
      alert("Please add at least one page with a URL or pasted HTML.");
      return;
    }
    if (inputSource === 'figma' && (!figmaUrl.trim() || !figmaToken.trim())) {
      alert("Please enter both a Figma URL and a personal access token.");
      return;
    }

    setIsFetching(true);
    try {
      let issues: JiraIssue[] = [];
      let label = '';
      switch (inputSource) {
        case 'jira': {
          issues = await fetchJiraIssues(activeConnection!, projectKey, sprintVersion);
          label = `${activeConnection!.name} · ${projectKey}`;
          break;
        }
        case 'brd': {
          const r = await fetchFromBrd(brdFile!);
          issues = r.items;
          label = r.label;
          break;
        }
        case 'html': {
          // One row per page being tested. Each row contributes either a URL to
          // fetch, pasted HTML, or both (HTML wins for content; URL is used as
          // the page-under-test label in derived test cases).
          const validPages = htmlPages
            .map(p => ({ url: p.url.trim(), html: p.html.trim() }))
            .filter(p => p.url || p.html);
          if (validPages.length === 0) throw new Error('Add at least one page with a URL or pasted HTML.');

          // Catch obviously-bad URLs client-side so the user gets a clearer error.
          for (let i = 0; i < validPages.length; i++) {
            const p = validPages[i];
            if (p.url && !p.html && !/^https?:\/\//i.test(p.url)) {
              throw new Error(`Page ${i + 1}: URL must start with http:// or https://, or paste HTML for that page.`);
            }
          }

          const r = await fetchFromHtml({ pages: validPages });
          issues = r.items;
          label = r.label;
          if (r.warnings && r.warnings.length) {
            // Surface non-fatal issues (e.g. one URL failed but others succeeded).
            console.warn('HTML fetch warnings:', r.warnings);
            alert('Some pages had issues:\n\n' + r.warnings.join('\n'));
          }
          break;
        }
        case 'figma': {
          const r = await fetchFromFigma(figmaUrl.trim(), figmaToken.trim());
          issues = r.items;
          label = r.label;
          break;
        }
      }
      setFetchedIssues(issues);
      setSourceLabel(label);
      setStep(3);
    } catch (error: any) {
      alert("Failed to fetch requirements: " + error.message);
    } finally {
      setIsFetching(false);
    }
  };

  const handleGeneratePlan = async () => {
    if (!llmConfig) {
      setIsSettingsOpen(true);
      return;
    }
    setIsGenerating(true);
    setStep(4);
    try {
      // Real URL we can ground the LLM in, so it stops making one up.
      // Priority:
      //   1. User-provided "Application URL" override (Step 3) — wins for any source
      //   2. HTML pages list (when exactly one distinct URL)
      //   3. Figma URL (it IS the design surface being tested)
      //
      // IMPORTANT: NEVER use the Jira instance URL (activeConnection.url) here.
      // That's where you READ the story from — not the URL of the app being
      // tested. Earlier this code did `sourceUrl = activeConnection.url` for
      // Jira input, which made every generated test case navigate to the user's
      // Atlassian host instead of their actual app.
      let sourceUrl = '';
      if (applicationUrl.trim()) {
        sourceUrl = applicationUrl.trim();
      } else if (inputSource === 'html') {
        const urls = Array.from(new Set(htmlPages.map(p => p.url.trim()).filter(Boolean)));
        if (urls.length === 1) sourceUrl = urls[0];
      } else if (inputSource === 'figma' && figmaUrl.trim()) {
        sourceUrl = figmaUrl.trim();
      }
      // For Jira/BRD without an Application URL set, sourceUrl stays empty;
      // the LLM prompt resolves that to "[URL not provided]" rather than guess.
      const plan = await generateTestPlanResult(llmConfig, productName, fetchedIssues, additionalContext, outputType, sourceUrl);
      setGeneratedPlan(plan);
    } catch (error: any) {
      alert("Generation failed: " + error.message);
      setStep(3);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSaveConnections = (newConns: Connection[]) => {
    setConnections(newConns);
    localStorage.setItem('tp_connections', JSON.stringify(newConns));
    if (newConns.length > 0) setActiveConnection(newConns[0]);
  };

  const handleSaveLLM = (config: LLMConfig) => {
    setLlmConfig(config);
    localStorage.setItem('tp_llm_config', JSON.stringify(config));
  };

  const stepsMeta = [
    { id: 1, name: 'Setup', subtitle: 'Jira Connection', icon: Database },
    { id: 2, name: 'Fetch Issues', subtitle: 'Query & Filter', icon: Search },
    { id: 3, name: 'Review', subtitle: 'Validate & Context', icon: ClipboardCheck },
    { id: 4, name: 'Generate & Execute', subtitle: 'Plan, Run & Report', icon: FileText },
  ];

  // Auth gate — short-circuit when auth is enabled and we don't yet have a user.
  // Loading state is rendered so we don't briefly flash the wizard before the
  // login screen appears.
  if (!authReady) {
    return <div className="min-h-screen flex items-center justify-center text-slate-400 dark:text-slate-500 text-sm">Loading…</div>;
  }
  if (authEnabled && !authUser) {
    return <LoginScreen bootstrapMode={authBootstrap} onAuthenticated={handleAuthenticated} notice={authNotice} />;
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 font-sans selection:bg-blue-100 selection:text-blue-900 dark:bg-slate-950 dark:text-slate-100 transition-colors duration-300 flex">

      {/* ─── Vertical Sidebar ─── */}
      {/* Narrower (240 vs 280) so the main content fits at 100% zoom on
          common laptop screens. Still wide enough for full module labels. */}
      {/* Solid background + GPU-promoted layer.
          - No backdrop-blur (was recomputing every frame on scroll → shimmer).
          - `transform-gpu` (translateZ(0)) puts this on its own GPU layer
            so during scroll it's just translated, not re-rasterized. That
            eliminates the subpixel jitter that read as "dancing".
          - Shadow trimmed because large box-shadows on scrolling neighbors
            also force repaints. */}
      <aside className="w-[240px] min-h-screen flex flex-col bg-white border-r border-slate-200 dark:bg-slate-900 dark:border-slate-800 sticky top-0 h-screen z-30 transform-gpu will-change-transform">

        {/* Brand — tightened vertical padding so the modules below fit
            within typical 768px laptop viewports without scrolling. */}
        <div className="px-5 pt-4 pb-3 border-b border-slate-100 dark:border-slate-800/60">
          <div className="flex items-center gap-2.5">
            <div className="bg-gradient-to-br from-blue-500 to-blue-700 p-2 rounded-xl text-white shadow-lg shadow-blue-300/40 ring-2 ring-blue-50 dark:shadow-blue-900/30 dark:ring-slate-800">
              <Briefcase size={16} strokeWidth={2.5} />
            </div>
            <div>
              <h1 className="text-[12px] font-black tracking-tight text-slate-800 dark:text-slate-100 leading-tight">Intelligent Test<br/>Planning Agent</h1>
              <p className="text-[8px] text-slate-400 font-black uppercase tracking-[0.15em] mt-0.5 dark:text-slate-500">B.L.A.S.T Protocol</p>
            </div>
          </div>
        </div>

        {/* ── Module Nav ─────────────────────────────────────────────
            Test Case Execution / API Testing / Performance / UI Quality /
            UI Performance / CI/CD. Wizard's 4 stages are nested directly
            under "Test Case Execution" (rendered inline below it) so the
            workflow lives where it belongs, not at the bottom of the nav.
            Settings + theme moved to top-right header. */}
        <nav className="flex-1 px-3 py-3 overflow-y-auto">
          <p className="text-[9px] font-black uppercase tracking-[0.25em] text-slate-400 dark:text-slate-500 mb-2 px-2">Modules</p>
          <div className="space-y-0.5">
            {([
              { key: 'wizard',   label: 'Test Case Execution', icon: ClipboardCheck },
              { key: 'apitest',  label: 'API Testing',         icon: Code2 },
              { key: 'perf',     label: 'Performance Testing', icon: Activity },
              { key: 'audit',    label: 'UI Quality',          icon: ShieldCheck },
              { key: 'cicd',     label: 'CI / CD',             icon: Workflow },
            ] as const).map((m) => {
              const Icon = m.icon;
              const isActive = view === m.key;
              const isWizard = m.key === 'wizard';
              return (
                <React.Fragment key={m.key}>
                  <button
                    onClick={() => setView(m.key)}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[11px] font-black uppercase tracking-[0.12em] transition-all ${
                      isActive
                        ? 'bg-gradient-to-r from-blue-600 to-blue-700 text-white shadow-md shadow-blue-300/30 dark:shadow-blue-900/40'
                        : 'text-slate-500 hover:text-blue-600 hover:bg-blue-50/60 dark:text-slate-400 dark:hover:text-blue-300 dark:hover:bg-slate-800/50'
                    }`}
                  >
                    <Icon size={14} className={isActive ? 'text-white' : ''} />
                    <span className="truncate flex-1 text-left">{m.label}</span>
                    {isActive && <ChevronRight size={12} className="text-white/70 flex-shrink-0" />}
                  </button>

                  {/* Wizard steps render INLINE right under Test Case Execution
                      when that module is active. Indented to read as nested
                      children of the parent module. */}
                  {isWizard && isActive && (
                    <div className="ml-2.5 pl-2.5 mt-0.5 mb-1 border-l-2 border-blue-200 dark:border-blue-900/40 space-y-0">
                      {stepsMeta.map((s) => {
                        const StepIcon = s.icon;
                        const stepActive = step === s.id;
                        const stepCompleted = step > s.id;
                        const stepClickable = step > s.id;
                        return (
                          <button
                            key={s.id}
                            onClick={() => stepClickable && setStep(s.id)}
                            className={`relative z-10 w-full flex items-center gap-2 px-2 py-1 rounded-md transition-all
                              ${stepActive
                                ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                                : stepCompleted
                                  ? 'text-blue-600 dark:text-blue-400 hover:bg-blue-50/60 dark:hover:bg-slate-800/60 cursor-pointer'
                                  : 'text-slate-400 dark:text-slate-600 cursor-default'
                              }`}
                          >
                            <div className={`w-[18px] h-[18px] rounded-md flex items-center justify-center flex-shrink-0
                              ${stepActive
                                ? 'bg-blue-100 dark:bg-blue-900/40 ring-1 ring-blue-300 dark:ring-blue-700'
                                : stepCompleted
                                  ? 'bg-blue-100 dark:bg-blue-900/40'
                                  : 'bg-slate-100 dark:bg-slate-800'
                              }`}
                            >
                              {stepCompleted
                                ? <CheckCircle2 size={10} className="text-blue-500 dark:text-blue-400" />
                                : <StepIcon size={10} />}
                            </div>
                            <p className={`text-[10px] font-bold leading-tight truncate flex-1 text-left
                              ${stepActive ? 'text-blue-700 dark:text-blue-300' : stepCompleted ? 'text-slate-700 dark:text-slate-200' : 'text-slate-400 dark:text-slate-600'}`}>
                              {s.name}
                            </p>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </nav>

        {/* Settings button — visible at bottom of sidebar so users can find
            it without hunting around the header. Theme toggle lives inside
            it (Appearance tab). */}
        <div className="px-4 pb-3 border-t border-slate-100 dark:border-slate-800/60 pt-3">
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[11px] font-black uppercase tracking-[0.12em] text-slate-500 hover:text-blue-600 hover:bg-blue-50/60 dark:text-slate-400 dark:hover:text-blue-300 dark:hover:bg-slate-800/50 transition-all"
            title="Connections, LLM, Notifications, Appearance"
          >
            <Settings size={15} />
            <span className="flex-1 text-left">Settings</span>
          </button>
        </div>

        {/* Auth user info — stays in sidebar so it doesn't crowd the header */}
        {authEnabled && authUser && (
          <div className="px-4 pb-4 border-t border-slate-100 dark:border-slate-800/60 pt-4">
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800/60">
              <UserIcon size={13} className="text-slate-500 dark:text-slate-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-black text-slate-700 dark:text-slate-200 truncate">{authUser.username}</p>
                <p className="text-[8px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">{authUser.role}</p>
              </div>
              <button
                onClick={handleLogout}
                className="p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                title="Sign out"
              >
                <LogOut size={13} />
              </button>
            </div>
          </div>
        )}
      </aside>

      {/* ─── Main Content ─── */}
      {/* min-w-0 is critical: without it, this flex item refuses to shrink
          below its children's intrinsic min-width (e.g. the test plan
          table's min-w-[800px]), which pushed the whole page wider than
          the viewport and produced a body-level horizontal scrollbar.
          With min-w-0 the table's own overflow-x-auto wrapper handles
          horizontal scrolling internally. */}
      <div className="flex-1 flex flex-col min-h-screen min-w-0">
        {/* Top Bar */}
        {/* Solid background + GPU layer — see note on the sidebar above. */}
        <header className="bg-white border-b border-slate-200 px-6 py-4 flex justify-between items-center sticky top-0 z-20 dark:bg-slate-900 dark:border-slate-800 transform-gpu will-change-transform">
          <div>
            <h2 className="text-lg font-black text-slate-800 dark:text-slate-100 tracking-tight">
              {view === 'history'
                ? 'Execution History Trends'
                : view === 'audit'
                  ? 'UI Quality'
                  : view === 'apitest'
                    ? 'API Testing'
                    : view === 'perf'
                      ? 'Performance Testing'
                      : view === 'cicd'
                        ? 'CI / CD'
                        : stepsMeta.find(s => s.id === step)?.name}
            </h2>
            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-[0.15em] dark:text-slate-500">
              {view === 'history'
                ? 'Trend, flakiness & past executions'
                : view === 'audit'
                  ? 'Visual regression & accessibility scans'
                  : view === 'apitest'
                    ? 'REST endpoint tests with assertions'
                    : view === 'perf'
                      ? 'Load & throughput testing via JMeter'
                      : view === 'cicd'
                        ? 'GitHub Actions runs, status & manual trigger'
                        : `Step ${step} of ${stepsMeta.length} • ${stepsMeta.find(s => s.id === step)?.subtitle}`}
            </p>
          </div>
          {/* Right side of header intentionally empty.
              - Step indicators removed (workflow nested in sidebar already shows progress).
              - Settings button moved back to sidebar so it's always visible. */}
        </header>

        {/* Content Area */}
        {/* IMPORTANT: do NOT use `transition-all` here — it animates every
            CSS property change, including the tiny reflows that happen when
            the viewport gains/loses a scrollbar, causing the visible UI
            "dancing" the user reported when scrolling vertically. Limit
            transitions to colors only (for dark-mode toggle). */}
        <main className="flex-1 p-4">
          <div className="bg-white border border-slate-200/80 rounded-[2rem] p-6 shadow-[0_24px_48px_-12px_rgba(0,0,0,0.06)] min-h-[600px] flex flex-col transition-colors duration-300 dark:bg-slate-900 dark:border-slate-800 dark:shadow-[0_24px_48px_-12px_rgba(0,0,0,0.4)]">
            <div className="flex-1 animate-in fade-in slide-in-from-bottom-4 duration-700">
              {/* TestPlanView is mounted persistently once we've reached
                  step 4 so its internal execution-report state survives
                  navigating to History Trends and back. We hide via CSS
                  instead of conditional render to preserve component state. */}
              {hasReachedTestPlan && (
                <div className={view === 'wizard' && step === 4 ? '' : 'hidden'}>
                  <TestPlanView
                    plan={generatedPlan}
                    productName={productName}
                    llmConfig={llmConfig}
                    connection={activeConnection}
                    projectKey={projectKey}
                    outputType={outputType}
                    onOpenHistory={() => setView('history')}
                  />
                </div>
              )}
              {view === 'history'
                ? <HistoryDashboard onBack={() => setView('wizard')} />
                : view === 'audit'
                  ? <QualityAudit onBack={() => setView('wizard')} />
                  : view === 'apitest'
                    ? <ApiTesting onBack={() => setView('wizard')} />
                    : view === 'perf'
                      ? <PerformanceTesting onBack={() => setView('wizard')} />
                      : view === 'cicd'
                        ? <CICDDashboard onBack={() => setView('wizard')} />
                        : step === 4
                          ? null /* rendered above, kept alive */
                          : renderStep()}
            </div>
          </div>
        </main>

        {/* Footer */}
        <footer className="px-10 py-6 text-center opacity-30">
          <p className="text-[9px] font-black uppercase tracking-[0.5em] text-slate-400">Master System Pilot • Antigravity AI</p>
        </footer>
      </div>

      {/* Settings Modal — now also hosts the Appearance tab (theme toggle
          moved here from the sidebar). */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        connections={connections}
        onSaveConnections={handleSaveConnections}
        llmConfig={llmConfig}
        onSaveLLM={handleSaveLLM}
        isDarkMode={isDarkMode}
        onToggleTheme={toggleTheme}
        authUser={authUser}
      />
    </div>
  )
}

export default App
