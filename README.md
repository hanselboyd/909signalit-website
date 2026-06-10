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
```

Do not commit real admin credentials. Use a long random value for `SESSION_SECRET`.

### CRM Routes

- `/desk`
- `/desk/leads`
- `/desk/customers`
- `/desk/tickets`
- `/api/leads`

## Configured Contact

- `909-260-8660`
- `support@909signalit.com`

## Booking

- Calendly booking URL: `https://calendly.com/aiindextv/30min`

## Placeholders To Replace

- Future images in `public/assets/`
