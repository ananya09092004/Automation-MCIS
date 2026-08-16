const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const GITHUB_URL_REGEX = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(?:tree|blob)\/([\w.-]+))?/i;

const SKIP_PATTERNS = [
  /node_modules/, /\.git\//, /package-lock\.json/, /yarn\.lock/, /pnpm-lock\.yaml/,
  /\.png$/i, /\.jpg$/i, /\.jpeg$/i, /\.gif$/i, /\.svg$/i, /\.ico$/i,
  /\.woff/, /\.ttf/, /\.mp4$/i, /\.pdf$/i, /\.zip$/i, /dist\//, /build\//,
  /\.env/, /\.map$/i,
];

const CODE_EXTENSIONS = /\.(js|jsx|ts|tsx|py|java|cpp|c|go|rb|php|html|css|json|md|yml|yaml|sql|sh)$/i;

function extractGithubUrl(message) {
  const match = message.match(GITHUB_URL_REGEX);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, ''), branch: match[3] || null };
}

// ✅ FIX: this previously queried a `github_connections` table with an
// `access_token` column that don't exist in this codebase. The actual
// OAuth token is stored by services/githubService.js in the
// `user_integrations` table, under the `github_token` column (see
// exchangeCodeForToken() / getUserToken() in that file). With the wrong
// names this always silently returned null — private repos would fail
// with "Repo not found" even for a user who had connected GitHub.
async function getUserGithubToken(userId) {
  try {
    const { data } = await supabase
      .from('user_integrations')
      .select('github_token')
      .eq('user_id', userId)
      .single();
    return data?.github_token || null;
  } catch {
    return null;
  }
}

async function githubApi(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    if (res.status === 404) throw new Error('Repo not found (private repo? connect GitHub in Workspaces first)');
    if (res.status === 403) throw new Error('GitHub rate limit hit — try again in a bit, or connect GitHub for higher limits');
    throw new Error(`GitHub API error: ${res.status}`);
  }
  return res.json();
}

async function getDefaultBranch(owner, repo, token) {
  const info = await githubApi(`/repos/${owner}/${repo}`, token);
  return info.default_branch;
}

async function fetchTree(owner, repo, branch, token) {
  const tree = await githubApi(`/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, token);
  return (tree.tree || []).filter(item => item.type === 'blob');
}

function pickRelevantFiles(files, maxFiles = 25) {
  const filtered = files.filter(f => {
    if (SKIP_PATTERNS.some(p => p.test(f.path))) return false;
    if (!CODE_EXTENSIONS.test(f.path)) return false;
    if (f.size > 40000) return false; // skip very large files
    return true;
  });

  // Prioritize: README, package.json, then everything else by shallowest path first
  filtered.sort((a, b) => {
    const aPriority = /readme/i.test(a.path) ? 0 : /package\.json|requirements\.txt/i.test(a.path) ? 1 : 2;
    const bPriority = /readme/i.test(b.path) ? 0 : /package\.json|requirements\.txt/i.test(b.path) ? 1 : 2;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return a.path.split('/').length - b.path.split('/').length;
  });

  return filtered.slice(0, maxFiles);
}

async function fetchFileContent(owner, repo, path, branch, token) {
  const data = await githubApi(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${branch}`, token);
  if (data.encoding === 'base64') {
    return Buffer.from(data.content, 'base64').toString('utf-8');
  }
  return '';
}

// Main entry point — returns a context string to inject into the AI's system prompt
async function buildRepoContext(message, userId, maxTotalChars = 18000) {
  const parsed = extractGithubUrl(message);
  if (!parsed) return '';

  const { owner, repo, branch: urlBranch } = parsed;

  try {
    const token = await getUserGithubToken(userId);
    const branch = urlBranch || await getDefaultBranch(owner, repo, token);
    const allFiles = await fetchTree(owner, repo, branch, token);
    const relevantFiles = pickRelevantFiles(allFiles);

    let context = `REPOSITORY: ${owner}/${repo} (branch: ${branch})\nFile tree (${allFiles.length} total files, showing ${relevantFiles.length} most relevant):\n`;
    context += allFiles.slice(0, 60).map(f => `- ${f.path}`).join('\n') + '\n\n';

    let usedChars = context.length;
    for (const file of relevantFiles) {
      if (usedChars > maxTotalChars) break;
      try {
        const content = await fetchFileContent(owner, repo, file.path, branch, token);
        const truncated = content.slice(0, 3000);
        const block = `\n--- FILE: ${file.path} ---\n${truncated}${content.length > 3000 ? '\n... (truncated)' : ''}\n`;
        context += block;
        usedChars += block.length;
      } catch (e) {
        logger.error(`Failed to fetch ${file.path}: ${e.message}`);
      }
    }

    return context;
  } catch (err) {
    logger.error(`Repo context error: ${err.message}`);
    return `\n[Could not fully access repository ${owner}/${repo}: ${err.message}]\n`;
  }
}

module.exports = { extractGithubUrl, buildRepoContext };