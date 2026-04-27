/// <reference types="chrome" />

declare module '@alpinejs/csp' {
  interface AlpineInstance {
    data<T>(name: string, callback: () => T): AlpineInstance;
    raw<T>(value: T): T;
    start(): void;
  }

  const Alpine: AlpineInstance;
  export default Alpine;
}

interface Window {
  Alpine: import('@alpinejs/csp').default;
}

type Account = {
  key?: string;
  name: string;
  balance: string;
};
type TransactionAccountType = 'credit_card' | 'checking' | 'savings' | 'unknown';
type TransactionType = 'credit' | 'debit';
type Transaction = {
  key: string;
  date: string;
  amountText: string;
  amountValue: number;
  rawAmountValue: number;
  currencyCode: string | null;
  cardProductName: string;
  merchant: string;
  description: string;
  maskedCardNumber: string;
  cardLastFour: string;
  accountName: string;
  accountType: TransactionAccountType;
  type: TransactionType;
  category: string;
};

type DatabaseKind = 'balance' | 'transactions';
type DatabasePropertyType = string;
type DatabaseProperty = {
  id: string;
  type: DatabasePropertyType;
  name: string;
  badgeClass?: string;
};
type DatabaseSchemaStatus = {
  isValid: boolean;
  missingFields: string[];
  autoCreatedFields: string[];
  notes: string[];
};
type Database = {
  id: string;
  dataSourceId: string | null;
  title: string;
  icon: string | null;
  emoji: string | null;
  properties: DatabaseProperty[];
  link: string;
  schemaStatus: DatabaseSchemaStatus | null;
};
type TransactionsFieldMapping = {
  dateProperty: string;
  amountProperty: string;
  merchantProperty: string;
  accountNameProperty: string;
  typeProperty: string;
};
type ExtensionSettings = {
  availableAccounts: Record<string, string>;
  selectedAccounts: string[];
  notionApiKey: string;
  balanceDatabase: Database | null;
  transactionsDatabase: Database | null;
  transactionsFieldMapping: TransactionsFieldMapping | null;
  balanceDatabaseLinkDraft: string;
  transactionsDatabaseLinkDraft: string;
};
