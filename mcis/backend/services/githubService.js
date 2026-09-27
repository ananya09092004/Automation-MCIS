// backend/services/githubService.js
//
// Layer 6: legacy per-user GitHub OAuth, now backed by the encrypted Layer 5
// integration store (services/security/githubOAuth.js). What changed:
//   - state: was base64(userId) (guessable, replayable); now 32 random bytes,
//     hashed server-side, bound to user + personal workspace + provider,
//     10-minute expiry, single use (services/security/oauthStateService.js)
//   - token storage: was plaintext user_integrations.github_token; now
//     AES-256-GCM in integration_credentials. The legacy column is never read
//     or written here (a DB trigger rejects new plaintext writes; existing rows
//     are moved by scripts/migrate-legacy-github-tokens.js)
//   - tokens never appear in logs, responses or errors
//   - repo/file names are validated and path segments encoded, so a file path
//     like "../../user/keys" can no longer reach other GitHub API endpoints
// The public API (getOAuthURL / exchangeCodeForToken / getUserToken /
// createRepoAndPush / isConnected) keeps its shape for existing callers.

const { getDefaultGithubAccountService } = require('./security/githubOAuth');

const REPO_NAME_RE = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

function accounts() {
  return getDefaultGithubAccountService();
}

function encodeRepoPath(filePath) {
  const parts = String(filePath || '').replace(/\\/g, '/').split('/').filter((p) => p !== '');
  if (!parts.length || parts.length > 50 || parts.some((p) => p === '.' || p === '..' || p.length > 255)) {
    throw new Error(`Invalid file path in project: ${String(filePath).slice(0, 100)}`);
  }
  return parts.map(encodeURIComponent).join('/');
}

class GitHubService {
  // ─── 1. Get OAuth URL (send to frontend) ─────────────────────────────────
  async getOAuthURL(userId) {
    return accounts().startUserConnect(userId);
  }

  // ─── 2. Exchange code for token (OAuth callback) ─────────────────────────
  async exchangeCodeForToken(code, state) {
    return accounts().completeUserConnect({ code, state });
  }

  // ─── 3. Stored connection for a user (server-side use only) ──────────────
  // Returns { github_token, github_username } for existing internal callers.
  async getUserToken(userId) {
    const t = await accounts().getUserToken(userId);
    return t ? { github_token: t.token, github_username: t.username } : null;
  }

  async getStatus(userId) {
    return accounts().status(userId);
  }

  async disconnect(userId) {
    return accounts().disconnectUser(userId);
  }

  // ─── 4. Create repo + push code ──────────────────────────────────────────
  async createRepoAndPush(userId, { repoName, description, files }) {
    if (typeof repoName !== 'string' || !REPO_NAME_RE.test(repoName)) throw new Error('Invalid repository name.');
    if (!Array.isArray(files) || !files.length || files.length > 500) throw new Error('files must be a non-empty array (max 500).');
    const paths = files.map((f) => encodeRepoPath(f && f.path)); // validate ALL before any write
    const integration = await this.getUserToken(userId);
    if (!integration) throw new Error('GitHub not connected. Please connect GitHub first.');

    const { github_token: token, github_username: username } = integration;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
    };
    const repoPath = `${encodeURIComponent(username)}/${encodeURIComponent(repoName)}`;

    // Check if repo exists
    const checkRes = await fetch(`https://api.github.com/repos/${repoPath}`, { headers });

    let repoUrl;

    if (checkRes.status === 404) {
      const createRes = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: repoName,
          description: typeof description === 'string' ? description.slice(0, 350) : undefined,
          private: false,
          auto_init: true,
        }),
      });
      if (!createRes.ok) throw new Error(`GitHub refused to create the repository (HTTP ${createRes.status}).`);
      const repo = await createRes.json();
      repoUrl = repo.html_url;

      // Wait for repo to initialize
      await new Promise((r) => setTimeout(r, 2000));
    } else if (checkRes.ok) {
      const repo = await checkRes.json();
      repoUrl = repo.html_url;
    } else {
      throw new Error(`Could not access the repository (HTTP ${checkRes.status}).`);
    }

    for (let i = 0; i < files.length; i++) {
      await this.pushFile(repoPath, paths[i], files[i].path, files[i].content, token);
    }

    return {
      repoUrl,
      cloneUrl: `https://github.com/${username}/${repoName}.git`,
      vsCodeUrl: `vscode://vscode.git/clone?url=https://github.com/${username}/${repoName}.git`,
      codespacesUrl: `https://github.com/codespaces/new?repo=${username}/${repoName}`,
    };
  }

  // ─── 5. Push a single file to repo ───────────────────────────────────────
  async pushFile(repoPath, encodedPath, displayPath, content, token) {
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
    };
    const url = `https://api.github.com/repos/${repoPath}/contents/${encodedPath}`;
    const checkRes = await fetch(url, { headers });

    let sha;
    if (checkRes.ok) {
      const existing = await checkRes.json();
      sha = existing.sha;
    }

    const encoded = Buffer.from(String(content ?? '')).toString('base64');

    const put = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `MCIS: Add ${String(displayPath).slice(0, 200)}`,
        content: encoded,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!put.ok) throw new Error(`GitHub rejected ${String(displayPath).slice(0, 200)} (HTTP ${put.status}).`);
  }

  // ─── 6. Check if user has GitHub connected ───────────────────────────────
  async isConnected(userId) {
    return (await accounts().status(userId)).connected;
  }
}

module.exports = new GitHubService();
module.exports.encodeRepoPath = encodeRepoPath;
