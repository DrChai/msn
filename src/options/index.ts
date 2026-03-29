import Alpine from '@alpinejs/csp';

import '../global.css';
import {
  connectNotionDatabase,
  formatNotionError,
  getCompatibleProperties,
  validateTransactionsFieldMapping,
} from '../lib/notion';
import { getExtensionSettings, saveExtensionSettings } from '../lib/storage';

window.Alpine = Alpine;

type AvailableAccount = { className: string; title: string };
type SelectedAccount = AvailableAccount['className'];
type MappingOption = DatabaseProperty & { selected: boolean };
type SectionState = {
  link: string;
  error: string;
  isConnecting: boolean;
};

const emptyTransactionsFieldMapping = (): TransactionsFieldMapping => ({
  dateProperty: '',
  amountProperty: '',
  merchantProperty: '',
  accountNameProperty: '',
  typeProperty: '',
});

const normalizeTransactionsFieldMapping = (mapping: TransactionsFieldMapping | null | undefined): TransactionsFieldMapping => ({
  dateProperty: mapping?.dateProperty ?? '',
  amountProperty: mapping?.amountProperty ?? '',
  merchantProperty: mapping?.merchantProperty ?? '',
  accountNameProperty: mapping?.accountNameProperty ?? '',
  typeProperty: mapping?.typeProperty ?? '',
});

const markSelectedOptions = (properties: DatabaseProperty[], selectedName: string): MappingOption[] =>
  properties.map((property) => ({
    ...property,
    selected: property.name === selectedName,
  }));

Alpine.data('accountOptions', () => ({
  availableAccounts: [] as AvailableAccount[],
  selectedAccounts: [] as SelectedAccount[],
  activeSettingsTab: 'account' as 'account' | 'transactions',
  notionApiKey: '',
  balanceDatabase: null as Database | null,
  transactionsDatabase: null as Database | null,
  transactionsFieldMapping: emptyTransactionsFieldMapping(),
  transactionsMappingErrors: [] as string[],
  balanceState: {
    link: '',
    error: '',
    isConnecting: false,
  } as SectionState,
  transactionsState: {
    link: '',
    error: '',
    isConnecting: false,
  } as SectionState,
  balanceRequiredSchema: ['title -> Account Name', 'number -> Balance', 'date -> Date'],
  transactionsRequiredSchema: [
    'title/rich_text -> Merchant/Description',
    'number -> Amount',
    'date -> Date',
    'rich_text -> Account Name',
    'select -> Type',
  ],
  transactionsDateOptions: [] as MappingOption[],
  transactionsAmountOptions: [] as MappingOption[],
  transactionsMerchantOptions: [] as MappingOption[],
  transactionsAccountNameOptions: [] as MappingOption[],
  transactionsTypeOptions: [] as MappingOption[],
  saveHintText: '',
  async init() {
    const settings = await getExtensionSettings();

    this.applySettingsSnapshot(settings);
    this.refreshTransactionsMappingState();
    this.refreshSaveHint();

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') {
        return;
      }

      if (
        !changes.availableAccounts &&
        !changes.selectedAccounts &&
        !changes.notionApiKey &&
        !changes.balanceDatabase &&
        !changes.transactionsDatabase &&
        !changes.transactionsFieldMapping &&
        !changes.balanceDatabaseLinkDraft &&
        !changes.transactionsDatabaseLinkDraft
      ) {
        return;
      }

      getExtensionSettings()
        .then((updatedSettings) => {
          this.applySettingsSnapshot(updatedSettings);
          this.refreshTransactionsMappingState();
          this.refreshSaveHint();
        })
        .catch(() => {});
    });
  },
  applySettingsSnapshot(settings: ExtensionSettings) {
    this.availableAccounts = Object.entries(settings.availableAccounts).map(([className, title]) => ({ className, title }));
    this.selectedAccounts = settings.selectedAccounts;
    this.notionApiKey = settings.notionApiKey;
    this.balanceDatabase = settings.balanceDatabase;
    this.transactionsDatabase = settings.transactionsDatabase;
    this.transactionsFieldMapping = normalizeTransactionsFieldMapping(settings.transactionsFieldMapping);
    this.balanceState.link = settings.balanceDatabaseLinkDraft;
    this.transactionsState.link = settings.transactionsDatabaseLinkDraft;
  },
  get balanceConnectButtonLabel() {
    return this.balanceState.isConnecting ? 'Connecting...' : 'Connect';
  },
  get transactionsConnectButtonLabel() {
    return this.transactionsState.isConnecting ? 'Connecting...' : 'Connect';
  },
  get showingAccountSyncTab() {
    return this.activeSettingsTab === 'account';
  },
  get showingTransactionSyncTab() {
    return this.activeSettingsTab === 'transactions';
  },
  get accountTabButtonClass() {
    return this.showingAccountSyncTab
      ? 'border-stone-200 border-b-white bg-white text-stone-900'
      : 'border-stone-200 bg-stone-200 text-stone-600 hover:bg-stone-300 hover:text-stone-800';
  },
  get transactionsTabButtonClass() {
    return this.showingTransactionSyncTab
      ? 'border-stone-200 border-b-white bg-white text-stone-900'
      : 'border-stone-200 bg-stone-200 text-stone-600 hover:bg-stone-300 hover:text-stone-800';
  },
  get hasBalanceDatabase() {
    return Boolean(this.balanceDatabase);
  },
  get noBalanceDatabase() {
    return !this.hasBalanceDatabase;
  },
  get hasTransactionsDatabase() {
    return Boolean(this.transactionsDatabase);
  },
  get noTransactionsDatabase() {
    return !this.hasTransactionsDatabase;
  },
  get hasBalanceEmojiOnly() {
    return Boolean(this.balanceDatabase && !this.balanceDatabase.icon && this.balanceDatabase.emoji);
  },
  get hasTransactionsEmojiOnly() {
    return Boolean(this.transactionsDatabase && !this.transactionsDatabase.icon && this.transactionsDatabase.emoji);
  },
  get balanceSchemaStatus() {
    return this.balanceDatabase?.schemaStatus ?? null;
  },
  get transactionsSchemaStatus() {
    return this.transactionsDatabase?.schemaStatus ?? null;
  },
  get balanceSchemaIsValid() {
    return Boolean(this.balanceSchemaStatus?.isValid);
  },
  get balanceSchemaToneClass() {
    return this.balanceSchemaIsValid ? 'text-lime-800' : 'text-amber-700';
  },
  get balanceSchemaHeadline() {
    return this.balanceSchemaIsValid ? 'Schema ready' : 'Schema needs attention';
  },
  get balanceAutoCreatedFieldsText() {
    return this.balanceSchemaStatus ? this.balanceSchemaStatus.autoCreatedFields.join(', ') : '';
  },
  get balanceMissingFieldsText() {
    return this.balanceSchemaStatus ? this.balanceSchemaStatus.missingFields.join(', ') : '';
  },
  get balanceNotesText() {
    return this.balanceSchemaStatus ? this.balanceSchemaStatus.notes.join(' ') : '';
  },
  get transactionsSchemaIsValid() {
    return Boolean(this.transactionsSchemaStatus?.isValid);
  },
  get transactionsSchemaToneClass() {
    return this.transactionsSchemaIsValid ? 'text-lime-800' : 'text-amber-700';
  },
  get transactionsSchemaHeadline() {
    return this.transactionsSchemaIsValid ? 'Schema ready' : 'Schema needs attention';
  },
  get transactionsAutoCreatedFieldsText() {
    return this.transactionsSchemaStatus ? this.transactionsSchemaStatus.autoCreatedFields.join(', ') : '';
  },
  get transactionsMissingFieldsText() {
    return this.transactionsSchemaStatus ? this.transactionsSchemaStatus.missingFields.join(', ') : '';
  },
  get transactionsNotesText() {
    return this.transactionsSchemaStatus ? this.transactionsSchemaStatus.notes.join(' ') : '';
  },
  get hasSaveHint() {
    return Boolean(this.saveHintText);
  },
  get noSaveHint() {
    return !this.hasSaveHint;
  },
  get hasAvailableAccounts() {
    return this.availableAccounts.length > 0;
  },
  get noAvailableAccounts() {
    return !this.hasAvailableAccounts;
  },
  openAccountSyncTab() {
    this.activeSettingsTab = 'account';
  },
  openTransactionSyncTab() {
    this.activeSettingsTab = 'transactions';
  },
  async onCheckBoxChange() {
    try {
      const selectedAccounts = [...this.selectedAccounts];

      this.selectedAccounts = selectedAccounts;
      await saveExtensionSettings({
        selectedAccounts,
      });
    } catch { /* empty */ }
  },
  onApiInput(event: Event) {
    const target = event.target as HTMLInputElement;
    this.notionApiKey = target.value;
    saveExtensionSettings({
      notionApiKey: this.notionApiKey.trim(),
    }).catch(() => {});
    this.refreshSaveHint();
  },
  onBalanceLinkInput(event: Event) {
    const target = event.target as HTMLInputElement;
    this.balanceState.link = target.value;
    saveExtensionSettings({
      balanceDatabaseLinkDraft: this.balanceState.link,
    }).catch(() => {});
  },
  onTransactionsLinkInput(event: Event) {
    const target = event.target as HTMLInputElement;
    this.transactionsState.link = target.value;
    saveExtensionSettings({
      transactionsDatabaseLinkDraft: this.transactionsState.link,
    }).catch(() => {});
  },
  refreshTransactionsMappingState() {
    this.transactionsDateOptions = markSelectedOptions(
      getCompatibleProperties(this.transactionsDatabase, ['date']),
      this.transactionsFieldMapping.dateProperty,
    );
    this.transactionsAmountOptions = markSelectedOptions(
      getCompatibleProperties(this.transactionsDatabase, ['number']),
      this.transactionsFieldMapping.amountProperty,
    );
    this.transactionsMerchantOptions = markSelectedOptions(
      getCompatibleProperties(this.transactionsDatabase, ['title', 'rich_text']),
      this.transactionsFieldMapping.merchantProperty,
    );
    this.transactionsAccountNameOptions = markSelectedOptions(
      getCompatibleProperties(this.transactionsDatabase, ['rich_text']),
      this.transactionsFieldMapping.accountNameProperty,
    );
    this.transactionsTypeOptions = markSelectedOptions(
      getCompatibleProperties(this.transactionsDatabase, ['select']),
      this.transactionsFieldMapping.typeProperty,
    );
    this.transactionsMappingErrors = validateTransactionsFieldMapping(
      this.transactionsDatabase ? this.transactionsFieldMapping : null,
      this.transactionsDatabase,
    );
  },
  refreshSaveHint() {
    if (this.balanceState.isConnecting || this.transactionsState.isConnecting) {
      this.saveHintText = 'Wait for the current Notion request to finish.';
      return;
    }

    if (this.transactionsMappingErrors.length > 0) {
      this.saveHintText = this.transactionsMappingErrors[0];
      return;
    }

    if (this.balanceSchemaStatus && !this.balanceSchemaStatus.isValid) {
      this.saveHintText = 'Balance database schema is still incomplete.';
      return;
    }

    if (this.transactionsSchemaStatus && !this.transactionsSchemaStatus.isValid) {
      this.saveHintText = 'Transactions database schema is still incomplete.';
      return;
    }

    this.saveHintText = '';
  },
  async connectBalanceDatabase() {
    this.balanceState.error = '';

    if (!this.notionApiKey.trim()) {
      this.balanceState.error = 'Enter your Notion API key first.';
      return;
    }

    if (!this.balanceState.link.trim()) {
      this.balanceState.error = 'Paste a Notion database block link first.';
      return;
    }

    this.balanceState.isConnecting = true;
    this.refreshSaveHint();
    try {
      const result = await connectNotionDatabase(this.notionApiKey, this.balanceState.link, 'balance');
      this.balanceDatabase = result.database;
      await saveExtensionSettings({
        balanceDatabase: result.database,
        balanceDatabaseLinkDraft: this.balanceState.link,
      });
    } catch (error) {
      this.balanceState.error = formatNotionError(error);
    } finally {
      this.balanceState.isConnecting = false;
      this.refreshSaveHint();
    }
  },
  async connectTransactionsDatabase() {
    this.transactionsState.error = '';

    if (!this.notionApiKey.trim()) {
      this.transactionsState.error = 'Enter your Notion API key first.';
      return;
    }

    if (!this.transactionsState.link.trim()) {
      this.transactionsState.error = 'Paste a Notion database block link first.';
      return;
    }

    this.transactionsState.isConnecting = true;
    this.refreshSaveHint();
    try {
      const result = await connectNotionDatabase(this.notionApiKey, this.transactionsState.link, 'transactions');
      this.transactionsDatabase = result.database;
      this.transactionsFieldMapping = normalizeTransactionsFieldMapping(result.suggestedMapping);
      await saveExtensionSettings({
        transactionsDatabase: result.database,
        transactionsFieldMapping: this.transactionsFieldMapping,
        transactionsDatabaseLinkDraft: this.transactionsState.link,
      });
      this.refreshTransactionsMappingState();
    } catch (error) {
      this.transactionsState.error = formatNotionError(error);
      this.refreshTransactionsMappingState();
    } finally {
      this.transactionsState.isConnecting = false;
      this.refreshSaveHint();
    }
  },
  clearBalanceDatabase() {
    this.balanceState.link = '';
    this.balanceState.error = '';
    this.balanceDatabase = null;
    saveExtensionSettings({
      balanceDatabase: null,
      balanceDatabaseLinkDraft: '',
    }).catch(() => {});
    this.refreshSaveHint();
  },
  clearTransactionsDatabase() {
    this.transactionsState.link = '';
    this.transactionsState.error = '';
    this.transactionsDatabase = null;
    this.transactionsFieldMapping = emptyTransactionsFieldMapping();
    this.transactionsDateOptions = [];
    this.transactionsAmountOptions = [];
    this.transactionsMerchantOptions = [];
    this.transactionsAccountNameOptions = [];
    this.transactionsTypeOptions = [];
    this.transactionsMappingErrors = [];
    saveExtensionSettings({
      transactionsDatabase: null,
      transactionsFieldMapping: null,
      transactionsDatabaseLinkDraft: '',
    }).catch(() => {});
    this.refreshSaveHint();
  },
  onTransactionsDateChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    this.transactionsFieldMapping.dateProperty = target.value;
    this.refreshTransactionsMappingState();
    this.refreshSaveHint();
    saveExtensionSettings({
      transactionsFieldMapping: Alpine.raw(this.transactionsFieldMapping),
    }).catch(() => {});
  },
  onTransactionsAmountChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    this.transactionsFieldMapping.amountProperty = target.value;
    this.refreshTransactionsMappingState();
    this.refreshSaveHint();
    saveExtensionSettings({
      transactionsFieldMapping: Alpine.raw(this.transactionsFieldMapping),
    }).catch(() => {});
  },
  onTransactionsMerchantChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    this.transactionsFieldMapping.merchantProperty = target.value;
    this.refreshTransactionsMappingState();
    this.refreshSaveHint();
    saveExtensionSettings({
      transactionsFieldMapping: Alpine.raw(this.transactionsFieldMapping),
    }).catch(() => {});
  },
  onTransactionsAccountNameChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    this.transactionsFieldMapping.accountNameProperty = target.value;
    this.refreshTransactionsMappingState();
    this.refreshSaveHint();
    saveExtensionSettings({
      transactionsFieldMapping: Alpine.raw(this.transactionsFieldMapping),
    }).catch(() => {});
  },
  onTransactionsTypeChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    this.transactionsFieldMapping.typeProperty = target.value;
    this.refreshTransactionsMappingState();
    this.refreshSaveHint();
    saveExtensionSettings({
      transactionsFieldMapping: Alpine.raw(this.transactionsFieldMapping),
    }).catch(() => {});
  },
}));

Alpine.start();
