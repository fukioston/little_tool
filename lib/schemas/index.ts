import { shiciSchema } from "./shici";
import { shilianSchema } from "./shilian";
import type { LocalDatabaseName, LocalDatabaseSchema } from "./types";
import { assertValidSchema } from "./types";
import { zhijiSchema } from "./zhiji";

// Reference-only schemas for migration and backup validation. The browser
// runtime deliberately does not import or automatically apply these models;
// each product feature store owns its active namespaced tables.

export { shiciSchema, shilianSchema, zhijiSchema };
export * from "./types";

export const localDatabaseSchemas: Readonly<
  Record<LocalDatabaseName, LocalDatabaseSchema>
> = {
  zhiji: zhijiSchema,
  shici: shiciSchema,
  shilian: shilianSchema,
};

for (const schema of Object.values(localDatabaseSchemas)) {
  assertValidSchema(schema);
}
