export type BankId = 'cibc' | 'bmo' | 'td' | 'ws';

export type BankPageMode = 'unknown' | 'balances' | 'transactions';

export type BankCapability = {
  balances: boolean;
  transactions: boolean;
};

export type InjectedPageFn<Args extends unknown[] = [], Result = unknown> = (...args: Args) => Result | Promise<Result>;

export type AccountGroupMap = Record<string, string>;

export type BankDetectionResult = {
  bankId: BankId;
  pageMode: BankPageMode;
};

export interface BankAdapter {
  id: BankId;
  name: string;
  domainHosts: string[];
  capabilities: BankCapability;

  /*
   * These functions are intended for chrome.scripting.executeScript.
   * Implementations must be self-contained and cannot capture outer-scope values.
   */
  detectPageMode: InjectedPageFn<[], BankPageMode>;
  extractAccountGroups: InjectedPageFn<[], AccountGroupMap>;
  extractAccounts: InjectedPageFn<[selectedGroupKeys: string[]], Account[]>;
  extractTransactions: InjectedPageFn<[], Transaction[]>;
}