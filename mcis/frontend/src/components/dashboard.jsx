import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Brain,
  BriefcaseBusiness,
  CalendarCheck,
  CheckCircle2,
  ChevronLeft,
  Eye,
  GitBranch,
  Info,
  LayoutDashboard,
  LogOut,
  MessageSquareText,
  PauseCircle,
  Plus,
  Gauge,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  Zap,
  Lightbulb,
  Heart,
  User,
  GraduationCap,
  Users,
  Activity,
  Palette,
  DollarSign,
  Wrench,
  MapPin,
} from 'lucide-react';

import SandboxExecutor from './SandboxExecutor';
import { auth } from '../firebase';

const API_BASE = process.env.REACT_APP_BACKEND_URL || process.env.REACT_APP_API_URL || 'https://mcis-backend.onrender.com';

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

// ── Memory category identity: one icon + one light color pair per kind ──────
const MEMORY_TYPE_META = {
  future_path: { label: 'Goal', Icon: Target, fg: '#1F5FCB', bg: '#EAF1FE' },
  goal: { label: 'Goal', Icon: Target, fg: '#1F5FCB', bg: '#EAF1FE' },
  goals: { label: 'Goal', Icon: Target, fg: '#1F5FCB', bg: '#EAF1FE' },
  insight: { label: 'Insight', Icon: Lightbulb, fg: '#A15E00', bg: '#FDF3E2' },
  preference: { label: 'Preference', Icon: Heart, fg: '#B33A73', bg: '#FBEAF1' },
  preferences: { label: 'Preference', Icon: Heart, fg: '#B33A73', bg: '#FBEAF1' },
  personal: { label: 'About you', Icon: User, fg: '#5B45D6', bg: '#F0EDFC' },
  profile: { label: 'About you', Icon: User, fg: '#5B45D6', bg: '#F0EDFC' },
  work: { label: 'Work', Icon: BriefcaseBusiness, fg: '#0E7C74', bg: '#E6F5F3' },
  education: { label: 'Learning', Icon: GraduationCap, fg: '#187A4A', bg: '#E7F6EC' },
  family: { label: 'Family', Icon: Users, fg: '#C13E6A', bg: '#FBEAF0' },
  health: { label: 'Health', Icon: Activity, fg: '#1E8A4C', bg: '#E7F6EC' },
  hobbies: { label: 'Hobby', Icon: Palette, fg: '#C1621B', bg: '#FCEEE2' },
  finance: { label: 'Finance', Icon: DollarSign, fg: '#6B3FA0', bg: '#F1EAF9' },
  projects: { label: 'Project', Icon: Wrench, fg: '#1C6E93', bg: '#E6F2F7' },
  emotions: { label: 'Mood', Icon: Heart, fg: '#B4471E', bg: '#FCEEE6' },
  location: { label: 'Location', Icon: MapPin, fg: '#12805A', bg: '#E6F6EF' },
  general: { label: 'Memory', Icon: Brain, fg: '#4A4D63', bg: '#EEEEF3' },
};

const getMemoryTypeMeta = (tag) => MEMORY_TYPE_META[(tag || '').toLowerCase()] || MEMORY_TYPE_META.general;

// Cap how much raw text a card is allowed to show. LifeOS content comes
// straight from saved chat context and can run to paragraphs — cards should
// read like short highlights, not reprint the source text.
function trimText(text, max = 140) {
  if (!text) return '';
  const clean = String(text).trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 40 ? lastSpace : max)}…`;
}

function parseMemoryEntry(memory) {
  let raw = (memory?.content || '').trim();

  const bracketMatch = raw.match(/^\[(\w+)\]\s*/);
  const bracketTag = bracketMatch ? bracketMatch[1].toLowerCase() : null;
  if (bracketMatch) raw = raw.slice(bracketMatch[0].length);

  const mainText = raw.split('|')[0].trim();

  const rawCategory = (memory?.category || '').toLowerCase();
  const isPending = rawCategory.startsWith('pending_');
  const categoryTag = isPending ? rawCategory.slice(8) : rawCategory;
  const tag = bracketTag || categoryTag || 'general';

  let title = null;
  let description = mainText;
  const colonIdx = mainText.indexOf(':');
  if (colonIdx > 0 && colonIdx < 60) {
    title = mainText.slice(0, colonIdx).trim();
    description = mainText.slice(colonIdx + 1).trim();
  }
  if (!description) description = mainText || 'Untitled memory';

  return { tag, title, description: trimText(description, 160) };
}

function MemBadge({ tag }) {
  const meta = getMemoryTypeMeta(tag);
  const Icon = meta.Icon;
  return (
    <span style={{ ...styles.memBadge, background: meta.bg, color: meta.fg }}>
      <Icon size={12} />
      {meta.label}
    </span>
  );
}

// Small "i" info icon with a native tooltip. Product vocabulary (Context
// readiness, Agent plan, etc.) stays on screen, but a plain-language
// explanation is one hover/tap away instead of extra permanent copy.
function InfoTip({ text }) {
  if (!text) return null;
  return (
    <span title={text} style={styles.infoTip}>
      <Info size={13} />
    </span>
  );
}

const TABS = [
  { id: 'today', label: 'Today', icon: LayoutDashboard },
  { id: 'lifeos', label: 'Life OS', icon: Sparkles },
  { id: 'workspaces', label: 'Workspaces', icon: BriefcaseBusiness },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'goals', label: 'Goals', icon: Target },
  { id: 'build', label: 'Build', icon: Zap },
];

const WORKSPACE_TEMPLATES = [
  { id: 'company', name: 'Company', description: 'Strategy, product decisions, hiring, and investor context.', accent: '#14b8a6' },
  { id: 'clients', name: 'Clients', description: 'Project notes, deliverables, follow-ups, and reusable context.', accent: '#6366f1' },
  { id: 'research', name: 'Research', description: 'Files, findings, decisions, and ideas that need continuity.', accent: '#f59e0b' },
  { id: 'personal', name: 'Personal', description: 'Goals, routines, preferences, and life admin.', accent: '#ef4444' },
];

const emptyArray = [];

function Dashboard({ userId, userName = 'User', onLogout, onGoToChat }) {
  const [activeTab, setActiveTab] = useState('today');
  const [sidebarOpen, setSidebarOpen] = useState(window.innerWidth > 860);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 860);
  const [memories, setMemories] = useState([]);
  const [goals, setGoals] = useState([]);
  const [projects, setProjects] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [githubStatus, setGithubStatus] = useState(null);
  const [commandCenter, setCommandCenter] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const displayName = userName?.split('@')[0] || 'there';

  useEffect(() => {
    const onResize = () => {
      const mobile = window.innerWidth <= 860;
      setIsMobile(mobile);
      setSidebarOpen(!mobile);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const loadWorkspaceData = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    const safeJson = async (url) => {
      try {
        const res = await authFetch(url);
        return await res.json();
      } catch {
        return null;
      }
    };

    const [memoryData, goalData, projectData, notifData, ghData, commandData] = await Promise.all([
      safeJson(`${API_BASE}/api/memory/${userId}`),
      safeJson(`${API_BASE}/api/goals/${userId}`),
      safeJson(`${API_BASE}/api/multifile/${userId}/projects`),
      safeJson(`${API_BASE}/api/notifications/${userId}`),
      safeJson(`${API_BASE}/api/github/status/${userId}`),
      safeJson(`${API_BASE}/api/command-center/${userId}`),
    ]);

    setMemories(memoryData?.memories || emptyArray);
    setGoals(goalData?.goals || emptyArray);
    setProjects(projectData?.projects || emptyArray);
    setNotifications(notifData?.notifications || emptyArray);
    setGithubStatus(ghData || null);
    setCommandCenter(commandData?.success ? commandData : null);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    loadWorkspaceData();
  }, [loadWorkspaceData]);

  const activeGoals = useMemo(() => goals.filter(g => g.status !== 'completed'), [goals]);
  const completedGoals = useMemo(() => goals.filter(g => g.status === 'completed'), [goals]);
  const decisions = useMemo(() => {
    return memories.filter(m => {
      const content = `${m.category || ''} ${m.content || ''}`.toLowerCase();
      return content.includes('decision') || content.includes('decided') || content.includes('chose') || content.includes('plan');
    }).slice(0, 6);
  }, [memories]);

  const filteredMemories = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return memories.slice(0, 18);
    return memories.filter(m => `${m.category} ${m.content}`.toLowerCase().includes(q)).slice(0, 18);
  }, [memories, search]);

  const memoryCategories = useMemo(() => {
    const counts = {};
    memories.forEach(memory => {
      counts[memory.category || 'general'] = (counts[memory.category || 'general'] || 0) + 1;
    });
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
  }, [memories]);

  const nextActions = useMemo(() => {
    if (commandCenter?.priorities?.length) {
      return commandCenter.priorities.map(priority => priority.action).slice(0, 4);
    }

    const actions = [];
    if (activeGoals[0]) actions.push(`Move "${activeGoals[0].title}" forward today.`);
    if (projects[0]) actions.push(`Review the latest project: ${projects[0].project_name}.`);
    if (decisions[0]) actions.push('Turn one recent decision into a concrete next step.');
    if (notifications[0]) actions.push(notifications[0].message || 'Check your latest reminder.');
    actions.push('Capture one important decision so MCIS can remember the why.');
    return actions.slice(0, 4);
  }, [activeGoals, commandCenter, decisions, notifications, projects]);

  const connectGitHub = async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/github/connect/${userId}`);
      const data = await res.json();
      if (data.url) window.location.href = data.url;
    } catch {
      alert('GitHub connection failed. Please try again.');
    }
  };

  const deleteMemory = async (memoryId) => {
    try {
      await authFetch(`${API_BASE}/api/memory/${memoryId}`, { method: 'DELETE' });
      setMemories(prev => prev.filter(m => m.id !== memoryId));
    } catch {
      alert('Could not delete this memory.');
    }
  };

  const navClick = (tabId) => {
    setActiveTab(tabId);
    if (isMobile) setSidebarOpen(false);
  };

  return (
    <div className="mcis-dashboard-shell" style={styles.shell}>
      {isMobile && sidebarOpen && <div style={styles.backdrop} onClick={() => setSidebarOpen(false)} />}

      <aside className="mcis-dash-sidebar" style={{
        ...styles.sidebar,
        width: sidebarOpen ? 280 : 86,
        transform: isMobile && !sidebarOpen ? 'translateX(-105%)' : 'translateX(0)',
        position: isMobile ? 'fixed' : 'relative',
        top: 0,
        left: 0,
        height: '100dvh',
      }}>
        <div style={styles.brand}>
          <div style={styles.logoMark} className="mcis-brand-mark">M</div>
          {sidebarOpen && (
            <div>
              <div className="mcis-gradient-text" style={styles.brandName}>MCIS</div>
              <div style={styles.brandSub}>AI workspace with memory</div>
            </div>
          )}
        </div>

        <div style={styles.nav}>
          {TABS.map(tab => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button key={tab.id} className="mcis-dash-navbtn" style={{ ...styles.navButton, ...(active ? styles.navButtonActive : {}) }} onClick={() => navClick(tab.id)} title={tab.label}>
                <Icon size={19} />
                {sidebarOpen && <span>{tab.label}</span>}
              </button>
            );
          })}
        </div>

        {sidebarOpen && (
          <div style={styles.memoryHealth}>
            <div style={styles.healthHeader}>
              <ShieldCheck size={16} />
              Memory health
              <InfoTip text="How much MCIS currently remembers about you. More memories and active goals means better, more personal answers." />
            </div>
            <div style={styles.healthMetric}>
              <span>{memories.length} memories</span>
              <strong>{activeGoals.length} active goals</strong>
            </div>
            <div style={styles.healthBar}>
              <div style={{ ...styles.healthFill, width: `${Math.min(100, Math.max(18, memories.length * 3))}%` }} />
            </div>
          </div>
        )}

        <div style={styles.sidebarFooter}>
          {sidebarOpen && (
            <div style={styles.userBox}>
              <span>Signed in as</span>
              <strong>{userName}</strong>
            </div>
          )}
          <button style={styles.logoutBtn} onClick={onLogout} title="Logout">
            <LogOut size={16} />
            {sidebarOpen && 'Logout'}
          </button>
        </div>
      </aside>

      <main className="mcis-dash-main" style={styles.main}>
        <header className="mcis-dash-topbar" style={styles.topbar}>
          <button style={styles.iconButton} onClick={() => setSidebarOpen(prev => !prev)} title="Toggle navigation">
            <ChevronLeft size={18} style={{ transform: sidebarOpen ? 'rotate(0deg)' : 'rotate(180deg)' }} />
          </button>
          <div style={styles.topbarTitle}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Welcome back, {displayName}</span>
            {!isMobile && <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Remember everything. Continue anything.</strong>}
          </div>
          <div style={styles.topbarActions}>
            <button style={styles.secondaryAction} onClick={() => onGoToChat()}>
              <MessageSquareText size={16} />
              {!isMobile && 'Chat'}
            </button>
            {githubStatus?.connected ? (
              <a style={styles.githubConnected} href={`https://github.com/${githubStatus.username}`} target="_blank" rel="noreferrer">
                <GitBranch size={16} />
                {!isMobile && `@${githubStatus.username}`}
              </a>
            ) : (
              <button style={styles.secondaryAction} onClick={connectGitHub}>
                <GitBranch size={16} />
                {!isMobile && 'Connect GitHub'}
              </button>
            )}
          </div>
        </header>

        <section style={styles.content}>
          {activeTab === 'today' && (
            <TodayView
              loading={loading}
              activeGoals={activeGoals}
              completedGoals={completedGoals}
              memories={memories}
              projects={projects}
              decisions={decisions}
              nextActions={nextActions}
              commandCenter={commandCenter}
              onGoToChat={onGoToChat}
              setActiveTab={setActiveTab}
              isMobile={isMobile}
            />
          )}

          {activeTab === 'workspaces' && (
            <WorkspacesView projects={projects} memories={memories} onGoToChat={onGoToChat} isMobile={isMobile} />
          )}

          {activeTab === 'lifeos' && (
            <LifeOSView
              userId={userId}
              commandCenter={commandCenter}
              memories={memories}
              goals={activeGoals}
              projects={projects}
              onGoToChat={onGoToChat}
              isMobile={isMobile}
              reload={loadWorkspaceData}
            />
          )}

          {activeTab === 'memory' && (
            <MemoryView
              memories={filteredMemories}
              totalMemories={memories.length}
              categories={memoryCategories}
              decisions={decisions}
              search={search}
              setSearch={setSearch}
              onDelete={deleteMemory}
              isMobile={isMobile}
            />
          )}

          {activeTab === 'goals' && (
            <GoalsView goals={goals} loadWorkspaceData={loadWorkspaceData} userId={userId} isMobile={isMobile} />
          )}

          {activeTab === 'build' && (
            <div style={styles.builderWrap}>
              <div style={styles.sectionHeader}>
                <span>Build workspace</span>
                <strong>Generate projects, review files, and push when ready.</strong>
              </div>
              <SandboxExecutor userId={userId} />
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function TodayView({ loading, activeGoals, memories, projects, decisions, nextActions, commandCenter, onGoToChat, setActiveTab, isMobile }) {
  if (loading) {
    return <div style={styles.loadingCard}>Preparing your workspace...</div>;
  }

  const stats = commandCenter?.stats || {};
  const contextScore = commandCenter?.brief?.contextScore || Math.min(100, Math.max(12, memories.length * 3));

  return (
    <>
      <div className="mcis-dash-hero" style={{ ...styles.hero, gridTemplateColumns: isMobile ? '1fr' : styles.hero.gridTemplateColumns }}>
        <div style={styles.heroCopy}>
          <div style={styles.kicker}>
            <Sparkles size={15} />
            Today
          </div>
          <h1 style={styles.heroTitle}>{commandCenter?.brief?.headline || 'Your work, picked up where you left off.'}</h1>
          <p style={styles.heroText}>
            {commandCenter?.brief?.summary || 'MCIS keeps track of your projects, goals, and decisions so you don\u2019t have to re-explain yourself every time.'}
          </p>
          <div style={styles.heroActions}>
            <button style={styles.primaryAction} onClick={() => onGoToChat()}>
              Continue in chat
              <ArrowRight size={16} />
            </button>
            <button style={styles.secondaryActionLight} onClick={() => setActiveTab('memory')}>
              Review memory
              <Brain size={16} />
            </button>
          </div>
        </div>
        <div style={styles.contextPanel}>
          <div style={styles.contextLabel}>
            Context readiness
            <InfoTip text="How much MCIS knows about your current work. The higher this is, the more useful its answers are." />
          </div>
          <div style={styles.readinessDial}>
            <Gauge size={18} />
            <strong>{contextScore}%</strong>
            <span>ready to help</span>
          </div>
          <div style={styles.contextGrid}>
            <Metric label="Memories" value={stats.memories ?? memories.length} />
            <Metric label="Active goals" value={stats.activeGoals ?? activeGoals.length} />
            <Metric label="Projects" value={stats.projects ?? projects.length} />
            <Metric label="Decisions" value={stats.decisions ?? decisions.length} />
          </div>
        </div>
      </div>

      <div style={{ ...styles.gridTwo, gridTemplateColumns: isMobile ? '1fr' : styles.gridTwo.gridTemplateColumns }}>
        <Panel title="Priorities" subtitle="What MCIS thinks you should do next" icon={CalendarCheck}>
          {commandCenter?.priorities?.length ? (
            <div style={styles.priorityList}>
              {commandCenter.priorities.map(priority => (
                <div key={priority.id} style={styles.priorityItem}>
                  <div style={styles.priorityTop}>
                    <span style={{ ...styles.urgencyPill, ...urgencyStyle(priority.urgency) }}>{priority.urgency}</span>
                    {priority.dueLabel && <small>{priority.dueLabel}</small>}
                  </div>
                  <strong>{priority.title}</strong>
                  <p className="mcis-clamp-2">{trimText(priority.action, 130)}</p>
                </div>
              ))}
            </div>
          ) : (
            <div style={styles.actionList}>
              {nextActions.map((action, index) => (
                <div key={index} style={styles.actionItem}>
                  <CheckCircle2 size={16} />
                  <span className="mcis-clamp-2">{trimText(action, 130)}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Watch out for" subtitle="Where MCIS needs more context or attention" icon={AlertTriangle}>
          {commandCenter?.risks?.length ? commandCenter.risks.map(risk => (
            <div key={risk.title} style={styles.riskRow}>
              <strong>{risk.title}</strong>
              <p className="mcis-clamp-2">{trimText(risk.detail, 130)}</p>
            </div>
          )) : null}
          {commandCenter?.contextGaps?.length ? commandCenter.contextGaps.map(gap => (
            <div key={gap.title} style={styles.gapRow}>
              <strong>{gap.title}</strong>
              <p className="mcis-clamp-2">{trimText(gap.action, 130)}</p>
            </div>
          )) : null}
          {!commandCenter?.risks?.length && !commandCenter?.contextGaps?.length && (
            <EmptyState text="Nothing urgent right now. Keep adding goals and decisions so MCIS stays useful." />
          )}
        </Panel>
      </div>

      <div style={{ ...styles.gridTwo, gridTemplateColumns: isMobile ? '1fr' : styles.gridTwo.gridTemplateColumns }}>
        <Panel title="Recent decisions" subtitle="The reasoning behind your work, saved for later" icon={BookOpen}>
          {(commandCenter?.recentDecisions?.length ? commandCenter.recentDecisions : decisions).length ? (commandCenter?.recentDecisions?.length ? commandCenter.recentDecisions : decisions.slice(0, 4)).map(memory => {
            const parsed = parseMemoryEntry(memory);
            return (
              <div key={memory.id} style={styles.compactMemory}>
                <MemBadge tag={parsed.tag} />
                {parsed.title && <strong style={styles.compactMemoryTitle}>{parsed.title}</strong>}
                <p className="mcis-clamp-2">{parsed.description}</p>
              </div>
            );
          }) : (
            <EmptyState text="No decisions saved yet. Tell MCIS when you choose a direction, pricing, stack, or plan." />
          )}
        </Panel>

        <Panel title="Quick actions" subtitle="Jump straight into the most common next steps" icon={Zap}>
          <div style={styles.actionList}>
            <button style={styles.executionButton} onClick={() => setActiveTab('goals')}>
              <Target size={16} />
              Create or update a goal
            </button>
            <button style={styles.executionButton} onClick={() => setActiveTab('memory')}>
              <Brain size={16} />
              Review what MCIS remembers
            </button>
            <button style={styles.executionButton} onClick={() => onGoToChat()}>
              <MessageSquareText size={16} />
              Turn today&apos;s brief into a plan
            </button>
          </div>
        </Panel>
      </div>
    </>
  );
}

function urgencyStyle(urgency) {
  if (urgency === 'overdue' || urgency === 'critical') return styles.urgencyCritical;
  if (urgency === 'high') return styles.urgencyHigh;
  if (urgency === 'medium') return styles.urgencyMedium;
  return styles.urgencyNormal;
}

function LifeOSView({ userId, commandCenter, memories, goals, projects, onGoToChat, isMobile, reload }) {
  const lifeOS = commandCenter?.lifeOS || {};
  const decisions = lifeOS.decisions || [];
  const nextActions = lifeOS.nextActions || [];
  const futurePaths = lifeOS.futurePaths || [];
  const insights = lifeOS.insights || [];
  const pendingReview = lifeOS.pendingReview || [];
  const stats = commandCenter?.stats || {};
  const [simDecision, setSimDecision] = useState('');
  const [simulating, setSimulating] = useState(false);
  const [simulation, setSimulation] = useState(null);
  const [actingId, setActingId] = useState(null);
  const [planning, setPlanning] = useState(false);
  const [agentPlan, setAgentPlan] = useState(null);

  const reviewItem = async (item, action) => {
    setActingId(item.id);
    try {
      await authFetch(`${API_BASE}/api/command-center/${userId}/items/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      await reload();
    } catch {
      alert(`Could not ${action} this item.`);
    }
    setActingId(null);
  };

  const createGoalFromItem = async (item) => {
    setActingId(item.id);
    try {
      await authFetch(`${API_BASE}/api/goals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          title: item.content.slice(0, 120),
          description: item.content,
          category: item.category || 'life-os',
        }),
      });
      await reload();
    } catch {
      alert('Could not create a goal from this item.');
    }
    setActingId(null);
  };

  const createGoalFromText = async (title, description = '') => {
    setActingId('agent-plan-goal');
    try {
      await authFetch(`${API_BASE}/api/goals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          title: title.slice(0, 120),
          description: description || title,
          category: 'agent-workspace',
        }),
      });
      await reload();
    } catch {
      alert('Could not add this agent task to goals.');
    }
    setActingId(null);
  };

  const createAgentPlanForItem = async (item) => {
    setPlanning(true);
    setAgentPlan(null);
    try {
      const res = await authFetch(`${API_BASE}/api/command-center/${userId}/agent-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task: item.content,
          context: {
            category: item.category,
            goals: goals.slice(0, 5).map(goal => goal.title),
            projects: projects.slice(0, 5).map(project => project.project_name || project.name),
            decisions: decisions.slice(0, 5).map(decision => decision.content),
          },
        }),
      });
      const data = await res.json();
      if (data.success) setAgentPlan(data);
    } catch {
      alert('Could not create an agent plan.');
    }
    setPlanning(false);
  };

  const startAgentPlanInChat = (plan) => {
    onGoToChat(plan.chatPrompt || `Run this MCIS agent plan: ${plan.objective}`);
  };

  const runSimulation = async () => {
    const decision = simDecision.trim() || decisions[0]?.content || futurePaths[0]?.content || '';
    if (!decision) return;
    setSimulating(true);
    try {
      const res = await authFetch(`${API_BASE}/api/command-center/${userId}/simulate-lite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          context: {
            goals: goals.slice(0, 5).map(goal => goal.title),
            decisions: decisions.slice(0, 5).map(item => item.content),
            projects: projects.slice(0, 5).map(project => project.project_name || project.name),
          },
        }),
      });
      const data = await res.json();
      if (data.success) setSimulation(data);
    } catch {
      alert('Could not simulate this decision.');
    }
    setSimulating(false);
  };

  return (
    <>
      <div style={styles.sectionHeader}>
        <span>Life OS</span>
        <strong>Your conversations, turned into decisions, next actions, and paths worth considering.</strong>
      </div>

      <div className="mcis-dash-hero" style={{ ...styles.lifeOSHero, gridTemplateColumns: isMobile ? '1fr' : styles.lifeOSHero.gridTemplateColumns }}>
        <div>
          <div style={styles.kicker}>
            <Sparkles size={15} />
            Life OS
          </div>
          <h1 style={styles.lifeOSTitle}>More than chat history. A running record of what matters.</h1>
          <p style={styles.lifeOSText}>
            MCIS turns useful conversations into things you can act on: what you decided, what to do next, and which
            direction is worth exploring.
          </p>
          <div style={styles.heroActions}>
            <button style={styles.primaryAction} onClick={() => onGoToChat()}>
              Add context in chat
              <ArrowRight size={16} />
            </button>
          </div>
        </div>
        <div style={styles.lifeOSStats}>
          <Metric label="Saved items" value={stats.operatingItems || 0} />
          <Metric label="Decisions" value={stats.decisions || decisions.length} />
          <Metric label="Future paths" value={stats.futurePaths || futurePaths.length} />
          <Metric label="Pending review" value={stats.pendingReview || pendingReview.length} />
        </div>
      </div>

      <Panel
        title="Review queue"
        subtitle="Approve what MCIS should remember long-term"
        icon={ShieldCheck}
        tip="MCIS suggests things worth remembering from your chats. Nothing becomes permanent context until you approve it here."
      >
        {pendingReview.length ? (
          <div style={styles.reviewQueue}>
            {pendingReview.map(item => (
              <div key={item.id} className="mcis-dash-card" style={styles.reviewItem}>
                <div style={{ minWidth: 0 }}>
                  <span>{item.category}</span>
                  <p className="mcis-clamp-2">{trimText(item.content, 140)}</p>
                </div>
                <div style={styles.reviewActions}>
                  <button style={styles.approveButton} disabled={actingId === item.id} onClick={() => reviewItem(item, 'approve')}>Approve</button>
                  <button style={styles.rejectButton} disabled={actingId === item.id} onClick={() => reviewItem(item, 'reject')}>Reject</button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState text="Nothing waiting for review. New strategic chats will show up here first." />
        )}
      </Panel>

      <div style={{ ...styles.operatingRail, gridTemplateColumns: isMobile ? '1fr' : styles.operatingRail.gridTemplateColumns }}>
        <OperatingColumn
          title="Decisions"
          subtitle="The reasoning behind your direction"
          icon={BookOpen}
          items={decisions}
          empty="No decisions saved yet."
        />
        <OperatingColumn
          title="Next actions"
          subtitle="Conversations turned into things to do"
          icon={CheckCircle2}
          items={nextActions}
          empty="No next actions saved yet."
          renderActions={(item) => (
            <>
              <button style={styles.miniActionButton} disabled={actingId === item.id} onClick={() => createGoalFromItem(item)}>Create goal</button>
              <button style={styles.miniActionButton} disabled={planning} onClick={() => createAgentPlanForItem(item)}>Agent plan</button>
              <button style={styles.miniActionButton} onClick={() => onGoToChat(`Help me execute this Life OS action: ${item.content}`)}>Start in chat</button>
            </>
          )}
        />
        <OperatingColumn
          title="Future paths"
          subtitle="Options worth thinking through before committing"
          icon={GitBranch}
          items={futurePaths}
          empty="No future paths saved yet."
          renderActions={(item) => (
            <>
              <button style={styles.miniActionButton} onClick={() => { setSimDecision(item.content); setSimulation(null); }}>Load simulator</button>
              <button style={styles.miniActionButton} disabled={planning} onClick={() => createAgentPlanForItem(item)}>Agent plan</button>
            </>
          )}
        />
      </div>

      {(planning || agentPlan) && (
        <Panel
          title="Agent plan"
          subtitle="A step-by-step plan MCIS can help you execute"
          icon={Zap}
          tip="MCIS breaks a task into concrete steps with tools, success criteria, and risks \u2014 like a project brief you can hand off."
        >
          {planning && <div style={styles.loadingCard}>Creating your plan...</div>}
          {agentPlan && !planning && (
            <div style={styles.agentPlanBox}>
              <div style={styles.agentPlanTop}>
                <div>
                  <span>{agentPlan.mode || 'execution'} · {agentPlan.estimatedMinutes || 45} min</span>
                  <h3>{agentPlan.objective}</h3>
                </div>
                <div style={styles.reviewActions}>
                  <button style={styles.approveButton} onClick={() => startAgentPlanInChat(agentPlan)}>Start in chat</button>
                  <button style={styles.rejectButton} disabled={actingId === 'agent-plan-goal'} onClick={() => createGoalFromText(agentPlan.todayTask, agentPlan.objective)}>Execute today</button>
                </div>
              </div>

              <div style={styles.agentStepGrid}>
                {agentPlan.steps?.map((step, index) => (
                  <div key={step.id || step.title || index} className="mcis-dash-card" style={styles.agentStep}>
                    <span>Step {index + 1}</span>
                    <strong className="mcis-clamp-2">{step.title}</strong>
                    <p className="mcis-clamp-3">{trimText(step.detail, 150)}</p>
                    {step.output && <small className="mcis-clamp-2">Output: {trimText(step.output, 90)}</small>}
                  </div>
                ))}
              </div>

              <div style={styles.agentMetaGrid}>
                <div>
                  <strong>Tools</strong>
                  <p className="mcis-clamp-2">{agentPlan.tools?.join(', ') || 'Life OS, chat, goals'}</p>
                </div>
                <div>
                  <strong>Success criteria</strong>
                  <p className="mcis-clamp-2">{trimText(agentPlan.successCriteria?.join(' · '), 130) || 'Visible output, verification, learning saved.'}</p>
                </div>
                <div>
                  <strong>Risks</strong>
                  <p className="mcis-clamp-2">{trimText(agentPlan.risks?.join(' · '), 130) || 'Keep scope small and verify before saving learning.'}</p>
                </div>
              </div>
            </div>
          )}
        </Panel>
      )}

      <div style={{ ...styles.gridTwo, gridTemplateColumns: isMobile ? '1fr' : styles.gridTwo.gridTemplateColumns }}>
        <Panel title="Future simulator" subtitle="Compare paths before you commit time to one" icon={GitBranch}>
          <div style={styles.simulatorBox}>
            <textarea
              style={styles.simulatorInput}
              value={simDecision}
              onChange={e => setSimDecision(e.target.value)}
              placeholder="Paste a decision or future path to compare..."
              rows={4}
            />
            <button style={styles.simulatorButton} onClick={runSimulation} disabled={simulating || (!simDecision.trim() && !decisions.length && !futurePaths.length)}>
              {simulating ? 'Comparing...' : 'Compare paths'}
            </button>
          </div>
          {simulation?.paths?.length ? (
            <div style={styles.simulationResults}>
              <div style={styles.recommendationBox}>
                <strong>Recommended: {simulation.recommendation.name}</strong>
                <p className="mcis-clamp-2">{trimText(simulation.recommendation.nextStep, 130)}</p>
              </div>
              {simulation.paths.map(path => (
                <div key={path.name} className="mcis-dash-card" style={styles.pathCard}>
                  <div style={styles.pathTop}>
                    <strong>{path.name}</strong>
                    <span>{Math.round(path.successProbability * 100)}%</span>
                  </div>
                  <p className="mcis-clamp-2">{trimText(path.upside, 120)}</p>
                  <small>Risk: {path.riskLevel} · Signal in {path.timeToSignalDays} days</small>
                </div>
              ))}
            </div>
          ) : null}
        </Panel>

        <Panel title="Product intelligence" subtitle="Patterns MCIS noticed in your direction" icon={Brain}>
          {insights.length ? insights.map(item => {
            const parsed = parseMemoryEntry(item);
            return (
              <div key={item.id} style={styles.compactMemory}>
                <MemBadge tag={parsed.tag} />
                {parsed.title && <strong style={styles.compactMemoryTitle}>{parsed.title}</strong>}
                <p className="mcis-clamp-2">{parsed.description}</p>
              </div>
            );
          }) : (
            <EmptyState text="No insights yet. Discuss strategy, tradeoffs, or positioning with MCIS." />
          )}
        </Panel>
      </div>
    </>
  );
}

function OperatingColumn({ title, subtitle, icon: Icon, items, empty, renderActions }) {
  return (
    <section className="mcis-dash-card" style={styles.operatingColumn}>
      <div style={styles.panelHeader}>
        <div style={styles.panelIcon}><Icon size={17} /></div>
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
      </div>
      <div style={styles.operatingItems}>
        {items.length ? items.map(item => (
          <div key={item.id} style={styles.operatingItem}>
            <span>{item.category}</span>
            <p className="mcis-clamp-2">{trimText(item.content, 120)}</p>
            {renderActions && <div style={styles.itemActions}>{renderActions(item)}</div>}
          </div>
        )) : (
          <EmptyState text={empty} />
        )}
      </div>
    </section>
  );
}

function WorkspacesView({ projects, memories, onGoToChat, isMobile }) {
  const [previewProject, setPreviewProject] = useState(null);

  return (
    <>
      <div style={styles.sectionHeader}>
        <span>Workspaces</span>
        <strong>Separate contexts for the different parts of your work.</strong>
      </div>
      <div style={styles.workspaceGrid}>
        {WORKSPACE_TEMPLATES.map(template => {
          const relatedMemories = memories.filter(m => `${m.content} ${m.category}`.toLowerCase().includes(template.id)).length;
          return (
            <div key={template.id} style={{ ...styles.workspaceCard, borderTopColor: template.accent }}>
              <div style={{ ...styles.workspaceIcon, background: `${template.accent}22`, color: template.accent }}>
                <BriefcaseBusiness size={20} />
              </div>
              <h3>{template.name}</h3>
              <p>{template.description}</p>
              <div style={styles.workspaceMeta}>
                <span>{relatedMemories} related memories</span>
                <button onClick={() => onGoToChat()}>Open chat</button>
              </div>
            </div>
          );
        })}
      </div>

      <Panel title="Recent generated projects" subtitle="Projects MCIS has helped create" icon={Zap}>
        {projects.length ? projects.slice(0, 6).map(project => (
          <div key={project.id || project.project_name} style={styles.projectRow}>
            <div style={styles.projectInfo}>
              <strong>{project.project_name}</strong>
              <span>{project.description || project.goal}</span>
            </div>
            <div style={styles.projectActions}>
              <button style={styles.previewButton} onClick={() => setPreviewProject(project)}>
                <Eye size={15} />
                Preview
              </button>
              {project.repo_url && (
                <a style={styles.projectLink} href={project.repo_url} target="_blank" rel="noreferrer">
                  GitHub
                </a>
              )}
            </div>
          </div>
        )) : (
          <EmptyState text="No generated projects yet. Use Build to create a complete project workspace." />
        )}
      </Panel>

      {previewProject && (
        <ProjectPreviewModal
          project={previewProject}
          onClose={() => setPreviewProject(null)}
          onGoToChat={onGoToChat}
          isMobile={isMobile}
        />
      )}
    </>
  );
}

function buildPreviewHTML(files = []) {
  if (!files?.length) return null;

  const paths = files.map(f => f.path?.toLowerCase() || '');
  const hasHTML = paths.some(p => p.endsWith('.html') || p.endsWith('.htm'));
  const hasCSS  = paths.some(p => p.endsWith('.css'));
  const hasJS   = paths.some(p => p.endsWith('.js') && !p.includes('node_modules') && !p.includes('package'));

  if (!hasHTML && !hasCSS && !hasJS) return null;

  const htmlFile = files.find(f => f.path?.toLowerCase().endsWith('.html') || f.path?.toLowerCase().endsWith('.htm'));
  const cssFiles = files.filter(f => f.path?.toLowerCase().endsWith('.css'));
  const jsFiles  = files.filter(f =>
    f.path?.toLowerCase().endsWith('.js') &&
    !f.path?.toLowerCase().includes('node_modules') &&
    !f.path?.toLowerCase().includes('package')
  );

  if (htmlFile) {
    let html = htmlFile.content || '';
    cssFiles.forEach(css => {
      html = html.includes('</head>')
        ? html.replace('</head>', `<style>${css.content}</style></head>`)
        : `<style>${css.content}</style>${html}`;
    });
    jsFiles.forEach(js => {
      const safe = (js.content || '')
        .replace(/import\s+.*?from\s+['"].*?['"]/g, '// import removed for preview')
        .replace(/export\s+default\s+/g, '')
        .replace(/export\s+/g, '');
      html = html.includes('</body>')
        ? html.replace('</body>', `<script>${safe}<\/script></body>`)
        : `${html}<script>${safe}<\/script>`;
    });
    return html;
  }

  const cssContent = cssFiles.map(f => f.content || '').join('\n');
  const jsContent  = jsFiles.map(f =>
    (f.content || '')
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
    body { margin: 0; padding: 20px; font-family: system-ui, sans-serif; background: #f9fafb; }
    ${cssContent}
  </style>
</head>
<body>
  <div id="root"></div>
  <div id="app"></div>
  <script>
    ${jsContent}
  <\/script>
</body>
</html>`;
}

const IconX         = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>;
const IconEye       = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>;
const IconCode      = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>;
const IconExternal  = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>;

function ProjectPreviewModal({ project, onClose, onGoToChat, isMobile }) {
  const [tab, setTab] = React.useState('preview');
  const [activeFile, setActiveFile] = React.useState(null);
  const iframeRef = React.useRef(null);

  const files       = project.files || [];
  const previewHTML = React.useMemo(() => buildPreviewHTML(files), [files]);
  const canPreview  = !!previewHTML;

  React.useEffect(() => {
    if (files.length && !activeFile) setActiveFile(files[0]);
  }, [files]);

  React.useEffect(() => {
    if (tab === 'preview' && canPreview && iframeRef.current) {
      const blob = new Blob([previewHTML], { type: 'text/html' });
      const url  = URL.createObjectURL(blob);
      iframeRef.current.src = url;
      return () => URL.revokeObjectURL(url);
    }
  }, [tab, previewHTML, canPreview]);

  const createdAt  = project.created_at ? new Date(project.created_at).toLocaleDateString() : 'Recently';
  const previewUrl = project.codespaces_url || project.vs_code_url || project.repo_url;

  return (
    <div style={modal.backdrop} onClick={onClose}>
      <div style={modal.sheet} onClick={e => e.stopPropagation()}>

        <div style={modal.header}>
          <div style={modal.headerLeft}>
            <div style={modal.kicker}>
              <IconEye /> Project preview
            </div>
            <h2 style={modal.title}>{project.project_name || 'Generated project'}</h2>
            <p style={modal.desc}>{project.description || project.goal || 'MCIS generated this project.'}</p>
          </div>
          <button style={modal.closeBtn} onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </div>

        <div style={modal.tabBar}>
          <button
            style={{ ...modal.tabBtn, ...(tab === 'preview' ? modal.tabBtnActive : {}) }}
            onClick={() => setTab('preview')}
          >
            <IconEye /> Preview
          </button>
          <button
            style={{ ...modal.tabBtn, ...(tab === 'files' ? modal.tabBtnActive : {}) }}
            onClick={() => setTab('files')}
          >
            <IconCode /> Files ({files.length})
          </button>
        </div>

        {tab === 'preview' && (
          <div style={modal.previewWrap}>
            {canPreview ? (
              <>
                <div style={modal.browserBar}>
                  <span style={modal.dot} />
                  <span style={{ ...modal.dot, background: '#fbbf24' }} />
                  <span style={{ ...modal.dot, background: '#22c55e' }} />
                  <span style={modal.urlBar}>{project.project_name || 'preview'}.app</span>
                </div>
                <iframe
                  ref={iframeRef}
                  title="preview"
                  sandbox="allow-scripts allow-same-origin"
                  style={{ ...modal.iframe, minHeight: isMobile ? 220 : 320 }}
                />
              </>
            ) : (
              <div style={modal.noPreview}>
                <div style={modal.noPreviewIcon}><IconCode /></div>
                <strong>Live preview not available</strong>
                <p>This project uses a framework that requires a build step (React, Next.js, Python, etc).<br/>Open in VS Code or Codespaces to run it.</p>
                <div style={modal.noPreviewActions}>
                  {project.vs_code_url    && <a href={project.vs_code_url}    style={modal.outlineLink}>💻 VS Code</a>}
                  {project.codespaces_url && <a href={project.codespaces_url} target="_blank" rel="noreferrer" style={modal.outlineLink}>☁️ Codespaces</a>}
                  {project.repo_url       && <a href={project.repo_url}       target="_blank" rel="noreferrer" style={modal.outlineLink}>🔗 GitHub</a>}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'files' && (
          <div style={modal.filesPanel}>
            {files.length ? (
              <>
                <div style={modal.fileList}>
                  {files.map((f, i) => (
                    <button
                      key={i}
                      style={{ ...modal.fileListItem, ...(activeFile?.path === f.path ? modal.fileListItemActive : {}) }}
                      onClick={() => setActiveFile(f)}
                    >
                      {f.path?.split('/').pop()}
                      <small style={modal.filePath}>{f.path}</small>
                    </button>
                  ))}
                </div>
                <pre style={modal.codeViewer}>
                  {activeFile?.content || ''}
                </pre>
              </>
            ) : (
              <div style={modal.noPreview}>
                <strong>No files saved</strong>
                <p>Files are only saved when you push to GitHub from the Execute tab. Generate a new project to see files here.</p>
              </div>
            )}
          </div>
        )}

        <div style={modal.footer}>
          <div style={modal.meta}>
            <span><strong>Stack</strong> {project.language || 'Project'}</span>
            <span><strong>Files</strong> {project.files_count ?? files.length}</span>
            <span><strong>Created</strong> {createdAt}</span>
          </div>
          <div style={modal.actions}>
            {previewUrl ? (
              <a style={modal.primaryAction} href={previewUrl} target={previewUrl.startsWith('http') ? '_blank' : undefined} rel="noreferrer">
                <IconExternal /> Open project
              </a>
            ) : (
              <button style={modal.primaryAction} onClick={() => { onClose(); onGoToChat?.(`Preview ${project.project_name}`); }}>
                <IconEye /> Ask MCIS
              </button>
            )}
            {project.repo_url       && <a style={modal.outlineLink} href={project.repo_url}       target="_blank" rel="noreferrer">GitHub</a>}
            {project.vs_code_url    && <a style={modal.outlineLink} href={project.vs_code_url}>VS Code</a>}
            {project.codespaces_url && <a style={modal.codespaceLink} href={project.codespaces_url} target="_blank" rel="noreferrer">Codespaces</a>}
          </div>
        </div>
      </div>
    </div>
  );
}

const modal = {
  backdrop:         { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'grid', placeItems: 'center', padding: '12px', zIndex: 1000, backdropFilter: 'blur(4px)' },
  sheet:            { width: 'min(820px, 100%)', maxHeight: 'calc(100dvh - 24px)', display: 'flex', flexDirection: 'column', background: 'var(--mcis-surface)', color: 'var(--mcis-text)', border: '1px solid var(--mcis-border)', borderRadius: 20, boxShadow: '0 32px 96px rgba(15,23,42,0.32)', overflow: 'hidden' },
  header:           { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', padding: '18px 18px 0', flexShrink: 0 },
  headerLeft:       { minWidth: 0 },
  kicker:           { display: 'flex', alignItems: 'center', gap: 7, color: 'var(--mcis-accent)', fontSize: 12, fontWeight: 800, marginBottom: 6 },
  title:            { margin: '0 0 4px', fontSize: 20, fontWeight: 800 },
  desc:             { margin: 0, color: 'var(--mcis-muted)', fontSize: 14, lineHeight: 1.5 },
  closeBtn:         { width: 36, height: 36, borderRadius: 10, border: '1px solid var(--mcis-border)', background: 'var(--mcis-subtle)', color: 'var(--mcis-text)', display: 'grid', placeItems: 'center', cursor: 'pointer', flexShrink: 0 },
  tabBar:           { display: 'flex', gap: 4, padding: '14px 18px 0', flexShrink: 0 },
  tabBtn:           { height: 36, borderRadius: 10, border: '1px solid var(--mcis-border)', background: 'var(--mcis-subtle)', color: 'var(--mcis-muted)', display: 'inline-flex', alignItems: 'center', gap: 7, padding: '0 14px', cursor: 'pointer', fontWeight: 700, fontSize: 13 },
  tabBtnActive:     { background: 'var(--mcis-primary)', color: '#fff', border: '1px solid transparent' },
  previewWrap:      { flex: 1, display: 'flex', flexDirection: 'column', margin: '12px 18px 0', border: '1px solid var(--mcis-border)', borderRadius: 14, overflow: 'hidden', minHeight: 0 },
  browserBar:       { height: 36, display: 'flex', alignItems: 'center', gap: 7, padding: '0 12px', background: 'var(--mcis-subtle)', borderBottom: '1px solid var(--mcis-border)', flexShrink: 0 },
  dot:              { width: 11, height: 11, borderRadius: 99, background: '#ef4444', display: 'inline-block' },
  urlBar:           { marginLeft: 10, fontSize: 12, color: 'var(--mcis-muted)', fontFamily: 'monospace' },
  iframe:           { flex: 1, width: '100%', border: 'none', background: '#fff', minHeight: 320 },
  noPreview:        { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 32, gap: 10, minHeight: 280 },
  noPreviewIcon:    { width: 56, height: 56, borderRadius: 16, background: 'var(--mcis-subtle)', color: 'var(--mcis-accent)', display: 'grid', placeItems: 'center', marginBottom: 6 },
  noPreviewActions: { display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center', marginTop: 8 },
  filesPanel:       { flex: 1, display: 'flex', gap: 0, margin: '12px 18px 0', border: '1px solid var(--mcis-border)', borderRadius: 14, overflow: 'hidden', minHeight: 320 },
  fileList:         { width: 180, flexShrink: 0, borderRight: '1px solid var(--mcis-border)', overflowY: 'auto', background: 'var(--mcis-subtle)' },
  fileListItem:     { width: '100%', border: 'none', background: 'transparent', color: 'var(--mcis-text)', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', padding: '10px 12px', cursor: 'pointer', borderBottom: '1px solid var(--mcis-border)', fontSize: 13, fontWeight: 600, textAlign: 'left' },
  fileListItemActive: { background: 'var(--mcis-active)', color: 'var(--mcis-text)' },
  filePath:         { fontWeight: 400, color: 'var(--mcis-muted)', fontSize: 10, marginTop: 2 },
  codeViewer:       { flex: 1, overflowY: 'auto', padding: 14, margin: 0, fontSize: 11, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--mcis-text)', background: 'var(--mcis-bg)' },
  footer:           { padding: '14px 18px', borderTop: '1px solid var(--mcis-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', flexShrink: 0 },
  meta:             { display: 'flex', gap: 18, fontSize: 13, color: 'var(--mcis-muted)', flexWrap: 'wrap' },
  actions:          { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  primaryAction:    { minHeight: 36, borderRadius: 10, background: 'var(--mcis-primary)', color: '#fff', border: 'none', padding: '0 14px', display: 'inline-flex', alignItems: 'center', gap: 7, fontWeight: 800, textDecoration: 'none', cursor: 'pointer', fontSize: 13 },
  outlineLink:      { minHeight: 36, borderRadius: 10, border: '1px solid var(--mcis-border)', color: 'var(--mcis-text)', padding: '0 12px', display: 'inline-flex', alignItems: 'center', textDecoration: 'none', fontWeight: 700, fontSize: 13 },
  codespaceLink:    { minHeight: 36, borderRadius: 10, border: '1px solid var(--mcis-border)', color: 'var(--mcis-text)', padding: '0 12px', display: 'inline-flex', alignItems: 'center', textDecoration: 'none', fontWeight: 700, fontSize: 13 },
};

function MemoryView({ memories, totalMemories, categories, decisions, search, setSearch, onDelete, isMobile }) {
  return (
    <>
      <div style={styles.sectionHeader}>
        <span>Memory</span>
        <strong>Everything MCIS remembers about you, in plain language.</strong>
      </div>

      <div style={{ ...styles.memoryToolbar }}>
        <div style={{ ...styles.searchBox, minWidth: isMobile ? '100%' : 260 }}>
          <Search size={16} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search your memories..." />
        </div>
        <div style={styles.memoryCount}>{totalMemories} saved</div>
      </div>

      <div style={{ ...styles.gridTwo, gridTemplateColumns: isMobile ? '1fr' : styles.gridTwo.gridTemplateColumns }}>
        <Panel title="Categories" subtitle="Where your context is concentrated" icon={Brain}>
          <div style={styles.categoryList}>
            {categories.length ? categories.map(([name, count]) => {
              const meta = getMemoryTypeMeta(name);
              const Icon = meta.Icon;
              return (
                <div key={name} style={styles.categoryRow}>
                  <span style={styles.categoryRowLabel}>
                    <span style={{ ...styles.categoryIcon, background: meta.bg, color: meta.fg }}>
                      <Icon size={13} />
                    </span>
                    {meta.label}
                  </span>
                  <strong>{count}</strong>
                </div>
              );
            }) : <EmptyState text="No memories yet." />}
          </div>
        </Panel>

        <Panel title="Decisions" subtitle="Useful for resuming work later" icon={BookOpen}>
          {decisions.length ? decisions.slice(0, 5).map(memory => {
            const parsed = parseMemoryEntry(memory);
            return (
              <div key={memory.id} style={styles.compactMemory}>
                <MemBadge tag={parsed.tag} />
                {parsed.title && <strong style={styles.compactMemoryTitle}>{parsed.title}</strong>}
                <p className="mcis-clamp-2">{parsed.description}</p>
              </div>
            );
          }) : <EmptyState text="No decisions captured yet." />}
        </Panel>
      </div>

      <div style={styles.memoryList}>
        {memories.length ? memories.map(memory => {
          const parsed = parseMemoryEntry(memory);
          return (
            <div key={memory.id} className="mcis-dash-card" style={styles.memoryRow}>
              <div style={{ minWidth: 0 }}>
                <div style={styles.memoryRowTop}><MemBadge tag={parsed.tag} /></div>
                {parsed.title && <strong style={styles.memoryRowTitle}>{parsed.title}</strong>}
                <p className="mcis-clamp-2">{parsed.description}</p>
                <small>{memory.created_at ? new Date(memory.created_at).toLocaleDateString() : ''}</small>
              </div>
              <button style={styles.memoryDeleteBtn} onClick={() => onDelete(memory.id)} title="Delete this memory">
                <Trash2 size={15} />
              </button>
            </div>
          );
        }) : (
          <EmptyState text="No matching memories found." />
        )}
      </div>
    </>
  );
}

function GoalsView({ goals, loadWorkspaceData, userId, isMobile }) {
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);

  const addGoal = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      await authFetch(`${API_BASE}/api/goals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, title: title.trim(), category: 'general' }),
      });
      setTitle('');
      await loadWorkspaceData();
    } catch {
      alert('Could not add goal.');
    }
    setSaving(false);
  };

  return (
    <>
      <div style={styles.sectionHeader}>
        <span>Goals</span>
        <strong>Turn remembered context into visible progress.</strong>
      </div>

      <div style={{ ...styles.goalComposer, flexWrap: isMobile ? 'wrap' : 'nowrap', height: isMobile ? 'auto' : 54, padding: isMobile ? '10px 12px' : styles.goalComposer.padding }}>
        <Target size={18} />
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Add a goal MCIS should help you remember..." />
        <button onClick={addGoal} disabled={saving || !title.trim()}>
          <Plus size={16} />
          Add
        </button>
      </div>

      <div style={styles.goalGrid}>
        {goals.length ? goals.map(goal => (
          <div key={goal.id} className="mcis-dash-card" style={styles.goalCard}>
            <div style={styles.goalTop}>
              <span>{goal.category || 'general'}</span>
              <strong>{goal.status || 'active'}</strong>
            </div>
            <h3 className="mcis-clamp-2">{goal.title}</h3>
            {goal.description && <p className="mcis-clamp-2">{trimText(goal.description, 120)}</p>}
            <div style={styles.goalProgress}>
              <div style={{ width: `${Math.min(100, goal.progress || 0)}%` }} />
            </div>
            <small>{goal.progress || 0}% complete</small>
          </div>
        )) : (
          <EmptyState text="No goals yet. Add one to make MCIS proactive." />
        )}
      </div>
    </>
  );
}

function Panel({ title, subtitle, icon: Icon, children, tip }) {
  return (
    <section style={styles.panel}>
      <div style={styles.panelHeader}>
        <div style={styles.panelIcon}><Icon size={17} /></div>
        <div>
          <h2 style={styles.panelTitleRow}>
            {title}
            {tip && <InfoTip text={tip} />}
          </h2>
          <p>{subtitle}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function Metric({ label, value }) {
  return (
    <div style={styles.metric}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function EmptyState({ text }) {
  return (
    <div style={styles.emptyState}>
      <PauseCircle size={17} />
      <span>{text}</span>
    </div>
  );
}

const styles = {
  shell: {
    height: '100dvh',
    display: 'flex',
    overflow: 'hidden',
    background: 'var(--mcis-bg)',
    color: 'var(--mcis-text)',
    fontFamily: 'var(--mcis-font-body)',
  },
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(10, 10, 8, 0.45)',
    zIndex: 20,
  },
  sidebar: {
    position: 'relative',
    zIndex: 30,
    flexShrink: 0,
    height: '100vh',
    background: 'var(--mcis-sidebar)',
    color: 'var(--mcis-text)',
    borderRight: '1px solid var(--mcis-border)',
    display: 'flex',
    flexDirection: 'column',
    transition: 'width 0.22s ease, transform 0.22s ease',
  },
  brand: {
    height: 78,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '0 18px',
    borderBottom: '1px solid var(--mcis-border)',
  },
  logoMark: {
    width: 42,
    height: 42,
    borderRadius: 12,
    color: '#0A0D13',
    display: 'grid',
    placeItems: 'center',
    fontWeight: 800,
    flexShrink: 0,
    fontFamily: 'var(--mcis-font-display)',
  },
  brandName: { fontWeight: 700, fontSize: 18, letterSpacing: 0, fontFamily: 'var(--mcis-font-display)' },
  brandSub: { color: 'var(--mcis-muted)', fontSize: 12, marginTop: 2 },
  nav: { padding: 14, display: 'flex', flexDirection: 'column', gap: 6 },
  navButton: {
    height: 44,
    border: 0,
    borderRadius: 'var(--mcis-radius-md)',
    background: 'transparent',
    color: 'var(--mcis-muted)',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '0 12px',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 14,
    transition: 'background 0.15s var(--mcis-ease), color 0.15s var(--mcis-ease)',
  },
  navButtonActive: {
    background: 'var(--mcis-active)',
    color: 'var(--mcis-primary-solid)',
    fontWeight: 700,
  },
  memoryHealth: {
    margin: '8px 14px',
    padding: 14,
    borderRadius: 'var(--mcis-radius-lg)',
    background: 'var(--mcis-subtle)',
    border: '1px solid var(--mcis-border)',
  },
  healthHeader: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700 },
  healthMetric: { display: 'flex', justifyContent: 'space-between', gap: 8, color: 'var(--mcis-muted)', fontSize: 12, marginTop: 12 },
  healthBar: { height: 7, background: 'var(--mcis-input)', borderRadius: 99, overflow: 'hidden', marginTop: 10 },
  healthFill: { height: '100%', background: 'var(--mcis-accent)', borderRadius: 99 },
  sidebarFooter: { marginTop: 'auto', padding: 14, borderTop: '1px solid var(--mcis-border)' },
  userBox: {
    background: 'var(--mcis-subtle)',
    borderRadius: 'var(--mcis-radius-md)',
    padding: 12,
    marginBottom: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
  },
  logoutBtn: {
    width: '100%',
    height: 40,
    border: 0,
    borderRadius: 'var(--mcis-radius-md)',
    background: 'var(--mcis-subtle)',
    color: 'var(--mcis-text)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    fontWeight: 700,
  },
  main: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 },
  topbar: {
    height: 78,
    background: 'var(--mcis-header)',
    backdropFilter: 'blur(18px)',
    borderBottom: '1px solid var(--mcis-border)',
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    padding: '0 clamp(16px, 3vw, 34px)',
    flexShrink: 0,
  },
  iconButton: {
    width: 38,
    height: 38,
    borderRadius: 'var(--mcis-radius-md)',
    border: '1px solid var(--mcis-border)',
    background: 'var(--mcis-surface)',
    cursor: 'pointer',
    display: 'grid',
    placeItems: 'center',
    color: 'var(--mcis-text)',
  },
  topbarTitle: { minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 3 },
  topbarActions: { display: 'flex', gap: 10, alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' },
  secondaryAction: {
    minHeight: 38,
    borderRadius: 'var(--mcis-radius-md)',
    border: '1px solid var(--mcis-border)',
    background: 'var(--mcis-surface)',
    color: 'var(--mcis-text)',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '0 13px',
    cursor: 'pointer',
    fontWeight: 700,
    textDecoration: 'none',
  },
  githubConnected: {
    minHeight: 38,
    borderRadius: 'var(--mcis-radius-md)',
    background: 'var(--mcis-success-soft)',
    color: 'var(--mcis-success)',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '0 13px',
    fontWeight: 700,
    textDecoration: 'none',
  },
  content: { flex: 1, overflowY: 'auto', minHeight: 0, WebkitOverflowScrolling: 'touch', padding: '28px clamp(16px, 4vw, 42px) 48px' },
  hero: {
    minHeight: 280,
    borderRadius: 'var(--mcis-radius-lg)',
    background: 'var(--mcis-hero)',
    color: 'var(--mcis-text)',
    padding: 'clamp(24px, 4vw, 42px)',
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.4fr) minmax(280px, 0.8fr)',
    gap: 24,
    alignItems: 'center',
    marginBottom: 22,
  },
  heroCopy: { maxWidth: 680 },
  kicker: { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--mcis-accent)', fontSize: 13, fontWeight: 700, marginBottom: 18 },
  heroTitle: { fontSize: 'clamp(30px, 4.4vw, 50px)', lineHeight: 1.04, letterSpacing: '-0.01em', margin: '0 0 18px', fontFamily: 'var(--mcis-font-display)', fontWeight: 600 },
  heroText: { color: 'var(--mcis-muted)', fontSize: 16, lineHeight: 1.7, maxWidth: 620, margin: 0 },
  heroActions: { display: 'flex', gap: 12, marginTop: 26, flexWrap: 'wrap' },
  primaryAction: {
    minHeight: 44,
    border: 0,
    borderRadius: 'var(--mcis-radius-md)',
    background: 'var(--mcis-primary)',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    padding: '0 18px',
    cursor: 'pointer',
    fontWeight: 700,
    boxShadow: 'var(--mcis-glow)',
  },
  secondaryActionLight: {
    minHeight: 44,
    borderRadius: 'var(--mcis-radius-md)',
    border: '1px solid var(--mcis-border-strong)',
    background: 'var(--mcis-subtle)',
    color: 'var(--mcis-text)',
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    padding: '0 16px',
    cursor: 'pointer',
    fontWeight: 700,
  },
  contextPanel: {
    borderRadius: 'var(--mcis-radius-lg)',
    background: 'var(--mcis-subtle)',
    border: '1px solid var(--mcis-border)',
    padding: 18,
  },
  contextLabel: { color: 'var(--mcis-muted)', fontWeight: 700, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 6 },
  readinessDial: {
    minHeight: 54,
    borderRadius: 'var(--mcis-radius-md)',
    background: 'var(--mcis-subtle)',
    padding: '0 14px',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },
  contextGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 },
  metric: { borderRadius: 'var(--mcis-radius-md)', background: 'var(--mcis-subtle)', padding: 14, display: 'flex', flexDirection: 'column', gap: 4 },
  gridTwo: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 18, marginBottom: 18 },
  panel: { background: 'var(--mcis-surface)', border: '1px solid var(--mcis-border)', borderRadius: 'var(--mcis-radius-lg)', padding: 18, boxShadow: 'var(--mcis-card-shadow)' },
  panelHeader: { display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 16 },
  panelIcon: { width: 34, height: 34, borderRadius: 'var(--mcis-radius-sm)', background: 'var(--mcis-subtle)', color: 'var(--mcis-accent)', display: 'grid', placeItems: 'center', flexShrink: 0 },
  panelTitleRow: { display: 'flex', alignItems: 'center', gap: 6 },
  infoTip: { display: 'inline-flex', alignItems: 'center', color: 'var(--mcis-muted)', cursor: 'help' },
  actionList: { display: 'flex', flexDirection: 'column', gap: 10 },
  actionItem: { display: 'flex', alignItems: 'flex-start', gap: 10, color: 'var(--mcis-text)', lineHeight: 1.5 },
  priorityList: { display: 'flex', flexDirection: 'column', gap: 12 },
  priorityItem: {
    border: '1px solid var(--mcis-border)',
    borderRadius: 'var(--mcis-radius-md)',
    padding: 14,
    background: 'var(--mcis-subtle)',
    display: 'flex',
    flexDirection: 'column',
    gap: 7,
  },
  priorityTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  urgencyPill: {
    minHeight: 24,
    borderRadius: 999,
    display: 'inline-flex',
    alignItems: 'center',
    padding: '0 9px',
    fontSize: 12,
    fontWeight: 700,
    textTransform: 'capitalize',
  },
  urgencyCritical: { background: 'var(--mcis-danger-soft)', color: 'var(--mcis-danger)' },
  urgencyHigh: { background: 'var(--mcis-warning-soft)', color: 'var(--mcis-warning)' },
  urgencyMedium: { background: 'var(--mcis-warning-soft)', color: 'var(--mcis-warning)' },
  urgencyNormal: { background: 'var(--mcis-success-soft)', color: 'var(--mcis-success)' },
  riskRow: { borderTop: '1px solid var(--mcis-border)', padding: '12px 0' },
  gapRow: { borderTop: '1px solid var(--mcis-border)', padding: '12px 0' },
  executionButton: {
    minHeight: 42,
    border: '1px solid var(--mcis-border)',
    borderRadius: 'var(--mcis-radius-md)',
    background: 'var(--mcis-subtle)',
    color: 'var(--mcis-text)',
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    padding: '0 13px',
    cursor: 'pointer',
    fontWeight: 650,
    textAlign: 'left',
  },
  compactMemory: { borderTop: '1px solid var(--mcis-border)', padding: '11px 0' },
  sectionHeader: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 18 },
  workspaceGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, marginBottom: 18 },
  workspaceCard: { background: 'var(--mcis-surface)', border: '1px solid var(--mcis-border)', borderTop: '4px solid', borderRadius: 'var(--mcis-radius-lg)', padding: 18, boxShadow: 'var(--mcis-card-shadow)' },
  workspaceIcon: { width: 42, height: 42, borderRadius: 'var(--mcis-radius-md)', display: 'grid', placeItems: 'center', marginBottom: 14 },
  workspaceMeta: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 16 },
  projectRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, borderTop: '1px solid var(--mcis-border)', padding: '12px 0' },
  projectInfo: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
  projectActions: { display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 },
  previewButton: {
    height: 32,
    borderRadius: 'var(--mcis-radius-sm)',
    border: '1px solid var(--mcis-border)',
    background: 'var(--mcis-subtle)',
    color: 'var(--mcis-text)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    padding: '0 11px',
    fontWeight: 700,
    cursor: 'pointer',
  },
  projectLink: { color: 'var(--mcis-accent)', textDecoration: 'none', fontWeight: 700 },
  memoryToolbar: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 18, flexWrap: 'wrap' },
  searchBox: { flex: 1, minWidth: 260, height: 44, border: '1px solid var(--mcis-border)', background: 'var(--mcis-surface)', borderRadius: 'var(--mcis-radius-md)', padding: '0 12px', display: 'flex', alignItems: 'center', gap: 10 },
  memoryCount: { height: 44, display: 'flex', alignItems: 'center', padding: '0 14px', background: 'var(--mcis-hero)', color: 'var(--mcis-text)', borderRadius: 'var(--mcis-radius-md)', fontWeight: 700 },
  categoryList: { display: 'flex', flexDirection: 'column', gap: 9 },
  categoryRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--mcis-border)', paddingTop: 9 },
  categoryRowLabel: { display: 'flex', alignItems: 'center', gap: 9, fontSize: 13.5, color: 'var(--mcis-text)' },
  categoryIcon: { width: 24, height: 24, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  memBadge: { display: 'inline-flex', alignItems: 'center', gap: 5, borderRadius: 999, padding: '3px 9px 3px 8px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4 },
  compactMemoryTitle: { display: 'block', marginTop: 8, marginBottom: 2, fontSize: 13.5 },
  memoryList: { display: 'grid', gap: 10 },
  memoryRow: { background: 'var(--mcis-surface)', border: '1px solid var(--mcis-border)', borderRadius: 'var(--mcis-radius-md)', padding: 14, display: 'flex', justifyContent: 'space-between', gap: 12, boxShadow: 'var(--mcis-card-shadow)' },
  memoryRowTop: { marginBottom: 8 },
  memoryRowTitle: { display: 'block', fontSize: 14, marginBottom: 3 },
  memoryDeleteBtn: { flexShrink: 0, width: 32, height: 32, borderRadius: 'var(--mcis-radius-sm)', border: '1px solid var(--mcis-border)', background: 'var(--mcis-subtle)', color: 'var(--mcis-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' },
  goalComposer: { height: 54, background: 'var(--mcis-surface)', border: '1px solid var(--mcis-border)', borderRadius: 'var(--mcis-radius-lg)', display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', marginBottom: 18, boxShadow: 'var(--mcis-card-shadow)' },
  goalGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 },
  goalCard: { background: 'var(--mcis-surface)', border: '1px solid var(--mcis-border)', borderRadius: 'var(--mcis-radius-lg)', padding: 18, boxShadow: 'var(--mcis-card-shadow)' },
  goalTop: { display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 10 },
  goalProgress: { height: 8, background: 'var(--mcis-input)', borderRadius: 99, overflow: 'hidden', margin: '16px 0 8px' },
  builderWrap: { maxWidth: 1060, margin: '0 auto' },
  loadingCard: { background: 'var(--mcis-surface)', border: '1px solid var(--mcis-border)', borderRadius: 'var(--mcis-radius-lg)', padding: 24 },
  emptyState: { color: 'var(--mcis-muted)', display: 'flex', alignItems: 'center', gap: 9, fontSize: 14, lineHeight: 1.5 },
  lifeOSHero: {
    minHeight: 240,
    borderRadius: 'var(--mcis-radius-lg)',
    background: 'var(--mcis-hero)',
    color: 'var(--mcis-text)',
    padding: 'clamp(22px, 4vw, 36px)',
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.25fr) minmax(260px, 0.75fr)',
    gap: 22,
    alignItems: 'center',
    marginBottom: 18,
  },
  lifeOSTitle: {
    fontSize: 'clamp(28px, 4vw, 44px)',
    lineHeight: 1.05,
    letterSpacing: '-0.01em',
    margin: '0 0 14px',
    maxWidth: 720,
    fontFamily: 'var(--mcis-font-display)',
    fontWeight: 600,
  },
  lifeOSText: {
    color: 'var(--mcis-muted)',
    fontSize: 15.5,
    lineHeight: 1.7,
    maxWidth: 680,
    margin: 0,
  },
  lifeOSStats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 10,
  },
  operatingRail: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 16,
    marginBottom: 18,
  },
  operatingColumn: {
    minHeight: 260,
    background: 'var(--mcis-surface)',
    border: '1px solid var(--mcis-border)',
    borderRadius: 'var(--mcis-radius-lg)',
    padding: 18,
    boxShadow: 'var(--mcis-card-shadow)',
  },
  operatingItems: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  operatingItem: {
    border: '1px solid var(--mcis-border)',
    borderRadius: 'var(--mcis-radius-md)',
    padding: 13,
    background: 'var(--mcis-subtle)',
  },
  itemActions: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 10,
  },
  miniActionButton: {
    minHeight: 32,
    border: '1px solid var(--mcis-border)',
    borderRadius: 'var(--mcis-radius-sm)',
    background: 'var(--mcis-surface)',
    color: 'var(--mcis-text)',
    padding: '0 10px',
    cursor: 'pointer',
    fontWeight: 650,
    fontSize: 12,
  },
  reviewQueue: {
    display: 'grid',
    gap: 10,
  },
  reviewItem: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: 14,
    alignItems: 'center',
    border: '1px solid var(--mcis-border)',
    borderRadius: 'var(--mcis-radius-md)',
    padding: 14,
    background: 'var(--mcis-subtle)',
  },
  reviewActions: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
  },
  approveButton: {
    minHeight: 36,
    border: 0,
    borderRadius: 'var(--mcis-radius-sm)',
    background: 'var(--mcis-success)',
    color: '#ffffff',
    padding: '0 12px',
    cursor: 'pointer',
    fontWeight: 700,
  },
  rejectButton: {
    minHeight: 36,
    border: '1px solid var(--mcis-border)',
    borderRadius: 'var(--mcis-radius-sm)',
    background: 'var(--mcis-surface)',
    color: 'var(--mcis-text)',
    padding: '0 12px',
    cursor: 'pointer',
    fontWeight: 700,
  },
  simulatorBox: {
    display: 'grid',
    gap: 10,
  },
  simulatorInput: {
    width: '100%',
    resize: 'vertical',
    border: '1px solid var(--mcis-border)',
    borderRadius: 'var(--mcis-radius-md)',
    background: 'var(--mcis-input)',
    color: 'var(--mcis-text)',
    padding: 12,
    outline: 'none',
    lineHeight: 1.5,
  },
  simulatorButton: {
    minHeight: 40,
    border: 0,
    borderRadius: 'var(--mcis-radius-md)',
    background: 'var(--mcis-primary)',
    color: '#ffffff',
    padding: '0 14px',
    cursor: 'pointer',
    fontWeight: 700,
  },
  simulationResults: {
    display: 'grid',
    gap: 10,
    marginTop: 14,
  },
  recommendationBox: {
    border: '1px solid var(--mcis-accent-soft)',
    borderRadius: 'var(--mcis-radius-md)',
    background: 'var(--mcis-active)',
    padding: 13,
  },
  pathCard: {
    border: '1px solid var(--mcis-border)',
    borderRadius: 'var(--mcis-radius-md)',
    background: 'var(--mcis-subtle)',
    padding: 13,
  },
  pathTop: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'center',
  },
  agentPlanBox: {
    display: 'grid',
    gap: 16,
  },
  agentPlanTop: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 14,
    alignItems: 'flex-start',
    border: '1px solid var(--mcis-border)',
    borderRadius: 'var(--mcis-radius-md)',
    background: 'var(--mcis-subtle)',
    padding: 14,
    flexWrap: 'wrap',
  },
  agentStepGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: 12,
  },
  agentStep: {
    border: '1px solid var(--mcis-border)',
    borderRadius: 'var(--mcis-radius-md)',
    background: 'var(--mcis-surface)',
    padding: 13,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  agentMetaGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: 12,
  },
};

export default Dashboard;