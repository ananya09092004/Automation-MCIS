// backend/services/githubService.js

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const GITHUB_CLIENT_ID     = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const REDIRECT_URI         = process.env.GITHUB_REDIRECT_URI; // e.g. https://your-backend.onrender.com/api/github/callback

class GitHubService {

  // ─── 1. Get OAuth URL (send to frontend) ─────────────────────────────────
  getOAuthURL(userId) {
    const state  = Buffer.from(userId).toString('base64'); // encode userId in state
    const scopes = 'repo,read:user';
    return `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=${scopes}&state=${state}`;
  }

  // ─── 2. Exchange code for token (OAuth callback) ─────────────────────────
  async exchangeCodeForToken(code, state) {
    const userId = Buffer.from(state, 'base64').toString('utf8');

    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept':       'application/json',
      },
      body: JSON.stringify({
        client_id:     GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri:  REDIRECT_URI,
      }),
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error_description);

    // Get GitHub username
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    const githubUser = await userRes.json();

    // Save to Supabase
    await supabase
      .from('user_integrations')
      .upsert([{
        user_id:         userId,
        github_token:    data.access_token,
        github_username: githubUser.login,
        updated_at:      new Date().toISOString(),
      }], { onConflict: 'user_id' });

    return { username: githubUser.login, userId };
  }

  // ─── 3. Get stored token for a user ──────────────────────────────────────
  async getUserToken(userId) {
    const { data, error } = await supabase
      .from('user_integrations')
      .select('github_token, github_username')
      .eq('user_id', userId)
      .single();

    if (error || !data?.github_token) return null;
    return data;
  }

  // ─── 4. Create repo + push code ──────────────────────────────────────────
  async createRepoAndPush(userId, { repoName, description, files }) {
    const integration = await this.getUserToken(userId);
    if (!integration) throw new Error('GitHub not connected. Please connect GitHub first.');

    const { github_token: token, github_username: username } = integration;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept:         'application/vnd.github+json',
    };

    // Check if repo exists
    const checkRes = await fetch(`https://api.github.com/repos/${username}/${repoName}`, { headers });

    let repoUrl;

    if (checkRes.status === 404) {
      // Create new repo
      const createRes = await fetch('https://api.github.com/user/repos', {
        method:  'POST',
        headers,
        body: JSON.stringify({
          name:        repoName,
          description,
          private:     false,
          auto_init:   true,
        }),
      });
      const repo = await createRes.json();
      repoUrl    = repo.html_url;

      // Wait for repo to initialize
      await new Promise(r => setTimeout(r, 2000));
    } else {
      const repo = await checkRes.json();
      repoUrl    = repo.html_url;
    }

    // Push each file
    for (const file of files) {
      await this.pushFile(username, repoName, file.path, file.content, token);
    }

    return {
      repoUrl,
      cloneUrl:   `https://github.com/${username}/${repoName}.git`,
      vsCodeUrl:  `vscode://vscode.git/clone?url=https://github.com/${username}/${repoName}.git`,
      codespacesUrl: `https://github.com/codespaces/new?repo=${username}/${repoName}`,
    };
  }

  // ─── 5. Push a single file to repo ───────────────────────────────────────
  async pushFile(username, repo, filePath, content, token) {
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept:         'application/vnd.github+json',
    };

    // Check if file exists (to get SHA for update)
    const checkRes = await fetch(
      `https://api.github.com/repos/${username}/${repo}/contents/${filePath}`,
      { headers }
    );

    let sha;
    if (checkRes.ok) {
      const existing = await checkRes.json();
      sha = existing.sha;
    }

    const encoded = Buffer.from(content).toString('base64');

    await fetch(`https://api.github.com/repos/${username}/${repo}/contents/${filePath}`, {
      method:  'PUT',
      headers,
      body: JSON.stringify({
        message: `MCIS: Add ${filePath}`,
        content: encoded,
        ...(sha ? { sha } : {}),
      }),
    });
  }

  // ─── 6. Check if user has GitHub connected ───────────────────────────────
  async isConnected(userId) {
    const integration = await this.getUserToken(userId);
    return !!integration;
  }
}

module.exports = new GitHubService();