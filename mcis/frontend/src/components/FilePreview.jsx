// frontend/src/components/FilePreview.jsx
// Live preview for HTML/CSS/JS projects inside MCIS

import { useState, useEffect, useRef } from 'react';

// ── Simple mobile detector (no other behavior changed) ─────────────────────
function useIsMobile(breakpoint = 640) {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth <= breakpoint
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= breakpoint);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);
  return isMobile;
}

// Check if files can be previewed
const canPreview = (files) => {
  if (!files?.length) return false;
  const paths = files.map(f => f.path.toLowerCase());
  return paths.some(p => p.endsWith('.html') || p.endsWith('.jsx') || p.endsWith('.tsx'));
};

// Build a single HTML blob from all project files
const buildPreviewHTML = (files) => {
  const htmlFile = files.find(f => f.path.toLowerCase().endsWith('.html'));
  const cssFiles  = files.filter(f => f.path.toLowerCase().endsWith('.css'));
  const jsFiles   = files.filter(f =>
    f.path.toLowerCase().endsWith('.js') &&
    !f.path.toLowerCase().includes('node_modules') &&
    !f.path.toLowerCase().includes('package')
  );

  if (htmlFile) {
    // Inject CSS and JS into HTML
    let html = htmlFile.content;

    // Inject all CSS inline
    cssFiles.forEach(css => {
      html = html.replace('</head>', `<style>${css.content}</style></head>`);
    });

    // Inject all JS inline (skip module imports)
    jsFiles.forEach(js => {
      const safeJS = js.content
        .replace(/import\s+.*?from\s+['"].*?['"]/g, '// import removed for preview')
        .replace(/export\s+default\s+/g, '')
        .replace(/export\s+/g, '');
      html = html.replace('</body>', `<script>${safeJS}</script></body>`);
    });

    return html;
  }

  // No HTML file — generate a simple wrapper
  const cssContent  = cssFiles.map(f => f.content).join('\n');
  const jsContent   = jsFiles.map(f =>
    f.content
      .replace(/import\s+.*?from\s+['"].*?['"]/g, '// import removed')
      .replace(/export\s+default\s+/g, '')
      .replace(/export\s+/g, '')
  ).join('\n');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 20px; font-family: sans-serif; background: #f9fafb; }
    ${cssContent}
  </style>
</head>
<body>
  <div id="root"></div>
  <div id="app"></div>
  <script>
    ${jsContent}
  </script>
</body>
</html>`;
};

export default function FilePreview({ files, projectName }) {
  const [activeFile, setActiveFile] = useState(null);
  const [previewMode, setPreviewMode] = useState('preview'); // 'preview' | 'code'
  const iframeRef = useRef(null);
  const isMobile = useIsMobile();

  const previewable = canPreview(files);

  // Set first file as active by default
  useEffect(() => {
    if (files?.length > 0 && !activeFile) {
      const htmlFile = files.find(f => f.path.toLowerCase().endsWith('.html'));
      setActiveFile(htmlFile || files[0]);
    }
  }, [files]);

  // Update iframe when files change
  useEffect(() => {
    if (previewMode === 'preview' && iframeRef.current && previewable) {
      const html = buildPreviewHTML(files);
      const blob = new Blob([html], { type: 'text/html' });
      const url  = URL.createObjectURL(blob);
      iframeRef.current.src = url;
      return () => URL.revokeObjectURL(url);
    }
  }, [files, previewMode, previewable]);

  if (!files?.length) return null;

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={{ ...styles.header, ...(isMobile ? styles.headerMobile : {}) }}>
        <h3 style={styles.title}>📁 {projectName || 'Project'}</h3>
        {previewable && (
          <div style={styles.tabs}>
            <button
              style={{ ...styles.tab, ...(previewMode === 'preview' ? styles.tabActive : {}) }}
              onClick={() => setPreviewMode('preview')}
            >
              👁️ Preview
            </button>
            <button
              style={{ ...styles.tab, ...(previewMode === 'code' ? styles.tabActive : {}) }}
              onClick={() => setPreviewMode('code')}
            >
              📝 Code
            </button>
          </div>
        )}
        {!previewable && (
          <span style={styles.noPreviewBadge}>
            💻 Open in VS Code to run
          </span>
        )}
      </div>

      {/* Preview / Code view */}
      <div style={{ ...styles.body, ...(isMobile ? styles.bodyMobile : {}) }}>
        {previewMode === 'preview' && previewable ? (
          <iframe
            ref={iframeRef}
            style={styles.iframe}
            title="Project Preview"
            sandbox="allow-scripts allow-same-origin"
          />
        ) : (
          <div style={styles.codePanel}>
            {/* File tabs */}
            <div style={styles.fileTabs}>
              {files.map((f, i) => (
                <button
                  key={i}
                  style={{
                    ...styles.fileTab,
                    ...(activeFile?.path === f.path ? styles.fileTabActive : {}),
                  }}
                  onClick={() => setActiveFile(f)}
                >
                  {f.path.split('/').pop()}
                </button>
              ))}
            </div>
            {/* Code content */}
            <pre style={styles.code}>
              {activeFile?.content || ''}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  container:      { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 12, overflow: 'hidden', marginTop: 16 },
  header:         { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: '#1e293b', borderBottom: '1px solid #334155' },
  headerMobile:   { flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' },
  title:          { color: '#f1f5f9', fontSize: 14, margin: 0, fontFamily: 'monospace' },
  tabs:           { display: 'flex', gap: 4 },
  tab:            { background: '#334155', color: '#94a3b8', border: 'none', borderRadius: 6, padding: '5px 14px', fontSize: 12, cursor: 'pointer', fontWeight: 500 },
  tabActive:      { background: '#6366f1', color: '#fff' },
  noPreviewBadge: { color: '#64748b', fontSize: 12, fontFamily: 'monospace' },
  body:           { height: 480 },
  bodyMobile:     { height: 320 },
  iframe:         { width: '100%', height: '100%', border: 'none', background: '#fff' },
  codePanel:      { display: 'flex', flexDirection: 'column', height: '100%' },
  fileTabs:       { display: 'flex', gap: 2, padding: '8px 12px', background: '#1e293b', overflowX: 'auto', flexShrink: 0 },
  fileTab:        { background: 'transparent', color: '#64748b', border: 'none', borderRadius: 4, padding: '4px 10px', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'monospace' },
  fileTabActive:  { background: '#334155', color: '#7dd3fc' },
  code:           { flex: 1, margin: 0, padding: 16, overflowY: 'auto', color: '#e2e8f0', fontSize: 11, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
};