import { CIBC_BANK_ADAPTER } from './cibc';
import { WEALTHSIMPLE_BANK_ADAPTER } from './wealthsimple';
import { BankAdapter, BankId } from './type';

export const BANK_ADAPTERS: BankAdapter[] = [CIBC_BANK_ADAPTER, WEALTHSIMPLE_BANK_ADAPTER];

export const detectBankFromHost = (hostname: string): BankAdapter | null =>
  BANK_ADAPTERS.find((adapter) => adapter.domainHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) ?? null;

export const getBankAdapterById = (bankId: BankId): BankAdapter | null => BANK_ADAPTERS.find((adapter) => adapter.id === bankId) ?? null;
