/**
 * Job Alerts — minimal full-stack job notification service
 * -----------------------------------------------------------
 * Stack (Render + Neon deployment):
 *  - Auth:          Firebase Authentication (email/password + phone OTP)
 *  - Notifications: Gmail SMTP via Nodemailer (100% free, ~500 emails/day limit)
 *  - Job data:      Arbeitnow public API (free, no key required)
 *  - Database:      Postgres (Neon free tier) — swapped from local SQLite because
 *                    Render's free web service has an EPHEMERAL filesystem; a SQLite
 *                    file would be wiped on every redeploy/restart.
 *  - Scheduler:      Two secret-protected HTTP endpoints (/api/cron/check-instant,
 *                    /api/cron/check-daily), triggered by a free external cron pinger
 *                    (e.g. cron-job.org). This replaces node-cron, because Render's
 *                    free tier spins the service down after 15 min of inactivity —
 *                    an in-process scheduler can't fire while the process is asleep.
 *                    The external pings also incidentally keep the service awake.
 *  - Payments:      Stripe Checkout + Subscriptions (recurring ₹49/month)
 * server.js
 *
 * Local dev setup:
 *  1. npm install
 *  2. Set DATABASE_URL in .env to your Neon connection string (works fine locally too)
 *  3. Everything else is the same as before — Firebase, Gmail, Stripe env vars
 *  4. Add CRON_SECRET — any long random string, protects the two cron endpoints
 *  5. npm start
 */

const express = require("express");
const { Pool } = require("pg");
const nodemailer = require("nodemailer");
const axios = require("axios");
const admin = require("firebase-admin");
require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static("public"));

// ---------- Firebase Admin ----------
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    }),
  });
}

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

function identityOf(reqUser) {
  return reqUser.email || reqUser.phone_number || null;
}

// Protects /api/cron/* from being triggered by anyone who finds the URL.
function requireCronSecret(req, res, next) {
  const provided = req.query.secret || req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || provided !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Invalid or missing cron secret." });
  }
  next();
}

// ---------- DB (Postgres — Neon free tier) ----------
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required for Neon's connection
});

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      firebase_uid TEXT,
      role_keywords TEXT NOT NULL,
      location TEXT DEFAULT '',
      is_subscribed INTEGER DEFAULT 0,
      frequency TEXT DEFAULT 'daily',
      created_at TIMESTAMP DEFAULT NOW(),
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      subscription_status TEXT DEFAULT 'none'
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS sent_jobs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      job_slug TEXT NOT NULL,
      sent_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, job_slug)
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_firebase_uid
    ON users(firebase_uid) WHERE firebase_uid IS NOT NULL;
  `);
  console.log("✅ Postgres schema ready.");
}

// ---------- Email ----------
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
});
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

// ---------- Job fetching ----------
async function fetchLatestJobs() {
  const res = await axios.get("https://www.arbeitnow.com/api/job-board-api");
  return res.data.data;
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

async function alreadySent(userId, jobSlug) {
  const { rows } = await db.query(
    "SELECT 1 FROM sent_jobs WHERE user_id = $1 AND job_slug = $2",
    [userId, jobSlug]
  );
  return rows.length > 0;
}

async function markSent(userId, jobSlug) {
  await db.query(
    "INSERT INTO sent_jobs (user_id, job_slug) VALUES ($1, $2) ON CONFLICT (user_id, job_slug) DO NOTHING",
    [userId, jobSlug]
  );
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

async function notifyUserFromJobs(user, jobs) {
  const candidates = jobs.filter(j => jobMatchesUser(j, user));
  const matches = [];
  for (const j of candidates) {
    if (!(await alreadySent(user.id, j.slug))) matches.push(j);
  }
  let sent = false;
  if (matches.length > 0) {
    sent = await sendEmail(
      user.email,
      `${matches.length} new job match(es) for "${user.role_keywords}"`,
      jobEmailHtml(matches)
    );
    if (sent) for (const j of matches) await markSent(user.id, j.slug);
  }
  return { matches: matches.length, emailed: sent };
}

async function checkAndNotifyUser(user) {
  const jobs = await fetchLatestJobs();
  return notifyUserFromJobs(user, jobs);
}

async function checkAndNotifyAll(frequencyFilter) {
  const { rows: users } = await db.query("SELECT * FROM users WHERE frequency = $1", [frequencyFilter]);
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

app.post("/api/subscribe", requireAuth, async (req, res) => {
  const { role_keywords, location } = req.body;
  const identity = identityOf(req.user);
  const uid = req.user.uid;
  if (!identity) return res.status(400).json({ error: "Your account has no email or phone number on file." });
  if (!role_keywords) return res.status(400).json({ error: "role_keywords is required" });

  await db.query(`
    INSERT INTO users (email, firebase_uid, role_keywords, location)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (email) DO UPDATE SET
      firebase_uid = excluded.firebase_uid,
      role_keywords = excluded.role_keywords,
      location = excluded.location
  `, [identity, uid, role_keywords, location || ""]);

  res.json({ success: true, message: "Preferences saved. You'll get daily job alerts by email." });
});

app.post("/api/create-checkout-session", requireAuth, async (req, res) => {
  const identity = identityOf(req.user);
  const { rows } = await db.query("SELECT * FROM users WHERE email = $1", [identity]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: "Subscribe with a role first, then upgrade." });

  try {
    const customerId = user.stripe_customer_id;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: customerId ? undefined : (req.user.email || undefined),
      customer: customerId || undefined,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${process.env.APP_URL}/?payment=success`,
      cancel_url: `${process.env.APP_URL}/?payment=cancelled`,
      metadata: { app_user_id: String(user.id), identity },
      subscription_data: { metadata: { app_user_id: String(user.id), identity } },
    });
    res.json({ success: true, url: session.url });
  } catch (err) {
    console.error("Create checkout session failed:", err.message);
    res.status(502).json({ error: "Couldn't start checkout. Try again shortly." });
  }
});

app.post("/api/cancel-subscription", requireAuth, async (req, res) => {
  const identity = identityOf(req.user);
  const { rows } = await db.query("SELECT * FROM users WHERE email = $1", [identity]);
  const user = rows[0];
  if (!user || !user.stripe_subscription_id) {
    return res.status(404).json({ error: "No active paid subscription found." });
  }
  try {
    await stripe.subscriptions.cancel(user.stripe_subscription_id);
    await db.query(
      "UPDATE users SET is_subscribed = 0, frequency = 'daily', subscription_status = 'cancelled' WHERE id = $1",
      [user.id]
    );
    res.json({ success: true, message: "Subscription cancelled. You're back on the free daily digest." });
  } catch (err) {
    console.error("Cancel subscription failed:", err.message);
    res.status(502).json({ error: "Couldn't cancel right now. Try again shortly." });
  }
});

app.post("/api/stripe-webhook", async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.rawBody,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`↪️  Stripe webhook: ${event.type}`);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session.metadata?.app_user_id;
    if (userId) {
      await db.query(
        "UPDATE users SET stripe_customer_id = $1, stripe_subscription_id = $2, subscription_status = 'created' WHERE id = $3",
        [session.customer, session.subscription, userId]
      );
    }
  }

  if (event.type === "invoice.paid") {
    const invoice = event.data.object;
    const subscriptionId = invoice.subscription;
    if (subscriptionId) {
      const { rows } = await db.query("SELECT * FROM users WHERE stripe_subscription_id = $1", [subscriptionId]);
      const user = rows[0];
      if (user) {
        await db.query(
          "UPDATE users SET is_subscribed = 1, frequency = 'instant', subscription_status = 'active' WHERE id = $1",
          [user.id]
        );
        console.log(`✅ ${user.email} upgraded to Express Mail (instant) after successful payment.`);
      }
    }
  }

  if (event.type === "customer.subscription.deleted" || event.type === "invoice.payment_failed") {
    const obj = event.data.object;
    const subscriptionId = obj.subscription || obj.id;
    const { rows } = await db.query("SELECT * FROM users WHERE stripe_subscription_id = $1", [subscriptionId]);
    const user = rows[0];
    if (user) {
      const status = event.type === "invoice.payment_failed" ? "payment_failed" : "cancelled";
      await db.query(
        "UPDATE users SET is_subscribed = 0, frequency = 'daily', subscription_status = $1 WHERE id = $2",
        [status, user.id]
      );
      console.log(`⬇️  ${user.email} downgraded to Surface Mail (daily) — ${event.type}.`);
    }
  }

  res.json({ received: true });
});

app.post("/api/unsubscribe", requireAuth, async (req, res) => {
  const identity = identityOf(req.user);
  const { rows } = await db.query("SELECT * FROM users WHERE email = $1", [identity]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: "No subscription found for this account." });

  if (user.stripe_subscription_id && user.subscription_status === "active") {
    try { await stripe.subscriptions.cancel(user.stripe_subscription_id); }
    catch (err) { console.error("Stripe cancel during unsubscribe failed:", err.message); }
  }

  await db.query("DELETE FROM sent_jobs WHERE user_id = $1", [user.id]);
  await db.query("DELETE FROM users WHERE id = $1", [user.id]);
  res.json({ success: true, message: "Unsubscribed. Your preferences and history were deleted." });
});

app.post("/api/check-now", requireAuth, async (req, res) => {
  const identity = identityOf(req.user);
  const { rows } = await db.query("SELECT * FROM users WHERE email = $1", [identity]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: "Subscribe first." });
  const result = await checkAndNotifyUser(user);
  res.json({ checked: 1, ...result });
});

app.get("/api/status", requireAuth, async (req, res) => {
  const identity = identityOf(req.user);
  const { rows } = await db.query(
    "SELECT email, role_keywords, location, is_subscribed, frequency, subscription_status FROM users WHERE email = $1",
    [identity]
  );
  const user = rows[0];
  if (!user) return res.status(404).json({ error: "Not subscribed yet." });
  res.json(user);
});

app.get("/api/profile", requireAuth, async (req, res) => {
  const identity = identityOf(req.user);
  const { rows } = await db.query(
    "SELECT id, email, role_keywords, location, is_subscribed, frequency, subscription_status, created_at FROM users WHERE email = $1",
    [identity]
  );
  const user = rows[0];
  if (!user) return res.status(404).json({ error: "Not subscribed yet." });

  const { rows: countRows } = await db.query("SELECT COUNT(*) AS c FROM sent_jobs WHERE user_id = $1", [user.id]);
  const alertsSent = parseInt(countRows[0].c, 10);

  res.json({
    email: user.email,
    role_keywords: user.role_keywords,
    location: user.location,
    is_subscribed: !!user.is_subscribed,
    verified: !!user.is_subscribed,
    frequency: user.frequency,
    subscription_status: user.subscription_status,
    member_since: user.created_at,
    alerts_sent: alertsSent,
  });
});

app.post("/api/resume/generate", requireAuth, async (req, res) => {
  const identity = identityOf(req.user);
  const { rows } = await db.query("SELECT * FROM users WHERE email = $1", [identity]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: "not_subscribed", message: "Subscribe with a role first." });
  if (!user.is_subscribed) {
    return res.status(403).json({ error: "express_only", message: "AI Resume Builder is only available to Express Mail members." });
  }

  const { full_name, target_role, experience, skills, education } = req.body;
  if (!target_role || !experience) {
    return res.status(400).json({ error: "target_role and experience are required." });
  }

  const prompt = `Write a concise, ATS-friendly, one-page resume in plain text (no markdown symbols) for this candidate. Use clear section headings (SUMMARY, EXPERIENCE, SKILLS, EDUCATION) in capitals, and keep bullet points action-oriented and quantified where possible.

Name: ${full_name || "Candidate"}
Target role: ${target_role}
Experience: ${experience}
Skills: ${skills || "Not specified — infer reasonable ones from the target role and experience."}
Education: ${education || "Not specified."}`;

  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      { model: "claude-sonnet-4-6", max_tokens: 1500, messages: [{ role: "user", content: prompt }] },
      { headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
    );
    const resumeText = response.data.content.map(block => block.text || "").join("\n");
    res.json({ success: true, resume: resumeText });
  } catch (err) {
    console.error("Resume generation failed:", err.response?.data || err.message);
    res.status(502).json({ error: "generation_failed", message: "Couldn't generate the resume right now. Try again shortly." });
  }
});

// ---------- Cron trigger endpoints (called by an external pinger, e.g. cron-job.org) ----------
// GET so a simple scheduled HTTP-GET service can call them directly.
// Protected by CRON_SECRET so nobody else can trigger mass emails on demand.
app.get("/api/cron/check-instant", requireCronSecret, async (req, res) => {
  try {
    const result = await checkAndNotifyAll("instant");
    console.log("⏱️  Cron (instant):", result);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("Cron (instant) failed:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/cron/check-daily", requireCronSecret, async (req, res) => {
  try {
    const result = await checkAndNotifyAll("daily");
    console.log("⏱️  Cron (daily):", result);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("Cron (daily) failed:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Job Alerts running on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error("❌ Failed to initialize database:", err.message);
    process.exit(1);
  });