/**
 * Job Alerts — minimal full-stack job notification service
 * -----------------------------------------------------------
 * Free stack used:
 *  - Auth:          Firebase Authentication (email/password)
 *  - Notifications: Gmail SMTP via Nodemailer (100% free, ~500 emails/day limit)
 *  - Job data:      Arbeitnow public API (free, no key required)
 *  - Database:      SQLite file (zero setup, no external DB server)
 *  - Scheduler:      node-cron (free, in-process)
 * server.js
 * Setup:
 *  1. npm install
 *  2. Create a Firebase project -> Authentication -> Sign-in method -> enable Email/Password
 *  3. Firebase console -> Project settings -> Service accounts -> Generate new private key
 *     (this gives you FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY)
 *  4. Create a Gmail "App Password" (Google Account > Security > App Passwords)
 *  5. Copy .env.example to .env and fill in every value
 *  6. npm start
 *  7. Open http://localhost:3000
 */

const express = require("express");
const Database = require("better-sqlite3");
const nodemailer = require("nodemailer");
const cron = require("node-cron");
const axios = require("axios");
const admin = require("firebase-admin");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

// ---------- Firebase Admin (verifies ID tokens sent by the frontend) ----------
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // .env files can't hold real newlines, so the key is stored with literal \n and unescaped here
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    }),
  });
}

// Verifies the "Authorization: Bearer <idToken>" header the frontend sends.
// On success, req.user = { uid, email, ... } straight from Firebase — never trust
// an email/uid coming from the request body instead of this.
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Please log in first." });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch (err) {
    console.error("Token verification failed:", err.message);
    return res.status(401).json({ error: "Your session expired. Please log in again." });
  }
}

// ---------- DB (SQLite, file-based, zero setup) ----------
const db = new Database("job_alerts.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    firebase_uid TEXT,
    role_keywords TEXT NOT NULL,       -- comma separated, e.g. "frontend,react developer"
    location TEXT DEFAULT '',           -- optional filter, blank = anywhere/remote
    is_subscribed INTEGER DEFAULT 0,    -- 0 = free plan, 1 = paid plan (Rs 49/mo)
    frequency TEXT DEFAULT 'daily',     -- 'instant' (paid only) or 'daily'
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sent_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    job_slug TEXT NOT NULL,
    sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, job_slug)
  );
`);
// Safe migration for databases created before firebase_uid existed.
try { db.exec("ALTER TABLE users ADD COLUMN firebase_uid TEXT"); } catch (e) { /* column already exists */ }
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid) WHERE firebase_uid IS NOT NULL");

// ---------- Email (free — Gmail SMTP) ----------
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// Fail loudly at startup instead of silently at send-time — this is the #1 reason
// "emails aren't arriving": wrong app password, 2FA not enabled, or typo in GMAIL_USER.
transporter.verify((err) => {
  if (err) console.error("❌ Email transporter could NOT connect:", err.message);
  else console.log("✅ Gmail SMTP connected — emails will send.");
});

async function sendEmail(to, subject, html) {
  try {
    const info = await transporter.sendMail({ from: process.env.GMAIL_USER, to, subject, html });
    console.log(`✅ Email sent to ${to} (${subject}) — id ${info.messageId}`);
    return true;
  } catch (err) {
    console.error(`❌ Email to ${to} failed:`, err.message);
    return false;
  }
}

// ---------- Job fetching (free — Arbeitnow public API, no key) ----------
async function fetchLatestJobs() {
  const res = await axios.get("https://www.arbeitnow.com/api/job-board-api");
  return res.data.data; // array of { slug, title, company_name, location, url, description, remote, tags... }
}

// ---------- Matching ----------
function jobMatchesUser(job, user) {
  const keywords = user.role_keywords.toLowerCase().split(",").map(k => k.trim()).filter(Boolean);
  const haystack = `${job.title} ${job.tags?.join(" ") || ""}`.toLowerCase();
  const keywordMatch = keywords.some(k => haystack.includes(k));

  if (!keywordMatch) return false;

  if (user.location) {
    const loc = user.location.toLowerCase();
    const jobLoc = (job.location || "").toLowerCase();
    const isRemoteOk = loc === "remote" && job.remote;
    if (!jobLoc.includes(loc) && !isRemoteOk) return false;
  }
  return true;
}

function alreadySent(userId, jobSlug) {
  return !!db.prepare("SELECT 1 FROM sent_jobs WHERE user_id = ? AND job_slug = ?").get(userId, jobSlug);
}

function markSent(userId, jobSlug) {
  db.prepare("INSERT OR IGNORE INTO sent_jobs (user_id, job_slug) VALUES (?, ?)").run(userId, jobSlug);
}

function jobEmailHtml(jobs) {
  return `
    <h2>New job matches for you 🎯</h2>
    ${jobs.map(j => `
      <div style="margin-bottom:16px;padding:12px;border:1px solid #eee;border-radius:8px;">
        <a href="${j.url}" style="font-size:16px;color:#1a0dab;text-decoration:none;"><b>${j.title}</b></a>
        <div style="color:#555;">${j.company_name} — ${j.location || (j.remote ? "Remote" : "")}</div>
      </div>
    `).join("")}
    <p style="color:#888;font-size:12px;">You're receiving this because you subscribed to job alerts. Upgrade to the Rs 49/month plan for instant alerts instead of the daily digest.</p>
  `;
}

// ---------- Core: match a pre-fetched job list against one user, and email if needed ----------
async function notifyUserFromJobs(user, jobs) {
  const matches = jobs.filter(j => jobMatchesUser(j, user) && !alreadySent(user.id, j.slug));
  let sent = false;
  if (matches.length > 0) {
    sent = await sendEmail(
      user.email,
      `${matches.length} new job match(es) for "${user.role_keywords}"`,
      jobEmailHtml(matches)
    );
    if (sent) matches.forEach(j => markSent(user.id, j.slug));
  }
  return { matches: matches.length, emailed: sent };
}

// ---------- Core: check jobs and notify one user (fetches fresh — used by manual "Check now") ----------
async function checkAndNotifyUser(user) {
  const jobs = await fetchLatestJobs();
  return notifyUserFromJobs(user, jobs);
}

// ---------- Core: check jobs and notify everyone on a plan (used by cron) ----------
// Fetches the job list ONCE per run and reuses it for every subscriber on this
// frequency, instead of re-fetching per user.
async function checkAndNotifyAll(frequencyFilter) {
  const users = db.prepare("SELECT * FROM users WHERE frequency = ?").all(frequencyFilter);
  if (users.length === 0) return { checked: 0, notified: 0 };

  const jobs = await fetchLatestJobs();
  let notified = 0;
  for (const user of users) {
    const { matches, emailed } = await notifyUserFromJobs(user, jobs);
    if (matches > 0 && emailed) notified++;
  }
  return { checked: users.length, notified };
}

// ---------- Routes ----------

// Preview matches for a role/location without saving anything — no login required,
// this reads nobody's data and just filters the live job feed on the fly.
app.get("/api/preview", async (req, res) => {
  const role_keywords = (req.query.role_keywords || "").toString();
  const location = (req.query.location || "").toString();
  if (!role_keywords) return res.status(400).json({ error: "role_keywords is required" });

  try {
    const jobs = await fetchLatestJobs();
    const fakeUser = { role_keywords, location };
    const matches = jobs.filter(j => jobMatchesUser(j, fakeUser));
    res.json({ jobs: matches.slice(0, 10) });
  } catch (err) {
    console.error("Preview failed:", err.message);
    res.status(502).json({ error: "Couldn't reach the job feed right now. Try again shortly." });
  }
});

// Sign up / update job alert preferences — tied to the logged-in Firebase account.
// Email comes from the verified token, never from the request body, so nobody can
// create or edit another person's subscription.
app.post("/api/subscribe", requireAuth, async (req, res) => {
  const { role_keywords, location } = req.body;
  const email = req.user.email;
  const uid = req.user.uid;
  if (!email) return res.status(400).json({ error: "Your account has no email on file." });
  if (!role_keywords) return res.status(400).json({ error: "role_keywords is required" });

  db.prepare(`
    INSERT INTO users (email, firebase_uid, role_keywords, location)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      firebase_uid = excluded.firebase_uid,
      role_keywords = excluded.role_keywords,
      location = excluded.location
  `).run(email, uid, role_keywords, location || "");

  res.json({ success: true, message: "Preferences saved. You'll get daily job alerts by email." });
});

// Upgrade to paid plan (Rs 49/month) — payment gateway plug-in point.
// Wire Razorpay's checkout here later; for now this flips the flag after a mock "payment",
// but only for the account that is actually logged in.
app.post("/api/upgrade", requireAuth, (req, res) => {
  const email = req.user.email;
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) return res.status(404).json({ error: "Subscribe first, then upgrade." });

  db.prepare("UPDATE users SET is_subscribed = 1, frequency = 'instant' WHERE email = ?").run(email);
  res.json({ success: true, message: "Upgraded! You'll now get instant alerts instead of the daily digest." });
});

// Unsubscribe — deletes preferences and send history for the logged-in account.
app.post("/api/unsubscribe", requireAuth, (req, res) => {
  const email = req.user.email;
  const user = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (!user) return res.status(404).json({ error: "No subscription found for this account." });

  db.prepare("DELETE FROM sent_jobs WHERE user_id = ?").run(user.id);
  db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
  res.json({ success: true, message: "Unsubscribed. Your preferences and history were deleted." });
});

// Manually trigger a check for the LOGGED-IN user only (handy for testing without
// waiting for the cron, and without spamming every other user on the platform).
app.post("/api/check-now", requireAuth, async (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(req.user.email);
  if (!user) return res.status(404).json({ error: "Subscribe first." });
  const result = await checkAndNotifyUser(user);
  res.json({ checked: 1, ...result });
});

// Status — only ever returns the logged-in user's own record.
app.get("/api/status", requireAuth, (req, res) => {
  const user = db.prepare(
    "SELECT email, role_keywords, location, is_subscribed, frequency FROM users WHERE email = ?"
  ).get(req.user.email);
  if (!user) return res.status(404).json({ error: "Not subscribed yet." });
  res.json(user);
});

// ---------- Cron schedules (batch jobs, unaffected by auth) ----------
// Paid users: check every 15 min for near-instant alerts
cron.schedule("*/15 * * * *", () => checkAndNotifyAll("instant").catch(console.error));
// Free users: once a day at 9am server time
cron.schedule("0 9 * * *", () => checkAndNotifyAll("daily").catch(console.error));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Job Alerts running on http://localhost:${PORT}`));