import { AccountGroupMap, BankAdapter, BankPageMode, InjectedPageFn } from './type';

const wealthsimpleDetectPageMode: InjectedPageFn<[], BankPageMode> = () => {
  const pathname = window.location.pathname.toLowerCase();
  const pageText = document.body?.innerText?.replace(/\s+/g, ' ').toLowerCase() ?? '';

  const hasMatchingElement = (selectors: string[]) => selectors.some((selector) => Boolean(document.querySelector(selector)));
  const isWealthsimpleAccountLabel = (text: string) =>
    text === 'Chequing' || text.startsWith('Credit card • ') || text.startsWith('Joint chequing • ');
  const hasWealthsimpleHomeAccounts = () =>
    Array.from(document.querySelectorAll('a[href^="/app/account-details/"]')).some((link) => {
      if (!(link instanceof HTMLAnchorElement)) {
        return false;
      }

      const labelledBy = link.getAttribute('aria-labelledby');
      const contentRoot = labelledBy ? document.getElementById(labelledBy) ?? link : link;
      const text = contentRoot.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      return Boolean(text) && /\$[\d,]+(?:\.\d{2})?/.test(text);
    });
  const hasWealthsimpleBalanceAccounts = () => {
    const isCurrencyLine = (text: string) => /[-+−–]?\s*\$[\d,]+(?:\.\d{2})?(?:\s*[A-Z]{3})?/.test(text);
    const isNoiseLine = (text: string) => {
      const normalized = text.toLowerCase();
      return (
        normalized === 'today' ||
        normalized === 'yesterday' ||
        normalized.includes('recent activity') ||
        normalized.includes('transaction history') ||
        normalized.includes('purchase') ||
        normalized.includes('direct deposit') ||
        normalized.includes('interac e-transfer') ||
        normalized.includes('pre-authorized debit') ||
        normalized.includes('transfer out')
      );
    };
    const isLikelyAccountLabel = (text: string) => {
      const normalized = text.toLowerCase();
      return (
        normalized === 'chequing' ||
        normalized.startsWith('joint chequing') ||
        normalized.includes('credit card') ||
        normalized.includes('cash') ||
        normalized.includes('tfsa') ||
        normalized.includes('rrsp') ||
        normalized.includes('fhsa') ||
        normalized.includes('resp') ||
        normalized.includes('invest') ||
        normalized.includes('save')
      );
    };

    return Array.from(
      document.querySelectorAll(
        'button, a, [role="button"], [data-testid*="account"], [data-testid*="holding"], [data-testid*="portfolio"], [data-testid*="product"]',
      ),
    ).some((element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const lines = element.innerText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      const amount = lines.find(isCurrencyLine);
      const label = lines.find((line) => isLikelyAccountLabel(line) && !isNoiseLine(line));

      return Boolean(amount && label);
    });
  };
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
    (hasWealthsimpleHomeAccounts() ||
      hasWealthsimpleBalanceAccounts() ||
      pathname.includes('/app/home') ||
      pathname.includes('/accounts') ||
      pathname.includes('/portfolio') ||
      pathname.includes('/invest') ||
      pageText.includes('net worth') ||
      pageText.includes('holdings')) &&
    (hasWealthsimpleHomeAccounts() || hasMatchingElement(balanceSelectors))
  ) {
    return 'balances';
  }

  return 'unknown';
};

const wealthsimpleExtractAccountGroups: InjectedPageFn<[], AccountGroupMap> = () => {
  const accountLinks = Array.from(document.querySelectorAll('a[href^="/app/account-details/"]'));
  const containers = accountLinks.filter((element) => {
    if (!(element instanceof HTMLAnchorElement)) {
      return false;
    }

    const labelledBy = element.getAttribute('aria-labelledby');
    const contentRoot = labelledBy ? document.getElementById(labelledBy) ?? element : element;
    const text = contentRoot.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    return Boolean(text) && /\$[\d,]+(?:\.\d{2})?/.test(text);
  });

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

  const isCurrencyLine = (text: string) => /[-+−–]?\s*\$[\d,]+(?:\.\d{2})?(?:\s*[A-Z]{3})?/.test(text);
  const isPerformanceLine = (text: string) => /(?:all time|today|this month|this year|action required|bi-weekly)/i.test(text);
  const isCountLine = (text: string) => /^\d+\s+accounts?$/i.test(text);
  const isStatusLine = (text: string) =>
    /^(managed|alt investments|crypto|action required)$/i.test(text.trim());
  const isNoiseLine = (text: string) => {
    const normalized = text.toLowerCase();
    return (
      normalized === 'today' ||
      normalized === 'yesterday' ||
      normalized.includes('recent activity') ||
      normalized.includes('transaction history') ||
      isCountLine(text) ||
      isPerformanceLine(text) ||
      isStatusLine(text)
    );
  };
  const getElementLines = (element: Element | null): string[] => {
    if (!(element instanceof HTMLElement)) {
      return [];
    }

    return element.innerText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  };
  const getGroupTitle = (link: HTMLAnchorElement): string => {
    const region = link.closest('[role="region"]');
    if (!(region instanceof HTMLElement)) {
      return '';
    }

    const labelledBy = region.getAttribute('aria-labelledby');
    if (!labelledBy) {
      return '';
    }

    const header = document.getElementById(labelledBy);
    const headerLines = getElementLines(header);
    return headerLines.find((line) => !isNoiseLine(line) && !isCurrencyLine(line)) ?? '';
  };
  const buildAccountName = (primaryName: string, secondaryName: string, groupTitle: string): string => {
    const normalizedPrimary = primaryName.toLowerCase();
    const normalizedSecondary = secondaryName.toLowerCase();
    const normalizedGroup = groupTitle.toLowerCase();

    if (
      secondaryName &&
      normalizedSecondary !== normalizedPrimary &&
      !isNoiseLine(secondaryName) &&
      !isCurrencyLine(secondaryName)
    ) {
      return `${primaryName} • ${secondaryName}`;
    }

    if (
      groupTitle &&
      normalizedGroup !== normalizedPrimary &&
      !normalizedPrimary.includes(normalizedGroup) &&
      !isNoiseLine(groupTitle)
    ) {
      return `${groupTitle} • ${primaryName}`;
    }

    return primaryName;
  };

  const containers = Array.from(document.querySelectorAll('a[href^="/app/account-details/"]'));
  const seen = new Set<string>();
  const accounts: Account[] = [];

  containers.forEach((container, index) => {
    if (!(container instanceof HTMLAnchorElement)) {
      return;
    }

    const labelledBy = container.getAttribute('aria-labelledby');
    const contentRoot = labelledBy ? document.getElementById(labelledBy) ?? container : container;
    const lines = getElementLines(contentRoot);

    if (lines.length === 0) {
      return;
    }

    const balance = lines.find(isCurrencyLine) ?? '';
    const contentLines = lines.filter((line) => line !== balance && !isNoiseLine(line) && !isCurrencyLine(line));
    const primaryName = contentLines[0] ?? `Wealthsimple account ${index + 1}`;
    const secondaryName = contentLines[1] ?? '';
    const groupTitle = getGroupTitle(container);
    const name = buildAccountName(primaryName, secondaryName, groupTitle);
    const key = container.getAttribute('href') ?? `${name}-${index}`;

    if (!balance || !name || isNoiseLine(name)) {
      return;
    }

    const dedupeKey = key;

    if (seen.has(dedupeKey)) {
      return;
    }

    seen.add(dedupeKey);
    accounts.push({
      key,
      name,
      balance,
    });
  });

  return accounts;
};

const wealthsimpleExtractTransactions: InjectedPageFn<[], Transaction[]> = () => {
  const isWealthsimpleAccountLabel = (text: string) =>
    text === 'Chequing' ||
    text.startsWith('Credit card • ') ||
    text.startsWith('Joint chequing • ') ||
    /saving|save/i.test(text);
  const inferAccountType = (accountLabel: string): TransactionAccountType => {
    const normalized = accountLabel.trim().toLowerCase();

    if (normalized.startsWith('credit card')) {
      return 'credit_card';
    }

    if (normalized === 'chequing' || normalized.startsWith('joint chequing')) {
      return 'checking';
    }

    if (normalized.includes('saving') || normalized.includes('save')) {
      return 'savings';
    }

    return 'unknown';
  };
  const inferTransactionType = (rawAmountValue: number): TransactionType => (rawAmountValue < 0 ? 'debit' : 'credit');

  const parseSignedAmount = (value: string): number => {
    const normalized = value.replace(/[−–]/g, '-');
    const parsed = parseFloat(normalized.replace(/[^0-9.-]+/g, ''));
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  const getCurrencyCode = (value: string): string | null => {
    const currencyMatch = value.match(/\b([A-Z]{3})\b/);
    return currencyMatch?.[1] ?? null;
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
      const accountType = inferAccountType(accountLabel);
      const rawAmountValue = parseSignedAmount(amountText);
      const dateText = currentDateText || findNearestDateHeadingText(element);

      transactions.push({
        key: `${dateText}-${amountText}-${detail || merchant}-${index}`,
        date: parseTransactionDate(dateText),
        amountText,
        amountValue: Math.abs(rawAmountValue),
        rawAmountValue,
        currencyCode: getCurrencyCode(amountText),
        cardProductName: accountName,
        merchant,
        description: detail || merchant,
        maskedCardNumber: '',
        cardLastFour: '',
        accountName,
        accountType,
        type: inferTransactionType(rawAmountValue),
        category: detail,
      });
    });

    return transactions;
  };

  return readTransactions();
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
