import type { JsonValue } from "./index.ts";

export function jsonSnapshot<T>(value: T, errorMessage: string): T & JsonValue {
  if (isJsonValue(value)) {
    try {
      const snapshot: unknown = structuredClone(value);

      if (isJsonValue(snapshot)) return snapshot as T & JsonValue;
    } catch {}
  }

  throw new Error(errorMessage);
}

export function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (typeof value !== "object") {
    return false;
  }

  if (ancestors.has(value)) {
    return false;
  }

  ancestors.add(value);

  try {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return false;
    }

    if (Array.isArray(value)) {
      const keys = Object.keys(value);

      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        return false;
      }

      return value.every((item) => isJsonValue(item, ancestors));
    }

    const prototype = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }

    return Object.values(value).every((item) => isJsonValue(item, ancestors));
  } finally {
    ancestors.delete(value);
  }
}
