import { z } from "zod";

import type { AuthDefinition } from "./auth.ts";
import type { JsonObject, ProviderOriginInputDefinition } from "./index.ts";
import type { LogEntry, ProviderRequest, ProviderResponse } from "./host.ts";
import { createProvider, type AwsSessionCredentials } from "./provider.ts";
import type { OAuthAuthorizationState } from "./oauth.ts";

export { resolveProviderOrigin } from "./http.ts";
export type { AwsSessionCredentials } from "./provider.ts";

export interface LocalHostOptions {
  readonly origin: ProviderOriginInputDefinition;
  readonly connectionConfig?: JsonObject;
  readonly auth?: AuthDefinition;
  readonly credentials?: Readonly<Record<string, string>>;
  readonly awsCredentials?: () => Promise<AwsSessionCredentials>;
  readonly authorizationState?: OAuthAuthorizationState;
  readonly outputPath: string;
  readonly statePath: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly onLog?: (entry: LogEntry) => void | Promise<void>;
  readonly onAuthorizationStateChanged?: (state: OAuthAuthorizationState) => void | Promise<void>;
}

/** Compatibility host used by Beetl Core while it moves to createProvider(). */
export class LocalHost {
  readonly #provider: ReturnType<typeof createProvider>;
  readonly #onLog: LocalHostOptions["onLog"];

  constructor(options: LocalHostOptions) {
    this.#onLog = options.onLog;
    this.#provider = createProvider(
      {
        origin: options.origin,
        inputs: z.object({}).catchall(z.json()),
        ...(options.auth === undefined ? {} : { auth: options.auth }),
      },
      {
        connectionConfig: options.connectionConfig ?? {},
        credentials: options.credentials ?? {},
        ...(options.awsCredentials === undefined ? {} : { awsCredentials: options.awsCredentials }),
        ...(options.authorizationState === undefined
          ? {}
          : { authorizationState: options.authorizationState }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.onAuthorizationStateChanged === undefined
          ? {}
          : { onAuthorizationStateChanged: options.onAuthorizationStateChanged }),
      },
    );
  }

  request(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderResponse> {
    return this.#provider.request(request, signal);
  }

  async log(entry: LogEntry): Promise<void> {
    await this.#onLog?.(entry);
  }

  settleAuthentication(): Promise<void> {
    return this.#provider.settleAuthentication();
  }
}
