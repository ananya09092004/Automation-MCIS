const express = require('express');
const http = require('http');
const cors = require('cors');
const fs = require('fs');
const helmet = require('helmet');
require('dotenv').config();
const authenticateFirebaseUser = require('./middleware/auth');
const jobsRouter = require('./routes/jobs');
const notificationsRoute = require('./routes/notifications');
const commandCenterRoute = require('./routes/commandCenter');
const dataControlsRoute = require('./routes/dataControls');
const chatRoute = require('./routes/chat');
const uploadRoute = require('./routes/upload');
const memoryRoute = require('./routes/memory');
const imageRoute = require('./routes/image');
const voiceRoute = require('./routes/voice');
const goalsRoute = require('./routes/goals');
const eventsRoute = require('./routes/events');
const analyticsRoute = require('./routes/analytics');
const errorHandler = require('./middleware/errorHandler');
const requestLogger = require('./middleware/logger');
const winstonLogger = require('./services/logger');
const sanitizeInput = require('./middleware/sanitizer');
const graphRoute = require('./routes/graph');
const profileRoute = require('./routes/profile');
const app = express();
const futureRoute = require('./routes/future');
const twinRoute = require('./routes/twin');
const timelineRoute = require('./routes/timeline');
const codingRoute = require('./routes/coding');
const codeWithPipelineRoute = require('./routes/codeWithPipeline');
const codeQualityRoute = require('./routes/codeQuality');
const sandboxRoutes = require('./routes/sandbox');
const githubRoutes = require('./routes/github');
const multifileRoutes = require('./routes/multifile');
const { attachAgentSocket } = require('./agentSocket');
const commandRoute = require('./backend-routing/commandRoute');
const deviceRoute = require('./routes/device');
const devicePairing = require('./backend-addon/devicePairing');
const permissionsRoute = require('./routes/permissions');
const emergencyStopRoute = require('./routes/emergencyStop');
// Was never mounted anywhere, even though hybridOrchestrator.js and this
// route both existed in the repo — /:userId/execute-goal was unreachable.
const hybridRoute = require('./routes/hybrid');
// ================================
// Middleware
// ================================
const allowedOrigins = (process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
console.log('DEBUG allowedOrigins:', allowedOrigins);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", ...allowedOrigins],
    },
  },
  crossOriginEmbedderPolicy: false
}));

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(sanitizeInput);

// Request logging middleware
app.use(requestLogger);

// Winston — har request log karo
app.use((req, res, next) => {
  winstonLogger.info(`${req.method} ${req.path}`);
  next();
});


// ================================
// Security Headers
// ================================
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});


// ================================
// Uploads Folder
// ================================
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}


// ================================
// Health Check
// ================================
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});


// ================================
// Routes
// ================================
try {
  app.use('/api', authenticateFirebaseUser);
  app.use('/api/chat', chatRoute);
  app.use('/api/upload', uploadRoute);
  app.use('/api/memory', memoryRoute);
  app.use('/api/image', imageRoute);
  app.use('/api/voice', voiceRoute);
  app.use('/api/goals', goalsRoute);
  app.use('/api/jobs', jobsRouter);
  app.use('/api/notifications', notificationsRoute);
  app.use('/api/command-center', commandCenterRoute);
  app.use('/api/data-controls', dataControlsRoute);
  app.use('/api/events', eventsRoute);
  app.use('/api/analytics', analyticsRoute);
  app.use('/api/graph', graphRoute);
  app.use('/api/profile', profileRoute);
  app.use('/api/twin', twinRoute);
  app.use('/api/future', futureRoute);
  app.use('/api/timeline', timelineRoute);
  app.use('/api/coding', codingRoute);
  app.use('/api/code-quality', codeQualityRoute);
  app.use('/api/code-pipeline', codeWithPipelineRoute);
  app.use('/api/sandbox', sandboxRoutes);
  app.use('/api/github', githubRoutes);
  app.use('/api/multifile', multifileRoutes);
  app.use('/api/command', commandRoute);
  app.use('/api/permissions', permissionsRoute);
  app.use('/api/hybrid', hybridRoute);
  app.use('/api/device', deviceRoute);
  app.use('/api/device', devicePairing);
  app.use('/api/emergency', emergencyStopRoute);
  winstonLogger.info('All routes loaded ✅');
} catch (err) {
  winstonLogger.error(`Route loading error: ${err.message}`);
}


// ================================
// Root Route
// ================================
app.get('/', (req, res) => {
  res.json({
    message: 'MCIS Backend Running!',
    version: '1.0.0',
    endpoints: [
      '/api/chat',
      '/api/upload',
      '/api/memory',
      '/api/image',
      '/api/voice',
      '/api/goals',
      '/api/command-center',
      '/api/data-controls',
      '/health'
    ]
  });
});
// ================================
// 404 Handler
// ================================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found'
  });
});


// ================================
// Global Error Handler
// ================================
app.use((err, req, res, next) => {
  winstonLogger.error(`${err.message} | Route: ${req.path}`);
  res.status(500).json({ success: false, error: 'Something went wrong' });
});

app.use(errorHandler);


// ================================
// Server Start
// ================================
const PORT = process.env.PORT || 5000;

const server = http.createServer(app);
attachAgentSocket(server);

server.listen(PORT, '0.0.0.0', () => {

  winstonLogger.info(`MCIS Server running on port ${PORT}`);
  winstonLogger.info(`Health check: http://localhost:${PORT}/health`);
});


// ================================
// Unhandled Errors
// ================================
process.on('unhandledRejection', (err) => {
  winstonLogger.error(`Unhandled Rejection: ${err.message}`);
});

process.on('uncaughtException', (err) => {
  winstonLogger.error(`Uncaught Exception: ${err.message}`);
});
