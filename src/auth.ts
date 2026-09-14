import { z } from "zod";

/** Mark a string credential as secret without changing its validation. */
export function secret<S extends z.ZodType<string>>(schema: S): S {
  return schema.meta({ ...schema.meta(), writeOnly: true, "x-beetl-widget": "password" });
}

const Name = z.string().min(1);
const Reference = z.strictObject({ credential: Name });
const Fields = z.record(Name, z.union([z.string(), Reference]));
const Expiry = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("absolute"), path: Name }),
  z.strictObject({ type: z.literal("relative"), path: Name }),
  z.strictObject({ type: z.literal("fixed"), seconds: z.number().positive() }),
]);
const Exchange = z.strictObject({
  type: z.literal("token_exchange"),
  request: z.strictObject({
    path: Name,
    headers: Fields.optional(),
    basic: z.strictObject({ username: Name, password: Name }).optional(),
    body: z.strictObject({ encoding: z.enum(["json", "form"]), fields: Fields }).optional(),
  }),
  response: z.strictObject({ tokenPath: Name, expiry: Expiry }),
  session: z
    .strictObject({
      header: Name.optional(),
      prefix: z.string().optional(),
      headers: Fields.optional(),
    })
    .optional(),
});

export const AuthManifestSchema = z
  .discriminatedUnion("type", [
    z.strictObject({ type: z.literal("none") }),
    z.strictObject({
      type: z.literal("aws_sigv4"),
      region: z.union([z.string().min(1), z.strictObject({ input: z.string().min(1) })]),
      service: z.literal("s3"),
      credentialSource: z.literal("assume_role").optional(),
    }),
    z.strictObject({ type: z.literal("bearer") }),
    z.strictObject({ type: z.literal("basic") }),
    z.strictObject({ type: z.literal("api_key"), in: z.enum(["header", "query"]), name: Name }),
    z.strictObject({
      type: z.literal("oauth2_authorization_code"),
      issuer: Name,
      authorizationUrl: Name,
      tokenUrl: Name,
      scopes: z.array(Name).min(1),
      usesClientSecret: z.boolean(),
      tokenFields: z.record(Name, Name),
    }),
    Exchange,
    z.strictObject({ type: z.literal("custom"), headers: Fields, query: Fields }),
  ])
  .readonly();

export type AuthManifest = z.output<typeof AuthManifestSchema>;

type AuthDefinitionFor<M extends AuthManifest> = M extends { type: "token_exchange" }
  ? M & { readonly credentials: z.ZodObject } & Partial<
        Omit<LegacyTokenExchangeOptions<z.ZodObject>, "credentials">
      >
  : M & { readonly credentials: z.ZodObject };

export type AuthDefinition = AuthDefinitionFor<AuthManifest>;

type FieldValue<K extends string> = string | { readonly credential: K };

type FieldMap<K extends string> = Readonly<Record<string, FieldValue<K>>>;

export interface LegacyTokenExchangeOptions<S extends z.ZodObject> {
  readonly credentials: S;
  readonly tokenUrl: string;
  readonly headers?: Readonly<Record<string, keyof z.output<S> & string>>;
  readonly body?: {
    readonly encoding: "json" | "form";
    readonly fields: Readonly<Record<string, keyof z.output<S> & string>>;
    readonly values?: Readonly<Record<string, string>>;
  };
  readonly basic?: {
    readonly username: keyof z.output<S> & string;
    readonly password: keyof z.output<S> & string;
  };
  readonly tokenPath?: string;
  readonly expiresAtPath?: string;
  readonly expiresInPath?: string;
  readonly expiresInSeconds?: number;
  readonly tokenHeader?: string;
  readonly tokenPrefix?: string;
  readonly requestHeaders?: Readonly<Record<string, keyof z.output<S> & string>>;
}

export interface TokenExchangeOptions<K extends string = string> {
  readonly request: {
    readonly path: string;
    readonly headers?: FieldMap<K>;
    readonly basic?: { readonly username: K; readonly password: K };
    readonly body?: { readonly encoding: "json" | "form"; readonly fields: FieldMap<K> };
  };
  readonly response: { readonly tokenPath: string; readonly expiry: z.output<typeof Expiry> };
  readonly session?: {
    readonly header?: string;
    readonly prefix?: string;
    readonly headers?: FieldMap<K>;
  };
}

export const auth = {
  none(): Extract<AuthDefinition, { type: "none" }> {
    return { type: "none", credentials: z.strictObject({}) };
  },
  awsSigV4(options: {
    readonly region: string | { readonly input: string };
    readonly service: "s3";
    readonly credentialSource?: "assume_role";
  }): Extract<AuthDefinition, { type: "aws_sigv4" }> {
    return {
      type: "aws_sigv4",
      ...options,
      credentials:
        options.credentialSource === "assume_role"
          ? z.strictObject({ roleArn: secret(z.string().min(1).meta({ title: "AWS role ARN" })) })
          : z.strictObject({
              accessKeyId: secret(z.string().min(1).meta({ title: "AWS access key ID" })),
              secretAccessKey: secret(z.string().min(1).meta({ title: "AWS secret access key" })),
              sessionToken: secret(
                z.string().meta({ title: "AWS session token (empty for long-lived keys)" }),
              ),
            }),
    };
  },
  bearer(): Extract<AuthDefinition, { type: "bearer" }> {
    return {
      type: "bearer",
      credentials: z.strictObject({
        token: secret(z.string().min(1).meta({ title: "Bearer token" })),
      }),
    };
  },
  basic(): Extract<AuthDefinition, { type: "basic" }> {
    return {
      type: "basic",
      credentials: z.strictObject({ username: z.string().min(1), password: secret(z.string()) }),
    };
  },
  apiKey(options: {
    readonly in: "header" | "query";
    readonly name: string;
  }): Extract<AuthDefinition, { type: "api_key" }> {
    return {
      type: "api_key",
      ...options,
      credentials: z.strictObject({ apiKey: secret(z.string().min(1).meta({ title: "API key" })) }),
    };
  },
  oauth2(options: {
    readonly issuer: string;
    readonly authorizationUrl: string;
    readonly tokenUrl: string;
    readonly scopes: readonly string[];
    readonly clientSecret?: true;
    readonly tokenFields?: Readonly<Record<string, string>>;
  }): Extract<AuthDefinition, { type: "oauth2_authorization_code" }> {
    return {
      type: "oauth2_authorization_code",
      issuer: options.issuer,
      authorizationUrl: options.authorizationUrl,
      tokenUrl: options.tokenUrl,
      scopes: [...options.scopes],
      usesClientSecret: options.clientSecret === true,
      tokenFields: { ...options.tokenFields },
      credentials: z.strictObject({
        clientId: z.string().min(1),
        ...(options.clientSecret ? { clientSecret: secret(z.string().min(1)) } : {}),
      }),
    };
  },
  tokenExchange<
    S extends z.ZodObject,
    O extends
      | (TokenExchangeOptions<keyof z.output<S> & string> & { readonly credentials: S })
      | LegacyTokenExchangeOptions<S>,
  >(options: O): Extract<AuthDefinition, { type: "token_exchange" }> & O {
    if (!("tokenUrl" in options))
      return { type: "token_exchange", ...options } as Extract<
        AuthDefinition,
        { type: "token_exchange" }
      > &
        O;
    const keys = new Set(Object.keys(options.credentials.shape));
    const references = (fields: Readonly<Record<string, string>> | undefined) =>
      Object.fromEntries(
        Object.entries(fields ?? {}).map(([name, value]) => [
          name,
          keys.has(value) ? { credential: value } : value,
        ]),
      );
    const requestFields = {
      ...Object.fromEntries(
        Object.entries(options.body?.values ?? {}).map(([name, value]) => [name, value]),
      ),
      ...references(options.body?.fields),
    };
    const result = {
      type: "token_exchange" as const,
      credentials: options.credentials,
      request: {
        path: options.tokenUrl,
        ...(Object.keys(references(options.headers)).length
          ? { headers: references(options.headers) }
          : {}),
        ...(options.basic === undefined ? {} : { basic: options.basic }),
        ...(options.body === undefined
          ? {}
          : { body: { encoding: options.body.encoding, fields: requestFields } }),
      },
      response: {
        tokenPath: options.tokenPath ?? "token",
        expiry: options.expiresInPath
          ? { type: "relative" as const, path: options.expiresInPath }
          : options.expiresInSeconds
            ? { type: "fixed" as const, seconds: options.expiresInSeconds }
            : { type: "absolute" as const, path: options.expiresAtPath ?? "expires_at" },
      },
      session: {
        ...(options.tokenHeader === undefined ? {} : { header: options.tokenHeader }),
        ...(options.tokenPrefix === undefined ? {} : { prefix: options.tokenPrefix }),
        ...(Object.keys(references(options.requestHeaders)).length
          ? { headers: references(options.requestHeaders) }
          : {}),
      },
    };
    for (const [name, value] of Object.entries(options))
      if (!(name in result)) Object.defineProperty(result, name, { value });
    return result as unknown as Extract<AuthDefinition, { type: "token_exchange" }> & O;
  },
  custom<S extends z.ZodObject>(options: {
    readonly credentials: S;
    readonly headers?: FieldMap<keyof z.output<S> & string>;
    readonly query?: FieldMap<keyof z.output<S> & string>;
  }): Extract<AuthDefinition, { type: "custom" }> {
    const keys = new Set(Object.keys(options.credentials.shape));
    const fields = (values: FieldMap<keyof z.output<S> & string> | undefined) =>
      Object.fromEntries(
        Object.entries(values ?? {}).map(([name, value]) => [
          name,
          typeof value === "string" && keys.has(value) ? { credential: value } : value,
        ]),
      );
    return {
      type: "custom",
      credentials: options.credentials,
      headers: fields(options.headers),
      query: fields(options.query),
    };
  },
  oauth2AuthorizationCode(options: {
    readonly issuer: string;
    readonly authorizationUrl: string;
    readonly tokenUrl: string;
    readonly scopes: readonly string[];
    readonly clientSecret?: true;
    readonly tokenFields?: Readonly<Record<string, string>>;
  }): Extract<AuthDefinition, { type: "oauth2_authorization_code" }> {
    return auth.oauth2(options);
  },
};

export function resolveFields(
  fields: FieldMap<string> | undefined,
  credentials: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fields ?? {}).map(([name, value]) => {
      if (typeof value === "string") return [name, value];

      const resolved = credentials[value.credential];

      if (resolved === undefined)
        throw new Error(`Missing credential ${JSON.stringify(value.credential)}`);

      return [name, resolved];
    }),
  );
}

export function valueAtPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, key))
      return undefined;

    return Reflect.get(current, key);
  }, value);
}

export function parseToken(body: unknown, response: TokenExchangeOptions["response"], now: number) {
  const accessToken = z.string().min(1).parse(valueAtPath(body, response.tokenPath));
  const expiry = response.expiry;
  const expiresAt =
    expiry.type === "absolute"
      ? Date.parse(z.string().parse(valueAtPath(body, expiry.path)))
      : now +
        1000 *
          (expiry.type === "fixed"
            ? expiry.seconds
            : z.number().positive().parse(valueAtPath(body, expiry.path)));

  if (!Number.isFinite(expiresAt) || expiresAt <= now)
    throw new Error("Token exchange returned an invalid or expired token");

  return { accessToken, expiresAt };
}
