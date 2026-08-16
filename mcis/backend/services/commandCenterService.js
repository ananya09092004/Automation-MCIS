const { createClient } = require('@supabase/supabase-js');
const multiFileService = require('./multiFileService');
const { ROLE_CONFIG, getAdaptiveProfile } = require('./adaptiveProfileService');
const logger = require('./logger');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const DAY_MS = 24 * 60 * 60 * 1000;

function daysUntil(dateValue) {
  if (!dateValue) return null;
  const target = new Date(dateValue);
  if (Number.isNaN(target.getTime())) return null;
  return Math.ceil((target.setHours(23, 59, 59, 999) - Date.now()) / DAY_MS);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function truncate(text = '', max = 140) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trim()}...`;
}

function getGoalScore(goal) {
  const progress = Number(goal.progress || 0);
  const days = daysUntil(goal.target_date);
  let score = 35;

  if (days !== null && days < 0) score += 38;
  else if (days !== null && days <= 2) score += 34;
  else if (days !== null && days <= 7) score += 26;
  else if (days !== null && days <= 21) score += 12;

  if (progress < 15) score += 16;
  else if (progress < 45) score += 10;
  else if (progress > 80) score += 8;

  return clamp(score, 0, 100);
}

function goalUrgency(goal) {
  const days = daysUntil(goal.target_date);
  if (days !== null && days < 0) return 'overdue';
  if (days !== null && days <= 2) return 'critical';
  if (days !== null && days <= 7) return 'high';
  if (Number(goal.progress || 0) < 15) return 'medium';
  return 'normal';
}

function dueLabel(dateValue) {
  const days = daysUntil(dateValue);
  if (days === null) return null;
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`;
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  return `${days} days left`;
}

function getRoleConfig(adaptiveProfile = {}) {
  return ROLE_CONFIG[adaptiveProfile.role] || ROLE_CONFIG.general;
}

function roleGoalAction(goal, adaptiveProfile, fallbackAction) {
  const role = adaptiveProfile?.role || 'general';
  const title = goal.title;

  if (role === 'student') {
    return `Turn "${title}" into a study sprint: revise one weak topic, solve practice, then summarize mistakes.`;
  }
  if (role === 'developer') {
    return `Turn "${title}" into a shippable dev task: pick one issue, implement, test, and prepare a commit.`;
  }
  if (role === 'founder') {
    return `Move "${title}" with one business signal today: customer proof, roadmap decision, or follow-up.`;
  }
  if (role === 'professional') {
    return `Move "${title}" with one work-visible output: draft, decision, follow-up, or deadline checkpoint.`;
  }
  if (role === 'creator') {
    return `Turn "${title}" into one publishable or draftable creative output today.`;
  }

  return fallbackAction;
}

function makeGoalPriority(goal, adaptiveProfile = {}) {
  const urgency = goalUrgency(goal);
  const progress = Number(goal.progress || 0);
  const due = dueLabel(goal.target_date);

  let action = `Move "${goal.title}" forward with one visible deliverable today.`;
  let reason = `${progress}% complete`;

  if (urgency === 'overdue') {
    action = `Rescope "${goal.title}" and choose the smallest recovery step.`;
    reason = `${due}; progress is ${progress}%.`;
  } else if (urgency === 'critical' || urgency === 'high') {
    action = `Spend a focused block on "${goal.title}" before starting lower-priority work.`;
    reason = `${due}; progress is ${progress}%.`;
  } else if (progress < 15) {
    action = `Define the first concrete milestone for "${goal.title}" and complete step one.`;
    reason = 'This goal is active but still near zero progress.';
  } else if (progress > 80) {
    action = `Finish or archive "${goal.title}" so it stops consuming attention.`;
    reason = 'This goal is close enough to completion to close the loop.';
  }

  action = roleGoalAction(goal, adaptiveProfile, action);

  return {
    id: `goal-${goal.id}`,
    type: 'goal',
    title: goal.title,
    reason,
    action,
    urgency,
    score: getGoalScore(goal),
    sourceId: goal.id,
    dueLabel: due,
    confidence: 0.86,
    chatPrompt: `Help me make progress on this goal today: ${goal.title}`,
  };
}

function makeNotificationPriority(notification) {
  return {
    id: `notification-${notification.id}`,
    type: 'notification',
    title: notification.title || 'Unread reminder',
    reason: truncate(notification.message || 'A saved reminder needs attention.', 120),
    action: 'Review this reminder and either complete, snooze, or delete it.',
    urgency: notification.read ? 'normal' : 'high',
    score: notification.read ? 36 : 72,
    sourceId: notification.id,
    dueLabel: notification.created_at ? new Date(notification.created_at).toLocaleDateString() : null,
    confidence: 0.78,
    chatPrompt: `Help me act on this reminder: ${notification.message || notification.title || 'latest reminder'}`,
  };
}

function makeProjectPriority(project, adaptiveProfile = {}) {
  const name = project.project_name || project.name || project.goal || 'Recent project';
  const role = adaptiveProfile?.role || 'general';
  const actionByRole = {
    student: 'Review this project for pending assignments, notes, or demo-ready improvements.',
    developer: 'Review code state, choose the next commit-worthy task, and run verification.',
    founder: 'Check whether this project supports the current product or customer milestone.',
    professional: 'Review deliverables and decide the next work-visible improvement.',
    creator: 'Turn this project into a draft, post, asset, or publishing task.',
    general: 'Review the latest project state and decide the next commit-worthy improvement.',
  };

  return {
    id: `project-${project.id || name}`,
    type: 'project',
    title: name,
    reason: truncate(project.description || project.goal || 'A generated project is ready to continue.', 120),
    action: actionByRole[role] || actionByRole.general,
    urgency: 'normal',
    score: 48,
    sourceId: project.id || null,
    dueLabel: project.created_at ? new Date(project.created_at).toLocaleDateString() : null,
    confidence: 0.7,
    chatPrompt: `Help me continue this project: ${name}`,
  };
}

function findDecisionMemories(memories) {
  return memories.filter(memory => {
    const text = `${memory.category || ''} ${memory.content || ''}`.toLowerCase();
    return text.includes('decision') ||
      text.includes('decided') ||
      text.includes('chose') ||
      text.includes('plan') ||
      text.includes('strategy');
  });
}

function stripOperatingPrefix(content = '') {
  return String(content)
    .replace(/^\[(decision|risk|next_action|future_path|insight)\]\s*/i, '')
    .replace(/\s*\|\s*confidence:\s*\d+(\.\d+)?/i, '')
    .replace(/\s*\|\s*chat:\s*[\w-]+/i, '')
    .trim();
}

function getOperatingMemories(memories, category, limit = 6) {
  return memories
    .filter(memory => {
      const memoryCategory = String(memory.category || '').toLowerCase();
      const content = String(memory.content || '').toLowerCase();
      return memoryCategory === category || content.startsWith(`[${category}]`);
    })
    .slice(0, limit)
    .map(memory => ({
      id: memory.id,
      category,
      content: truncate(stripOperatingPrefix(memory.content), 190),
      createdAt: memory.created_at,
    }));
}

function getPendingOperatingMemories(memories, limit = 8) {
  return memories
    .filter(memory => String(memory.category || '').toLowerCase().startsWith('pending_'))
    .slice(0, limit)
    .map(memory => {
      const pendingCategory = String(memory.category || '').replace(/^pending_/, '');
      return {
        id: memory.id,
        category: pendingCategory,
        content: truncate(stripOperatingPrefix(memory.content), 190),
        createdAt: memory.created_at,
      };
    });
}

function makeOperatingPriority(memory) {
  const clean = stripOperatingPrefix(memory.content || '');
  const isRisk = memory.category === 'risk' || String(memory.content || '').startsWith('[risk]');
  const isAction = memory.category === 'next_action' || String(memory.content || '').startsWith('[next_action]');

  return {
    id: `operating-${memory.id}`,
    type: memory.category || 'operating_context',
    title: isRisk ? 'Resolve detected risk' : isAction ? 'Execute captured next action' : 'Use captured context',
    reason: truncate(clean, 130),
    action: isRisk
      ? `Reduce this risk: ${truncate(clean, 120)}`
      : `Act on this: ${truncate(clean, 130)}`,
    urgency: isRisk ? 'high' : 'medium',
    score: isRisk ? 76 : 64,
    sourceId: memory.id,
    dueLabel: memory.created_at ? new Date(memory.created_at).toLocaleDateString() : null,
    confidence: 0.76,
    chatPrompt: `Help me execute this MCIS operating item: ${clean}`,
  };
}

function buildContextGaps({ goals, memories, projects, adaptiveProfile }) {
  const gaps = [];
  const roleConfig = getRoleConfig(adaptiveProfile);

  if (!goals.length) {
    gaps.push({
      title: `No ${roleConfig.label.toLowerCase()} goal is pinned`,
      detail: `MCIS can become more useful when it knows the user's main ${roleConfig.label.toLowerCase()} outcome.`,
      action: `Create one 30-day ${roleConfig.label.toLowerCase()} goal.`,
    });
  }

  if (goals.some(goal => !goal.target_date)) {
    gaps.push({
      title: 'Some goals have no deadline',
      detail: 'Deadlines let MCIS rank work instead of only storing it.',
      action: 'Ask for target dates on goals that matter.',
    });
  }

  if (memories.length < 8) {
    gaps.push({
      title: 'Memory profile is still thin',
      detail: 'The assistant needs more preferences, constraints, projects, and decisions to personalize well.',
      action: 'Capture preferences and important decisions after each useful chat.',
    });
  }

  if (!projects.length) {
    gaps.push({
      title: 'No project workspace yet',
      detail: 'A project workspace gives users a reason to return beyond normal chat.',
      action: adaptiveProfile?.role === 'student'
        ? 'Turn one subject, assignment, or exam into a workspace.'
        : 'Turn one goal into a workspace.',
    });
  }

  return gaps.slice(0, 4);
}

function buildRisks(activeGoals) {
  return activeGoals
    .map(goal => {
      const days = daysUntil(goal.target_date);
      const progress = Number(goal.progress || 0);
      if (days !== null && days < 0) {
        return {
          title: `${goal.title} is overdue`,
          detail: `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} past target with ${progress}% progress.`,
          severity: 'high',
        };
      }
      if (days !== null && days <= 7 && progress < 50) {
        return {
          title: `${goal.title} may slip`,
          detail: `${days} day${days === 1 ? '' : 's'} left with ${progress}% progress.`,
          severity: 'medium',
        };
      }
      if (progress < 10) {
        return {
          title: `${goal.title} has not started strongly`,
          detail: 'Low early progress usually needs a smaller first milestone.',
          severity: 'low',
        };
      }
      return null;
    })
    .filter(Boolean)
    .slice(0, 4);
}

function buildStarterPriorities(adaptiveProfile = {}) {
  const roleConfig = getRoleConfig(adaptiveProfile);
  return roleConfig.suggestedActions.map((action, index) => ({
    id: `starter-${adaptiveProfile.role || 'general'}-${index}`,
    type: 'starter',
    title: `${roleConfig.label} starter action`,
    reason: `MCIS is currently tuned for ${roleConfig.promise}.`,
    action,
    urgency: index === 0 ? 'medium' : 'normal',
    score: 34 - index,
    sourceId: null,
    dueLabel: null,
    confidence: 0.74,
    chatPrompt: action,
  }));
}

function buildCommandCenter({ goals = [], memories = [], projects = [], notifications = [], adaptiveProfile = {} }) {
  const activeGoals = goals.filter(goal => goal.status !== 'completed');
  const completedGoals = goals.filter(goal => goal.status === 'completed');
  const unreadNotifications = notifications.filter(notification => !notification.read);
  const decisions = findDecisionMemories(memories);
  const operatingActions = memories.filter(memory => {
    const category = String(memory.category || '').toLowerCase();
    const content = String(memory.content || '').toLowerCase();
    return category === 'next_action' || category === 'risk' || content.startsWith('[next_action]') || content.startsWith('[risk]');
  });
  const risks = getOperatingMemories(memories, 'risk', 4);
  const futurePaths = getOperatingMemories(memories, 'future_path', 4);
  const insights = getOperatingMemories(memories, 'insight', 5);
  const roleConfig = getRoleConfig(adaptiveProfile);

  const priorities = [
    ...activeGoals.map(goal => makeGoalPriority(goal, adaptiveProfile)),
    ...unreadNotifications.slice(0, 3).map(makeNotificationPriority),
    ...operatingActions.slice(0, 4).map(makeOperatingPriority),
    ...projects.slice(0, 2).map(project => makeProjectPriority(project, adaptiveProfile)),
    ...buildStarterPriorities(adaptiveProfile),
  ]
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (!priorities.length) {
    priorities.push({
      id: 'capture-context',
      type: 'memory',
      title: `Capture one ${roleConfig.label.toLowerCase()} context item`,
      reason: 'MCIS becomes more valuable when it remembers goals, constraints, and decisions.',
      action: `Tell MCIS what you are doing as a ${roleConfig.label.toLowerCase()} this week.`,
      urgency: 'normal',
      score: 35,
      sourceId: null,
      dueLabel: null,
      confidence: 0.72,
      chatPrompt: 'Help me set up MCIS with my current goals and projects.',
    });
  }

  const top = priorities[0];

  return {
    success: true,
    generatedAt: new Date().toISOString(),
    brief: {
      headline: top ? top.action : 'Build context today so MCIS can become proactive.',
      summary: `${roleConfig.label} mode: ${roleConfig.promise}. ${activeGoals.length} active goal${activeGoals.length === 1 ? '' : 's'}, ${decisions.length} decision${decisions.length === 1 ? '' : 's'}, ${futurePaths.length} future path${futurePaths.length === 1 ? '' : 's'}, ${unreadNotifications.length} unread reminder${unreadNotifications.length === 1 ? '' : 's'}.`,
      contextScore: clamp((memories.length * 3) + (activeGoals.length * 12) + (decisions.length * 7) + (projects.length * 8) + (operatingActions.length * 9) + (futurePaths.length * 8) + (adaptiveProfile?.onboardingComplete ? 12 : 0), 12, 100),
    },
    adaptiveProfile: {
      role: adaptiveProfile.role || 'general',
      label: roleConfig.label,
      onboardingComplete: Boolean(adaptiveProfile.onboardingComplete),
      focusAreas: adaptiveProfile.focusAreas || roleConfig.dailyFocus,
    },
    stats: {
      activeGoals: activeGoals.length,
      completedGoals: completedGoals.length,
      memories: memories.length,
      decisions: decisions.length,
      operatingItems: operatingActions.length + futurePaths.length + insights.length,
      futurePaths: futurePaths.length,
      insights: insights.length,
      pendingReview: getPendingOperatingMemories(memories, 20).length,
      projects: projects.length,
      unreadNotifications: unreadNotifications.length,
    },
    priorities,
    risks: [
      ...risks.map(risk => ({
        title: risk.content.split(':')[0] || 'Detected risk',
        detail: risk.content,
        severity: 'medium',
      })),
      ...buildRisks(activeGoals),
    ].slice(0, 5),
    contextGaps: buildContextGaps({ goals: activeGoals, memories, projects, adaptiveProfile }),
    recentDecisions: decisions.slice(0, 5).map(memory => ({
      id: memory.id,
      category: memory.category || 'decision',
      content: truncate(memory.content, 180),
      createdAt: memory.created_at,
    })),
    lifeOS: {
      decisions: getOperatingMemories(memories, 'decision', 5),
      nextActions: getOperatingMemories(memories, 'next_action', 6),
      futurePaths,
      insights,
      pendingReview: getPendingOperatingMemories(memories, 8),
    },
  };
}

async function fetchUserContext(userId) {
  const [goalsResult, memoriesResult, notificationsResult, projects] = await Promise.all([
    supabase
      .from('goals')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false }),
    supabase
      .from('user_memories')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(80),
    supabase
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20),
    multiFileService.getProjects(userId).catch(err => {
      logger.warn(`Command center project fetch failed for ${userId}: ${err.message}`);
      return [];
    }),
  ]);

  if (goalsResult.error) throw goalsResult.error;
  if (memoriesResult.error) throw memoriesResult.error;
  if (notificationsResult.error) throw notificationsResult.error;

  const contextText = [
    ...(goalsResult.data || []).map(goal => `${goal.title} ${goal.description || ''}`),
    ...(memoriesResult.data || []).map(memory => `${memory.category || ''} ${memory.content || ''}`),
    ...(projects || []).map(project => `${project.project_name || ''} ${project.description || project.goal || ''}`),
  ].join('\n');

  const adaptiveProfile = await getAdaptiveProfile(userId, contextText);

  return {
    goals: goalsResult.data || [],
    memories: memoriesResult.data || [],
    notifications: notificationsResult.data || [],
    projects: projects || [],
    adaptiveProfile,
  };
}

async function getCommandCenter(userId) {
  const context = await fetchUserContext(userId);
  return buildCommandCenter(context);
}

module.exports = {
  buildCommandCenter,
  getCommandCenter,
};
