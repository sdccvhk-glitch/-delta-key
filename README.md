# DELTA.KEYS — Vercel + Firestore edition

This version is restructured to run on Vercel's serverless platform, using
Firebase Firestore for storage instead of a local JSON file (Vercel's
filesystem is read-only, so it cannot persist data between requests).

## What changed from the original version

- `server.js` → `api/index.js` (Vercel expects an exported Express app under `api/`, not an `app.listen()` script)
- Local JSON file storage → Firestore (`lib/store.js`, `lib/firebase.js`)
- Telegram: background polling loop removed (serverless functions can't run infinite loops) → replaced with a webhook endpoint at `/api/telegram/webhook`
- `public/` folder (all customer/admin frontend files) is **unchanged**

## 1. Firebase setup

1. In Firebase Console, go to **Project Settings → Service Accounts**.
2. **Important:** if you ever pasted your service account key into a chat, an
   email, or a public place, treat it as compromised. Click **Generate New
   Private Key** to issue a fresh one and ignore/delete the old key.
3. Download the JSON file. Do not commit it to git or paste it anywhere
   public — it grants full admin access to your Firebase project.
4. In **Firestore Database**, create a database if you haven't already
   (production mode is fine; this app only touches it through the trusted
   service account, never from the browser).

## 2. Vercel environment variables

In your Vercel project: **Settings → Environment Variables**, add:

| Name | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | The entire downloaded JSON file content, as one line |
| `ADMIN_USER` | Your chosen admin username (default `admin`) |
| `ADMIN_PASSWORD` | Your chosen admin password (used only the first time the store is created) |
| `UPI_ID` | Your UPI ID, e.g. `yourname@upi` |
| `PAYMENT_PAYEE_NAME` | Name shown to customers, e.g. `DELTA.KEYS` |
| `TELEGRAM_BOT_TOKEN` | (optional) Telegram bot token |
| `TELEGRAM_ADMIN_CHAT_ID` | (optional) Your Telegram chat ID |

For `FIREBASE_SERVICE_ACCOUNT`, easiest way to get a one-line value: open the
downloaded JSON in a text editor and remove the line breaks, or run:

```bash
node -e "console.log(JSON.stringify(require('./your-downloaded-file.json')))"
```

Paste that single-line output as the variable's value.

Never commit `.env`, `.env.local`, or the downloaded service account JSON to
git — `.gitignore` in this project already excludes them.

## 3. Deploy

```bash
npm install
vercel        # first deploy, follow prompts
vercel --prod # promote to production
```

Or connect the GitHub repo in the Vercel dashboard and it will build
automatically on every push.

## 4. Telegram webhook (only if you set the Telegram env vars)

After deployment, tell Telegram where to send updates by calling this once
(replace values):

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<your-vercel-domain>/api/telegram/webhook"
```

If you don't set `TELEGRAM_BOT_TOKEN` / `TELEGRAM_ADMIN_CHAT_ID` at all, the
Telegram feature is simply disabled — orders can still be approved normally
from the admin panel.

## 5. First login

Visit `https://<your-vercel-domain>/admin`, log in with the `ADMIN_USER` /
`ADMIN_PASSWORD` you set in step 2 (default in this project: `admin` /
`admin123`). This is a weak, publicly-known password — change it immediately
from Settings once you're in. After that, the password is stored (hashed) in
Firestore, not in the environment variable.

## Local testing (optional)

```bash
npm install
FIREBASE_SERVICE_ACCOUNT='...' ADMIN_PASSWORD=test1234 npm start
```

This runs the same `api/index.js` app with a plain `app.listen()` wrapper
(`local-dev-server.js`) for local testing only — Vercel itself never uses that
file.
