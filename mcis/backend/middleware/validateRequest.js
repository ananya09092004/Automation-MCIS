/*
  REASON: Input validation
  Pehle: Koi validation nahi thi
  Ab: Har request validate hogi
  Security ke liye zaruri — SQL injection, XSS prevent karo
*/

function validateChat(req, res, next) {
  const { userId, message, chatId } = req.body;

  if (!userId || typeof userId !== 'string' || userId.length > 200) {
    return res.status(400).json({ success: false, error: 'Invalid userId' });
  }

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ success: false, error: 'Message required' });
  }

  if (message.length > 10000) {
    return res.status(400).json({ success: false, error: 'Message too long. Max 10000 chars.' });
  }

  // Basic XSS prevention — script tags remove karo
  req.body.message = message.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

  next();
}

function validateUserId(req, res, next) {
  const userId = req.params.userId || req.body.userId;

  if (!userId || typeof userId !== 'string' || userId.length > 200) {
    return res.status(400).json({ success: false, error: 'Invalid userId' });
  }

  next();
}

module.exports = { validateChat, validateUserId };