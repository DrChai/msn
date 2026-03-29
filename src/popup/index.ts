import Alpine from '@alpinejs/csp';
import { Client } from '@notionhq/client';

import '../global.css';
import { detectBankFromHost, getBankAdapterById } from '../lib/bank';
import type { BankId } from '../lib/bank/type';
import {
  createNotionClient,
  refreshNotionDatabaseConnection,
  suggestTransactionsFieldMapping,
  TRANSACTION_SYNC_ID_PROPERTY,
  validateTransactionsFieldMapping,
} from '../lib/notion';
import { getExtensionSettings, saveExtensionSettings } from '../lib/storage';

window.Alpine = Alpine;

const parseCurrency = (str: string): number => parseFloat(str.replace(/[^0-9.-]+/g, ''));
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
    transaction.rawAmountValue.toFixed(2),
    normalizeSyncIdPart(transaction.accountName),
  ].join('|');

  return sha256Hex(seed);
};
const getTransactionAccountTypeLabel = (accountType: TransactionAccountType): string => {
  switch (accountType) {
    case 'credit_card':
      return 'Credit card';
    case 'checking':
      return 'Checking';
    case 'savings':
      return 'Savings';
    default:
      return 'Unknown';
  }
};
const getTransactionCurrencyCode = (transaction: Transaction): string | null => {
  if (transaction.currencyCode) {
    return transaction.currencyCode;
  }

  const currencyMatch = transaction.amountText.match(/\b([A-Z]{3})\b/);
  return currencyMatch?.[1] ?? null;
};
const getTransactionTypeLabel = (type: TransactionType): string => (type === 'debit' ? 'Debit' : 'Credit');
const formatTransactionAmount = (transaction: Transaction): string => {
  const amount = Math.abs(transaction.amountValue);
  const currencyCode = getTransactionCurrencyCode(transaction);
  const formatter = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const absAmount = formatter.format(amount);
  const currencyPrefix = currencyCode === 'USD' ? 'US$' : '$';
  const currencySuffix = currencyCode ? ` ${currencyCode}` : '';

  return `${currencyPrefix}${absAmount}${currencySuffix}`;
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

type NotionPageCreateRequest = Parameters<Client['pages']['create']>[0];
type NotionPageCreateProperties = NonNullable<NotionPageCreateRequest['properties']>;
type BankAccountKey = string;
type BalanceAccountsUpdateDetail = {
  bankId: BankId;
  accounts: Account[];
  selectedAccountKeys: string[];
};
const BANK_ACCOUNT_KEY_SEPARATOR = '::';
const toBankScopedAccountKey = (bankId: BankId, accountKey: string): BankAccountKey => `${bankId}${BANK_ACCOUNT_KEY_SEPARATOR}${accountKey}`;
const isBankScopedAccountKey = (value: string, bankId: BankId): boolean => value.startsWith(`${bankId}${BANK_ACCOUNT_KEY_SEPARATOR}`);
const fromBankScopedAccountKey = (value: string, bankId: BankId): string =>
  isBankScopedAccountKey(value, bankId) ? value.slice(`${bankId}${BANK_ACCOUNT_KEY_SEPARATOR}`.length) : value;

const getAccountSelectionKey = (account: Account): string => account.key?.trim() || account.name;
const getScopedAvailableAccountsForBank = (availableAccounts: Record<string, string>, bankId: BankId): Record<string, string> =>
  Object.fromEntries(Object.entries(availableAccounts).filter(([key]) => isBankScopedAccountKey(key, bankId)));
const getScopedSelectedAccountsForBank = (selectedAccounts: string[], bankId: BankId): string[] =>
  selectedAccounts.filter((key) => isBankScopedAccountKey(key, bankId)).map((key) => fromBankScopedAccountKey(key, bankId));
const buildAvailableAccountsMap = (accounts: Account[], bankId: BankId, bankLabel: string): Record<string, string> => {
  const nameCounts = accounts.reduce<Record<string, number>>((result, account) => {
    result[account.name] = (result[account.name] ?? 0) + 1;
    return result;
  }, {});

  return Object.fromEntries(
    accounts.map((account) => {
      const isDuplicateName = (nameCounts[account.name] ?? 0) > 1;
      const baseTitle = isDuplicateName ? `${account.name} (${account.balance})` : account.name;
      return [toBankScopedAccountKey(bankId, getAccountSelectionKey(account)), `${bankLabel} • ${baseTitle}`];
    }),
  );
};
const matchesStoredAccountSelection = (account: Account, selectedAccounts: string[], bankId: BankId): boolean =>
  selectedAccounts.includes(toBankScopedAccountKey(bankId, getAccountSelectionKey(account))) ||
  selectedAccounts.includes(getAccountSelectionKey(account)) ||
  selectedAccounts.includes(account.name);

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

const resolveTransactionsFieldMapping = (
  mapping: TransactionsFieldMapping | null,
  database: Database | null,
): TransactionsFieldMapping | null => {
  if (!database) {
    return mapping;
  }

  if (mapping && validateTransactionsFieldMapping(mapping, database).length === 0) {
    return mapping;
  }

  return suggestTransactionsFieldMapping(database);
};

Alpine.data('popup', () => ({
  filteredAccts: [] as Account[],
  selectedAccounts: [] as string[],
  currentBankId: null as BankId | null,
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
    this.transactionsFieldMapping = resolveTransactionsFieldMapping(settings.transactionsFieldMapping, settings.transactionsDatabase);
    this.selectedAccounts = [];

    if (this.transactionsFieldMapping !== settings.transactionsFieldMapping) {
      saveExtensionSettings({
        transactionsFieldMapping: this.transactionsFieldMapping,
      }).catch(() => {});
    }

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') {
        return;
      }

      if (
        !changes.selectedAccounts &&
        !changes.availableAccounts &&
        !changes.balanceDatabase &&
        !changes.transactionsDatabase &&
        !changes.transactionsFieldMapping &&
        !changes.notionApiKey
      ) {
        return;
      }

      getExtensionSettings()
        .then((updatedSettings) => {
          this.selectedAccounts = this.currentBankId ? getScopedSelectedAccountsForBank(updatedSettings.selectedAccounts, this.currentBankId) : [];
          this.notionApiKey = updatedSettings.notionApiKey;
          this.balanceDatabase = updatedSettings.balanceDatabase;
          this.transactionsDatabase = updatedSettings.transactionsDatabase;
          this.transactionsFieldMapping = resolveTransactionsFieldMapping(
            updatedSettings.transactionsFieldMapping,
            updatedSettings.transactionsDatabase,
          );
        })
        .catch(() => {});
    });
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

    const mappingErrors = validateTransactionsFieldMapping(this.resolvedTransactionsFieldMapping, this.transactionsDatabase);
    if (mappingErrors.length > 0) {
      return 'Mapping incomplete';
    }

    return this.transactionsDatabase.schemaStatus?.isValid ? 'Ready' : 'Needs attention';
  },
  get canSyncBalanceState() {
    return Boolean(
      this.balanceDatabase &&
        this.notionApiKey &&
        this.balanceDatabase.schemaStatus?.isValid &&
        !this.isLoading &&
        this.selectedBalanceAccounts.length > 0,
    );
  },
  get canSyncTransactionsState() {
    if (!this.transactionsDatabase || !this.notionApiKey || !this.transactionsDatabase.schemaStatus?.isValid || this.isLoading) {
      return false;
    }

    const mappingErrors = validateTransactionsFieldMapping(this.resolvedTransactionsFieldMapping, this.transactionsDatabase);
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
  get balanceAccountOptions() {
    return this.filteredAccts.map((account: Account) => ({
      ...account,
      key: getAccountSelectionKey(account),
      isSelected: this.selectedAccounts.includes(getAccountSelectionKey(account)),
    }));
  },
  get selectedBalanceAccounts() {
    const selectedAccountSet = new Set(this.selectedAccounts);
    return this.filteredAccts.filter((account: Account) => selectedAccountSet.has(getAccountSelectionKey(account)));
  },
  get selectedBalanceCountText() {
    return `${this.selectedBalanceAccounts.length} of ${this.filteredAccts.length} account${this.filteredAccts.length === 1 ? '' : 's'} selected`;
  },
  get transactionsDatabaseTitle() {
    return this.transactionsDatabase ? this.transactionsDatabase.title : 'Not connected';
  },
  get resolvedTransactionsFieldMapping() {
    return resolveTransactionsFieldMapping(this.transactionsFieldMapping, this.transactionsDatabase);
  },
  get hasTransactionsPreview() {
    return this.detectedTransactions.length > 0;
  },
  get transactionsPreview() {
    return this.detectedTransactions.map((transaction: Transaction) => ({
      ...transaction,
      previewAmountText: formatTransactionAmount(transaction),
      previewTypeText: getTransactionTypeLabel(transaction.type),
      accountTypeLabel: getTransactionAccountTypeLabel(transaction.accountType),
    }));
  },
  get transactionsPreviewCountText() {
    return `${this.detectedTransactions.length} transaction${this.detectedTransactions.length === 1 ? '' : 's'} detected`;
  },
  get detectedTransactionsAccountTypeText() {
    if (this.detectedTransactions.length === 0) {
      return 'Unknown';
    }

    const uniqueAccountTypes = Array.from(
      new Set<TransactionAccountType>(this.detectedTransactions.map((transaction: Transaction) => transaction.accountType)),
    );
    if (uniqueAccountTypes.length === 1) {
      return getTransactionAccountTypeLabel(uniqueAccountTypes[0] ?? 'unknown');
    }

    return uniqueAccountTypes.map((accountType: TransactionAccountType) => getTransactionAccountTypeLabel(accountType)).join(', ');
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
  afterAccountsUpdate(event: CustomEvent<BalanceAccountsUpdateDetail>) {
    this.isLoading = false;
    this.pageMode = 'balances';
    if (event.detail) {
      this.currentBankId = event.detail.bankId;
      this.filteredAccts = event.detail.accounts;
      this.selectedAccounts = event.detail.selectedAccountKeys;
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
  async onBalanceSelectionChange() {
    if (!this.currentBankId) {
      return;
    }

    const selectedAccounts = this.filteredAccts
      .map((account: Account) => getAccountSelectionKey(account))
      .filter((accountKey: string) => this.selectedAccounts.includes(accountKey));

    const settings = await getExtensionSettings();
    const currentBankScopedAccountKeys = this.filteredAccts.map((account: Account) => toBankScopedAccountKey(this.currentBankId!, getAccountSelectionKey(account)));
    const mergedAvailableAccounts = Object.fromEntries(
      Object.entries(settings.availableAccounts).filter(
        ([key]) => !currentBankScopedAccountKeys.includes(key) && !this.filteredAccts.some((account: Account) => getAccountSelectionKey(account) === key),
      ),
    );
    const mergedSelectedAccounts = settings.selectedAccounts.filter(
      (key: string) =>
        !currentBankScopedAccountKeys.includes(key) &&
        !this.filteredAccts.some((account: Account) => getAccountSelectionKey(account) === key || account.name === key),
    );
    const currentBankLabel = getBankAdapterById(this.currentBankId)?.name ?? this.currentBankId.toUpperCase();

    this.selectedAccounts = selectedAccounts;
    await saveExtensionSettings({
      availableAccounts: {
        ...mergedAvailableAccounts,
        ...buildAvailableAccountsMap(this.filteredAccts, this.currentBankId, currentBankLabel),
      },
      selectedAccounts: [...mergedSelectedAccounts, ...selectedAccounts.map((accountKey: string) => toBankScopedAccountKey(this.currentBankId!, accountKey))],
    });
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
        this.selectedBalanceAccounts.map((acct: Account) =>
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
      this.syncResultMessage = `Created ${this.selectedBalanceAccounts.length} balance item${this.selectedBalanceAccounts.length === 1 ? '' : 's'}.`;
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

    const initialMapping = this.resolvedTransactionsFieldMapping;
    const mappingErrors = validateTransactionsFieldMapping(initialMapping, this.transactionsDatabase);
    if (mappingErrors.length > 0 || !initialMapping) {
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
      const transactionsDatabase = await refreshNotionDatabaseConnection(notion, this.transactionsDatabase, 'transactions');
      this.transactionsDatabase = transactionsDatabase;
      this.transactionsFieldMapping = resolveTransactionsFieldMapping(this.transactionsFieldMapping, transactionsDatabase);
      await saveExtensionSettings({
        transactionsDatabase,
        transactionsFieldMapping: this.transactionsFieldMapping,
      });

      const resolvedMapping = this.resolvedTransactionsFieldMapping;
      const refreshedMappingErrors = validateTransactionsFieldMapping(resolvedMapping, transactionsDatabase);
      if (refreshedMappingErrors.length > 0) {
        this.error = refreshedMappingErrors[0];
        return;
      }

      const merchantProperty = transactionsDatabase.properties.find(
        (property) => property.name === resolvedMapping!.merchantProperty,
      );
      const typeProperty = transactionsDatabase.properties.find(
        (property) => property.name === resolvedMapping!.typeProperty,
      );
      const syncIdProperty = transactionsDatabase.properties.find(
        (property) => property.name === TRANSACTION_SYNC_ID_PROPERTY,
      );

      if (!merchantProperty || !typeProperty || !syncIdProperty) {
        this.error = 'Transactions database is missing the merchant field, type field, or Sync ID field.';
        return;
      }

      const transactionDateRange = getTransactionsDateRange(this.detectedTransactions);
      if (!transactionDateRange) {
        this.error = 'Could not determine the transactions date range from the current page.';
        return;
      }

      const transactionSyncIds = await Promise.all(
        this.detectedTransactions.map(async (transaction: Transaction) => ({
          transaction,
          syncId: await createTransactionSyncId(transaction),
        })),
      );

      const existingSyncIds = await getExistingTransactionSyncIds(
        notion,
        transactionsDatabase.dataSourceId!,
        resolvedMapping!.dateProperty,
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
          const properties: NotionPageCreateProperties = {
            [resolvedMapping!.dateProperty]: {
              type: 'date',
              date: {
                start: transaction.date,
              },
            },
            [resolvedMapping!.amountProperty]: {
              type: 'number',
              number: Math.abs(transaction.amountValue),
            },
            [resolvedMapping!.accountNameProperty]: toRichText(transaction.accountName),
            [TRANSACTION_SYNC_ID_PROPERTY]: toRichText(syncId),
          };

          properties[resolvedMapping!.merchantProperty] =
            merchantProperty.type === 'title' ? toTitle(transaction.merchant) : toRichText(transaction.merchant);
          properties[resolvedMapping!.typeProperty] =
            typeProperty.type === 'select'
              ? {
                  type: 'select',
                  select: {
                    name: transaction.type,
                  },
                }
              : toRichText(transaction.type);

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

let isScanningCurrentPage = false;

const dispatchScanError = (detail: string) => {
  window.dispatchEvent(
    new CustomEvent('on-error', {
      detail,
    }),
  );
};

const scanCurrentPage = () => {
  if (isScanningCurrentPage) {
    return;
  }

  isScanningCurrentPage = true;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const currentTab = tabs[0];
    if (!currentTab?.url || !currentTab.id) {
      isScanningCurrentPage = false;
      dispatchScanError('Error: unable to determine the current tab URL.');
      return;
    }

    const currentDomain = new URL(currentTab.url).hostname;
    const bankAdapter = detectBankFromHost(currentDomain);

    if (!bankAdapter) {
      isScanningCurrentPage = false;
      dispatchScanError('Error: unsupported bank domain. Open a supported bank page and try again.');
      return;
    }

    chrome.scripting.executeScript(
      {
        target: { tabId: currentTab.id },
        func: bankAdapter.detectPageMode,
      },
      async (modeResults) => {
        if (chrome.runtime.lastError) {
          isScanningCurrentPage = false;
          dispatchScanError(`Error: ${chrome.runtime.lastError.message}`);
          return;
        }

        const pageMode = modeResults?.[0]?.result as 'unknown' | 'balances' | 'transactions';

        if (pageMode === 'transactions') {
          chrome.scripting.executeScript(
            {
              target: { tabId: currentTab.id! },
              func: bankAdapter.extractTransactions,
            },
            (transactionResults) => {
              isScanningCurrentPage = false;
              if (chrome.runtime.lastError) {
                dispatchScanError(`Error: ${chrome.runtime.lastError.message}`);
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
          dispatchScanError(`Error: unsupported ${bankAdapter.name} page. Open either an accounts overview page or a transactions page.`);
          return;
        }

        chrome.scripting.executeScript(
          {
            target: { tabId: currentTab.id! },
            func: bankAdapter.extractAccountGroups,
          },
          async (results) => {
            if (chrome.runtime.lastError) {
              isScanningCurrentPage = false;
              dispatchScanError(`Error: ${chrome.runtime.lastError.message}`);
              return;
            }

            const availableAccounts = results?.[0]?.result;
            if (!availableAccounts) {
              isScanningCurrentPage = false;
              dispatchScanError('Error: unable to find account sections.');
              return;
            }

            const settings = await getExtensionSettings();
            const scopedAvailableAccounts = getScopedAvailableAccountsForBank(settings.availableAccounts, bankAdapter.id);
            const scopedSelectedAccounts = getScopedSelectedAccountsForBank(settings.selectedAccounts, bankAdapter.id);
            const allGroupKeys = Object.keys(availableAccounts);
            const legacySelectedGroupKeys = allGroupKeys.filter((groupKey) => settings.selectedAccounts.includes(groupKey));

            chrome.scripting.executeScript(
              {
                target: { tabId: currentTab.id! },
                func: bankAdapter.extractAccounts,
                args: [allGroupKeys],
              },
              (accountResults) => {
                isScanningCurrentPage = false;
                if (chrome.runtime.lastError) {
                  dispatchScanError(`Error: ${chrome.runtime.lastError.message}`);
                  return;
                }

                const accounts = (accountResults?.[0]?.result ?? []) as Account[];
                if (accounts.length === 0) {
                  dispatchScanError(`Error: unable to find any ${bankAdapter.name} accounts on the current balances page.`);
                  return;
                }

                const accountKeys = accounts.map((account) => getAccountSelectionKey(account));
                const matchedSelectedAccountKeys = accounts
                  .filter((account) => matchesStoredAccountSelection(account, settings.selectedAccounts, bankAdapter.id))
                  .map((account) => getAccountSelectionKey(account));
                const shouldDefaultToAllAccounts =
                  scopedSelectedAccounts.length === 0 && legacySelectedGroupKeys.length === 0 && Object.keys(scopedAvailableAccounts).length === 0;

                const finalizeAccountSelection = async (selectedAccountKeys: string[]) => {
                  const normalizedSelectedAccountKeys = accountKeys.filter((accountKey) => selectedAccountKeys.includes(accountKey));
                  const scopedAccountKeys = accountKeys.map((accountKey) => toBankScopedAccountKey(bankAdapter.id, accountKey));
                  const mergedAvailableAccounts = Object.fromEntries(
                    Object.entries(settings.availableAccounts).filter(
                      ([key]) => !scopedAccountKeys.includes(key) && !accountKeys.includes(key),
                    ),
                  );
                  const mergedSelectedAccounts = settings.selectedAccounts.filter(
                    (key) =>
                      !scopedAccountKeys.includes(key) &&
                      !accountKeys.includes(key) &&
                      !accounts.some((account) => account.name === key),
                  );

                  await saveExtensionSettings({
                    availableAccounts: {
                      ...mergedAvailableAccounts,
                      ...buildAvailableAccountsMap(accounts, bankAdapter.id, bankAdapter.name),
                    },
                    selectedAccounts: [
                      ...mergedSelectedAccounts,
                      ...normalizedSelectedAccountKeys.map((accountKey) => toBankScopedAccountKey(bankAdapter.id, accountKey)),
                    ],
                  });

                  window.dispatchEvent(
                    new CustomEvent<BalanceAccountsUpdateDetail>('after-accounts-update', {
                      detail: {
                        bankId: bankAdapter.id,
                        accounts,
                        selectedAccountKeys: normalizedSelectedAccountKeys,
                      },
                    }),
                  );
                };

                if (matchedSelectedAccountKeys.length > 0) {
                  finalizeAccountSelection(matchedSelectedAccountKeys).catch((error) => {
                    const message = error instanceof Error ? error.message : String(error);
                    dispatchScanError(`Error: ${message}`);
                  });
                  return;
                }

                if (legacySelectedGroupKeys.length === 0) {
                  const defaultSelectedAccountKeys = shouldDefaultToAllAccounts ? accountKeys : [];
                  finalizeAccountSelection(defaultSelectedAccountKeys).catch((error) => {
                    const message = error instanceof Error ? error.message : String(error);
                    dispatchScanError(`Error: ${message}`);
                  });
                  return;
                }

                chrome.scripting.executeScript(
                  {
                    target: { tabId: currentTab.id! },
                    func: bankAdapter.extractAccounts,
                    args: [legacySelectedGroupKeys],
                  },
                  (legacyAccountResults) => {
                    if (chrome.runtime.lastError) {
                      dispatchScanError(`Error: ${chrome.runtime.lastError.message}`);
                      return;
                    }

                    const legacyAccounts = (legacyAccountResults?.[0]?.result ?? []) as Account[];
                    const legacySelectedAccountKeys = accountKeys.filter((accountKey) =>
                      legacyAccounts.some((account) => getAccountSelectionKey(account) === accountKey || account.name === accountKey),
                    );

                    finalizeAccountSelection(legacySelectedAccountKeys.length > 0 ? legacySelectedAccountKeys : accountKeys).catch((error) => {
                      const message = error instanceof Error ? error.message : String(error);
                      dispatchScanError(`Error: ${message}`);
                    });
                  },
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
//     const pageMode = bankAdapter.detectPageMode();
//     console.log(`Tab ${tabId} changed to: ${tab.url}`, pageMode);
//     scanCurrentPage();
//   }
// });

/*
* Popup scripts are ephemeral and only run while the popup is open. setInterval wouldnt act as supposed to do.
*/
scanCurrentPage();
