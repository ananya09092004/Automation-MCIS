import { useState, useEffect, useCallback, useMemo } from "react";

const BASE_URL = process.env.REACT_APP_API_URL || "https://mcis-backend.onrender.com";

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

// ── Design tokens: futuristic-professional, wired to the global theme so
// this panel automatically follows the system's light/dark preference ──
const theme = {
  overlayBg: "var(--mcis-overlay)",
  panelBg: "linear-gradient(165deg, var(--mcis-surface) 0%, var(--mcis-surface-raised) 55%, var(--mcis-surface) 100%)",
  panelBorder: "var(--mcis-border-strong)",
  glassBg: "var(--mcis-input)",
  glassBorder: "var(--mcis-border)",
  textPrimary: "var(--mcis-text)",
  textMuted: "var(--mcis-muted)",
  textFaint: "var(--mcis-muted)",
  accentA: "var(--mcis-accent)",
  accentB: "var(--mcis-signal)",
  danger: "var(--mcis-danger)",
  dangerSoft: "var(--mcis-danger-soft)",
};

const ACCENT_GRADIENT = `linear-gradient(90deg, ${theme.accentA} 0%, #6366f1 55%, ${theme.accentB} 100%)`;

// ── Friendly type metadata: emoji + label + 2-color gradient per kind ───────
const TYPE_META = {
  future_path: { label: "Goal", emoji: "🎯", grad: ["#22d3ee", "#6366f1"] },
  goal: { label: "Goal", emoji: "🎯", grad: ["#22d3ee", "#6366f1"] },
  goals: { label: "Goal", emoji: "🎯", grad: ["#22d3ee", "#6366f1"] },
  insight: { label: "Insight", emoji: "💡", grad: ["#f59e0b", "#f97316"] },
  preference: { label: "Preference", emoji: "❤️", grad: ["#ec4899", "#f43f5e"] },
  preferences: { label: "Preference", emoji: "❤️", grad: ["#ec4899", "#f43f5e"] },
  personal: { label: "About You", emoji: "👤", grad: ["#3b82f6", "#22d3ee"] },
  profile: { label: "About You", emoji: "👤", grad: ["#3b82f6", "#22d3ee"] },
  work: { label: "Work", emoji: "💼", grad: ["#0ea5e9", "#38bdf8"] },
  education: { label: "Learning", emoji: "📚", grad: ["#14b8a6", "#2dd4bf"] },
  family: { label: "Family", emoji: "👨‍👩‍👧", grad: ["#f472b6", "#fb7185"] },
  health: { label: "Health", emoji: "🩺", grad: ["#22c55e", "#4ade80"] },
  hobbies: { label: "Hobby", emoji: "🎨", grad: ["#f97316", "#fb923c"] },
  finance: { label: "Finance", emoji: "💰", grad: ["#a855f7", "#c084fc"] },
  projects: { label: "Project", emoji: "🛠️", grad: ["#06b6d4", "#22d3ee"] },
  emotions: { label: "Mood", emoji: "🌤️", grad: ["#ef4444", "#f87171"] },
  location: { label: "Location", emoji: "📍", grad: ["#10b981", "#34d399"] },
  reminder: { label: "Reminder", emoji: "⏰", grad: ["#3b82f6", "#60a5fa"] },
  important: { label: "Important", emoji: "❗", grad: ["#ef4444", "#f43f5e"] },
  general: { label: "Memory", emoji: "🧠", grad: ["#6366f1", "#8b5cf6"] },
};

const getTypeMeta = (tag) => TYPE_META[tag] || TYPE_META.general;

// Keep a card's body to a short highlight instead of the full raw memory.
function trimText(text, max = 150) {
  if (!text) return "";
  const clean = String(text).trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 40 ? lastSpace : max)}…`;
}

// ── Parse a raw memory into clean, user-facing pieces ───────────────────────
function parseMemory(memory) {
  let raw = (memory.content || "").trim();

  const bracketMatch = raw.match(/^\[(\w+)\]\s*/);
  const bracketTag = bracketMatch ? bracketMatch[1].toLowerCase() : null;
  if (bracketMatch) raw = raw.slice(bracketMatch[0].length);

  const segments = raw.split("|").map((s) => s.trim());
  const mainText = segments[0] || "";

  let confidence = null;
  for (const seg of segments.slice(1)) {
    const m = seg.match(/confidence\s*:\s*([\d.]+)/i);
    if (m) confidence = parseFloat(m[1]);
  }

  const rawCategory = (memory.category || "").toLowerCase();
  const isPending = rawCategory.startsWith("pending_");
  const categoryTag = isPending ? rawCategory.slice(8) : rawCategory;
  const tag = bracketTag || categoryTag || "general";

  let title = null;
  let description = mainText;
  const colonIdx = mainText.indexOf(":");
  if (colonIdx > 0 && colonIdx < 60) {
    title = mainText.slice(0, colonIdx).trim();
    description = mainText.slice(colonIdx + 1).trim();
  }
  if (!description) description = mainText;

  return { tag, isPending, title, description: trimText(description, 150), confidence };
}

function MemoryPanel({ userId, onClose }) {
  const [memories, setMemories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [editContent, setEditContent] = useState("");
  const [filter, setFilter] = useState("all");
  const [nlQuery, setNlQuery] = useState("");
  const [nlLoading, setNlLoading] = useState(false);
  const [nlResult, setNlResult] = useState("");
  const [visibleCount, setVisibleCount] = useState(30);
  const isMobile = useIsMobile();

  const categories = [
    "all", "personal", "goals", "preferences", "work",
    "education", "family", "health", "hobbies",
    "finance", "projects", "emotions", "location", "general"
  ];

  const loadMemories = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_URL}/api/memory/${userId}`);
      const data = await res.json();
      if (data.success) setMemories(data.memories);
    } catch (err) {
      console.error("Load memories error:", err);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => { loadMemories(); }, [loadMemories]);

  const deleteMemory = async (id) => {
    try {
      await fetch(`${BASE_URL}/api/memory/${id}`, { method: "DELETE" });
      setMemories((prev) => prev.filter((m) => m.id !== id));
    } catch (err) {
      console.error("Delete error:", err);
    }
  };

  const startEdit = (memory) => {
    setEditingId(memory.id);
    setEditContent(memory.content);
  };

  const saveEdit = async (id) => {
    try {
      await fetch(`${BASE_URL}/api/memory/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editContent }),
      });
      setMemories((prev) =>
        prev.map((m) => (m.id === id ? { ...m, content: editContent } : m))
      );
    } catch (err) {
      console.error("Edit error:", err);
    }
    setEditingId(null);
  };

  const handleNLDelete = async () => {
    if (!nlQuery.trim()) return;
    setNlLoading(true);
    setNlResult("");
    try {
      const res = await fetch(`${BASE_URL}/api/memory/nl-delete/${userId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: nlQuery }),
      });
      const data = await res.json();
      if (data.success) {
        setNlResult(
          data.deleted > 0 ? `${data.deleted} memory deleted` : "No matching memory found"
        );
        if (data.deleted > 0) loadMemories();
      }
    } catch {
      setNlResult("Something went wrong");
    }
    setNlLoading(false);
    setNlQuery("");
  };

  const parsedMemories = useMemo(
    () => memories.map((m) => ({ memory: m, parsed: parseMemory(m) })),
    [memories]
  );

  const filteredMemories =
    filter === "all"
      ? parsedMemories
      : parsedMemories.filter(({ memory }) => memory.category === filter);

  // Rendering 300+ animated, shadowed cards in one scroll list is what was
  // making the panel feel like it was "flying apart" while scrolling — the
  // browser was fighting to composite far too many layers at once. Paging
  // keeps the DOM light; "Load more" reveals the rest on demand.
  const visibleMemories = filteredMemories.slice(0, visibleCount);
  const hasMore = filteredMemories.length > visibleMemories.length;

  useEffect(() => {
    setVisibleCount(30);
  }, [filter]);

  const summaryPoints = useMemo(() => {
    return parsedMemories
      .filter(({ parsed }) => parsed.description)
      .sort((a, b) => (b.parsed.confidence ?? 0) - (a.parsed.confidence ?? 0))
      .slice(0, 5)
      .map(({ parsed }) => trimText(parsed.description, 90));
  }, [parsedMemories]);

  return (
    <div style={{ ...styles.overlay, backdropFilter: isMobile ? "none" : styles.overlay.backdropFilter }}>
      {/* Scoped hover/interaction styles — inline styles can't do :hover.
          ✅ FIX: .mcis-mem-card previously set `transform: translateY(-1px)`
          + `box-shadow` on hover UNCONDITIONALLY (no media query). index.css
          already disables exactly this lift/shadow on mobile
          (`.mcis-mem-card:hover { transform: none; box-shadow: none; }`
          inside a max-width:768px block), but because this component's
          <style> tag is injected at runtime — after index.css in the DOM —
          it won a specificity/order fight and silently overrode that mobile
          fix on every screen size. That's what was causing cards to visibly
          "jump"/"break" apart while scrolling. Removed the transform/shadow
          hover here entirely; a plain border-color change is enough
          feedback and never fights with the global CSS again. */}
      <style>{`
        .mcis-mem-card { transition: border-color 0.15s ease; }
        .mcis-mem-card:hover { border-color: var(--mcis-border-strong, rgba(255,255,255,0.16)); }
        .mcis-mem-filter { transition: all 0.15s ease; }
        .mcis-mem-filter:hover { border-color: rgba(139,92,246,0.55) !important; color: var(--mcis-text, #eef0fb) !important; }
        .mcis-mem-close:hover { border-color: rgba(139,92,246,0.55); background: rgba(139,92,246,0.12); }
        .mcis-mem-edit:hover { background: rgba(34,211,238,0.12); border-color: rgba(34,211,238,0.55); }
        .mcis-mem-delete:hover { background: rgba(251,113,133,0.14); border-color: rgba(251,113,133,0.6); }
        .mcis-mem-nlbtn:hover { filter: brightness(1.1); }
        .mcis-mem-scroll::-webkit-scrollbar { width: 8px; }
        .mcis-mem-scroll::-webkit-scrollbar-thumb { background: rgba(139,92,246,0.25); border-radius: 8px; }
        .mcis-mem-clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
      `}</style>

      <div className="mcis-drawer-panel" style={{ ...styles.panel, ...(isMobile ? styles.panelMobile : {}) }}>

        {/* Header */}
        <div style={{ ...styles.header, ...(isMobile ? styles.headerMobile : {}) }}>
          <div>
            <div style={styles.title}>My Memories</div>
            <div style={styles.subtitle}>{memories.length} memories saved</div>
          </div>
          <button className="mcis-mem-close" style={styles.closeBtn} onClick={onClose}>Close</button>
        </div>

        <div className="mcis-mem-scroll" style={styles.scrollArea}>

          {/* What MCIS knows about you — summary section */}
          {!loading && summaryPoints.length > 0 && (
            <div style={styles.summaryBox}>
              <div style={styles.summaryGlow} />
              <div style={styles.summaryTitleRow}>
                <div style={styles.summaryIconRing}>🧠</div>
                <div style={styles.summaryTitle}>What MCIS knows about you</div>
              </div>
              <ul style={styles.summaryList}>
                {summaryPoints.map((point, i) => (
                  <li key={i} style={styles.summaryItem}>
                    <span style={styles.summaryDot} />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* NL Delete Box */}
          <div style={styles.nlBox}>
            <div style={styles.nlAccentBar} />
            <div style={styles.nlLabel}>Forget a memory</div>
            <div style={{ display: "flex", gap: 8, flexWrap: isMobile ? "wrap" : "nowrap" }}>
              <input
                style={{ ...styles.nlInput, minWidth: 0 }}
                placeholder='e.g. "forget that I like painting"'
                value={nlQuery}
                onChange={(e) => setNlQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleNLDelete()}
              />
              <button
                className="mcis-mem-nlbtn"
                style={{ ...styles.nlBtn, ...(isMobile ? { flex: "1 1 100%" } : {}) }}
                onClick={handleNLDelete}
                disabled={nlLoading}
              >
                {nlLoading ? "..." : "Forget"}
              </button>
            </div>
            {nlResult && <div style={styles.nlResult}>{nlResult}</div>}
          </div>

          {/* Category Filter */}
          <div style={styles.filterContainer}>
            {categories.map((cat) => (
              <button
                key={cat}
                className="mcis-mem-filter"
                style={{
                  ...styles.filterBtn,
                  background: filter === cat ? ACCENT_GRADIENT : "rgba(255,255,255,0.03)",
                  color: filter === cat ? "#fff" : theme.textMuted,
                  border: `1px solid ${filter === cat ? "transparent" : theme.glassBorder}`,
                  boxShadow: filter === cat ? "0 4px 16px rgba(99,102,241,0.35)" : "none",
                }}
                onClick={() => setFilter(cat)}
              >
                {cat}
              </button>
            ))}
          </div>

          {/* Memories List */}
          <div style={styles.list}>
            {loading ? (
              <div style={styles.empty}>Loading memories...</div>
            ) : filteredMemories.length === 0 ? (
              <div style={styles.empty}>No memories in this category</div>
            ) : (
              visibleMemories.map(({ memory, parsed }) => {
                const meta = getTypeMeta(parsed.tag);
                const grad = `linear-gradient(135deg, ${meta.grad[0]}, ${meta.grad[1]})`;
                return (
                  <div key={memory.id} className="mcis-mem-card" style={styles.memoryCard}>
                    <div style={{ ...styles.cardTopBar, background: grad }} />

                    <div style={styles.badgeRow}>
                      <div style={{ ...styles.iconRing, background: `linear-gradient(135deg, ${meta.grad[0]}22, ${meta.grad[1]}33)`, border: `1px solid ${meta.grad[0]}55` }}>
                        <span style={{ fontSize: 15 }}>{meta.emoji}</span>
                      </div>
                      <span style={{ ...styles.badgeLabel, color: meta.grad[1] }}>{meta.label}</span>
                    </div>

                    {typeof parsed.confidence === "number" && !isNaN(parsed.confidence) && (
                      <div className="mcis-mem-confidence" title="How confident MCIS is in this memory">
                        <span className="mcis-mem-confidence-label">
                          {Math.round(Math.min(1, Math.max(0, parsed.confidence)) * 100)}%
                        </span>
                        <div className="mcis-mem-confidence-track">
                          <div
                            className="mcis-mem-confidence-fill"
                            style={{ width: `${Math.round(Math.min(1, Math.max(0, parsed.confidence)) * 100)}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {editingId === memory.id ? (
                      <textarea
                        style={styles.editInput}
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        rows={3}
                      />
                    ) : (
                      <>
                        {parsed.title && <div className="mcis-mem-clamp" style={styles.cardTitle}>{parsed.title}</div>}
                        <div className="mcis-mem-clamp" style={styles.content}>{parsed.description}</div>
                      </>
                    )}

                    <div style={styles.date}>
                      Saved <span style={{ opacity: 0.5 }}>•</span>{" "}
                      {new Date(memory.created_at).toLocaleDateString("en-IN", {
                        day: "numeric", month: "short", year: "numeric",
                      })}
                    </div>

                    <div style={{ ...styles.actions, flexWrap: isMobile ? "wrap" : "nowrap" }}>
                      {editingId === memory.id ? (
                        <>
                          <button style={styles.saveBtn} onClick={() => saveEdit(memory.id)}>Save</button>
                          <button style={styles.cancelBtn} onClick={() => setEditingId(null)}>Cancel</button>
                        </>
                      ) : (
                        <>
                          <button className="mcis-mem-edit" style={styles.editBtn} onClick={() => startEdit(memory)}>Edit</button>
                          <button className="mcis-mem-delete" style={styles.deleteBtn} onClick={() => deleteMemory(memory.id)}>Delete</button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })
            )}
            {hasMore && (
              <button style={styles.loadMoreBtn} onClick={() => setVisibleCount(c => c + 30)}>
                Load {Math.min(30, filteredMemories.length - visibleMemories.length)} more
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const styles = {
  overlay: { position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: theme.overlayBg, zIndex: 1000, display: "flex", justifyContent: "flex-end", backdropFilter: "blur(10px)" },
  panel: { width: 440, maxWidth: "100vw", height: "100vh", background: theme.panelBg, borderLeft: `1px solid ${theme.panelBorder}`, display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "-24px 0 64px rgba(0,0,0,0.45)" },
  panelMobile: { width: "100vw", maxWidth: "100vw", height: "100dvh", borderLeft: "none" },

  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "22px 24px", borderBottom: `1px solid ${theme.glassBorder}`, flexShrink: 0 },
  headerMobile: { padding: "16px 16px" },
  title: { fontSize: 20, fontWeight: 800, letterSpacing: -0.3, background: ACCENT_GRADIENT, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" },
  subtitle: { fontSize: 12, color: theme.textMuted, marginTop: 4 },
  closeBtn: { background: "rgba(255,255,255,0.04)", border: `1px solid ${theme.glassBorder}`, borderRadius: 8, color: theme.textPrimary, cursor: "pointer", padding: "7px 14px", fontSize: 13 },

  scrollArea: { flex: 1, overflowY: "auto", minHeight: 0, WebkitOverflowScrolling: "touch" },

  // ✅ FIX: backdropFilter blur() removed from summaryBox/nlBox — both sit
  // *inside* the scrolling list, so the browser had to re-blur them on
  // every single scroll frame. That GPU cost is what made the panel feel
  // "stuck"/heavy while scrolling. Solid background keeps the same look
  // without the per-frame repaint cost.
  summaryBox: { position: "relative", margin: "16px 16px 6px", background: "var(--mcis-surface-raised)", border: "1px solid rgba(139,92,246,0.3)", borderRadius: 16, padding: "17px 18px", overflow: "hidden" },
  summaryGlow: { position: "absolute", top: -60, right: -60, width: 140, height: 140, borderRadius: "50%", background: "radial-gradient(circle, rgba(139,92,246,0.28) 0%, transparent 70%)", pointerEvents: "none" },
  summaryTitleRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 12, position: "relative" },
  summaryIconRing: { width: 30, height: 30, borderRadius: "50%", background: "linear-gradient(135deg, rgba(34,211,238,0.18), rgba(139,92,246,0.24))", border: "1px solid rgba(139,92,246,0.4)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 },
  summaryTitle: { fontSize: 14, fontWeight: 800, color: theme.textPrimary },
  summaryList: { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 9, position: "relative" },
  summaryItem: { display: "flex", alignItems: "flex-start", gap: 9, fontSize: 13, color: theme.textPrimary, lineHeight: 1.55 },
  summaryDot: { width: 5, height: 5, borderRadius: "50%", background: ACCENT_GRADIENT, marginTop: 7, flexShrink: 0, boxShadow: "0 0 6px rgba(139,92,246,0.7)" },

  nlBox: { position: "relative", margin: "14px 16px 6px", background: "var(--mcis-surface-raised)", border: "1px solid rgba(251,113,133,0.3)", borderRadius: 14, padding: "14px", overflow: "hidden" },
  nlAccentBar: { position: "absolute", top: 0, left: 0, right: 0, height: 2, background: `linear-gradient(90deg, ${theme.danger}, #f43f5e)` },
  nlLabel: { fontSize: 11, color: theme.danger, fontWeight: 800, marginBottom: 9, textTransform: "uppercase", letterSpacing: 0.8 },
  nlInput: { flex: 1, background: "rgba(255,255,255,0.04)", border: `1px solid ${theme.glassBorder}`, borderRadius: 8, padding: "9px 12px", color: theme.textPrimary, fontSize: 13, outline: "none", minWidth: 0 },
  nlBtn: { background: `linear-gradient(135deg, ${theme.danger}, #f43f5e)`, border: "none", borderRadius: 8, color: "#fff", padding: "9px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", flexShrink: 0 },
  nlResult: { fontSize: 12, color: theme.danger, marginTop: 9 },

  filterContainer: { display: "flex", flexWrap: "wrap", gap: 7, padding: "14px 16px", borderBottom: `1px solid ${theme.glassBorder}` },
  filterBtn: { borderRadius: 20, padding: "5px 13px", fontSize: 11, cursor: "pointer", fontWeight: 700, textTransform: "capitalize" },

  list: { padding: "14px 16px" },
  empty: { color: theme.textMuted, textAlign: "center", marginTop: 40, fontSize: 14 },
  loadMoreBtn: { width: "100%", background: "rgba(255,255,255,0.04)", border: `1px solid ${theme.glassBorder}`, borderRadius: 10, color: theme.textPrimary, cursor: "pointer", padding: "11px", fontSize: 13, fontWeight: 700, marginTop: 4 },

  memoryCard: { position: "relative", background: theme.glassBg, border: `1px solid ${theme.glassBorder}`, borderRadius: 16, padding: "18px 16px 14px", marginBottom: 13, overflow: "hidden", contain: "content" },
  cardTopBar: { position: "absolute", top: 0, left: 0, right: 0, height: 3 },
  badgeRow: { display: "flex", alignItems: "center", gap: 9, marginBottom: 11 },
  iconRing: { width: 30, height: 30, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  badgeLabel: { fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.6 },

  cardTitle: { fontSize: 14.5, fontWeight: 700, color: theme.textPrimary, marginBottom: 5, lineHeight: 1.4 },
  content: { fontSize: 13, color: theme.textMuted, lineHeight: 1.6, marginBottom: 10 },
  date: { fontSize: 11, color: theme.textFaint, marginBottom: 10 },

  actions: { display: "flex", gap: 8 },
  editBtn: { background: "rgba(255,255,255,0.03)", border: `1px solid ${theme.glassBorder}`, borderRadius: 7, color: theme.accentA, cursor: "pointer", fontSize: 12, fontWeight: 600, padding: "5px 13px" },
  deleteBtn: { background: "rgba(255,255,255,0.03)", border: `1px solid ${theme.glassBorder}`, borderRadius: 7, color: theme.danger, cursor: "pointer", fontSize: 12, fontWeight: 600, padding: "5px 13px" },
  saveBtn: { background: ACCENT_GRADIENT, border: "none", borderRadius: 7, color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 700, padding: "5px 14px" },
  cancelBtn: { background: "transparent", border: `1px solid ${theme.glassBorder}`, borderRadius: 7, color: theme.textMuted, cursor: "pointer", fontSize: 12, padding: "5px 14px" },
  editInput: { width: "100%", background: "rgba(255,255,255,0.04)", border: `1px solid rgba(139,92,246,0.4)`, borderRadius: 8, padding: 10, color: theme.textPrimary, fontSize: 13, outline: "none", resize: "vertical", boxSizing: "border-box", marginBottom: 10 },
};

export default MemoryPanel;