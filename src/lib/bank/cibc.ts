import { AccountGroupMap, BankAdapter, BankPageMode, InjectedPageFn } from './type';

const cibcDetectPageMode: InjectedPageFn<[], BankPageMode> = () => {
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
};

const cibcExtractAccountGroups: InjectedPageFn<[], AccountGroupMap> = () => {
  const accountGroups = document.querySelectorAll('.account-groups-container');
  const accountTypes: AccountGroupMap = {};

  accountGroups.forEach((group) => {
    const headerElement = group.querySelector('.account-groups-header h2');
    const groupClass = group.classList[1];
    const groupTitle = (headerElement as HTMLElement | null)?.innerText.trim();

    if (groupTitle && groupClass) {
      accountTypes[groupClass] = groupTitle;
    }
  });

  return accountTypes;
};

const cibcExtractAccounts: InjectedPageFn<[selectedGroupKeys: string[]], Account[]> = (selectedGroupKeys) => {
  const selector = selectedGroupKeys.map((className) => `.account-groups-container.${className} .card-container`).join(',');
  const cardContainers = document.querySelectorAll(selector);
  const accounts: Account[] = [];

  cardContainers.forEach((container) => {
    const nameElement = container.querySelector('.account-name span');
    const balanceElement = container.querySelector('.account-balance p');

    const name = nameElement instanceof HTMLElement ? nameElement.innerText.trim() : 'No name found';
    const balance = balanceElement instanceof HTMLElement ? balanceElement.innerText.trim() : 'No balance found';

    accounts.push({ name, balance });
  });

  return accounts;
};

const cibcExtractTransactions: InjectedPageFn<[], Transaction[]> = () => {
  const parseSignedAmount = (value: string): number => {
    const normalized = value.replace(/[−–]/g, '-');
    const parsed = parseFloat(normalized.replace(/[^0-9.-]+/g, ''));
    return Number.isNaN(parsed) ? 0 : parsed;
  };

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

  const getRows = () =>
    Array.from(document.querySelectorAll('tr.transaction-row')).filter(
      (row) =>
        Boolean(row.querySelector('.transactionDate span')) && Boolean(row.querySelector('.transactionDescription')) && Boolean(row.querySelector('td.amount')),
    );

  const cardProductName = (document.querySelector('.card-details-main .product-name') as HTMLElement | null)?.innerText.replace(/\s+/g, ' ').trim() ?? '';

  const readTransactions = (): Transaction[] =>
    getRows().map((row) => {
      const dateText = (row.querySelector('.transactionDate span') as HTMLElement | null)?.innerText.trim() ?? '';
      const description = (row.querySelector('.transactionDescription') as HTMLElement | null)?.innerText.trim() ?? '';
      const maskedCardNumber = (row.querySelector('.transactionCardNo') as HTMLElement | null)?.innerText.trim() ?? '';
      const amountCell = row.querySelector('td.amount');
      const amountText = (amountCell?.querySelector('span') as HTMLElement | null)?.innerText.trim() ?? '';
      const amountClassList = Array.from(amountCell?.classList ?? []);
      const categoryIcon = row.querySelector('td.transactions img[title]') as HTMLImageElement | null;
      const category = categoryIcon?.title?.trim() ?? '';
      const cardLastFour = (maskedCardNumber.match(/(\d{4})$/) ?? [])[1] ?? '';
      const amountValue = parseSignedAmount(amountText);
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
        accountType: 'credit_card',
        direction,
        category,
      };
    });

  return readTransactions();
};

export const CIBC_BANK_ADAPTER: BankAdapter = {
  id: 'cibc',
  name: 'CIBC',
  domainHosts: ['cibconline.cibc.com'],
  capabilities: {
    balances: true,
    transactions: true,
  },
  detectPageMode: cibcDetectPageMode,
  extractAccountGroups: cibcExtractAccountGroups,
  extractAccounts: cibcExtractAccounts,
  extractTransactions: cibcExtractTransactions,
};
