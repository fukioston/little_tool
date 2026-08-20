export type LocalDatabaseName = "zhiji" | "shici";

export type SchemaMigration = Readonly<{
  version: number;
  description: string;
  sql: string;
}>;

export type LocalDatabaseSchema = Readonly<{
  name: LocalDatabaseName;
  filename: `${string}.sqlite3`;
  applicationId: number;
  seedVersion: number;
  migrations: readonly SchemaMigration[];
  seedSql: string;
}>;

export function currentSchemaVersion(schema: LocalDatabaseSchema): number {
  return schema.migrations.at(-1)?.version ?? 0;
}

export function assertValidSchema(schema: LocalDatabaseSchema): void {
  let previousVersion = 0;

  for (const migration of schema.migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= previousVersion) {
      throw new Error(
        `Migrations for ${schema.name} must use strictly increasing positive integer versions.`,
      );
    }
    previousVersion = migration.version;
  }
}
