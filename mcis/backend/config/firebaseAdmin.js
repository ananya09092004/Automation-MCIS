const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

function parseServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }

  const serviceAccountPath =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    path.join(__dirname, '..', 'firebase-service-account.json');

  if (fs.existsSync(serviceAccountPath)) {
    return JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
  }

  if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  ) {
    return {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
  }

  return null;
}

function getFirebaseAdmin() {
  if (admin.apps.length) return admin;

  const serviceAccount = parseServiceAccount();

  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    return admin;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
    return admin;
  }

  throw new Error('Firebase Admin credentials are not configured.');
}

module.exports = getFirebaseAdmin;
