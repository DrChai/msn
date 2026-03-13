import { AccountGroupMap, BankAdapter, BankPageMode, InjectedPageFn } from './type';

const wealthsimpleDetectPageMode: InjectedPageFn<[], BankPageMode> = () => {
  const pathname = window.location.pathname.toLowerCase();
  const pageText = document.body?.innerText?.replace(/\s+/g, ' ').toLowerCase() ?? '';

  const hasMatchingElement = (selectors: string[]) => selectors.some((selector) => Boolean(document.querySelector(selector)));
  const isWealthsimpleAccountLabel = (text: string) =>
    text === 'Chequing' || text.startsWith('Credit card • ') || text.startsWith('Joint chequing • ');
  const hasWealthsimpleCreditCardTransactions = () =>
    Array.from(document.querySelectorAll('button[aria-controls][id$="-header"]')).some((button) => {
      if (!(button instanceof HTMLElement)) {
        return false;
      }

      const texts = Array.from(button.querySelectorAll('p'))
        .map((element) => element.textContent?.replace(/\s+/g, ' ').trim() ?? '')
        .filter(Boolean);

      const hasAccountLabel = texts.some((text) => isWealthsimpleAccountLabel(text));
      const hasAmount = texts.some((text) => /[-+−–]?\s*\$[\d,]+(?:\.\d{2})?\s*[A-Z]{3}/.test(text));

      return hasAccountLabel && hasAmount;
    });

  const transactionSelectors = [
    '[data-testid*="activity"]',
    '[data-testid*="transaction"]',
    '[aria-label*="activity" i]',
    '[aria-label*="transaction" i]',
    '[role="table"]',
    'table',
  ];

  const balanceSelectors = [
    '[data-testid*="account"]',
    '[data-testid*="holding"]',
    '[data-testid*="portfolio"]',
    '[aria-label*="account" i]',
    '[aria-label*="holding" i]',
    '[role="table"]',
    'table',
  ];

  if (
    hasWealthsimpleCreditCardTransactions() ||
    ((pathname.includes('/activity') ||
      pathname.includes('/transactions') ||
      pageText.includes('recent activity') ||
      pageText.includes('transaction history')) &&
      hasMatchingElement(transactionSelectors))
  ) {
    return 'transactions';
  }

  if (
    (pathname.includes('/accounts') ||
      pathname.includes('/portfolio') ||
      pathname.includes('/invest') ||
      pageText.includes('net worth') ||
      pageText.includes('holdings')) &&
    hasMatchingElement(balanceSelectors)
  ) {
    return 'balances';
  }

  return 'unknown';
};

const wealthsimpleExtractAccountGroups: InjectedPageFn<[], AccountGroupMap> = () => {
  const containers = document.querySelectorAll(
    '[data-testid*="account"], [data-testid*="holding"], [data-testid*="portfolio"], [role="table"], table',
  );

  if (containers.length === 0) {
    return {} as AccountGroupMap;
  }

  return {
    all: 'All Wealthsimple accounts',
  };
};

const wealthsimpleExtractAccounts: InjectedPageFn<[selectedGroupKeys: string[]], Account[]> = (selectedGroupKeys) => {
  const shouldReadAll = selectedGroupKeys.length === 0 || selectedGroupKeys.includes('all');
  if (!shouldReadAll) {
    return [];
  }

  const containers = Array.from(
    document.querySelectorAll(
      '[data-testid*="account"], [data-testid*="holding"], [data-testid*="portfolio"], [role="table"], table',
    ),
  );
  const seen = new Set<string>();
  const accounts: Account[] = [];

  containers.forEach((container, index) => {
    if (!(container instanceof HTMLElement)) {
      return;
    }

    const lines = container.innerText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return;
    }

    const balance = lines.find((line) => /[-+−–]?\$[\d,]+(?:\.\d{2})?/.test(line)) ?? '';
    const name = lines.find((line) => line !== balance) ?? `Wealthsimple account ${index + 1}`;
    const dedupeKey = `${name}|${balance}`;

    if (seen.has(dedupeKey)) {
      return;
    }

    seen.add(dedupeKey);
    accounts.push({
      name,
      balance,
    });
  });

  return accounts;
};

const wealthsimpleExtractTransactions: InjectedPageFn<[], Transaction[]> = () => {
  const isWealthsimpleAccountLabel = (text: string) =>
    text === 'Chequing' || text.startsWith('Credit card • ') || text.startsWith('Joint chequing • ');

  const parseSignedAmount = (value: string): number => {
    const normalized = value.replace(/[−–]/g, '-');
    const parsed = parseFloat(normalized.replace(/[^0-9.-]+/g, ''));
    return Number.isNaN(parsed) ? 0 : parsed;
  };

  const parseTransactionDate = (value: string): string => {
    const normalizedValue = value.trim().toLowerCase();

    if (normalizedValue === 'today' || normalizedValue === 'yesterday') {
      const relativeDate = new Date();
      if (normalizedValue === 'yesterday') {
        relativeDate.setDate(relativeDate.getDate() - 1);
      }

      const year = relativeDate.getFullYear();
      const month = `${relativeDate.getMonth() + 1}`.padStart(2, '0');
      const day = `${relativeDate.getDate()}`.padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return value;
    }

    const year = parsed.getFullYear();
    const month = `${parsed.getMonth() + 1}`.padStart(2, '0');
    const day = `${parsed.getDate()}`.padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const isSupportedDateHeadingText = (value: string): boolean => {
    const normalizedValue = value.trim().toLowerCase();
    if (!normalizedValue) {
      return false;
    }

    if (normalizedValue === 'today' || normalizedValue === 'yesterday') {
      return true;
    }

    return !Number.isNaN(new Date(value).getTime());
  };

  const isDateHeading = (element: Element): element is HTMLHeadingElement => {
    if (!(element instanceof HTMLHeadingElement)) {
      return false;
    }

    const text = element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    return isSupportedDateHeadingText(text);
  };

  const isTransactionButton = (element: Element): element is HTMLButtonElement => {
    if (!(element instanceof HTMLButtonElement)) {
      return false;
    }

    const texts = Array.from(element.querySelectorAll('p'))
      .map((paragraph) => paragraph.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      .filter(Boolean);

    const hasAccountLabel = texts.some((text) => isWealthsimpleAccountLabel(text));
    const hasAmount = texts.some((text) => /[-+−–]?\s*\$[\d,]+(?:\.\d{2})?\s*[A-Z]{3}/.test(text));

    return hasAccountLabel && hasAmount;
  };

  const getTimelineElements = () =>
    Array.from(document.querySelectorAll('h2, button[aria-controls][id$="-header"]')).filter((element) => {
      if (isDateHeading(element)) {
        return true;
      }

      return isTransactionButton(element);
    });

  const findNearestDateHeadingText = (button: HTMLButtonElement): string => {
    let currentElement: Element | null = button;

    while (currentElement) {
      let sibling: Element | null = currentElement.previousElementSibling;
      while (sibling) {
        const directHeading = sibling.matches('h2') ? sibling : sibling.querySelector('h2');
        if (directHeading instanceof HTMLHeadingElement) {
          const headingText = directHeading.textContent?.replace(/\s+/g, ' ').trim() ?? '';
          if (isSupportedDateHeadingText(headingText)) {
            return headingText;
          }
        }

        sibling = sibling.previousElementSibling;
      }

      currentElement = currentElement.parentElement;
    }

    return '';
  };

  const readTransactions = (): Transaction[] => {
    const timelineElements = getTimelineElements();
    const transactions: Transaction[] = [];
    let currentDateText = '';

    timelineElements.forEach((element, index) => {
      if (isDateHeading(element)) {
        currentDateText = element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        return;
      }

      if (!isTransactionButton(element)) {
        return;
      }

      const texts = Array.from(element.querySelectorAll('p'))
        .map((paragraph) => paragraph.textContent?.replace(/\s+/g, ' ').trim() ?? '')
        .filter(Boolean);

      const amountText = texts.find((text) => /[-+−–]?\s*\$[\d,]+(?:\.\d{2})?\s*[A-Z]{3}/.test(text)) ?? '';
      const accountLabel = texts.find((text) => isWealthsimpleAccountLabel(text)) ?? 'Wealthsimple account';
      const contentTexts = texts.filter((text) => text !== amountText && text !== accountLabel);
      const merchant = contentTexts[0] ?? `Transaction ${index + 1}`;
      const detail = contentTexts[1] ?? '';
      const accountName = accountLabel.includes('•') ? accountLabel.split('•').pop()?.trim() ?? accountLabel : accountLabel;
      const amountValue = parseSignedAmount(amountText);
      const direction = amountValue < 0 ? 'debit' : amountValue > 0 ? 'credit' : 'unknown';
      const dateText = currentDateText || findNearestDateHeadingText(element);

      transactions.push({
        key: `${dateText}-${amountText}-${detail || merchant}-${index}`,
        date: parseTransactionDate(dateText),
        amountText,
        amountValue,
        cardProductName: accountName,
        merchant,
        description: detail || merchant,
        maskedCardNumber: '',
        cardLastFour: '',
        accountName,
        direction,
        category: detail,
      });
    });

    return transactions;
  };

  const initialTransactions = readTransactions();
  if (initialTransactions.length > 0) {
    return Promise.resolve(initialTransactions);
  }

  return new Promise<Transaction[]>((resolve) => {
    const startedAt = Date.now();
    const intervalId = window.setInterval(() => {
      const transactions = readTransactions();
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

export const WEALTHSIMPLE_BANK_ADAPTER: BankAdapter = {
  id: 'ws',
  name: 'Wealthsimple',
  domainHosts: ['app.wealthsimple.com', 'my.wealthsimple.com'],
  capabilities: {
    balances: true,
    transactions: true,
  },
  detectPageMode: wealthsimpleDetectPageMode,
  extractAccountGroups: wealthsimpleExtractAccountGroups,
  extractAccounts: wealthsimpleExtractAccounts,
  extractTransactions: wealthsimpleExtractTransactions,
};
