# Job Alerts

A minimal job-notification subscription service. Free tier: daily email digest.
Paid tier (₹49/month, plug in Razorpay): instant alerts checked every 15 min.

## Why everything here is free
| Piece | Tool | Cost |
|---|---|---|
| Notifications | Gmail SMTP (Nodemailer) | Free, ~500 emails/day |
| Job listings | [Arbeitnow public API](https://www.arbeitnow.com/api/job-board-api) | Free, no key |
| Database | SQLite file (`better-sqlite3`) | Free, no server needed |
| Scheduler | `node-cron` | Free, runs in-process |

## Setup (5 min)
1. `npm install`
2. Get a Gmail **App Password**: Google Account → Security → 2-Step Verification → App Passwords → generate one for "Mail".
3. `cp .env.example .env` and fill in `GMAIL_USER` and `GMAIL_APP_PASSWORD`.
4. `npm start`
5. Open `http://localhost:3000`, subscribe with a role like `frontend developer`.
6. To test immediately without waiting for the cron: `curl -X POST http://localhost:3000/api/check-now`

## How it works
- User submits email + desired role keywords (+ optional location) → saved to SQLite.
- Cron job fetches live listings from Arbeitnow, matches by keyword/location, skips jobs already sent to that user, emails matches.
- Free users are checked once daily (9am); paid users (`is_subscribed=1`) are checked every 15 min.
- `/api/upgrade` flips a user to paid — wire this to Razorpay's checkout later (Razorpay is the standard INR subscription gateway); right now it just sets the flag so you can test the full flow without payment setup.

## Next steps when you're ready to go further
- Swap the mock `/api/upgrade` for real Razorpay Subscriptions
- Add more free job sources (RemoteOK API is also free/no-key) and merge results
- Add unsubscribe link in emails (required for deliverability/compliance)
- Move from SQLite to Postgres if you expect heavy concurrent traffic