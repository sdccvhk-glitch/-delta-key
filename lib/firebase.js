const admin = require("firebase-admin");

let app = null;
let db = null;

function initFirebase() {
  if (app) return { app, db };

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!raw) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT environment variable is not set. " +
      "Add your Firebase service account JSON (as a single-line string) " +
      "in Vercel Project Settings -> Environment Variables."
    );
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the full service " +
      "account JSON file content as-is into the environment variable."
    );
  }

  // Vercel sometimes stores newlines in env vars as literal \n sequences.
  if (serviceAccount.private_key && serviceAccount.private_key.includes("\\n")) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  app = admin.apps.length
    ? admin.app()
    : admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });

  db = admin.firestore();

  return { app, db };
}

module.exports = { initFirebase };
