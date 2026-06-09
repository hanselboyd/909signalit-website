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

## Configured Contact

- `909-260-8660`
- `support@909signalit.com`

## Booking

- Calendly booking URL: `https://calendly.com/aiindextv/30min`

## Placeholders To Replace

- Future images in `public/assets/`
