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

export type AuthDefinition = AuthManifest & { readonly credentials: z.ZodObject };

type FieldValue<K extends string> = string | { readonly credential: K };

type FieldMap<K extends string> = Readonly<Record<string, FieldValue<K>>>;

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
  tokenExchange<S extends z.ZodObject>(
    options: TokenExchangeOptions<keyof z.output<S> & string> & { readonly credentials: S },
  ): Extract<AuthDefinition, { type: "token_exchange" }> {
    return { type: "token_exchange", ...options };
  },
  custom<S extends z.ZodObject>(options: {
    readonly credentials: S;
    readonly headers?: FieldMap<keyof z.output<S> & string>;
    readonly query?: FieldMap<keyof z.output<S> & string>;
  }): Extract<AuthDefinition, { type: "custom" }> {
    return {
      type: "custom",
      credentials: options.credentials,
      headers: { ...options.headers },
      query: { ...options.query },
    };
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
