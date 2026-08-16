/*
  REASON: Request logging
  Pehle: Koi logs nahi the
  Ab: Har request log hogi
  Debug aur monitoring ke liye zaruri
*/
const logger = (req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const status = res.statusCode;
    const color = status >= 500 ? '❌' : status >= 400 ? '⚠️' : '✅';

    console.log(
      `${color} ${req.method} ${req.path} — ${status} — ${duration}ms`
    );
  });

  next();
};

module.exports = logger;