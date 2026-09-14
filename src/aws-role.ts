import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import { randomUUID } from "node:crypto";
import type { AwsSessionCredentials } from "./local-host.ts";

/** Call only from a trusted worker, never from a provider integration runtime. */
export async function assumeAwsRole(
  roleArn: string,
  externalId: string,
  region: string,
  createProvider: typeof fromTemporaryCredentials = fromTemporaryCredentials,
): Promise<AwsSessionCredentials> {
  if (
    !/^arn:aws:iam::\d{12}:role\/[\w+=,.@\/-]+$/.test(roleArn) ||
    !/^beetl-[a-f0-9-]{36}$/.test(externalId) ||
    !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)
  )
    throw new Error("Invalid AWS role binding");
  const options = {
    clientConfig: { region },
    params: { RoleArn: roleArn, RoleSessionName: externalId, DurationSeconds: 3600 },
  };
  // Reject trust policies that omit the tenant binding or accept another tenant.
  for (const params of [
    options.params,
    { ...options.params, ExternalId: `beetl-${randomUUID()}` },
  ]) {
    let denied = false;
    try {
      await createProvider({ ...options, params })();
    } catch (error) {
      if (error instanceof Error && ["AccessDenied", "AccessDeniedException"].includes(error.name))
        denied = true;
      else throw new Error("Could not verify AWS role trust policy");
    }
    if (!denied) throw new Error("AWS role trust policy must require the exact Beetl external ID");
  }
  const credentials = await createProvider({
    ...options,
    params: { ...options.params, ExternalId: externalId },
  })();
  if (!credentials.expiration || !credentials.sessionToken)
    throw new Error("AWS STS returned incomplete session credentials");
  return {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    expiration: credentials.expiration.getTime(),
  };
}
