import Alpine from '@alpinejs/csp';
import { Client } from '@notionhq/client';

import '../global.css';
import { createNotionClient, refreshNotionDatabaseConnection, TRANSACTION_SYNC_ID_PROPERTY, validateTransactionsFieldMapping } from '../lib/notion';
import { getExtensionSettings, saveExtensionSettings } from '../lib/storage';

window.Alpine = Alpine;

const parseCurrency = (str: string): number => parseFloat(str.replace(/[^0-9.-]+/g, ''));
const parseSignedAmount = (str: string): number => {
  const normalized = str.replace(/[−–]/g, '-');
  const parsed = parseFloat(normalized.replace(/[^0-9.-]+/g, ''));
  return Number.isNaN(parsed) ? 0 : parsed;
};
const toRichText = (content: string) => ({
  type: 'rich_text' as const,
  rich_text: [
    {
      type: 'text' as const,
      text: {
        content,
      },
    },
  ],
});
const toTitle = (content: string) => ({
  type: 'title' as const,
  title: [
    {
      type: 'text' as const,
      text: {
        content,
      },
    },
  ],
});
const normalizeSyncIdPart = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase();
const sha256Hex = async (value: string): Promise<string> => {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};
const createTransactionSyncId = async (transaction: Transaction): Promise<string> => {
  const seed = [
    normalizeSyncIdPart(transaction.merchant),
    transaction.date,
    transaction.amountValue.toFixed(2),
    normalizeSyncIdPart(transaction.accountName),
  ].join('|');

  return sha256Hex(seed);
};
type NotionTextFragment = {
  plain_text?: string;
};

type NotionPageProperty = {
  type?: string;
  rich_text?: NotionTextFragment[];
  title?: NotionTextFragment[];
};

type NotionQueryPage = {
  properties?: Record<string, NotionPageProperty | undefined>;
};

const getTransactionsDateRange = (transactions: Transaction[]): { start: string; end: string } | null => {
  const dates = transactions
    .map((transaction) => transaction.date)
    .filter(Boolean)
    .sort();
  if (dates.length === 0) {
    return null;
  }

  return {
    start: dates[0],
    end: dates[dates.length - 1],
  };
};

const getPlainTextFromProperty = (property: NotionPageProperty | undefined): string => {
  const textItems = property?.type === 'title' ? property.title : property?.rich_text;
  return (textItems ?? [])
    .map((item) => item.plain_text ?? '')
    .join('')
    .trim();
};

const getExistingTransactionSyncIds = async (
  notion: Client,
  dataSourceId: string,
  dateProperty: string,
  range: { start: string; end: string },
): Promise<Set<string>> => {
  const syncIds = new Set<string>();
  let startCursor: string | undefined;

  do {
    const result = await notion.dataSources.query({
      data_source_id: dataSourceId,
      filter: {
        and: [
          {
            property: dateProperty,
            date: {
              on_or_after: range.start,
            },
          },
          {
            property: dateProperty,
            date: {
              on_or_before: range.end,
            },
          },
        ],
      },
      page_size: 100,
      start_cursor: startCursor,
    });

    result.results.forEach((page) => {
      const syncId = getPlainTextFromProperty((page as unknown as NotionQueryPage).properties?.[TRANSACTION_SYNC_ID_PROPERTY]);
      if (syncId) {
        syncIds.add(syncId);
      }
    });

    startCursor = result.has_more ? (result.next_cursor ?? undefined) : undefined;
  } while (startCursor);

  return syncIds;
};

Alpine.data('popup', () => ({
  filteredAccts: [] as Account[],
  detectedTransactions: [] as Transaction[],
  isLoading: false,
  error: '',
  syncResultMessage: '',
  notionApiKey: '',
  balanceDatabase: null as Database | null,
  transactionsDatabase: null as Database | null,
  transactionsFieldMapping: null as TransactionsFieldMapping | null,
  syncBtnTitle: 'Sync to Notion',
  pageMode: 'unknown' as 'unknown' | 'balances' | 'transactions',
  async init() {
    const settings = await getExtensionSettings();

    this.notionApiKey = settings.notionApiKey;
    this.balanceDatabase = settings.balanceDatabase;
    this.transactionsDatabase = settings.transactionsDatabase;
    this.transactionsFieldMapping = settings.transactionsFieldMapping;
  },
  get syncBtnText() {
    if (this.isLoading) {
      return 'Syncing...';
    }
    if (this.showingTransactions) {
      return 'Sync Transactions';
    }
    if (this.showingBalances) {
      return 'Sync Balances';
    }
    return this.syncBtnTitle;
  },
  get balanceStatusText() {
    if (!this.balanceDatabase) {
      return 'Not connected';
    }

    return this.balanceDatabase.schemaStatus?.isValid ? 'Ready' : 'Needs attention';
  },
  get transactionsStatusText() {
    if (!this.transactionsDatabase) {
      return 'Not connected';
    }

    const mappingErrors = validateTransactionsFieldMapping(this.transactionsFieldMapping, this.transactionsDatabase);
    if (mappingErrors.length > 0) {
      return 'Mapping incomplete';
    }

    return this.transactionsDatabase.schemaStatus?.isValid ? 'Ready' : 'Needs attention';
  },
  get canSyncBalanceState() {
    return Boolean(this.balanceDatabase && this.notionApiKey && this.balanceDatabase.schemaStatus?.isValid && !this.isLoading && this.filteredAccts.length > 0);
  },
  get canSyncTransactionsState() {
    if (!this.transactionsDatabase || !this.notionApiKey || !this.transactionsDatabase.schemaStatus?.isValid || this.isLoading) {
      return false;
    }

    const mappingErrors = validateTransactionsFieldMapping(this.transactionsFieldMapping, this.transactionsDatabase);
    return mappingErrors.length === 0 && this.detectedTransactions.length > 0;
  },
  get syncDisabled() {
    if (this.showingTransactions) {
      return !this.canSyncTransactionsState;
    }
    if (this.showingBalances) {
      return !this.canSyncBalanceState;
    }
    return true;
  },
  get balanceDatabaseTitle() {
    return this.balanceDatabase ? this.balanceDatabase.title : 'Not connected';
  },
  get transactionsDatabaseTitle() {
    return this.transactionsDatabase ? this.transactionsDatabase.title : 'Not connected';
  },
  get hasTransactionsPreview() {
    return this.detectedTransactions.length > 0;
  },
  get transactionsPreview() {
    return this.detectedTransactions.slice(0, 3);
  },
  get transactionsPreviewCountText() {
    return `${this.detectedTransactions.length} transaction${this.detectedTransactions.length === 1 ? '' : 's'} detected`;
  },
  get showingBalances() {
    return this.pageMode === 'balances';
  },
  get showingTransactions() {
    return this.pageMode === 'transactions';
  },
  get showUnsupportedPage() {
    return !this.showingBalances && !this.showingTransactions;
  },
  get balancePageReady() {
    return this.pageMode === 'balances';
  },
  get transactionsPageReady() {
    return this.pageMode === 'transactions';
  },
  get showBalancePageHint() {
    return !this.balancePageReady;
  },
  get showTransactionsPageHint() {
    return !this.transactionsPageReady;
  },
  get pageModeText() {
    if (this.pageMode === 'balances') {
      return 'Balances page';
    }
    if (this.pageMode === 'transactions') {
      return 'Transactions page';
    }
    return 'Unsupported page';
  },
  errorHandling(event: CustomEvent<string>) {
    this.error = event.detail;
    this.syncResultMessage = '';
    this.isLoading = false;
    this.syncBtnTitle = 'Sync to Notion';
  },
  onLoading() {
    this.isLoading = true;
    this.error = '';
    this.syncResultMessage = '';
  },
  afterAccountsUpdate(event: CustomEvent<Account[]>) {
    this.isLoading = false;
    this.pageMode = 'balances';
    if (event.detail) {
      this.filteredAccts = event.detail;
      this.detectedTransactions = [];
    }
  },
  afterTransactionsUpdate(event: CustomEvent<Transaction[]>) {
    this.isLoading = false;
    this.pageMode = 'transactions';
    if (event.detail) {
      this.detectedTransactions = event.detail;
      this.filteredAccts = [];
    }
  },
  onOpenSettings() {
    this.isLoading = false;
    this.error = '';
    this.syncResultMessage = '';
    chrome.runtime.openOptionsPage();
  },
  async onSync() {
    if (this.showingTransactions) {
      await this.onSyncTransactions();
      return;
    }

    if (!this.balanceDatabase) {
      this.error = 'Connect an account balance database in Settings first.';
      return;
    }

    this.isLoading = true;
    this.error = '';
    this.syncResultMessage = '';
    this.syncBtnTitle = 'Syncing...';

    let notion: Client;
    try {
      notion = createNotionClient(this.notionApiKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.dispatchEvent(
        new CustomEvent('on-error', {
          detail: `Notion client init failed: ${message}`,
        }),
      );
      return;
    }

    try {
      const balanceDatabase = await refreshNotionDatabaseConnection(notion, this.balanceDatabase, 'balance');
      this.balanceDatabase = balanceDatabase;
      await saveExtensionSettings({
        balanceDatabase,
      });

      const titleKey = balanceDatabase.properties.find((prop) => prop.type === 'title')?.name;
      const balanceKey = balanceDatabase.properties.find((prop) => prop.type === 'number')?.name;
      const dateKey = balanceDatabase.properties.find((prop) => prop.type === 'date')?.name;

      if (!titleKey || !balanceKey || !dateKey || !balanceDatabase.dataSourceId) {
        this.error = 'Balance database is missing a title, number, date, or data source id.';
        return;
      }

      await Promise.all(
        this.filteredAccts.map((acct) =>
          notion.pages.create({
            parent: {
              data_source_id: balanceDatabase.dataSourceId!,
            },
            properties: {
              [titleKey]: {
                type: 'title',
                title: [
                  {
                    type: 'text',
                    text: {
                      content: acct.name,
                    },
                  },
                ],
              },
              [balanceKey]: {
                type: 'number',
                number: parseCurrency(acct.balance),
              },
              [dateKey]: {
                type: 'date',
                date: {
                  start: new Date().toISOString(),
                },
              },
            },
          }),
        ),
      );
      this.syncBtnTitle = 'Synced';
      this.syncResultMessage = `Created ${this.filteredAccts.length} balance item${this.filteredAccts.length === 1 ? '' : 's'}.`;
      window.dispatchEvent(new CustomEvent('after-accounts-update', {}));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.dispatchEvent(
        new CustomEvent('on-error', {
          detail: `Notion sync failed: ${message}`,
        }),
      );
    } finally {
      this.isLoading = false;
    }
  },
  async onSyncTransactions() {
    if (!this.transactionsDatabase) {
      this.error = 'Connect a transactions database in Settings first.';
      return;
    }

    const mappingErrors = validateTransactionsFieldMapping(this.transactionsFieldMapping, this.transactionsDatabase);
    if (mappingErrors.length > 0 || !this.transactionsFieldMapping) {
      this.error = mappingErrors[0] ?? 'Transactions field mapping is incomplete.';
      return;
    }

    this.isLoading = true;
    this.error = '';
    this.syncResultMessage = '';
    this.syncBtnTitle = 'Syncing...';

    let notion: Client;
    try {
      notion = createNotionClient(this.notionApiKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.dispatchEvent(
        new CustomEvent('on-error', {
          detail: `Notion client init failed: ${message}`,
        }),
      );
      return;
    }

    try {
      let transactionsDatabase = await refreshNotionDatabaseConnection(notion, this.transactionsDatabase, 'transactions');
      this.transactionsDatabase = transactionsDatabase;
      await saveExtensionSettings({
        transactionsDatabase,
      });

      const refreshedMappingErrors = validateTransactionsFieldMapping(this.transactionsFieldMapping, transactionsDatabase);
      if (refreshedMappingErrors.length > 0) {
        this.error = refreshedMappingErrors[0];
        return;
      }

      const merchantProperty = transactionsDatabase.properties.find(
        (property) => property.name === this.transactionsFieldMapping!.merchantProperty,
      );
      const syncIdProperty = transactionsDatabase.properties.find(
        (property) => property.name === TRANSACTION_SYNC_ID_PROPERTY,
      );

      if (!merchantProperty || !syncIdProperty) {
        this.error = 'Transactions database is missing either the merchant field or the Sync ID field.';
        return;
      }

      const transactionDateRange = getTransactionsDateRange(this.detectedTransactions);
      if (!transactionDateRange) {
        this.error = 'Could not determine the transactions date range from the current page.';
        return;
      }

      const transactionSyncIds = await Promise.all(
        this.detectedTransactions.map(async (transaction) => ({
          transaction,
          syncId: await createTransactionSyncId(transaction),
        })),
      );

      const existingSyncIds = await getExistingTransactionSyncIds(
        notion,
        transactionsDatabase.dataSourceId!,
        this.transactionsFieldMapping.dateProperty,
        transactionDateRange,
      );

      const seenSyncIds = new Set(existingSyncIds);
      const unsyncedTransactions = transactionSyncIds.filter(({ syncId }) => {
        if (seenSyncIds.has(syncId)) {
          return false;
        }

        seenSyncIds.add(syncId);
        return true;
      });
      const skippedCount = transactionSyncIds.length - unsyncedTransactions.length;

      if (unsyncedTransactions.length === 0) {
        this.syncBtnTitle = 'No new items';
        this.syncResultMessage = `Created 0 transactions, skipped ${skippedCount} duplicates.`;
        return;
      }

      await Promise.all(
        unsyncedTransactions.map(({ transaction, syncId }) => {
          const properties: Record<string, unknown> = {
            [this.transactionsFieldMapping!.dateProperty]: {
              type: 'date',
              date: {
                start: transaction.date,
              },
            },
            [this.transactionsFieldMapping!.amountProperty]: {
              type: 'number',
              number: transaction.amountValue,
            },
            [this.transactionsFieldMapping!.accountNameProperty]: toRichText(transaction.accountName),
            [TRANSACTION_SYNC_ID_PROPERTY]: toRichText(syncId),
          };

          properties[this.transactionsFieldMapping!.merchantProperty] =
            merchantProperty.type === 'title' ? toTitle(transaction.merchant) : toRichText(transaction.merchant);

          return notion.pages.create({
            parent: {
              data_source_id: transactionsDatabase.dataSourceId!,
            },
            properties,
          });
        }),
      );
      this.syncBtnTitle = 'Synced';
      this.syncResultMessage = `Created ${unsyncedTransactions.length} transaction${unsyncedTransactions.length === 1 ? '' : 's'}, skipped ${skippedCount} duplicate${skippedCount === 1 ? '' : 's'}.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.dispatchEvent(
        new CustomEvent('on-error', {
          detail: `Transactions sync failed: ${message}`,
        }),
      );
    } finally {
      this.isLoading = false;
    }
  },
}));

Alpine.start();

const TARGET_DOMAIN = 'cibconline.cibc.com';
const PAGE_SCAN_INTERVAL_MS = 3000;

const syncAccountTypesFromPage = () => {
  const accountGroups = document.querySelectorAll('.account-groups-container');
  const accountTypes: Record<string, string> = {};

  accountGroups.forEach((group) => {
    const headerElement = group.querySelector('.account-groups-header h2');
    const groupClass: string = group.classList[1];
    const groupTitle = (headerElement as HTMLElement | null)?.innerText.trim();
    if (groupTitle && groupClass) {
      accountTypes[groupClass] = groupTitle;
    }
  });

  return accountTypes;
};

const getAllAccounts = (selectedTypes: string[]) => {
  const selector = selectedTypes.map((className) => `.account-groups-container.${className} .card-container`).join(',');
  const cardContainers = document.querySelectorAll(selector);
  const accounts: Account[] = [];

  cardContainers.forEach((container) => {
    const nameElement = container.querySelector('.account-name span');
    const balanceElement = container.querySelector('.account-balance p');

    const name = nameElement ? nameElement.innerText.trim() : 'No name found';
    const balance = balanceElement ? balanceElement.innerText.trim() : 'No balance found';

    accounts.push({ name, balance });
  });
  return accounts;
};

const getPageMode = () => {
  const hasTransactions = () =>
    Boolean(
      document.querySelector('.transaction-list .merchant-cleansing table tbody tr.transaction-row') ||
      document.querySelector('.transactions .transaction-list tbody tr.transaction-row'),
    );
  const hasBalances = () => Boolean(document.querySelector('.account-groups-container'));

  if (hasTransactions()) {
    return 'transactions';
  }

  if (hasBalances()) {
    return 'balances';
  }
  return 'unknown';
  // return new Promise<'unknown' | 'balances' | 'transactions'>((resolve) => {
  //   const startedAt = Date.now();
  //   const intervalId = window.setInterval(() => {
  //     if (hasTransactions()) {
  //       window.clearInterval(intervalId);
  //       resolve('transactions');
  //       return;
  //     }

  //     if (hasBalances()) {
  //       window.clearInterval(intervalId);
  //       resolve('balances');
  //       return;
  //     }

  //     if (Date.now() - startedAt >= 4000) {
  //       window.clearInterval(intervalId);
  //       resolve('unknown');
  //     }
  //   }, 200);
  // });
};

const getTransactionsFromPage = () => {
  const parseInjectedSignedAmount = (str: string): number => {
    const normalized = str.replace(/[−–]/g, '-');
    const parsed = parseFloat(normalized.replace(/[^0-9.-]+/g, ''));
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  const getTransactionRows = () =>
    Array.from(document.querySelectorAll('tr.transaction-row')).filter(
      (row) =>
        Boolean(row.querySelector('.transactionDate span')) && Boolean(row.querySelector('.transactionDescription')) && Boolean(row.querySelector('td.amount')),
    );

  const parseTransactionDate = (value: string): string => {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return value;
    }

    const year = parsed.getFullYear();
    const month = `${parsed.getMonth() + 1}`.padStart(2, '0');
    const day = `${parsed.getDate()}`.padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const cardProductName = (document.querySelector('.card-details-main .product-name') as HTMLElement | null)?.innerText.replace(/\s+/g, ' ').trim() ?? '';
  const buildTransactions = () => {
    const rows = getTransactionRows();

    return rows.map((row) => {
      const dateText = (row.querySelector('.transactionDate span') as HTMLElement | null)?.innerText.trim() ?? '';
      const description = (row.querySelector('.transactionDescription') as HTMLElement | null)?.innerText.trim() ?? '';
      const maskedCardNumber = (row.querySelector('.transactionCardNo') as HTMLElement | null)?.innerText.trim() ?? '';
      const amountCell = row.querySelector('td.amount');
      const amountText = (amountCell?.querySelector('span') as HTMLElement | null)?.innerText.trim() ?? '';
      const amountClassList = Array.from(amountCell?.classList ?? []);
      const categoryIcon = row.querySelector('td.transactions img[title]') as HTMLImageElement | null;
      const category = categoryIcon?.title?.trim() ?? '';
      const cardLastFour = (maskedCardNumber.match(/(\d{4})$/) ?? [])[1] ?? '';
      const amountValue = parseInjectedSignedAmount(amountText);
      const direction = amountClassList.includes('credit') ? 'credit' : amountClassList.includes('debit') ? 'debit' : 'unknown';
      const accountName =
        cardProductName && cardLastFour ? `${cardProductName} ${cardLastFour}` : cardLastFour ? `Card ${cardLastFour}` : cardProductName || 'Card';

      return {
        key: `${dateText}-${amountText}-${description}-${maskedCardNumber}`,
        date: parseTransactionDate(dateText),
        amountText,
        amountValue: Number.isNaN(amountValue) ? 0 : amountValue,
        cardProductName,
        merchant: description,
        description,
        maskedCardNumber,
        cardLastFour,
        accountName,
        direction,
        category,
      } satisfies Transaction;
    });
  };

  const initialTransactions = buildTransactions();
  if (initialTransactions.length > 0) {
    return Promise.resolve(initialTransactions);
  }

  return new Promise<Transaction[]>((resolve) => {
    const startedAt = Date.now();
    const intervalId = window.setInterval(() => {
      const transactions = buildTransactions();
      if (transactions.length > 0) {
        window.clearInterval(intervalId);
        resolve(transactions);
        return;
      }

      if (Date.now() - startedAt >= 4000) {
        window.clearInterval(intervalId);
        resolve([]);
      }
    }, 200);
  });
};

let isScanningCurrentPage = false;

const scanCurrentPage = () => {
  if (isScanningCurrentPage) {
    return;
  }

  isScanningCurrentPage = true;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const currentTab = tabs[0];
    if (!currentTab?.url || !currentTab.id) {
      isScanningCurrentPage = false;
      window.dispatchEvent(
        new CustomEvent('on-error', {
          detail: 'Error: unable to determine the current tab URL.',
        }),
      );
      return;
    }

    const currentDomain = new URL(currentTab.url).hostname;
    if (!currentDomain.includes(TARGET_DOMAIN)) {
      isScanningCurrentPage = false;
      window.dispatchEvent(
        new CustomEvent('on-error', {
          detail: `Error: This is not the correct domain. Expected domain: ${TARGET_DOMAIN}`,
        }),
      );
      return;
    }

    chrome.scripting.executeScript(
      {
        target: { tabId: currentTab.id },
        func: getPageMode,
      },
      async (modeResults) => {
        if (chrome.runtime.lastError) {
          isScanningCurrentPage = false;
          window.dispatchEvent(
            new CustomEvent('on-error', {
              detail: `Error: ${chrome.runtime.lastError.message}`,
            }),
          );
          return;
        }

        const pageMode = modeResults?.[0]?.result as 'unknown' | 'balances' | 'transactions';

        if (pageMode === 'transactions') {
          chrome.scripting.executeScript(
            {
              target: { tabId: currentTab.id! },
              func: getTransactionsFromPage,
            },
            (transactionResults) => {
              isScanningCurrentPage = false;
              if (chrome.runtime.lastError) {
                window.dispatchEvent(
                  new CustomEvent('on-error', {
                    detail: `Error: ${chrome.runtime.lastError.message}`,
                  }),
                );
                return;
              }

              const transactions = (transactionResults?.[0]?.result ?? []) as Transaction[];
              window.dispatchEvent(
                new CustomEvent('after-transactions-update', {
                  detail: transactions,
                }),
              );
            },
          );
          return;
        }

        if (pageMode !== 'balances') {
          isScanningCurrentPage = false;
          window.dispatchEvent(
            new CustomEvent('on-error', {
              detail: 'Error: unsupported CIBC page. Open either an accounts overview page or a credit-card transactions page.',
            }),
          );
          return;
        }

        chrome.scripting.executeScript(
          {
            target: { tabId: currentTab.id! },
            func: syncAccountTypesFromPage,
          },
          async (results) => {
            if (chrome.runtime.lastError) {
              isScanningCurrentPage = false;
              window.dispatchEvent(
                new CustomEvent('on-error', {
                  detail: `Error: ${chrome.runtime.lastError.message}`,
                }),
              );
              return;
            }

            const availableAccounts = results?.[0]?.result;
            if (!availableAccounts) {
              isScanningCurrentPage = false;
              window.dispatchEvent(
                new CustomEvent('on-error', {
                  detail: 'Error: unable to find account sections.',
                }),
              );
              return;
            }

            chrome.storage.local.set({ availableAccounts });
            const settings = await getExtensionSettings();
            const selectedAccounts = settings.selectedAccounts.length ? settings.selectedAccounts : Object.keys(availableAccounts);

            chrome.scripting.executeScript(
              {
                target: { tabId: currentTab.id! },
                func: getAllAccounts,
                args: [selectedAccounts],
              },
              (accountResults) => {
                isScanningCurrentPage = false;
                if (chrome.runtime.lastError) {
                  window.dispatchEvent(
                    new CustomEvent('on-error', {
                      detail: `Error: ${chrome.runtime.lastError.message}`,
                    }),
                  );
                  return;
                }

                const accounts = accountResults?.[0]?.result as Account[];
                window.dispatchEvent(
                  new CustomEvent('after-accounts-update', {
                    detail: accounts,
                  }),
                );
              },
            );
          },
        );
      },
    );
  });
};
// TODO: consider event-based scanCurrentPage() refresh, but 
// the listener only exists while the popup is open.
// for continuous tab monitoring, this should live in a background/service worker script, not popup runtime.
//
// chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
//   if (changeInfo.status === 'complete' && tab.url) {
//     const pageMode = getPageMode();
//     console.log(`Tab ${tabId} changed to: ${tab.url}`, pageMode);
//     scanCurrentPage();
//   }
// });

/*
* Popup scripts are ephemeral and only run while the popup is open. setInterval wouldnt act as supposed to do.
*/
scanCurrentPage();
// window.setInterval(scanCurrentPage, PAGE_SCAN_INTERVAL_MS);
