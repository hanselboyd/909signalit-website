# 909 Signal IT Website

Static website for 909 Signal IT, a local IT support and computer repair business serving Ontario, California and nearby Inland Empire cities.

## Stack

- Plain HTML, CSS, and JavaScript
- Vite for static builds to `dist/`
- Small Node server for Railway production hosting

## Local Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm start
```

The production server serves the Vite `dist` output and uses Railway's `PORT` environment variable.

## Railway Deployment

1. Create a Railway account.
2. Create a New Project.
3. Choose Deploy from GitHub repo.
4. Select `909signalit-website`.
5. Railway should detect the Node project and run `npm install`, `npm run build`, and `npm start`.
6. Add the custom domain `909signalit.com`.
7. Add the DNS records in Cloudflare as Railway provides them.

## 909 Signal Desk CRM

The private CRM/job desk is available at `/desk` after deployment. It captures public contact form submissions as leads and provides private lead, customer, and ticket management.

### Railway PostgreSQL

1. In Railway, open the project.
2. Add a PostgreSQL database service.
3. Copy or link the generated `DATABASE_URL` into the website service variables.
4. Add the admin session variables listed below.
5. Run Prisma setup from a Railway shell or locally with the same `DATABASE_URL`:

```bash
npx prisma generate
npx prisma db push
```

### Required Environment Variables

```bash
DATABASE_URL=
ADMIN_USERNAME=
ADMIN_PASSWORD=
SESSION_SECRET=
LEAD_NOTIFY_EMAIL=support@909signalit.com
RESEND_API_KEY=
FROM_EMAIL=
GOOGLE_REVIEW_URL=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
PUBLIC_SITE_URL=https://909signalit.com
```

Do not commit real admin credentials. Use a long random value for `SESSION_SECRET`.

### Lead Email Notifications

Lead notification emails use Resend. Create a Resend account, verify the sending domain, create an API key, and set:

- `RESEND_API_KEY`
- `FROM_EMAIL`, for example `909 Signal IT <noreply@909signalit.com>` after the domain is verified
- `LEAD_NOTIFY_EMAIL=support@909signalit.com`

If these variables are not set, or if Resend delivery fails, lead creation still succeeds. The server logs a safe email error without showing secrets.

### Google Review Requests

909 Signal Desk can show copy-ready Google review request messages on completed or closed tickets. The public `/reviews.html` page also uses this optional link when it is configured.

1. Open Google Business Profile.
2. Choose Ask for reviews.
3. Copy the review link.
4. In Railway, add `GOOGLE_REVIEW_URL=your_link`.
5. Redeploy the website service.

If `GOOGLE_REVIEW_URL` is missing, completed and closed tickets still show safe manual follow-up copy, but direct Google review links are replaced with a configuration notice. The older `GOOGLE_REVIEW_LINK` variable is still accepted for compatibility.

### Stripe Invoice Payments

909 Signal Desk stores invoices and can generate Stripe-hosted Checkout links for payment collection. Credit card processing stays on Stripe; the CRM only stores invoice records, checkout session IDs, and payment URLs.

1. Create or open a Stripe account.
2. Copy a secret API key from Stripe Developers.
3. In Railway, add:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `PUBLIC_SITE_URL=https://909signalit.com`

If `STRIPE_SECRET_KEY` is missing, invoices still work. The CRM shows: `Stripe is not configured. Add STRIPE_SECRET_KEY in Railway to generate payment links.`

To automatically mark invoices paid after Checkout succeeds:

1. In Stripe Dashboard, open Developers -> Webhooks.
2. Add endpoint `https://909signalit.com/api/stripe/webhook`.
3. Select event `checkout.session.completed`.
4. Copy the webhook signing secret.
5. In Railway, add `STRIPE_WEBHOOK_SECRET=whsec_...`.
6. Redeploy the website service.
7. Use a Stripe test payment and confirm the matching invoice status changes to `Paid`.

After adding invoice schema changes, run:

```bash
npx prisma db push
npx prisma generate
```

### CRM Routes

- `/desk`
- `/desk/leads`
- `/desk/customers`
- `/desk/tickets`
- `/desk/invoices`
- `/desk/service-menu`
- `/api/leads`

### Standard Service Menu

The standard service menu is used for quick invoice line items and can be edited in code for now.

### Expense Tracking

Expense tracking allows 909 Signal Desk to track parts, tools, subscriptions, travel, marketing, and other business costs. Dashboard profit is estimated as paid revenue minus recorded expenses.

### Reports and CSV Exports

Reports and CSV exports allow 909 Signal Desk to download leads, customers, tickets, invoices, expenses, and monthly revenue/expense/profit summaries for backup and bookkeeping.

### Follow-Up Reminders

Follow-up reminders help track leads needing contact, unpaid invoices, stale tickets, review follow-ups, and customer follow-ups. They are internal CRM reminders and do not send automatic messages.

### 909 Signal Remote Assist

909 Signal Remote Assist is a consent-first remote support workflow. Clients request a session, accept consent terms, and receive a session code. Actual remote control will be added later through a visible, client-approved tool or app. The system must not provide hidden, unattended, or stealth access.

### 909 Signal Live View

909 Signal Live View is a browser-based, consent-first screen-sharing MVP. Clients explicitly start screen sharing using browser permissions. Technicians can view the screen from the protected CRM. Sessions are not recorded and do not provide mouse/keyboard control.

## Configured Contact

- `909-260-8660`
- `support@909signalit.com`

## Booking

- Calendly booking URL: `https://calendly.com/aiindextv/30min`

## Brand Assets

- Apple Business Connect logo asset: `public/assets/apple-business-logo-1024.png`

## Placeholders To Replace

- Future images in `public/assets/`
