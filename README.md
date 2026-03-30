# Mint Money

> Sync your bank accounts into Notion — automatically.

Mint Money is a Chrome extension that extracts balance and transaction data from CIBC and Wealthsimple, then pushes it into your Notion databases. Keep your personal finance tracker up to date without manual data entry.

---

## Features

- **Account Sync** — pulls current balances for all accounts and writes them into a Notion database
- **Transaction Sync** — extracts credit card transactions and syncs them as Notion database entries
- **Deduplication** — each transaction gets a Sync ID; re-syncing won't create duplicate rows
- **Auto-creates Notion properties** — missing database properties are created automatically on first sync

## Supported Banks

| Bank | Balances | Transactions |
|------|----------|--------------|
| CIBC | ✅ | ✅ |
| Wealthsimple | ✅ | ✅ |

## Requirements

- Google Chrome
- A [Notion integration](https://www.notion.so/my-integrations) API key
- Active login to CIBC Online Banking and/or Wealthsimple web app

---

## Installation

1. **Build the extension:**

   ```shell
   npm run build
   ```

2. **Load in Chrome:**

   Navigate to [`chrome://extensions`](chrome://extensions), toggle on **Developer Mode**, click **Load Unpacked**, and select the `dist/` folder.

---

## Configuration

### Notion API Key

1. Go to [https://www.notion.so/my-integrations](https://www.notion.so/my-integrations) and create a new integration.
2. Copy the **Internal Integration Secret**.
3. Open the extension options page and paste the key into the **API Key** field.

### Database Link

Paste the full URL of your Notion database (e.g. `https://www.notion.so/yourworkspace/abc123...`) into the **Database Link** field. The extension will parse the database ID automatically.

Make sure your Notion integration has been **shared** with the target database (open the database → Share → invite your integration).

---

## TODOs

1. To support more Banking views in [`src/popup/index.ts`](https://github.com/DrChai/msn/blob/61e91cb5aa71a51c9ffa17bbd934e995c5a6bf0c/src/popup/index.ts#L111-L145): upgrade `getAllAccounts()` and `syncAccountTypesFromPage` functions
2. Strict types for Alpine.js

---

## Tech Stack

- **Vite** — build tooling
- **TypeScript** — type-safe extension logic
- **Alpine.js** (CSP build) — reactive UI in the popup/options pages
- **Tailwind CSS** — utility-first styling
- **Notion API** — database read/write via REST API
