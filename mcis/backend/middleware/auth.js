const getFirebaseAdmin = require('../config/firebaseAdmin');
const logger = require('../services/logger');

const publicApiPaths = [
  { method: 'GET', path: '/github/callback' },
  { method: 'GET', path: '/data-controls/privacy/summary' },
  { method: 'POST', path: '/command' },
  { method: 'POST', path: '/device/pair/start' },
  { method: 'GET', path: '/device/pair/status' },
  { method: 'POST', path: '/voice/transcribe' },
  { method: 'POST', path: '/permissions/grant' },
  { method: 'POST', path: '/emergency/stop' },
  { method: 'POST', path: '/emergency/resume' },
];

function isPublicApiRequest(req) {
  return publicApiPaths.some(
    (route) => route.method === req.method && req.path === route.path
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
    { pattern: /^\/goals\/([^/]+)\/(create-with-breakdown|breakdown|generate-daily-plan|today-plan|review-weekly|adapt|all-with-breakdown|reviews)/ },
    { pattern: /^\/goals\/([^/]+)$/, methods: ['GET'] },
    { pattern: /^\/graph\/([^/]+)/ },
    { pattern: /^\/memory\/nl-delete\/([^/]+)/ },
    { pattern: /^\/memory\/([^/]+)$/, methods: ['GET'] },
    { pattern: /^\/multifile\/([^/]+)/ },
    { pattern: /^\/notifications\/([^/]+)/ },
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

async function authenticateFirebaseUser(req, res, next) {
  if (isPublicApiRequest(req)) return next();

  if (process.env.ALLOW_UNAUTHENTICATED_API === 'true') {
    logger.warn('ALLOW_UNAUTHENTICATED_API=true is enabled. Do not use this in production.');
    return next();
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
