const getFirebaseAdmin = require('../config/firebaseAdmin');
const logger = require('../services/logger');

const publicApiPaths = [
  { method: 'GET', path: '/github/callback' },
  { method: 'GET', path: '/oauth/google_drive/callback' }, // Layer 9: forwards code/state to the app in the URL fragment only
  { method: 'GET', path: '/data-controls/privacy/summary' },
  { method: 'POST', path: '/command' },
  { method: 'POST', path: '/device/pair/start' },
  { method: 'GET', path: '/device/pair/status' },
  { method: 'POST', path: '/permissions/grant' },
  { method: 'POST', path: '/emergency/stop' },
  { method: 'POST', path: '/emergency/resume' },
];

const publicApiPathPatterns = [
  { method: 'GET', pattern: /^\/command\/goal\/[^/]+\/status$/ },
  { method: 'POST', pattern: /^\/command\/goal\/[^/]+\/answer$/ },
];

function isPublicApiRequest(req) {
  if (publicApiPaths.some((route) => route.method === req.method && req.path === route.path)) {
    return true;
  }
  return publicApiPathPatterns.some(
    (route) => route.method === req.method && route.pattern.test(req.path)
  );
}

function getRequestedUserIds(req) {
  const ids = [];

  if (typeof req.params?.userId === 'string') ids.push(req.params.userId);
  if (typeof req.body?.userId === 'string') ids.push(req.body.userId);
  if (typeof req.query?.userId === 'string') ids.push(req.query.userId);
  ids.push(...getUserIdsFromApiPath(req.method, req.path));

  return [...new Set(ids.filter(Boolean))];
}

function getUserIdsFromApiPath(method, path) {
  const pathOnly = path.split('?')[0];
  const patterns = [
    { pattern: /^\/analytics\/([^/]+)/ },
    { pattern: /^\/chat\/chats\/([^/]+)/, methods: ['GET'] },
    { pattern: /^\/chat\/messages\/([^/]+)/ },
    { pattern: /^\/chat\/search\/([^/]+)/ },
    { pattern: /^\/chat\/welcome\/([^/]+)/ },
    { pattern: /^\/code-quality\/([^/]+)/ },
    { pattern: /^\/coding\/([^/]+)/ },
    { pattern: /^\/command-center\/([^/]+)/ },
    { pattern: /^\/data-controls\/([^/]+)(?:\/|$)/ },
    { pattern: /^\/events\/([^/]+)/ },
    { pattern: /^\/future\/([^/]+)/ },
    { pattern: /^\/github\/connect\/([^/]+)/ },
    { pattern: /^\/github\/disconnect\/([^/]+)/ },
    { pattern: /^\/github\/status\/([^/]+)/ },
    // P-SEC-7 (security hardening, pre-launch, D2): this alternation had
    // drifted out of sync with routes/goals.js -- "report" (GET
    // /:userId/report/weekly) was missing, so this middleware extracted no
    // userId for that path and let a cross-user request through untouched.
    // Fixed here, but routes/goals.js now also enforces ownership inline,
    // in the route handlers themselves, so this list drifting again won't
    // silently reopen the same gap for that file.
    { pattern: /^\/goals\/([^/]+)\/(create-with-breakdown|breakdown|generate-daily-plan|today-plan|review-weekly|adapt|all-with-breakdown|reviews|report)/ },
    { pattern: /^\/goals\/([^/]+)$/, methods: ['GET'] },
    { pattern: /^\/graph\/([^/]+)/ },
    { pattern: /^\/memory\/nl-delete\/([^/]+)/ },
    { pattern: /^\/memory\/([^/]+)$/, methods: ['GET'] },
    { pattern: /^\/multifile\/([^/]+)/ },
    // Layer 9: only GET /notifications/:userId carries a user id; PATCH /:id/read and DELETE /:id carry a notification id (owner-checked in the route).
    { pattern: /^\/notifications\/([^/]+)$/, methods: ['GET'] },
    { pattern: /^\/profile\/([^/]+)/ },
    { pattern: /^\/sandbox\/([^/]+)/ },
    { pattern: /^\/timeline\/([^/]+)/ },
    { pattern: /^\/twin\/([^/]+)/ },
  ];

  return patterns
    .filter(({ methods }) => !methods || methods.includes(method))
    .map(({ pattern }) => pathOnly.match(pattern)?.[1])
    .filter(Boolean)
    .filter((id) => id.length <= 200);
}

let warnedBypassInProduction = false;

async function authenticateFirebaseUser(req, res, next) {
  if (isPublicApiRequest(req)) return next();

  // P3.17 / Layer 9 -- this was missing the same NODE_ENV!=='production'
  // guard that backend-routing/resolveUserId.js's devBypassUserId() already
  // enforces for the exact same escape hatch. Before this fix, a stray
  // ALLOW_UNAUTHENTICATED_API=true left over from a dev .env (or copied
  // into production by mistake) would bypass auth for every route in this
  // file, in production, contradicting .env.example's own "NEVER set this
  // in production" warning and the one other place in the codebase that
  // reads this same variable. Now both call sites agree: the escape hatch
  // only works outside production, no matter how the variable is set --
  // and in production, the misconfiguration is logged once instead of
  // silently ignored, so it gets noticed and cleaned up.
  if (process.env.ALLOW_UNAUTHENTICATED_API === 'true') {
    if (process.env.NODE_ENV === 'production') {
      if (!warnedBypassInProduction) {
        warnedBypassInProduction = true;
        logger.error('ALLOW_UNAUTHENTICATED_API=true is IGNORED because NODE_ENV=production. Authentication stays on.');
      }
    } else {
      logger.warn('ALLOW_UNAUTHENTICATED_API=true is enabled. Do not use this in production.');
      return next();
    }
  }

  const authHeader = req.headers.authorization || '';
  const [, token] = authHeader.match(/^Bearer\s+(.+)$/i) || [];

  if (!token) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  try {
    const admin = getFirebaseAdmin();
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || null,
      claims: decodedToken,
    };

    const requestedUserIds = getRequestedUserIds(req);
    const mismatchedUserId = requestedUserIds.find((id) => id !== decodedToken.uid);

    if (mismatchedUserId) {
      logger.warn(`Blocked userId mismatch. Auth=${decodedToken.uid} Requested=${mismatchedUserId}`);
      return res.status(403).json({ success: false, error: 'Forbidden for this user' });
    }

    next();
  } catch (err) {
    if (
      process.env.NODE_ENV !== 'production' &&
      err.message === 'Firebase Admin credentials are not configured.'
    ) {
      logger.warn('Firebase Admin credentials missing. Allowing unauthenticated API in development only.');
      return next();
    }

    logger.warn(`Firebase auth failed: ${err.message}`);
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

module.exports = authenticateFirebaseUser;