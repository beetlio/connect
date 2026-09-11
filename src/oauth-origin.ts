import type { ConnectionDefinition, JsonObject } from "./index.ts";
import { resolveProviderOrigin } from "./local-host.ts";

// Shared CLI/server preparation; absolute endpoints need no connection configuration.
export async function resolveOAuthOrigin(
  connection: ConnectionDefinition,
  connectionConfig: unknown = {},
): Promise<string | undefined> {
  const auth = connection.auth;

  if (
    auth?.type !== "oauth2_authorization_code" ||
    ![auth.issuer, auth.authorizationUrl, auth.tokenUrl].some((url) => url.startsWith("/"))
  ) {
    return undefined;
  }

  if (typeof connection.origin !== "string" && "oauthTokenField" in connection.origin) {
    throw new Error("Relative OAuth URLs require an origin available before authorization");
  }

  const config =
    typeof connection.origin !== "string" && connection.inputs !== undefined
      ? await connection.inputs.schema.parseAsync(connectionConfig)
      : connectionConfig;

  return resolveProviderOrigin(connection.origin, undefined, true, config as JsonObject).origin;
}
