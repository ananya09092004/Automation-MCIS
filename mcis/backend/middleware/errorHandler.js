/*
  REASON: Centralized error handling
  Pehle: Har route mein alag try/catch
  Ab: Ek jagah se sab errors handle
  Production mein zaruri hai
*/
const errorHandler = (err, req, res, next) => {
  console.error(`[ERROR] ${new Date().toISOString()} — ${req.method} ${req.path}`);
  console.error(err.message);

  // Rate limit error
  if (err.status === 429) {
    return res.status(429).json({
      success: false,
      error: 'Too many requests. Please wait.'
    });
  }

  // File too large
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      success: false,
      error: 'File too large. Max 10MB allowed.'
    });
  }

  // Default error
  res.status(err.status || 500).json({
    success: false,
    error: process.env.NODE_ENV === 'production'
      ? 'Something went wrong'
      : err.message
  });
};

module.exports = errorHandler;