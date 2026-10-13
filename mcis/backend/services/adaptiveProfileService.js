const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const PROFILE_KEY = 'adaptive_profile';

const ROLE_CONFIG = {
  student: {
    label: 'Student',
    promise: 'study planning, revision, assignments, exams, projects, and habit tracking',
    dailyFocus: ['study sprint', 'revision', 'assignment progress', 'exam risk', 'notes cleanup'],
    suggestedActions: [
      'Create a focused study block with one measurable outcome.',
      'Revise the weakest topic before starting new material.',
      'Turn assignments into small tasks with deadlines.',
    ],
  },
  developer: {
    label: 'Developer',
    promise: 'coding, debugging, GitHub, project shipping, testing, and architecture',
    dailyFocus: ['open project', 'bug risk', 'test status', 'commit-worthy task', 'learning pattern'],
    suggestedActions: [
      'Pick one project issue and produce a commit-worthy change.',
      'Run or add tests before moving to a new feature.',
      'Document the decision behind the current implementation.',
    ],
  },
  founder: {
    label: 'Founder',
    promise: 'roadmap, customer discovery, decisions, strategy, hiring, and investor readiness',
    dailyFocus: ['customer signal', 'roadmap risk', 'decision log', 'growth experiment', 'follow-up'],
    suggestedActions: [
      'Choose one growth or customer-learning action for today.',
      'Turn a strategic decision into a tracked next step.',
      'Review open risks before adding new ideas.',
    ],
  },
  professional: {
    label: 'Professional',
    promise: 'work priorities, meetings, follow-ups, documents, decisions, and weekly progress',
    dailyFocus: ['priority task', 'follow-up', 'meeting prep', 'decision memory', 'deadline risk'],
    suggestedActions: [
      'Handle the highest-leverage work item before reactive tasks.',
      'Convert one meeting or decision into a saved next action.',
      'Review deadlines and follow-ups that may slip.',
    ],
  },
  creator: {
    label: 'Creator',
    promise: 'content planning, audience insights, creative output, publishing, and consistency',
    dailyFocus: ['content idea', 'draft progress', 'publishing plan', 'audience learning', 'creative backlog'],
    suggestedActions: [
      'Ship or draft one audience-facing asset today.',
      'Reuse one saved idea into a concrete post, script, or artifact.',
      'Review what performed well and create the next experiment.',
    ],
  },
  general: {
    label: 'General',
    promise: 'goals, memory, decisions, projects, and personal execution',
    dailyFocus: ['top goal', 'deadline risk', 'memory gap', 'project progress', 'decision follow-up'],
    suggestedActions: [
      'Pick one visible outcome for today.',
      'Capture one important decision and the reason behind it.',
      'Turn a broad goal into a next action.',
    ],
  },
};

function parseValue(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeRole(role) {
  const clean = String(role || '').toLowerCase().trim();
  return ROLE_CONFIG[clean] ? clean : 'general';
}

function inferRoleFromText(text = '') {
  const lower = text.toLowerCase();

  const scores = {
    student: ['exam', 'study', 'college', 'school', 'assignment', 'semester', 'dsa practice', 'notes'],
    developer: ['code', 'github', 'repo', 'debug', 'bug', 'api', 'frontend', 'backend', 'deploy', 'commit'],
    founder: ['startup', 'customer', 'investor', 'pitch', 'roadmap', 'revenue', 'market', 'product'],
    professional: ['meeting', 'client', 'manager', 'work', 'office', 'deadline', 'presentation', 'report'],
    creator: ['content', 'video', 'post', 'script', 'audience', 'youtube', 'instagram', 'newsletter'],
  };

  let bestRole = 'general';
  let bestScore = 0;

  Object.entries(scores).forEach(([role, keywords]) => {
    const score = keywords.reduce((total, keyword) => total + (lower.includes(keyword) ? 1 : 0), 0);
    if (score > bestScore) {
      bestRole = role;
      bestScore = score;
    }
  });

  return bestRole;
}

function buildDefaultProfile(role = 'general') {
  const normalizedRole = normalizeRole(role);
  return {
    role: normalizedRole,
    label: ROLE_CONFIG[normalizedRole].label,
    experienceLevel: 'growing',
    dailyMinutes: 45,
    focusAreas: ROLE_CONFIG[normalizedRole].dailyFocus.slice(0, 3),
    responseStyle: 'direct',
    onboardingComplete: normalizedRole !== 'general',
    updatedAt: new Date().toISOString(),
  };
}

async function getAdaptiveProfile(userId, contextText = '') {
  try {
    const { data, error } = await supabase
      .from('user_preferences')
      .select('value')
      .eq('user_id', userId)
      .eq('key', PROFILE_KEY)
      .maybeSingle();

    if (error) throw error;

    const saved = parseValue(data?.value);
    if (saved?.role) {
      const role = normalizeRole(saved.role);
      return {
        ...buildDefaultProfile(role),
        ...saved,
        role,
        label: ROLE_CONFIG[role].label,
        roleConfig: ROLE_CONFIG[role],
      };
    }

    const inferredRole = inferRoleFromText(contextText);
    return {
      ...buildDefaultProfile(inferredRole),
      onboardingComplete: false,
      roleConfig: ROLE_CONFIG[inferredRole],
    };
  } catch (err) {
    logger.error(`Adaptive profile fetch error: ${err.message}`);
    return {
      ...buildDefaultProfile('general'),
      onboardingComplete: false,
      roleConfig: ROLE_CONFIG.general,
    };
  }
}

async function saveAdaptiveProfile(userId, profile = {}) {
  const role = normalizeRole(profile.role);
  const current = await getAdaptiveProfile(userId);
  const nextProfile = {
    ...current,
    ...profile,
    role,
    label: ROLE_CONFIG[role].label,
    focusAreas: Array.isArray(profile.focusAreas) && profile.focusAreas.length
      ? profile.focusAreas.slice(0, 6)
      : ROLE_CONFIG[role].dailyFocus.slice(0, 3),
    dailyMinutes: Number(profile.dailyMinutes || current.dailyMinutes || 45),
    onboardingComplete: true,
    updatedAt: new Date().toISOString(),
  };

  delete nextProfile.roleConfig;

  const { error } = await supabase
    .from('user_preferences')
    .upsert({
      user_id: userId,
      key: PROFILE_KEY,
      value: JSON.stringify(nextProfile),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,key' });

  if (error) throw error;

  return {
    ...nextProfile,
    roleConfig: ROLE_CONFIG[role],
  };
}

async function getAdaptiveProfileContext(userId, contextText = '') {
  const profile = await getAdaptiveProfile(userId, contextText);
  const config = profile.roleConfig || ROLE_CONFIG[profile.role] || ROLE_CONFIG.general;

  return `Adaptive user mode: ${config.label}
User type promise: ${config.promise}
Experience level: ${profile.experienceLevel}
Preferred response style: ${profile.responseStyle}
Daily available time: ${profile.dailyMinutes} minutes
Focus areas: ${(profile.focusAreas || config.dailyFocus).join(', ')}
Answer adaptation: make the response useful for a ${config.label.toLowerCase()} and include practical next actions.`;
}

module.exports = {
  ROLE_CONFIG,
  getAdaptiveProfile,
  saveAdaptiveProfile,
  getAdaptiveProfileContext,
  inferRoleFromText,
};
