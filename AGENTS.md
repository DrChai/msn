# AGENTS.md

## Project Overview

This repo is a Chrome extension built with:

- Vite
- TypeScript
- Alpine.js CSP build (`@alpinejs/csp`)
- Tailwind CSS
- Notion API

The extension syncs CIBC account data into Notion:

- `Account Sync` for balances
- `Transaction Sync` for credit card transactions

Primary UI entry points:

- `src/options/index.html`
- `src/options/index.ts`
- `src/popup/index.html`
- `src/popup/index.ts`

Shared logic lives in:

- `src/lib/storage.ts`
- `src/lib/notion.ts`
- `src/global.d.ts`

## Build And Validation

Use:

```bash
npm run build
```

Prefer `npm` over `yarn` in this repo because `package-lock.json` is present.

When making UI or storage changes, always rebuild before finishing.

## Architecture Notes

### Popup

The popup detects the active CIBC page and shows the matching workflow:

- balances page -> balance sync UI
- transactions page -> transaction sync UI
- other pages -> unsupported page message

The popup polls the active page periodically. Anything injected with `chrome.scripting.executeScript` must be self-contained and must not depend on outer-scope helpers.

### Settings

The settings page is split into:

- shared Notion API section
- `Account Sync` tab
- `Transaction Sync` tab

Settings are auto-saved. Do not reintroduce a manual save dependency unless explicitly requested.

Persisted settings currently include:

- Notion API key
- selected accounts
- balance database
- transactions database
- transactions field mapping
- link draft values for both database inputs

### Notion Integration

The extension uses direct Notion database block links, not workspace scanning.

`src/lib/notion.ts` is responsible for:

- parsing database ids from links
- retrieving and validating Notion databases
- auto-creating supported missing properties
- building suggested transaction field mappings

### Transaction Dedupe

Transaction sync dedupes using a hashed `Sync ID`.

Current sync id inputs:

- merchant
- date
- signed amount
- account name

Before creating pages, the popup queries Notion only for the detected transaction date range, collects existing `Sync ID` values, and skips duplicates locally.

## Important Constraints

### Alpine CSP Rules

This repo uses Alpine's CSP-friendly build. Template expressions must stay simple.

Avoid in templates:

- nested assignment via `x-model` on deep properties
- function calls with arguments
- negation-heavy expressions such as `!foo`
- ternaries when a precomputed getter/property is cleaner
- inline string building or array joins for display logic

Prefer:

- plain property reads
- no-arg handlers such as `@click="openAccountSyncTab"`
- precomputed getters/state in `index.ts`
- explicit `@change` handlers for form controls

If a template starts throwing `CSP-friendly build restrictions` errors, move the logic into Alpine state/getters/handlers.

### Storage Shape Stability

`src/lib/storage.ts` normalizes stored database objects. Be careful not to assume previously stored values are perfectly shaped.

When changing persisted shapes:

- keep backward compatibility where practical
- normalize on read
- avoid breaking existing extension installs

### Injected Page Scripts

Any function passed into `chrome.scripting.executeScript` runs in the page context, not the extension module context.

That means:

- no captured helpers
- no imported values
- no reliance on outer lexical scope

If parsing helpers are needed, define them inside the injected function.

## UI Guidance

Keep the UI compact and practical. This is an extension, not a marketing page.

Prefer:

- clear state labels
- obvious connection status
- readable schema/mapping summaries
- dense but not cramped layouts

Avoid:

- overly decorative controls
- large empty gutters
- hidden state transitions

When changing settings UI, preserve the distinction between:

- `Account Sync` settings
- `Transaction Sync` settings
- shared Notion API config

## Existing Product Behavior To Preserve

Unless explicitly changing behavior, preserve these assumptions:

- Balance sync logic should remain as stable as possible
- Transactions are synced to a separate Notion database
- Negative transaction amounts must stay negative in Notion
- The settings page should auto-save as fields change
- Database links should persist even before a successful connect

## File-Specific Notes

### `src/options/index.ts`

- Keep settings behavior auto-save first
- Keep CSP-safe Alpine handlers
- Keep transaction mapping state normalized

### `src/popup/index.ts`

- Page detection must tolerate delayed CIBC rendering
- Transactions extraction should be defensive and DOM-shape aware
- Sync result messages should stay user-visible and concise

### `src/lib/notion.ts`

- Favor primary Notion API behavior over heuristics
- Keep balance schema support conservative
- Transaction schema support may auto-create safe fields such as `Amount`, `Date`, `Account Name`, and `Sync ID`

## If You Change Core Behavior

If you touch:

- storage keys
- popup page detection
- transactions extraction selectors
- Notion schema creation
- transaction dedupe logic

then also verify the related UI flow end-to-end after building.
