import { useState, useEffect, useCallback } from "react";

const BASE_URL = process.env.REACT_APP_API_URL || "https://mcis-backend.onrender.com";

const CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'career', label: 'Career' },
  { id: 'health', label: 'Health' },
  { id: 'learning', label: 'Learning' },
  { id: 'personal', label: 'Personal' },
  { id: 'finance', label: 'Finance' },
];

const CATEGORY_COLORS = {
  career: '#6c63ff',
  health: '#00c9a7',
  learning: '#f7b731',
  personal: '#fc5c65',
  finance: '#26de81',
  general: '#778ca3'
};

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

function GoalsPanel({ userId, onClose }) {
  const [goals, setGoals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState('all');
  const [showAddForm, setShowAddForm] = useState(false);
  const [weeklyReport, setWeeklyReport] = useState('');
  const [reportLoading, setReportLoading] = useState(false);
  const [updatingGoal, setUpdatingGoal] = useState(null);
  const [newGoal, setNewGoal] = useState({
    title: '', description: '', category: 'career', targetDate: ''
  });
  const isMobile = useIsMobile();

  const t = {
    panelBg: 'var(--mcis-sidebar)',
    cardBg: 'var(--mcis-surface)',
    border: 'var(--mcis-border)',
    text: 'var(--mcis-text)',
    textMuted: 'var(--mcis-muted)',
    inputBg: 'var(--mcis-input)',
    reportText: 'var(--mcis-text)',
  };

  const loadGoals = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_URL}/api/goals/${userId}`);
      const data = await res.json();
      if (data.success) setGoals(data.goals);
    } catch (err) {
      console.error('Load goals error:', err);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => { loadGoals(); }, [loadGoals]);

  const addGoal = async () => {
    if (!newGoal.title.trim()) return;
    try {
      const res = await fetch(`${BASE_URL}/api/goals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, ...newGoal })
      });
      const data = await res.json();
      if (data.success) {
        setGoals(prev => [data.goal, ...prev]);
        setNewGoal({ title: '', description: '', category: 'career', targetDate: '' });
        setShowAddForm(false);
      }
    } catch (err) {
      console.error('Add goal error:', err);
    }
  };

  const updateProgress = async (goalId, newProgress, note = '') => {
    try {
      const res = await fetch(`${BASE_URL}/api/goals/${goalId}/progress`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ progress: newProgress, note, userId })
      });
      const data = await res.json();
      if (data.success) {
        setGoals(prev => prev.map(g => g.id === goalId ? data.goal : g));
        setUpdatingGoal(null);
      }
    } catch (err) {
      console.error('Update progress error:', err);
    }
  };

  const deleteGoal = async (goalId) => {
    if (!window.confirm('Delete this goal?')) return;
    try {
      await fetch(`${BASE_URL}/api/goals/${goalId}`, { method: 'DELETE' });
      setGoals(prev => prev.filter(g => g.id !== goalId));
    } catch (err) {
      console.error('Delete goal error:', err);
    }
  };

  const getWeeklyReport = async () => {
    setReportLoading(true);
    try {
      const res = await fetch(`${BASE_URL}/api/goals/${userId}/report/weekly`);
      const data = await res.json();
      if (data.success) setWeeklyReport(data.report);
    } catch (err) {
      console.error('Report error:', err);
    }
    setReportLoading(false);
  };

  const getDaysLeft = (targetDate) => {
    if (!targetDate) return null;
    const days = Math.ceil((new Date(targetDate) - new Date()) / (1000 * 60 * 60 * 24));
    return days;
  };

  const filteredGoals = activeCategory === 'all'
    ? goals
    : goals.filter(g => g.category === activeCategory);

  const activeGoals = goals.filter(g => g.status === 'active').length;
  const completedGoals = goals.filter(g => g.status === 'completed').length;
  const avgProgress = goals.length
    ? Math.round(goals.reduce((sum, g) => sum + g.progress, 0) / goals.length)
    : 0;

  return (
    <div style={{ ...styles.overlay, backdropFilter: isMobile ? 'none' : styles.overlay.backdropFilter }}>
      <div className="mcis-drawer-panel" style={{ ...styles.panel, background: t.panelBg, ...(isMobile ? styles.panelMobile : {}) }}>

        {/* Header */}
        <div style={{ ...styles.header, borderBottom: `1px solid ${t.border}`, ...(isMobile ? styles.headerMobile : {}) }}>
          <div>
            <div style={{ ...styles.title, color: t.text }}>My Goals</div>
            <div style={{ ...styles.subtitle, color: t.textMuted }}>
              {activeGoals} active · {completedGoals} completed · {avgProgress}% avg progress
            </div>
          </div>
          <button style={{ ...styles.closeBtn, border: `1px solid ${t.border}`, color: t.textMuted }} onClick={onClose}>✕</button>
        </div>

        {/* Stats Row */}
        <div style={{ ...styles.statsRow, flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
          <div style={{ ...styles.statCard, background: t.cardBg, border: `1px solid ${t.border}`, flex: isMobile ? '1 1 70px' : 1 }}>
            <div style={styles.statNum}>{activeGoals}</div>
            <div style={{ ...styles.statLabel, color: t.textMuted }}>Active</div>
          </div>
          <div style={{ ...styles.statCard, background: t.cardBg, border: `1px solid ${t.border}`, flex: isMobile ? '1 1 70px' : 1 }}>
            <div style={{ ...styles.statNum, color: '#00c9a7' }}>{completedGoals}</div>
            <div style={{ ...styles.statLabel, color: t.textMuted }}>Done</div>
          </div>
          <div style={{ ...styles.statCard, background: t.cardBg, border: `1px solid ${t.border}`, flex: isMobile ? '1 1 70px' : 1 }}>
            <div style={{ ...styles.statNum, color: '#f7b731' }}>{avgProgress}%</div>
            <div style={{ ...styles.statLabel, color: t.textMuted }}>Avg Progress</div>
          </div>
          <button style={{ ...styles.reportBtn, ...(isMobile ? { flex: '1 1 100%' } : {}) }} onClick={getWeeklyReport} disabled={reportLoading}>
            {reportLoading ? '...' : 'AI Report'}
          </button>
        </div>

        {/* AI Weekly Report — apna scroll hai */}
        {weeklyReport && (
          <div style={{ ...styles.reportBox, background: t.cardBg, border: '1px solid #6c63ff', maxHeight: 220, overflowY: 'auto' }}>
            <div style={styles.reportTitle}>Weekly AI Report</div>
            <div style={{ ...styles.reportText, color: t.reportText }}>{weeklyReport}</div>
            <button style={{ ...styles.closeReportBtn, border: `1px solid ${t.border}`, color: t.textMuted }} onClick={() => setWeeklyReport('')}>Close</button>
          </div>
        )}

        {/* Category Filter */}
        <div style={styles.filterRow}>
          {CATEGORIES.map(cat => (
            <button
              key={cat.id}
              style={{
                ...styles.filterBtn,
                background: activeCategory === cat.id ? '#6c63ff' : 'transparent',
                color: activeCategory === cat.id ? '#fff' : t.textMuted,
                border: `1px solid ${activeCategory === cat.id ? '#6c63ff' : t.border}`
              }}
              onClick={() => setActiveCategory(cat.id)}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* Add Goal Button */}
        <button style={styles.addBtn} onClick={() => setShowAddForm(!showAddForm)}>
          {showAddForm ? 'Cancel' : '+ Add New Goal'}
        </button>

        {/* Add Goal Form */}
        {showAddForm && (
          <div style={{ ...styles.addForm, background: t.cardBg, border: `1px solid ${t.border}` }}>
            <input
              style={{ ...styles.formInput, background: t.inputBg, border: `1px solid ${t.border}`, color: t.text }}
              placeholder="Goal title *"
              value={newGoal.title}
              onChange={e => setNewGoal(prev => ({ ...prev, title: e.target.value }))}
            />
            <textarea
              style={{ ...styles.formInput, background: t.inputBg, border: `1px solid ${t.border}`, color: t.text, resize: 'vertical', minHeight: 60 }}
              placeholder="Description (optional)"
              value={newGoal.description}
              onChange={e => setNewGoal(prev => ({ ...prev, description: e.target.value }))}
            />
            <div style={{ display: 'flex', gap: 8, flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
              <select
                style={{ ...styles.formInput, background: t.inputBg, border: `1px solid ${t.border}`, color: t.text, flex: isMobile ? '1 1 140px' : 1, minWidth: 0 }}
                value={newGoal.category}
                onChange={e => setNewGoal(prev => ({ ...prev, category: e.target.value }))}
              >
                <option value="career">Career</option>
                <option value="health">Health</option>
                <option value="learning">Learning</option>
                <option value="personal">Personal</option>
                <option value="finance">Finance</option>
                <option value="general">General</option>
              </select>

              {/* Date input — colorScheme dark/light se proper color */}
              <input
                style={{
                  ...styles.formInput,
                  background: t.inputBg,
                  border: `1px solid ${t.border}`,
                  color: t.text,
                  flex: isMobile ? '1 1 140px' : 1,
                  minWidth: 0,
                  colorScheme: 'light dark'
                }}
                type="date"
                value={newGoal.targetDate}
                onChange={e => setNewGoal(prev => ({ ...prev, targetDate: e.target.value }))}
              />
            </div>
            <button style={styles.saveBtn} onClick={addGoal}>
              Save Goal
            </button>
          </div>
        )}

        {/* Goals List — main scrollable area with scrollbar on extreme right */}
        <div style={{
          ...styles.list,
          scrollbarWidth: 'thin',
          scrollbarColor: '#6c63ff transparent',
        }}>
          {loading ? (
            <div style={{ ...styles.empty, color: t.textMuted }}>Loading goals...</div>
          ) : filteredGoals.length === 0 ? (
            <div style={{ ...styles.empty, color: t.textMuted }}>
              No goals yet — add your first goal!
            </div>
          ) : (
            filteredGoals.map(goal => {
              const daysLeft = getDaysLeft(goal.target_date);
              const color = CATEGORY_COLORS[goal.category] || '#778ca3';
              const isCompleted = goal.status === 'completed';

              return (
                <div key={goal.id} style={{
                  ...styles.goalCard,
                  background: t.cardBg,
                  border: `1px solid ${t.border}`,
                  opacity: isCompleted ? 0.7 : 1,
                  borderLeft: `3px solid ${color}`
                }}>
                  {/* Goal Header */}
                  <div style={styles.goalHeader}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ ...styles.categoryBadge, background: color }}>
                          {goal.category}
                        </span>
                        {isCompleted && (
                          <span style={styles.completedBadge}>Completed</span>
                        )}
                      </div>
                      <div style={{ ...styles.goalTitle, color: t.text }}>{goal.title}</div>
                      {goal.description && (
                        <div style={{ ...styles.goalDesc, color: t.textMuted }}>{goal.description}</div>
                      )}
                    </div>
                    <button
                      style={{ ...styles.deleteGoalBtn, color: t.textMuted }}
                      onClick={() => deleteGoal(goal.id)}
                    >
                      ✕
                    </button>
                  </div>

                  {/* Progress Bar */}
                  <div style={styles.progressContainer}>
                    <div style={{ ...styles.progressBar, background: t.border }}>
                      <div style={{
                        ...styles.progressFill,
                        width: `${goal.progress}%`,
                        background: isCompleted
                          ? '#00c9a7'
                          : `linear-gradient(90deg, ${color}, ${color}99)`
                      }} />
                    </div>
                    <span style={{ ...styles.progressText, color: t.textMuted }}>{goal.progress}%</span>
                  </div>

                  {/* Days left */}
                  {daysLeft !== null && !isCompleted && (
                    <div style={{
                      ...styles.daysLeft,
                      color: daysLeft < 7 ? '#fc5c65' : daysLeft < 30 ? '#f7b731' : t.textMuted
                    }}>
                      {daysLeft > 0 ? `${daysLeft} days left` : daysLeft === 0 ? 'Due today!' : `${Math.abs(daysLeft)} days overdue`}
                    </div>
                  )}

                  {/* Update Progress */}
                  {!isCompleted && (
                    updatingGoal === goal.id ? (
                      <div style={styles.updateBox}>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          defaultValue={goal.progress}
                          style={{ width: '100%', accentColor: color }}
                          onChange={e => {
                            setGoals(prev => prev.map(g =>
                              g.id === goal.id ? { ...g, progress: parseInt(e.target.value) } : g
                            ));
                          }}
                          id={`slider-${goal.id}`}
                        />
                        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                          <button
                            style={styles.updateSaveBtn}
                            onClick={() => {
                              const slider = document.getElementById(`slider-${goal.id}`);
                              updateProgress(goal.id, parseInt(slider.value));
                            }}
                          >
                            Save
                          </button>
                          <button
                            style={{ ...styles.updateCancelBtn, border: `1px solid ${t.border}`, color: t.textMuted }}
                            onClick={() => setUpdatingGoal(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        style={{ ...styles.updateBtn, borderColor: color, color }}
                        onClick={() => setUpdatingGoal(goal.id)}
                      >
                        Update Progress
                      </button>
                    )
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

const styles = {
  overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--mcis-overlay)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end', backdropFilter: 'blur(8px)' },
  panel: { width: '100%', maxWidth: 460, height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: 'var(--mcis-drawer-shadow)' },
  // Mobile override: ensure full-height, full-width drawer on small screens
  panelMobile: { maxWidth: '100vw', height: '100dvh' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '22px 22px 16px', flexShrink: 0 },
  headerMobile: { padding: '16px 16px 12px' },
  title: { fontSize: 20, fontWeight: '800' },
  subtitle: { fontSize: 12, marginTop: 4 },
  closeBtn: { background: 'transparent', borderRadius: 8, cursor: 'pointer', padding: '6px 12px', fontSize: 14 },
  statsRow: { display: 'flex', gap: 8, padding: '12px 16px', alignItems: 'center', flexShrink: 0 },
  statCard: { flex: 1, borderRadius: 10, padding: '10px 8px', textAlign: 'center', boxShadow: 'var(--mcis-card-shadow)' },
  statNum: { fontSize: 20, fontWeight: 'bold', color: '#6c63ff' },
  statLabel: { fontSize: 10, marginTop: 2 },
  reportBtn: { background: 'var(--mcis-primary)', border: 'none', borderRadius: 10, color: '#fff', padding: '10px 12px', fontSize: 12, fontWeight: 'bold', cursor: 'pointer', flexShrink: 0, boxShadow: 'var(--mcis-glow)' },
  reportBox: { margin: '0 16px 8px', borderRadius: 12, padding: '14px', flexShrink: 0 },
  reportTitle: { fontSize: 13, fontWeight: 'bold', color: '#6c63ff', marginBottom: 8 },
  reportText: { fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' },
  closeReportBtn: { marginTop: 10, background: 'transparent', borderRadius: 6, cursor: 'pointer', padding: '4px 12px', fontSize: 12 },
  filterRow: { display: 'flex', gap: 6, padding: '8px 16px', overflowX: 'auto', flexShrink: 0 },
  filterBtn: { borderRadius: 20, padding: '5px 12px', fontSize: 12, cursor: 'pointer', fontWeight: 'bold', whiteSpace: 'nowrap', flexShrink: 0 },
  addBtn: { margin: '8px 16px', background: 'var(--mcis-subtle)', border: '1px dashed #6c63ff', borderRadius: 10, color: '#6c63ff', padding: '10px', fontSize: 13, fontWeight: 'bold', cursor: 'pointer', flexShrink: 0 },
  addForm: { margin: '0 16px 8px', borderRadius: 12, padding: '14px', display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 },
  formInput: { borderRadius: 8, padding: '10px 12px', fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box' },
  saveBtn: { background: 'var(--mcis-primary)', border: 'none', borderRadius: 8, color: '#fff', padding: '10px', fontSize: 13, fontWeight: 'bold', cursor: 'pointer', boxShadow: 'var(--mcis-glow)' },
  list: { flex: 1, overflowY: 'auto', minHeight: 0, padding: '8px 4px 8px 16px', marginRight: 0, WebkitOverflowScrolling: 'touch', overscrollBehaviorY: 'contain' },
  empty: { textAlign: 'center', marginTop: 40, fontSize: 14 },
  goalCard: { borderRadius: 12, padding: '14px', marginBottom: 12, marginRight: 12, boxShadow: 'var(--mcis-card-shadow)' },
  goalHeader: { display: 'flex', gap: 8, marginBottom: 10 },
  categoryBadge: { fontSize: 10, fontWeight: 'bold', color: '#fff', borderRadius: 20, padding: '2px 8px', display: 'inline-block' },
  completedBadge: { fontSize: 10, color: '#00c9a7', border: '1px solid #00c9a7', borderRadius: 20, padding: '2px 8px' },
  goalTitle: { fontSize: 15, fontWeight: 'bold', marginTop: 6 },
  goalDesc: { fontSize: 12, marginTop: 4, lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
  deleteGoalBtn: { background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 16, padding: '0 4px', flexShrink: 0 },
  progressContainer: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 },
  progressBar: { flex: 1, height: 6, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 3, transition: 'width 0.3s' },
  progressText: { fontSize: 12, flexShrink: 0, width: 32, textAlign: 'right' },
  daysLeft: { fontSize: 11, marginBottom: 8 },
  updateBox: { marginTop: 8 },
  updateBtn: { background: 'transparent', border: '1px solid', borderRadius: 8, padding: '6px 14px', fontSize: 12, fontWeight: 'bold', cursor: 'pointer', marginTop: 4 },
  updateSaveBtn: { background: 'var(--mcis-primary)', border: 'none', borderRadius: 6, color: '#fff', padding: '6px 16px', fontSize: 12, cursor: 'pointer' },
  updateCancelBtn: { background: 'transparent', borderRadius: 6, padding: '6px 12px', fontSize: 12, cursor: 'pointer' },
};

export default GoalsPanel;