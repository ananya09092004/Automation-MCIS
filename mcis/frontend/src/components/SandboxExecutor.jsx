import { useState, useRef, useEffect, useCallback } from 'react';
import { auth } from '../firebase';

const LANGUAGES = ['javascript', 'python', 'typescript', 'java', 'cpp', 'c'];

// ✅ NEW: complexity options shown to the user
const COMPLEXITY_OPTIONS = [
  { value: 'simple',  label: '🟢 Simple (2-5 files)' },
  { value: 'medium',  label: '🟡 Medium (6-12 files)' },
  { value: 'complex', label: '🔴 Complex (13-25 files)' },
];

const EVENT_EMOJIS = {
  start:'🚀', planning:'🧠', plan_ready:'📋', generating_file:'✍️',
  file_generated:'📝', file_error:'⚠️', memory:'🧬', generating:'✍️',
  code_generated:'📝', running:'⚡', success:'✅', error:'❌',
  fixed:'🔧', failed:'💀', teaching:'🧠', explanation:'💡',
  complete:'🎉', final:'🎉', fatal_error:'💀',
};

const BACKEND = process.env.REACT_APP_BACKEND_URL || '';

// ── Simple mobile detector (no other behavior changed) ─────────────────────
const useIsMobile = (breakpoint = 640) => {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= breakpoint
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= breakpoint);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);
  return isMobile;
};

// ── Auth fetch helper ──────────────────────────────────────────────────────
const authFetch = async (url, options = {}) => {
  const token = await auth.currentUser?.getIdToken();
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
};

// ── Build preview HTML from files ──────────────────────────────────────────
const isConfigFile = (p) =>
  /(^|\/)(package(-lock)?\.json|tailwind\.config|postcss\.config|vite\.config|webpack\.config|babel\.config|\.eslintrc|tsconfig)/.test(p);

function buildPreviewHTML(files = []) {
  if (!files?.length) return null;
  const paths = files.map(f => f.path?.toLowerCase() || '');
  const hasHTML = paths.some(p => p.endsWith('.html') || p.endsWith('.htm'));
  const hasCSS  = paths.some(p => p.endsWith('.css'));
  const hasJSX  = paths.some(p =>
    (p.endsWith('.jsx') || p.endsWith('.tsx')) && !p.includes('node_modules')
  );
  const hasJS   = paths.some(p =>
    p.endsWith('.js') && !p.includes('node_modules') && !isConfigFile(p)
  );
  if (!hasHTML && !hasCSS && !hasJS && !hasJSX) return null;

  const cssFiles = files.filter(f => f.path?.toLowerCase().endsWith('.css'));
  const cssContent = cssFiles.map(f => f.content || '').join('\n');

  const cleanJS = (src) => (src || '')
    .replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];?/g, '')
    .replace(/import\s+['"][^'"]+['"];?/g, '')
    .replace(/export\s+default\s+/g, '')
    .replace(/export\s+/g, '');

  // ── React/JSX project: use CDN React + ReactDOM + Babel standalone ───────
  if (hasJSX || files.some(f => /from\s+['"]react['"]/.test(f.content || ''))) {
    const codeFiles = files.filter(f => {
      const p = f.path?.toLowerCase() || '';
      return (p.endsWith('.jsx') || p.endsWith('.tsx') || p.endsWith('.js')) &&
        !p.includes('node_modules') && !isConfigFile(p);
    });
    // Entry files (index/main) render the app, so they must come last
    // once every other component has already been defined.
    const isEntry = (p) => /(^|\/)(index|main)\.(jsx?|tsx?)$/.test(p);
    const ordered = [
      ...codeFiles.filter(f => !isEntry(f.path?.toLowerCase() || '')),
      ...codeFiles.filter(f => isEntry(f.path?.toLowerCase() || '')),
    ];
    const jsContent = ordered.map(f => cleanJS(f.content)).join('\n\n');
    const hasRenderCall = /ReactDOM\.(createRoot|render)/.test(jsContent);
    const autoRender = hasRenderCall ? '' : `
      const __RootComp = typeof App !== 'undefined' ? App : (typeof Main !== 'undefined' ? Main : null);
      if (__RootComp) {
        ReactDOM.createRoot(document.getElementById('root')).render(<__RootComp />);
      }
    `;

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"><\/script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"><\/script>
  <script crossorigin src="https://unpkg.com/@babel/standalone/babel.min.js"><\/script>
  <style>
    body{margin:0;padding:20px;font-family:system-ui,sans-serif;background:#f9fafb;}
    ${cssContent}
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel" data-presets="react,env">
    ${jsContent}
    ${autoRender}
  <\/script>
</body>
</html>`;
  }

  const jsFiles = files.filter(f =>
    f.path?.toLowerCase().endsWith('.js') &&
    !f.path?.toLowerCase().includes('node_modules') &&
    !isConfigFile(f.path?.toLowerCase() || '')
  );

  const htmlFile = files.find(f =>
    f.path?.toLowerCase().endsWith('.html') || f.path?.toLowerCase().endsWith('.htm')
  );

  if (htmlFile) {
    let html = htmlFile.content || '';
    cssFiles.forEach(css => {
      html = html.includes('</head>')
        ? html.replace('</head>', `<style>${css.content}</style></head>`)
        : `<style>${css.content}</style>${html}`;
    });
    jsFiles.forEach(js => {
      const safe = cleanJS(js.content);
      html = html.includes('</body>')
        ? html.replace('</body>', `<script>${safe}<\/script></body>`)
        : `${html}<script>${safe}<\/script>`;
    });
    return html;
  }

  const jsContent = jsFiles.map(f => cleanJS(f.content)).join('\n');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{margin:0;padding:20px;font-family:system-ui,sans-serif;background:#f9fafb;}
    ${cssContent}
  </style>
</head>
<body>
  <div id="root"></div>
  <div id="app"></div>
  <script>${jsContent}<\/script>
</body>
</html>`;
}

export default function SandboxExecutor({ userId }) {
  const [mode,            setMode]            = useState(null);
  const [goal,            setGoal]            = useState('');
  const [language,        setLanguage]        = useState('javascript');
  const [complexity,      setComplexity]      = useState('medium'); // ✅ NEW
  const [events,          setEvents]          = useState([]);
  const [running,         setRunning]         = useState(false);
  const [files,           setFiles]           = useState([]);
  const [activeFile,      setActiveFile]      = useState(null);
  const [previewTab,      setPreviewTab]      = useState('preview');
  const [projectInfo,     setProjectInfo]     = useState(null);
  const [githubStatus,    setGithubStatus]    = useState(null);
  const [pushResult,      setPushResult]      = useState(null);
  const [pushing,         setPushing]         = useState(false);
  const [editCmd,         setEditCmd]         = useState('');
  const [editingFile,     setEditingFile]     = useState(null);
  const [projects,        setProjects]        = useState([]);
  const [duplicate,       setDuplicate]       = useState(null);
  const [selectedProject, setSelectedProject] = useState(null);
  const [showGithubMenu,  setShowGithubMenu]  = useState(false);

  const isMobile = useIsMobile();

  const iframeRef = useRef(null);
  const esRef     = useRef(null);
  const bottomRef = useRef(null);

  // ── Load GitHub status ───────────────────────────────────────────────────
  useEffect(() => {
    if (!userId) return;
    authFetch(`${BACKEND}/api/github/status/${userId}`)
      .then(r => r.json()).then(d => setGithubStatus(d)).catch(() => {});
  }, [userId]);

  // ── Load projects ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!userId) return;
    authFetch(`${BACKEND}/api/multifile/${userId}/projects`)
      .then(r => r.json()).then(d => setProjects(d.projects || [])).catch(() => {});
  }, [userId, pushResult]);

  // ── Set first file active when files arrive ──────────────────────────────
  useEffect(() => {
    if (files.length > 0) {
      setActiveFile(files[0]);
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [files.length]);

  // ── Render iframe when switching to preview ──────────────────────────────
  useEffect(() => {
    if (previewTab !== 'preview' || !iframeRef.current || !files.length) return;
    const html = buildPreviewHTML(files);
    if (!html) return;
    const blob = new Blob([html], { type: 'text/html' });
    const url  = URL.createObjectURL(blob);
    iframeRef.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [previewTab, files]);

  // ── Auto-push after GitHub OAuth ─────────────────────────────────────────
  useEffect(() => {
    if (!githubStatus?.connected || !userId) return;
    try {
      const pending = localStorage.getItem('mcis_pending_push');
      if (!pending) return;
      const data = JSON.parse(pending);
      localStorage.removeItem('mcis_pending_push');
      doPush(data.projectName, data.description, data.files, data.goal, data.language);
    } catch (_) {}
  }, [githubStatus?.connected]);

  const addEvent = (ev) => setEvents(prev => [...prev, { ...ev, ts: Date.now() }]);

  // ── Connect GitHub (save pending push if files exist) ────────────────────
  const connectGitHub = useCallback(async () => {
    if (files.length > 0 && projectInfo) {
      localStorage.setItem('mcis_pending_push', JSON.stringify({
        projectName: projectInfo.name,
        description: projectInfo.description,
        goal, language,
        files: files.map(f => ({ path: f.path, content: f.content })),
      }));
    }
    try {
      const r = await authFetch(`${BACKEND}/api/github/connect/${userId}`);
      const d = await r.json();
      if (d.url) window.location.href = d.url;
    } catch { alert('GitHub connection failed.'); }
  }, [files, projectInfo, goal, language, userId]);

  const disconnectGitHub = async () => {
    if (!window.confirm('Disconnect GitHub from MCIS?')) return;
    try {
      await authFetch(`${BACKEND}/api/github/disconnect/${userId}`, { method: 'DELETE' });
      setGithubStatus({ connected: false, username: null });
      setShowGithubMenu(false);
    } catch {}
  };

  // ── Actual push ───────────────────────────────────────────────────────────
  const doPush = async (projectName, description, projectFiles, goalText, lang) => {
    if (!projectFiles?.length) return;
    setPushing(true);
    try {
      const res = await authFetch(`${BACKEND}/api/multifile/${userId}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoName: projectName, description,
          files: projectFiles.map(f => ({ path: f.path, content: f.content })),
        }),
      });
      const data = await res.json();
      if (data.success) {
        setPushResult(data);
        authFetch(`${BACKEND}/api/multifile/${userId}/save-project`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectName, description,
            goal: goalText || goal, language: lang || language,
            filesCount: projectFiles.length, files: projectFiles,
            repoUrl: data.repoUrl, vsCodeUrl: data.vsCodeUrl,
            codespacesUrl: data.codespacesUrl,
          }),
        }).catch(() => {});
        if (data.repoUrl) window.open(data.repoUrl, '_blank');
      } else {
        alert('Push failed: ' + (data.error || 'Unknown error'));
      }
    } catch (e) {
      alert('Push failed: ' + e.message);
    } finally {
      setPushing(false);
    }
  };

  // ── Push to GitHub — connect if needed ───────────────────────────────────
  const pushToGitHub = async () => {
    if (!files.length) return;
    if (!githubStatus?.connected) {
      await connectGitHub();
      return;
    }
    await doPush(projectInfo?.name || 'mcis-project', projectInfo?.description, files);
  };

  // ── Generate project ──────────────────────────────────────────────────────
  const run = async () => {
    if (!goal.trim() || running) return;
    try {
      const r = await authFetch(`${BACKEND}/api/multifile/${userId}/check-duplicate?goal=${encodeURIComponent(goal)}`);
      const d = await r.json();
      if (d.duplicate) { setDuplicate(d.duplicate); return; }
    } catch {}
    setDuplicate(null);
    setEvents([]); setFiles([]); setProjectInfo(null);
    setPushResult(null); setActiveFile(null); setEditCmd('');
    setRunning(true);
    if (esRef.current) esRef.current.abort();
    const ctrl = new AbortController();
    esRef.current = ctrl;
    try {
      const res = await authFetch(`${BACKEND}/api/multifile/${userId}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal, language, complexity }), // ✅ CHANGED: complexity sent to backend
        signal: ctrl.signal,
      });
      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            addEvent(ev);
            if (ev.type === 'plan_ready' && ev.plan)
              setProjectInfo({ name: ev.plan.projectName, description: ev.plan.description });
            if (ev.type === 'final' && ev.result) {
              setFiles(ev.result.files || []);
              setProjectInfo({ name: ev.result.projectName, description: ev.result.description });
            }
          } catch {}
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') addEvent({ type: 'fatal_error', error: err.message });
    } finally { setRunning(false); }
  };

  // ── Edit active file with natural language cmd ────────────────────────────
  const editActiveFile = async () => {
    if (!editCmd.trim() || !activeFile) return;
    setEditingFile(activeFile.path);
    try {
      const res = await authFetch(`${BACKEND}/api/multifile/${userId}/edit-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: activeFile.path,
          currentContent: activeFile.content,
          instruction: editCmd,
          allFiles: files.map(f => ({ path: f.path })),
          language,
        }),
      });
      const data = await res.json();
      if (data.success && data.content) {
        const updated = { ...activeFile, content: data.content };
        const updatedFiles = files.map(f =>
          f.path === activeFile.path ? updated : f
        );
        setFiles(updatedFiles);
        setActiveFile(updated);
        setEditCmd('');
        // Re-render preview
        setPreviewTab('files');
        setTimeout(() => setPreviewTab('preview'), 100);
      } else {
        alert('Edit failed: ' + (data.error || 'Unknown'));
      }
    } catch (e) {
      alert('Edit failed: ' + e.message);
    } finally {
      setEditingFile(null);
    }
  };

  const stop = () => {
    if (esRef.current) esRef.current.abort();
    setRunning(false);
    addEvent({ type: 'error', message: 'Stopped by user.' });
  };

  const reset = () => {
    setMode(null); setGoal(''); setEvents([]);
    setFiles([]); setProjectInfo(null); setPushResult(null);
    setActiveFile(null); setEditCmd(''); setPreviewTab('preview');
  };

  const previewHTML = buildPreviewHTML(files);
  const canPreview  = !!previewHTML;

  // ══ MODE SELECTOR ══════════════════════════════════════════════════════════
  if (!mode) return (
    <div style={{ ...s.container, ...(isMobile ? s.containerMobile : {}) }}>
      <h2 style={s.title}>⚡ MCIS Execution Engine</h2>
      <p style={s.subtitle}>How do you want MCIS to work?</p>
      <div style={{ ...s.modeGrid, ...(isMobile ? s.modeGridMobile : {}) }}>
        <div style={s.modeCard} onClick={() => setMode('autonomous')}>
          <div style={s.modeIcon}>🤖</div>
          <h3 style={s.modeTitle}>Autonomous</h3>
          <p style={s.modeDesc}>MCIS plans the project and writes every file. Preview live, edit with commands, push to GitHub.</p>
          <div style={s.modeTags}>
            <span style={s.tag}>Live preview</span>
            <span style={s.tag}>Edit with commands</span>
            <span style={s.tag}>GitHub push</span>
          </div>
          <button style={s.modeBtn}>Select →</button>
        </div>
        <div style={s.modeCard} onClick={() => setMode('teach')}>
          <div style={s.modeIcon}>📖</div>
          <h3 style={s.modeTitle}>Teach Me</h3>
          <p style={s.modeDesc}>MCIS plans and builds the project, explaining each file as it goes.</p>
          <div style={s.modeTags}>
            <span style={s.tag}>Step by step</span>
            <span style={s.tag}>Explanations</span>
            <span style={s.tag}>Learn patterns</span>
          </div>
          <button style={{ ...s.modeBtn, background: '#7c3aed' }}>Select →</button>
        </div>
      </div>
      <div style={{ marginTop: 20 }}>
        {githubStatus?.connected ? (
          <div style={{ position: 'relative', display: 'inline-block' }}>
            <button style={s.githubConnectedBtn} onClick={() => setShowGithubMenu(p => !p)}>
              ✅ @{githubStatus.username} ▾
            </button>
            {showGithubMenu && (
              <div style={s.githubMenu}>
                <a href={`https://github.com/${githubStatus.username}`} target="_blank" rel="noreferrer"
                   style={s.githubMenuItem} onClick={() => setShowGithubMenu(false)}>
                  🔗 View GitHub Profile
                </a>
                <button style={{ ...s.githubMenuItem, color: '#fca5a5', border: 'none', background: 'none', cursor: 'pointer', width: '100%', textAlign: 'left' }}
                  onClick={disconnectGitHub}>
                  🔌 Disconnect GitHub
                </button>
              </div>
            )}
          </div>
        ) : (
          <button style={s.githubConnectBtn} onClick={connectGitHub}>
            🐙 Connect GitHub (optional — connect when you push)
          </button>
        )}
      </div>
    </div>
  );

  // ══ EXECUTION VIEW ═════════════════════════════════════════════════════════
  return (
    <div style={{ ...s.container, ...(isMobile ? s.containerMobile : {}) }}>
      <div style={{ ...s.header, ...(isMobile ? s.headerMobile : {}) }}>
        <div>
          <h2 style={s.title}>{mode === 'autonomous' ? '🤖 Autonomous Mode' : '📖 Teach Me Mode'}</h2>
          <p style={s.subtitle}>Build → Preview live → Edit with commands → Push to GitHub</p>
        </div>
        <button style={s.backBtn} onClick={reset} disabled={running}>← Change Mode</button>
      </div>

      {/* GitHub bar */}
      <div style={s.githubBar}>
        {githubStatus?.connected ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ color: '#86efac' }}>✅ GitHub: @{githubStatus.username}</span>
            <button style={s.disconnectBtn} onClick={disconnectGitHub}>Disconnect</button>
          </div>
        ) : (
          <span style={{ color: '#94a3b8' }}>🐙 GitHub not connected — you can connect when you push</span>
        )}
      </div>

      {duplicate && (
        <div style={s.duplicateBox}>
          <p style={{ color: '#fbbf24', fontWeight: 700, margin: '0 0 6px' }}>⚠️ Already Built!</p>
          <p style={{ color: '#d6d3d1', fontSize: 13, margin: '0 0 10px' }}>
            You already built <strong>{duplicate.project_name}</strong>.
          </p>
          {duplicate.repo_url && <a href={duplicate.repo_url} target="_blank" rel="noreferrer" style={s.link}>🔗 View on GitHub</a>}
          <button style={s.buildAnywayBtn} onClick={() => { setDuplicate(null); run(); }}>Build Again Anyway</button>
        </div>
      )}

      <textarea
        style={s.textarea}
        placeholder="What do you want to build? e.g. 'Build a todo app with React'"
        value={goal}
        onChange={e => setGoal(e.target.value)}
        rows={3}
        disabled={running}
      />

      <div style={{ ...s.controls, ...(isMobile ? s.controlsMobile : {}) }}>
        <select style={{ ...s.select, ...(isMobile ? { flex: '1 1 45%' } : {}) }} value={language} onChange={e => setLanguage(e.target.value)} disabled={running}>
          {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        {/* ✅ NEW: complexity selector */}
        <select style={{ ...s.select, ...(isMobile ? { flex: '1 1 45%' } : {}) }} value={complexity} onChange={e => setComplexity(e.target.value)} disabled={running}>
          {COMPLEXITY_OPTIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        {!running
          ? <button style={{ ...s.runBtn, ...(isMobile ? { flex: '1 1 100%' } : {}) }} onClick={run} disabled={!goal.trim()}>🤖 Build Project</button>
          : <button style={{ ...s.stopBtn, ...(isMobile ? { flex: '1 1 100%' } : {}) }} onClick={stop}>⏹ Stop</button>}
      </div>

      {projectInfo && (
        <div style={s.projectBox}>
          <strong style={{ color: '#c7d2fe' }}>📦 {projectInfo.name}</strong>
          <p style={{ color: '#a5b4fc', fontSize: 13, margin: '4px 0 0' }}>{projectInfo.description}</p>
        </div>
      )}

      {events.length > 0 && (
        <div style={s.log}>
          <div style={s.logTitle}>LIVE PROGRESS</div>
          {events.map((ev, i) => (
            <div key={i} style={{
              ...s.logItem,
              borderLeft: `3px solid ${
                ev.type === 'file_generated' || ev.type === 'final' || ev.type === 'complete' ? '#22c55e' :
                ev.type === 'error' || ev.type === 'file_error' || ev.type === 'failed' || ev.type === 'fatal_error' ? '#ef4444' :
                ev.type === 'memory' ? '#a78bfa' : '#3b82f6'
              }`
            }}>
              <span style={{ fontSize: 16, minWidth: 24 }}>{EVENT_EMOJIS[ev.type] || '•'}</span>
              <div>
                {ev.message && <p style={{ color: '#e2e8f0', margin: 0, fontSize: 13 }}>{ev.message}</p>}
                {ev.error   && <p style={{ color: '#fca5a5', margin: '4px 0 0', fontSize: 12 }}>{ev.error}</p>}
                {ev.file && ev.type === 'generating_file' && <p style={{ color: '#7dd3fc', margin: 0, fontSize: 13 }}>📄 {ev.file}</p>}
                {ev.preview && <pre style={{ background: '#1e293b', color: '#94a3b8', padding: 8, borderRadius: 4, fontSize: 11, margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{ev.preview}...</pre>}
              </div>
            </div>
          ))}
        </div>
      )}

      {pushing && <div style={s.pushingBox}>⏳ Pushing to GitHub...</div>}

      {pushResult && (
        <div style={s.pushSuccessBox}>
          <strong style={{ color: '#86efac' }}>🎉 Pushed to GitHub!</strong>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8 }}>
            {pushResult.repoUrl       && <a href={pushResult.repoUrl}       target="_blank" rel="noreferrer" style={s.link}>🔗 View on GitHub</a>}
            {pushResult.vsCodeUrl     && <a href={pushResult.vsCodeUrl}     style={s.link}>💻 Open in VS Code</a>}
            {pushResult.codespacesUrl && <a href={pushResult.codespacesUrl} target="_blank" rel="noreferrer" style={s.link}>☁️ Codespaces</a>}
          </div>
        </div>
      )}

      {/* ── Files + Preview ── */}
      {files.length > 0 && (
        <div style={s.filesBox}>

          {/* Header row */}
          <div style={{ ...s.codeHeader, ...(isMobile ? s.codeHeaderMobile : {}) }}>
            <strong style={{ color: '#94a3b8', fontSize: 13, textTransform: 'uppercase', letterSpacing: 1 }}>
              📁 {projectInfo?.name || 'Project'} — {files.length} files
            </strong>
            {!pushResult && (
              <button
                style={{ ...s.pushBtn, opacity: pushing ? 0.7 : 1, ...(isMobile ? { flex: '1 1 100%' } : {}) }}
                onClick={pushToGitHub}
                disabled={pushing}
              >
                {pushing ? '⏳ Pushing...' : '⬆️ Push to GitHub'}
              </button>
            )}
            {pushResult?.repoUrl && (
              <a href={pushResult.repoUrl} target="_blank" rel="noreferrer"
                 style={{ ...s.pushBtn, background: '#14532d', textDecoration: 'none', ...(isMobile ? { flex: '1 1 100%', textAlign: 'center' } : {}) }}>
                🔗 View Repo
              </a>
            )}
          </div>

          {/* Tab bar */}
          <div style={s.tabBar}>
            <button style={{ ...s.tabBtn, ...(previewTab === 'preview' ? s.tabActive : {}) }}
              onClick={() => setPreviewTab('preview')}>
              👁 Preview
            </button>
            <button style={{ ...s.tabBtn, ...(previewTab === 'files' ? s.tabActive : {}) }}
              onClick={() => setPreviewTab('files')}>
              📄 Files ({files.length})
            </button>
          </div>

          {/* PREVIEW TAB */}
          {previewTab === 'preview' && (
            <div style={s.previewWrap}>
              {canPreview ? (
                <>
                  <div style={s.browserBar}>
                    <span style={{ ...s.dot, background: '#ef4444' }} />
                    <span style={{ ...s.dot, background: '#fbbf24' }} />
                    <span style={{ ...s.dot, background: '#22c55e' }} />
                    <span style={{ color: '#64748b', fontSize: 12, marginLeft: 10, fontFamily: 'monospace' }}>
                      {projectInfo?.name || 'preview'}.app
                    </span>
                    <button
                      style={{ marginLeft: 'auto', background: '#334155', color: '#f1f5f9', border: 'none', borderRadius: 6, padding: '2px 10px', fontSize: 11, cursor: 'pointer' }}
                      onClick={() => {
                        const html = buildPreviewHTML(files);
                        if (html && iframeRef.current) {
                          const blob = new Blob([html], { type: 'text/html' });
                          iframeRef.current.src = URL.createObjectURL(blob);
                        }
                      }}
                    >
                      ↻ Refresh
                    </button>
                  </div>
                  <iframe ref={iframeRef} title="preview" sandbox="allow-scripts allow-same-origin" style={{ ...s.iframe, ...(isMobile ? s.iframeMobile : {}) }} />
                  {/* Edit command bar below preview */}
                  <div style={{ ...s.cmdBar, ...(isMobile ? s.cmdBarMobile : {}) }}>
                    <select
                      style={{ ...s.select, fontSize: 12, padding: '5px 8px', minWidth: isMobile ? 0 : 140, ...(isMobile ? { flex: '1 1 100%' } : {}) }}
                      value={activeFile?.path || ''}
                      onChange={e => setActiveFile(files.find(f => f.path === e.target.value) || null)}
                    >
                      {files.map(f => <option key={f.path} value={f.path}>{f.path}</option>)}
                    </select>
                    <input
                      style={{ ...s.cmdInput, ...(isMobile ? s.cmdInputMobile : {}) }}
                      placeholder='Type a command: "make header blue", "add dark mode", "fix the button"...'
                      value={editCmd}
                      onChange={e => setEditCmd(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && editActiveFile()}
                      disabled={!!editingFile}
                    />
                    <button style={{ ...s.cmdBtn, ...(isMobile ? { flex: '1 1 100%' } : {}) }} onClick={editActiveFile}
                      disabled={!!editingFile || !editCmd.trim() || !activeFile}>
                      {editingFile ? '⏳' : '✏️ Apply'}
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ ...s.noPreview, ...(isMobile ? s.noPreviewMobile : {}) }}>
                  <div style={{ fontSize: 48, marginBottom: 12 }}>🏗️</div>
                  <strong style={{ color: '#f1f5f9', fontSize: 15 }}>Live preview not available</strong>
                  <p style={{ color: '#94a3b8', fontSize: 13, margin: '8px 0 16px', textAlign: 'center', maxWidth: 400 }}>
                    This project uses React, Next.js, Python, or another framework that needs a build step.
                    Push to GitHub then open in VS Code or Codespaces to run it.
                  </p>
                  <button style={s.pushBtn} onClick={pushToGitHub} disabled={pushing}>
                    {pushing ? '⏳ Pushing...' : '⬆️ Push to GitHub to Run'}
                  </button>
                  {/* Still show edit command even without preview */}
                  <div style={{ ...s.cmdBar, marginTop: 16, width: '100%', maxWidth: 600, ...(isMobile ? s.cmdBarMobile : {}) }}>
                    <select
                      style={{ ...s.select, fontSize: 12, padding: '5px 8px', minWidth: isMobile ? 0 : 140, ...(isMobile ? { flex: '1 1 100%' } : {}) }}
                      value={activeFile?.path || ''}
                      onChange={e => setActiveFile(files.find(f => f.path === e.target.value) || null)}
                    >
                      {files.map(f => <option key={f.path} value={f.path}>{f.path}</option>)}
                    </select>
                    <input
                      style={{ ...s.cmdInput, ...(isMobile ? s.cmdInputMobile : {}) }}
                      placeholder='Edit command: "add dark mode", "fix the API route"...'
                      value={editCmd}
                      onChange={e => setEditCmd(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && editActiveFile()}
                      disabled={!!editingFile}
                    />
                    <button style={{ ...s.cmdBtn, ...(isMobile ? { flex: '1 1 100%' } : {}) }} onClick={editActiveFile}
                      disabled={!!editingFile || !editCmd.trim() || !activeFile}>
                      {editingFile ? '⏳' : '✏️ Apply'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* FILES TAB — split pane */}
          {previewTab === 'files' && (
            <div style={{ ...s.splitPane, ...(isMobile ? s.splitPaneMobile : {}) }}>
              {/* File list */}
              <div style={{ ...s.fileList, ...(isMobile ? s.fileListMobile : {}) }}>
                {files.map((f, i) => (
                  <button key={i}
                    style={{ ...s.fileListItem, ...(activeFile?.path === f.path ? s.fileListActive : {}), ...(isMobile ? s.fileListItemMobile : {}) }}
                    onClick={() => setActiveFile(f)}
                  >
                    <span style={{ fontWeight: 700, fontSize: 12 }}>{f.path?.split('/').pop()}</span>
                    <small style={{ color: activeFile?.path === f.path ? 'rgba(255,255,255,0.6)' : '#475569', fontSize: 10, marginTop: 2 }}>{f.path}</small>
                  </button>
                ))}
              </div>
              {/* Code pane */}
              <div style={s.codePane}>
                {activeFile && (
                  <>
                    <div style={{ padding: '6px 12px', borderBottom: '1px solid #1e293b', background: '#1e293b', fontSize: 12, color: '#7dd3fc' }}>
                      📄 {activeFile.path}
                    </div>
                    <pre style={s.codePre}>{activeFile.content}</pre>
                    {/* Edit command bar */}
                    <div style={{ ...s.cmdBar, ...(isMobile ? s.cmdBarMobile : {}) }}>
                      <input
                        style={{ ...s.cmdInput, ...(isMobile ? s.cmdInputMobile : {}) }}
                        placeholder='Command: "make header blue", "add validation", "use TypeScript types"...'
                        value={editCmd}
                        onChange={e => setEditCmd(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && editActiveFile()}
                        disabled={!!editingFile}
                      />
                      <button style={{ ...s.cmdBtn, ...(isMobile ? { flex: '1 1 100%' } : {}) }} onClick={editActiveFile}
                        disabled={!!editingFile || !editCmd.trim()}>
                        {editingFile === activeFile.path ? '⏳' : '✏️ Apply'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <div ref={bottomRef} />

      {/* Projects History */}
      {projects.length > 0 && !selectedProject && files.length === 0 && (
        <div style={{ ...s.filesBox, marginTop: 24 }}>
          <div style={s.logTitle}>📚 YOUR PROJECTS ({projects.length})</div>
          {projects.map((p, i) => (
            <div key={i} style={{ ...s.historyItem, cursor: 'pointer' }} onClick={() => setSelectedProject(p)}>
              <div>
                <p style={{ color: '#c7d2fe', fontSize: 14, fontWeight: 600, margin: '0 0 2px' }}>📦 {p.project_name}</p>
                <p style={{ color: '#94a3b8', fontSize: 12, margin: '0 0 4px' }}>{p.description}</p>
                <p style={{ color: '#475569', fontSize: 11, margin: 0 }}>{p.language} · {p.files_count} files · {new Date(p.created_at).toLocaleDateString()}</p>
              </div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                {p.repo_url       && <a href={p.repo_url}       target="_blank" rel="noreferrer" style={s.link} onClick={e => e.stopPropagation()}>🔗 GitHub</a>}
                {p.vs_code_url    && <a href={p.vs_code_url}    style={s.link} onClick={e => e.stopPropagation()}>💻 VS Code</a>}
                {p.codespaces_url && <a href={p.codespaces_url} target="_blank" rel="noreferrer" style={s.link} onClick={e => e.stopPropagation()}>☁️ Codespaces</a>}
                <span style={{ color: '#6366f1', fontSize: 12 }}>→ Open</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {selectedProject && (
        <div style={{ ...s.filesBox, marginTop: 24 }}>
          <div style={s.codeHeader}>
            <div>
              <strong style={{ color: '#c7d2fe' }}>📦 {selectedProject.project_name}</strong>
              <p style={{ color: '#64748b', fontSize: 12, margin: '4px 0 0' }}>{selectedProject.description}</p>
            </div>
            <button style={s.backBtn} onClick={() => setSelectedProject(null)}>← Back</button>
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: '12px 0 16px' }}>
            {selectedProject.repo_url       && <a href={selectedProject.repo_url}       target="_blank" rel="noreferrer" style={s.link}>🔗 View on GitHub</a>}
            {selectedProject.vs_code_url    && <a href={selectedProject.vs_code_url}    style={s.link}>💻 Open in VS Code</a>}
            {selectedProject.codespaces_url && <a href={selectedProject.codespaces_url} target="_blank" rel="noreferrer" style={s.link}>☁️ Open in Codespaces</a>}
          </div>
          <button style={s.runBtn} onClick={() => { setSelectedProject(null); setGoal(`Update ${selectedProject.project_name}: `); setMode(null); }}>
            🔄 Build Updated Version
          </button>
        </div>
      )}
    </div>
  );
}

const s = {
  container:        { maxWidth: 920, margin: '0 auto', padding: 24, fontFamily: 'monospace' },
  containerMobile:  { padding: 12 },
  header:           { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
  headerMobile:     { flexWrap: 'wrap', gap: 10 },
  title:            { fontSize: 22, marginBottom: 4, color: '#f1f5f9', margin: 0 },
  subtitle:         { color: '#64748b', fontSize: 13, margin: '4px 0 0' },
  backBtn:          { background: '#1e293b', color: '#94a3b8', border: '1px solid #334155', borderRadius: 8, padding: '6px 14px', fontSize: 12, cursor: 'pointer' },
  modeGrid:         { display: 'flex', gap: 20, marginTop: 24, flexWrap: 'wrap' },
  modeGridMobile:   { gap: 14 },
  modeCard:         { flex: '1 1 280px', background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 24, cursor: 'pointer', transition: 'border-color 0.2s' },
  modeIcon:         { fontSize: 40, marginBottom: 12 },
  modeTitle:        { color: '#f1f5f9', fontSize: 18, margin: '0 0 8px' },
  modeDesc:         { color: '#94a3b8', fontSize: 13, lineHeight: 1.6, margin: '0 0 16px' },
  modeTags:         { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 },
  tag:              { background: '#0f172a', color: '#7dd3fc', fontSize: 11, padding: '3px 8px', borderRadius: 4 },
  modeBtn:          { background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 20px', fontSize: 14, cursor: 'pointer', fontWeight: 700, width: '100%' },
  githubConnectedBtn: { background: '#14532d', color: '#86efac', border: '1px solid #166634', borderRadius: 8, padding: '8px 16px', fontSize: 13, cursor: 'pointer', fontWeight: 600 },
  githubConnectBtn: { background: '#1e293b', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 8, padding: '8px 16px', fontSize: 13, cursor: 'pointer' },
  githubMenu:       { position: 'absolute', top: '110%', left: 0, background: '#1e293b', border: '1px solid #334155', borderRadius: 8, padding: 4, zIndex: 100, minWidth: 200 },
  githubMenuItem:   { display: 'block', padding: '8px 12px', color: '#e2e8f0', fontSize: 13, textDecoration: 'none', borderRadius: 6 },
  githubBar:        { background: '#0f172a', borderRadius: 8, padding: '8px 14px', marginBottom: 16, fontSize: 13 },
  disconnectBtn:    { background: 'transparent', border: '1px solid #7f1d1d', color: '#fca5a5', borderRadius: 6, padding: '3px 10px', fontSize: 11, cursor: 'pointer' },
  textarea:         { width: '100%', background: '#1e293b', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 8, padding: 12, fontSize: 14, resize: 'vertical', boxSizing: 'border-box', marginBottom: 12 },
  controls:         { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' },
  controlsMobile:   { gap: 8 },
  select:           { background: '#1e293b', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '6px 10px', fontSize: 14 },
  runBtn:           { background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 20px', fontSize: 14, cursor: 'pointer', fontWeight: 700 },
  stopBtn:          { background: '#ef4444', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 20px', fontSize: 14, cursor: 'pointer', fontWeight: 700 },
  projectBox:       { background: '#1e1b4b', border: '1px solid #4338ca', borderRadius: 8, padding: 14, marginBottom: 16 },
  log:              { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, padding: 16, marginBottom: 16 },
  logTitle:         { color: '#94a3b8', fontSize: 12, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 },
  logItem:          { display: 'flex', gap: 10, padding: '8px 0', borderBottom: '1px solid #1e293b' },
  pushingBox:       { background: '#1e293b', borderRadius: 8, padding: 12, marginBottom: 16, color: '#94a3b8', fontSize: 13 },
  pushSuccessBox:   { background: '#052e16', border: '1px solid #166534', borderRadius: 8, padding: 16, marginBottom: 16 },
  link:             { color: '#7dd3fc', fontSize: 13, textDecoration: 'none' },
  filesBox:         { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, padding: 16 },
  codeHeader:       { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  codeHeaderMobile: { flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' },
  pushBtn:          { background: '#166534', color: '#86efac', border: 'none', borderRadius: 8, padding: '7px 18px', fontSize: 13, cursor: 'pointer', fontWeight: 700 },
  tabBar:           { display: 'flex', gap: 6, marginBottom: 12 },
  tabBtn:           { height: 34, borderRadius: 8, border: '1px solid #334155', background: '#1e293b', color: '#94a3b8', padding: '0 14px', cursor: 'pointer', fontWeight: 700, fontSize: 13 },
  tabActive:        { background: '#6366f1', color: '#fff', border: '1px solid transparent' },
  previewWrap:      { border: '1px solid #334155', borderRadius: 10, overflow: 'hidden' },
  browserBar:       { height: 36, display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px', background: '#1e293b', borderBottom: '1px solid #334155' },
  dot:              { width: 11, height: 11, borderRadius: 99, display: 'inline-block' },
  iframe:           { width: '100%', height: 440, border: 'none', background: '#fff', display: 'block' },
  iframeMobile:     { height: 300 },
  cmdBar:           { display: 'flex', gap: 8, padding: '10px 12px', borderTop: '1px solid #1e293b', background: '#0f172a', alignItems: 'center' },
  cmdBarMobile:     { flexWrap: 'wrap' },
  cmdInput:         { flex: 1, background: '#1e293b', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 8, padding: '8px 12px', fontSize: 13, outline: 'none', minWidth: 0 },
  cmdInputMobile:   { flex: '1 1 100%' },
  cmdBtn:           { background: '#4338ca', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 13, cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap' },
  noPreview:        { minHeight: 260, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 32, textAlign: 'center' },
  noPreviewMobile:  { padding: 16, minHeight: 220 },
  splitPane:        { display: 'flex', border: '1px solid #334155', borderRadius: 10, overflow: 'hidden', minHeight: 400 },
  splitPaneMobile:  { flexDirection: 'column', minHeight: 0 },
  fileList:         { width: 190, flexShrink: 0, borderRight: '1px solid #334155', overflowY: 'auto', background: '#0a0f1a' },
  fileListMobile:   { width: '100%', display: 'flex', flexDirection: 'row', flexWrap: 'wrap', maxHeight: 160, borderRight: 'none', borderBottom: '1px solid #334155' },
  fileListItem:     { width: '100%', border: 'none', background: 'transparent', color: '#e2e8f0', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', padding: '10px 12px', cursor: 'pointer', borderBottom: '1px solid #1e293b', textAlign: 'left' },
  fileListItemMobile: { width: 'auto', flex: '1 1 45%' },
  fileListActive:   { background: '#6366f1', color: '#fff' },
  codePane:         { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: '#0f172a' },
  codePre:          { flex: 1, color: '#e2e8f0', margin: 0, padding: 12, fontSize: 11, whiteSpace: 'pre-wrap', overflowX: 'auto', overflowY: 'auto', maxHeight: 380, fontFamily: 'monospace' },
  duplicateBox:     { background: '#1c1917', border: '1px solid #b45309', borderRadius: 8, padding: 16, marginBottom: 16 },
  buildAnywayBtn:   { background: '#374151', color: '#f9fafb', border: 'none', borderRadius: 6, padding: '6px 14px', fontSize: 12, cursor: 'pointer', marginTop: 8, display: 'block' },
  historyItem:      { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '12px 0', borderBottom: '1px solid #1e293b', flexWrap: 'wrap', gap: 8 },
};