# WhatsApp CSV Sender (WhatsApp Web + Playwright)

## What it does

- Upload a CSV with columns: `phone`, `message` (optional: `name`)
- Preview parsed rows in the browser
- Click **Send** to open WhatsApp Web (Chromium) and send messages automatically

## Requirements

- Node.js installed
- WhatsApp account

## Install

```bat
npm install
npx playwright install chromium
```

## Run

```bat
npm run dev
```

Open:

- http://localhost:3000

## CSV format

Example: `sample.csv`

- `phone`: digits only recommended, include country code (example: `919999999999`)
- `message`: text to send
- `name`: optional; you can use `{name}` inside `message`

## First time login

- When you click **Send**, a Chromium window will open.
- If you are not logged in, scan the QR code.
- Session is saved in `.wa-session/` so you usually scan QR only once.

## Notes / Risks

- This uses **WhatsApp Web automation**. It can break if WhatsApp changes its UI.
- Automated/bulk messaging can violate WhatsApp policies and may risk your account.
- Add delays and avoid spam.

