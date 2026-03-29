import { Client } from '@notionhq/client';

type NotionTitleItem = {
  plain_text?: string;
};

type NotionIcon =
  | {
      type: 'emoji';
      emoji: string;
    }
  | {
      type: 'external';
      external: {
        url: string;
      };
    }
  | {
      type: 'file';
      file: {
        url: string;
      };
    }
  | {
      type: 'custom_emoji';
      custom_emoji: {
        url: string;
      };
    }
  | null;

type NotionPropertyResponse = {
  id?: string;
  name?: string;
  type: string;
};

type NotionDatabaseResponse = {
  id: string;
  title?: NotionTitleItem[];
  icon?: NotionIcon;
  data_sources?: Array<{
    id: string;
    name?: string;
  }>;
};

type NotionDataSourceResponse = {
  id: string;
  title?: NotionTitleItem[];
  icon?: NotionIcon;
  properties: Record<string, NotionPropertyResponse>;
  parent?: {
    type: 'database_id';
    database_id: string;
  } | {
    type: 'data_source_id';
    data_source_id: string;
  };
};

type NotionDataSourceUpdateRequest = Parameters<Client['dataSources']['update']>[0];
type NotionDataSourceUpdateProperties = NonNullable<NotionDataSourceUpdateRequest['properties']>;

type DatabaseConnectionResult = {
  database: Database;
  suggestedMapping: TransactionsFieldMapping | null;
};

const BALANCE_REQUIRED_FIELDS = ['Account Name', 'Balance', 'Date'] as const;
const TRANSACTION_REQUIRED_FIELDS = ['Date', 'Amount', 'Merchant/Description', 'Account Name', 'Type'] as const;
export const TRANSACTION_SYNC_ID_PROPERTY = 'Sync ID';

const BALANCE_AUTO_PROPERTIES = {
  Balance: { number: { format: 'dollar' } },
  Date: { date: {} },
} as const;

const TRANSACTION_TYPE_SELECT_PROPERTY: NotionDataSourceUpdateProperties[string] = {
  select: {
    options: [
      { name: 'debit', color: 'red' },
      { name: 'credit', color: 'green' },
    ],
  },
};

const TRANSACTION_AUTO_PROPERTIES = {
  Amount: { number: { format: 'dollar' } },
  Date: { date: {} },
  'Account Name': { rich_text: {} },
  Type: TRANSACTION_TYPE_SELECT_PROPERTY,
  [TRANSACTION_SYNC_ID_PROPERTY]: { rich_text: {} },
} as const;

const NOTION_ID_PATTERN = /[0-9a-z]{32}|[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/i;
const NOTION_PATH_ID_PATTERN = /(?:^|-)([0-9a-z]{32}|[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12})$/i;

const EMPTY_SCHEMA_STATUS = (): DatabaseSchemaStatus => ({
  isValid: false,
  missingFields: [],
  autoCreatedFields: [],
  notes: [],
});

const normalizeNotionId = (value: string): string => {
  const compact = value.replace(/-/g, '').toLowerCase();
  if (compact.length !== 32) {
    return value;
  }

  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20, 32),
  ].join('-');
};

const extractNotionId = (value: string): string | null => {
  const match = value.match(NOTION_ID_PATTERN);
  return match ? normalizeNotionId(match[0]) : null;
};

const plainTitle = (title: NotionTitleItem[] | undefined): string => title?.map((item) => item.plain_text ?? '').join('').trim() ?? '';

const iconUrlFromIcon = (icon: NotionIcon | undefined): string | null => {
  if (!icon) {
    return null;
  }

  if (icon.type === 'external') {
    return icon.external.url;
  }

  if (icon.type === 'file') {
    return icon.file.url;
  }

  if (icon.type === 'custom_emoji') {
    return icon.custom_emoji.url;
  }

  return null;
};

const emojiFromIcon = (icon: NotionIcon | undefined): string | null => (icon?.type === 'emoji' ? icon.emoji : null);

const mapProperties = (properties: Record<string, NotionPropertyResponse>): DatabaseProperty[] =>
  Object.entries(properties).map(([fallbackName, property]) => ({
    id: property.id ?? fallbackName,
    name: property.name ?? fallbackName,
    type: property.type,
    badgeClass:
      property.type === 'title'
        ? 'bg-blue-100 text-blue-800'
        : property.type === 'date'
          ? 'bg-pink-100 text-pink-800'
          : property.type === 'number'
            ? 'bg-green-100 text-green-800'
            : property.type === 'rich_text'
              ? 'bg-amber-100 text-amber-800'
              : 'bg-gray-100 text-gray-800',
  }));

const mapDatabase = (
  databaseResponse: NotionDatabaseResponse,
  dataSourceResponse: NotionDataSourceResponse,
  link: string,
  schemaStatus: DatabaseSchemaStatus | null,
): Database => ({
  id: databaseResponse.id,
  dataSourceId: dataSourceResponse.id,
  title: plainTitle(dataSourceResponse.title) || plainTitle(databaseResponse.title) || 'Untitled database',
  icon: iconUrlFromIcon(dataSourceResponse.icon) ?? iconUrlFromIcon(databaseResponse.icon),
  emoji: emojiFromIcon(dataSourceResponse.icon) ?? emojiFromIcon(databaseResponse.icon),
  properties: mapProperties(dataSourceResponse.properties),
  link,
  schemaStatus,
});

const browserSafeFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

export const createNotionClient = (apiKey: string): Client =>
  new Client({
    auth: apiKey.trim(),
    fetch: browserSafeFetch,
  });

const getDatabaseProperty = (database: Database, predicate: (property: DatabaseProperty) => boolean): DatabaseProperty | undefined =>
  database.properties.find(predicate);

const missingBalanceFields = (database: Database): string[] => {
  const missing: string[] = [];

  if (!database.properties.some((property) => property.type === 'title')) {
    missing.push('Account Name');
  }
  if (!database.properties.some((property) => property.type === 'number')) {
    missing.push('Balance');
  }
  if (!database.properties.some((property) => property.type === 'date')) {
    missing.push('Date');
  }

  return missing;
};

const missingTransactionsFields = (database: Database): string[] => {
  const missing: string[] = [];
  const titleProperties = database.properties.filter((property) => property.type === 'title');
  const richTextProperties = database.properties.filter((property) => property.type === 'rich_text');
  const hasMerchantProperty = titleProperties.length > 0 || richTextProperties.length > 0;
  const hasAccountNameProperty =
    Boolean(findPropertyByName(database, 'Account Name')) || richTextProperties.length >= (titleProperties.length > 0 ? 1 : 2);
  const hasTypeProperty = Boolean(findPropertyByName(database, 'Type')) || database.properties.some((property) => property.type === 'select');

  if (!hasMerchantProperty) {
    missing.push('Merchant/Description');
  }
  if (!database.properties.some((property) => property.type === 'number')) {
    missing.push('Amount');
  }
  if (!database.properties.some((property) => property.type === 'date')) {
    missing.push('Date');
  }
  if (!hasAccountNameProperty) {
    missing.push('Account Name');
  }
  if (!hasTypeProperty) {
    missing.push('Type');
  }

  return missing;
};

const buildSchemaStatus = (
  kind: DatabaseKind,
  database: Database,
  autoCreatedFields: string[],
  notes: string[],
): DatabaseSchemaStatus => {
  const missingFields = kind === 'balance' ? missingBalanceFields(database) : missingTransactionsFields(database);

  return {
    isValid: missingFields.length === 0,
    missingFields,
    autoCreatedFields,
    notes,
  };
};

const findPropertyByName = (database: Database, name: string): DatabaseProperty | undefined =>
  getDatabaseProperty(database, (property) => property.name === name);

const findPropertyByType = (database: Database, type: string): DatabaseProperty | undefined =>
  getDatabaseProperty(database, (property) => property.type === type);

export const suggestTransactionsFieldMapping = (database: Database): TransactionsFieldMapping | null => {
  const titleProperty = database.properties.find((property) => property.type === 'title');
  const richTextProperties = database.properties.filter((property) => property.type === 'rich_text');
  const nonSystemRichTextProperties = richTextProperties.filter(
    (property) => property.name !== 'Account Name' && property.name !== 'Type' && property.name !== TRANSACTION_SYNC_ID_PROPERTY,
  );
  const amountProperty = findPropertyByName(database, 'Amount') ?? findPropertyByType(database, 'number');
  const dateProperty = findPropertyByName(database, 'Date') ?? findPropertyByType(database, 'date');
  const merchantProperty =
    titleProperty ??
    findPropertyByName(database, 'Merchant') ??
    findPropertyByName(database, 'Merchant/Description') ??
    findPropertyByName(database, 'Description') ??
    nonSystemRichTextProperties[0];
  const accountNameProperty =
    findPropertyByName(database, 'Account Name') ??
    nonSystemRichTextProperties.find((property) => property.name !== merchantProperty?.name);
  const typeProperty = findPropertyByName(database, 'Type');

  if (!dateProperty || !amountProperty || !merchantProperty || !accountNameProperty || !typeProperty) {
    return null;
  }

  const uniqueProperties = new Set([
    dateProperty.name,
    amountProperty.name,
    merchantProperty.name,
    accountNameProperty.name,
    typeProperty.name,
  ]);

  if (uniqueProperties.size !== 5) {
    return null;
  }

  return {
    dateProperty: dateProperty.name,
    amountProperty: amountProperty.name,
    merchantProperty: merchantProperty.name,
    accountNameProperty: accountNameProperty.name,
    typeProperty: typeProperty.name,
  };
};

const makeReadableError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'object' && error && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }

  return 'Unknown error';
};

const resolveDataSourceId = (response: NotionDatabaseResponse, preferredDataSourceId?: string): string => {
  const dataSources = response.data_sources ?? [];

  if (preferredDataSourceId && dataSources.some((dataSource) => dataSource.id === preferredDataSourceId)) {
    return preferredDataSourceId;
  }

  if (dataSources.length === 1) {
    return dataSources[0].id;
  }

  if (dataSources.length === 0) {
    throw new Error('Notion database has no data sources available for syncing.');
  }

  throw new Error('Notion database has multiple data sources. Connect a database that has only one data source.');
};

const retrieveDatabaseContainer = async (notion: Client, databaseId: string): Promise<NotionDatabaseResponse> =>
  (await notion.databases.retrieve({
    database_id: databaseId,
  })) as unknown as NotionDatabaseResponse;

const retrieveDataSource = async (notion: Client, dataSourceId: string): Promise<NotionDataSourceResponse> =>
  (await notion.dataSources.retrieve({
    data_source_id: dataSourceId,
  })) as unknown as NotionDataSourceResponse;

const isObjectNotFoundError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'object_not_found';

const retrieveConnectedDatabase = async (
  notion: Client,
  databaseId: string,
  link: string,
  schemaStatus: DatabaseSchemaStatus | null,
  preferredDataSourceId?: string,
): Promise<Database> => {
  const databaseResponse = await retrieveDatabaseContainer(notion, databaseId);
  const dataSourceId = resolveDataSourceId(databaseResponse, preferredDataSourceId);
  const dataSourceResponse = await retrieveDataSource(notion, dataSourceId);

  return mapDatabase(databaseResponse, dataSourceResponse, link, schemaStatus);
};

const updateDatabaseProperties = async (
  notion: Client,
  dataSourceId: string,
  properties: NotionDataSourceUpdateProperties,
): Promise<void> => {
  if (Object.keys(properties).length === 0) {
    return;
  }

  await notion.dataSources.update({
    data_source_id: dataSourceId,
    properties,
  });
};

const ensureBalanceSchema = async (
  notion: Client,
  link: string,
  databaseId: string,
  preferredDataSourceId?: string,
): Promise<Database> => {
  let mapped = await retrieveConnectedDatabase(notion, databaseId, link, EMPTY_SCHEMA_STATUS(), preferredDataSourceId);
  const propertiesToCreate: NotionDataSourceUpdateProperties = {};
  const autoCreatedFields: string[] = [];
  const notes: string[] = [];

  if (!findPropertyByType(mapped, 'title')) {
    notes.push('Notion database is missing a title property and cannot be used for balance sync.');
  }
  if (!findPropertyByType(mapped, 'number')) {
    propertiesToCreate.Balance = BALANCE_AUTO_PROPERTIES.Balance;
    autoCreatedFields.push('Balance');
  }
  if (!findPropertyByType(mapped, 'date')) {
    propertiesToCreate.Date = BALANCE_AUTO_PROPERTIES.Date;
    autoCreatedFields.push('Date');
  }

  if (Object.keys(propertiesToCreate).length > 0) {
    await updateDatabaseProperties(notion, mapped.dataSourceId!, propertiesToCreate);
    mapped = await retrieveConnectedDatabase(notion, mapped.id, link, EMPTY_SCHEMA_STATUS(), mapped.dataSourceId ?? undefined);
  }

  mapped.schemaStatus = buildSchemaStatus('balance', mapped, autoCreatedFields, notes);
  return mapped;
};

const ensureTransactionsSchema = async (
  notion: Client,
  link: string,
  databaseId: string,
  preferredDataSourceId?: string,
): Promise<Database> => {
  let mapped = await retrieveConnectedDatabase(notion, databaseId, link, EMPTY_SCHEMA_STATUS(), preferredDataSourceId);
  const propertiesToCreate: NotionDataSourceUpdateProperties = {};
  const autoCreatedFields: string[] = [];

  if (!findPropertyByType(mapped, 'number')) {
    propertiesToCreate.Amount = TRANSACTION_AUTO_PROPERTIES.Amount;
    autoCreatedFields.push('Amount');
  }
  if (!findPropertyByType(mapped, 'date')) {
    propertiesToCreate.Date = TRANSACTION_AUTO_PROPERTIES.Date;
    autoCreatedFields.push('Date');
  }
  if (!findPropertyByName(mapped, 'Account Name')) {
    propertiesToCreate['Account Name'] = TRANSACTION_AUTO_PROPERTIES['Account Name'];
    autoCreatedFields.push('Account Name');
  }
  const typeProperty = findPropertyByName(mapped, 'Type');
  if (!typeProperty) {
    propertiesToCreate.Type = TRANSACTION_AUTO_PROPERTIES.Type;
    autoCreatedFields.push('Type');
  } else if (typeProperty.type === 'rich_text') {
    propertiesToCreate.Type = TRANSACTION_AUTO_PROPERTIES.Type;
    autoCreatedFields.push('Type (converted to select)');
  }
  if (!findPropertyByName(mapped, TRANSACTION_SYNC_ID_PROPERTY)) {
    propertiesToCreate[TRANSACTION_SYNC_ID_PROPERTY] = TRANSACTION_AUTO_PROPERTIES[TRANSACTION_SYNC_ID_PROPERTY];
    autoCreatedFields.push(TRANSACTION_SYNC_ID_PROPERTY);
  }

  if (Object.keys(propertiesToCreate).length > 0) {
    await updateDatabaseProperties(notion, mapped.dataSourceId!, propertiesToCreate);
    mapped = await retrieveConnectedDatabase(notion, mapped.id, link, EMPTY_SCHEMA_STATUS(), mapped.dataSourceId ?? undefined);
  }

  const notes: string[] = [];
  if (!findPropertyByType(mapped, 'title')) {
    notes.push('Transactions database should keep one title property for Merchant/Description.');
  }
  if (!findPropertyByType(mapped, 'title') && !findPropertyByType(mapped, 'rich_text')) {
    notes.push('No text field is available for Merchant/Description.');
  }

  mapped.schemaStatus = buildSchemaStatus('transactions', mapped, autoCreatedFields, notes);
  return mapped;
};

export const parseNotionDatabaseId = (value: string): string | null => {
  const trimmed = value.trim();
  const looksLikeUrl = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) || trimmed.startsWith('www.');

  if (looksLikeUrl) {
    try {
      const url = new URL(trimmed.startsWith('www.') ? `https://${trimmed}` : trimmed);
      const pathSegments = url.pathname
        .split('/')
        .filter(Boolean)
        .reverse();

      for (const segment of pathSegments) {
        const match = decodeURIComponent(segment).match(NOTION_PATH_ID_PATTERN);
        if (match) {
          return normalizeNotionId(match[1]);
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  return extractNotionId(trimmed);
};

export const connectNotionDatabase = async (
  apiKey: string,
  link: string,
  kind: DatabaseKind,
): Promise<DatabaseConnectionResult> => {
  const notion = createNotionClient(apiKey);
  const notionId = parseNotionDatabaseId(link);

  if (!notionId) {
    throw new Error('Paste a full Notion database URL or a raw 32-character database/data source ID. Do not paste the v= view ID.');
  }

  let database: Database;

  try {
    database =
      kind === 'balance'
        ? await ensureBalanceSchema(notion, link, notionId)
        : await ensureTransactionsSchema(notion, link, notionId);
  } catch (error) {
    if (!isObjectNotFoundError(error)) {
      throw error;
    }

    const dataSource = await retrieveDataSource(notion, notionId);
    if (dataSource.parent?.type !== 'database_id') {
      throw new Error('The provided data source is not directly attached to a Notion database.');
    }

    database =
      kind === 'balance'
        ? await ensureBalanceSchema(notion, link, dataSource.parent.database_id, dataSource.id)
        : await ensureTransactionsSchema(notion, link, dataSource.parent.database_id, dataSource.id);
  }

  return {
    database,
    suggestedMapping: kind === 'transactions' ? suggestTransactionsFieldMapping(database) : null,
  };
};

export const refreshNotionDatabaseConnection = async (
  notion: Client,
  database: Database,
  kind: DatabaseKind,
): Promise<Database> =>
  kind === 'balance'
    ? ensureBalanceSchema(notion, database.link, database.id, database.dataSourceId ?? undefined)
    : ensureTransactionsSchema(notion, database.link, database.id, database.dataSourceId ?? undefined);

export const getCompatibleProperties = (
  database: Database | null,
  types: string[],
): DatabaseProperty[] => {
  if (!database) {
    return [];
  }

  return database.properties.filter((property) => types.includes(property.type));
};

export const validateTransactionsFieldMapping = (
  mapping: TransactionsFieldMapping | null,
  database: Database | null,
): string[] => {
  if (!database) {
    return [];
  }

  if (!mapping) {
    return ['Field mapping is required for the transactions database.'];
  }

  const rules: Array<[keyof TransactionsFieldMapping, string[]]> = [
    ['dateProperty', ['date']],
    ['amountProperty', ['number']],
    ['merchantProperty', ['title', 'rich_text']],
    ['accountNameProperty', ['rich_text']],
    ['typeProperty', ['select']],
  ];
  const fieldLabels: Record<keyof TransactionsFieldMapping, string> = {
    dateProperty: 'Date field',
    amountProperty: 'Amount field',
    merchantProperty: 'Merchant/Description field',
    accountNameProperty: 'Account Name field',
    typeProperty: 'Type field',
  };
  const errors: string[] = [];

  for (const [field, allowedTypes] of rules) {
    const propertyName = mapping[field];
    if (!propertyName) {
      errors.push(`${fieldLabels[field]} is required.`);
      continue;
    }

    const property = findPropertyByName(database, propertyName);
    if (!property) {
      errors.push(`${propertyName} is no longer available in the database.`);
      continue;
    }

    if (!allowedTypes.includes(property.type)) {
      errors.push(`${propertyName} has type ${property.type}, expected ${allowedTypes.join(' or ')}.`);
    }
  }

  const uniqueProperties = new Set(Object.values(mapping).filter(Boolean));
  if (uniqueProperties.size !== Object.values(mapping).filter(Boolean).length) {
    errors.push('Each transactions field must map to a different Notion property.');
  }

  return errors;
};

export const formatNotionError = (error: unknown): string => {
  const message = makeReadableError(error);

  if (typeof error === 'object' && error && 'code' in error && typeof error.code === 'string') {
    return `Notion [${error.code}]: ${message}`;
  }

  return message;
};

export const requiredFieldsFor = (kind: DatabaseKind): readonly string[] =>
  kind === 'balance' ? BALANCE_REQUIRED_FIELDS : TRANSACTION_REQUIRED_FIELDS;

export const ensureTransactionsSyncIdProperty = async (
  notion: Client,
  database: Database,
): Promise<Database> => {
  const connectedDatabase =
    database.dataSourceId && database.properties.length > 0
      ? database
      : await refreshNotionDatabaseConnection(notion, database, 'transactions');

  if (findPropertyByName(connectedDatabase, TRANSACTION_SYNC_ID_PROPERTY)) {
    return connectedDatabase;
  }

  await updateDatabaseProperties(notion, connectedDatabase.dataSourceId!, {
    [TRANSACTION_SYNC_ID_PROPERTY]: TRANSACTION_AUTO_PROPERTIES[TRANSACTION_SYNC_ID_PROPERTY],
  });

  const schemaStatus = connectedDatabase.schemaStatus ?? {
    isValid: true,
    missingFields: [],
    autoCreatedFields: [],
    notes: [],
  };
  const updated = await retrieveConnectedDatabase(
    notion,
    connectedDatabase.id,
    connectedDatabase.link,
    schemaStatus,
    connectedDatabase.dataSourceId ?? undefined,
  );
  updated.schemaStatus = {
    ...schemaStatus,
    autoCreatedFields: Array.from(new Set([...schemaStatus.autoCreatedFields, TRANSACTION_SYNC_ID_PROPERTY])),
  };
  return updated;
};
