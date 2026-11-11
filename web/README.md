# ClearChart web demo

A static, browser-only front end for ClearChart. It walks through the product
on three invented lab reports: pick a report, watch it being read, then see
each value explained next to the line the lab printed.

It does not call the ClearChart API. The original app is untouched in
`frontend/` and `backend/`.

## Run locally

```bash
cd web
npm install
npm run dev
```

## Deploy to Vercel

Import the `SecondOpinion` repository, set **Root Directory** to `web`, deploy.

## Where things live

- `src/data/biomarkers.ts`: plain-English text, food table and source per biomarker
- `src/data/reports.ts`: the three sample reports, questions and trend data

All reports are sample data. The site is a health-literacy demo, not a diagnostic tool.
