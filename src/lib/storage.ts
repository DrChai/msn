const STORAGE_KEYS = [
  'availableAccounts',
  'selectedAccounts',
  'notionApiKey',
  'selectedDatabase',
  'balanceDatabase',
  'transactionsDatabase',
  'transactionsFieldMapping',
  'invertTransactionSigns',
  'balanceDatabaseLinkDraft',
  'transactionsDatabaseLinkDraft',
] as const;

const badgeClassForType = (type: string): string => {
  switch (type) {
    case 'title':
      return 'bg-blue-100 text-blue-800';
    case 'date':
      return 'bg-pink-100 text-pink-800';
    case 'number':
      return 'bg-green-100 text-green-800';
    case 'rich_text':
      return 'bg-amber-100 text-amber-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
};

const normalizeAvailableAccounts = (availableAccounts: unknown): Record<string, string> => {
  if (!availableAccounts || typeof availableAccounts !== 'object' || Array.isArray(availableAccounts)) {
    return {};
  }

  return Object.entries(availableAccounts).reduce<Record<string, string>>((result, [key, value]) => {
    if (typeof key !== 'string' || typeof value !== 'string') {
      return result;
    }

    result[key] = value;
    return result;
  }, {});
};

const normalizeSelectedAccounts = (selectedAccounts: unknown): string[] => {
  if (!Array.isArray(selectedAccounts)) {
    return [];
  }

  return Array.from(new Set(selectedAccounts.filter((value): value is string => typeof value === 'string')));
};

const normalizeBoolean = (value: unknown, fallback = false): boolean => (typeof value === 'boolean' ? value : fallback);

const normalizeDatabaseProperties = (properties: unknown): DatabaseProperty[] => {
  if (Array.isArray(properties)) {
    return properties
      .filter((property): property is Partial<DatabaseProperty> & { type: string } => Boolean(property && typeof property === 'object' && 'type' in property))
      .map((property, index) => ({
        id: typeof property.id === 'string' ? property.id : `property-${index}`,
        name: typeof property.name === 'string' ? property.name : typeof property.id === 'string' ? property.id : `Property ${index + 1}`,
        type: property.type,
        badgeClass: typeof property.badgeClass === 'string' ? property.badgeClass : badgeClassForType(property.type),
      }));
  }

  if (properties && typeof properties === 'object') {
    return Object.entries(properties).map(([name, property], index) => {
      const typedProperty = (property ?? {}) as Partial<DatabaseProperty> & { type?: string };
      const type = typeof typedProperty.type === 'string' ? typedProperty.type : 'unknown';

      return {
        id: typeof typedProperty.id === 'string' ? typedProperty.id : name || `property-${index}`,
        name: typeof typedProperty.name === 'string' ? typedProperty.name : name || `Property ${index + 1}`,
        type,
        badgeClass: typeof typedProperty.badgeClass === 'string' ? typedProperty.badgeClass : badgeClassForType(type),
      };
    });
  }

  return [];
};

const normalizeDatabase = (database: Database | null | undefined): Database | null => {
  if (!database) {
    return null;
  }

  const maybeDatabase = database as Database & { dataSourceId?: unknown; link?: unknown; properties?: unknown };

  return {
    ...database,
    dataSourceId: typeof maybeDatabase.dataSourceId === 'string' ? maybeDatabase.dataSourceId : null,
    schemaStatus: database.schemaStatus ?? null,
    link: typeof maybeDatabase.link === 'string' ? maybeDatabase.link : '',
    properties: normalizeDatabaseProperties(maybeDatabase.properties),
  };
};

const EMPTY_SETTINGS: ExtensionSettings = {
  availableAccounts: {},
  selectedAccounts: [],
  notionApiKey: '',
  balanceDatabase: null,
  transactionsDatabase: null,
  transactionsFieldMapping: null,
  invertTransactionSigns: false,
  balanceDatabaseLinkDraft: '',
  transactionsDatabaseLinkDraft: '',
};

type RawSettings = Partial<ExtensionSettings> & {
  selectedDatabase?: Database | null;
};

export const getExtensionSettings = async (): Promise<ExtensionSettings> => {
  const stored = (await chrome.storage.local.get([...STORAGE_KEYS])) as RawSettings;
  const legacyDatabase = stored.selectedDatabase ?? null;
  const balanceDatabase = normalizeDatabase(stored.balanceDatabase ?? legacyDatabase);
  const availableAccounts = normalizeAvailableAccounts(stored.availableAccounts);
  const selectedAccounts = normalizeSelectedAccounts(stored.selectedAccounts);

  if (legacyDatabase && !stored.balanceDatabase) {
    await chrome.storage.local.set({
      balanceDatabase: legacyDatabase,
      selectedDatabase: legacyDatabase,
    });
  }

  return {
    availableAccounts,
    selectedAccounts,
    notionApiKey: stored.notionApiKey ?? EMPTY_SETTINGS.notionApiKey,
    balanceDatabase,
    transactionsDatabase: normalizeDatabase(stored.transactionsDatabase ?? EMPTY_SETTINGS.transactionsDatabase),
    transactionsFieldMapping: stored.transactionsFieldMapping ?? EMPTY_SETTINGS.transactionsFieldMapping,
    invertTransactionSigns: normalizeBoolean(stored.invertTransactionSigns, EMPTY_SETTINGS.invertTransactionSigns),
    balanceDatabaseLinkDraft: stored.balanceDatabaseLinkDraft ?? balanceDatabase?.link ?? EMPTY_SETTINGS.balanceDatabaseLinkDraft,
    transactionsDatabaseLinkDraft:
      stored.transactionsDatabaseLinkDraft ??
      normalizeDatabase(stored.transactionsDatabase ?? EMPTY_SETTINGS.transactionsDatabase)?.link ??
      EMPTY_SETTINGS.transactionsDatabaseLinkDraft,
  };
};

export const saveExtensionSettings = async (partial: Partial<ExtensionSettings>): Promise<void> => {
  const payload: Record<string, unknown> = { ...partial };

  if (Object.prototype.hasOwnProperty.call(partial, 'balanceDatabase')) {
    payload.selectedDatabase = partial.balanceDatabase;
  }

  await chrome.storage.local.set(payload);
};
