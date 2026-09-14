import { createHash, createHmac } from "node:crypto";

// S3 signs each path segment once and does not normalize object-key slashes.
export function signS3Request(
  url: URL,
  method: string,
  headers: Headers,
  body: Uint8Array | undefined,
  credentials: {
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
  },
  now = new Date(),
): void {
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(credentials.region))
    throw new Error("Invalid AWS signing region");
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("AWS signing requires an HTTPS origin");
  const regionalSuffix = `.s3.${credentials.region}.amazonaws.com`;
  if (
    !url.hostname.endsWith(regionalSuffix) &&
    !(credentials.region === "us-east-1" && url.hostname.endsWith(".s3.amazonaws.com"))
  )
    throw new Error("AWS signing requires the configured regional S3 bucket endpoint");
  if (url.pathname.split("/").some((part) => [".", ".."].includes(decodeURIComponent(part))))
    throw new Error("Ambiguous S3 key path");
  const encode = (value: string) =>
    encodeURIComponent(value).replace(
      /[!'()*]/g,
      (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase(),
    );
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = date.slice(0, 8);
  const hash = createHash("sha256")
    .update(body ?? new Uint8Array())
    .digest("hex");
  headers.delete("authorization");
  headers.delete("x-amz-security-token");
  headers.set("host", url.host);
  headers.set("x-amz-date", date);
  headers.set("x-amz-content-sha256", hash);
  if (credentials.sessionToken) headers.set("x-amz-security-token", credentials.sessionToken);
  const entries = [...headers]
    .filter(
      ([name]) =>
        name === "host" || name.startsWith("x-amz-") || name === "range" || name === "if-match",
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = entries.map(([name]) => name).join(";");
  const canonicalHeaders = entries
    .map(([name, value]) => name + ":" + value.trim().replace(/\s+/g, " ") + "\n")
    .join("");
  const query = [...url.searchParams]
    .map(([key, value]) => [encode(key), encode(value)] as const)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([key, value]) => key + "=" + value)
    .join("&");
  const path = url.pathname
    .split("/")
    .map((part) => encode(decodeURIComponent(part)))
    .join("/");
  const canonical = [method.toUpperCase(), path, query, canonicalHeaders, signedHeaders, hash].join(
    "\n",
  );
  const scope = `${day}/${credentials.region}/s3/aws4_request`;
  const toSign = [
    "AWS4-HMAC-SHA256",
    date,
    scope,
    createHash("sha256").update(canonical).digest("hex"),
  ].join("\n");
  let signingKey: Buffer = Buffer.from("AWS4" + credentials.secretAccessKey);
  for (const value of [day, credentials.region, "s3", "aws4_request"])
    signingKey = createHmac("sha256", signingKey).update(value).digest();
  const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");
  headers.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  );
}
