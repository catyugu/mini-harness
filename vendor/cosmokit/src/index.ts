// Selected utilities from DSH’s vendored Cosmokit 1.8.1. See ../LICENSE.
/** String/symbol keyed dictionary type. */
export type Dict<T = any, K extends string | symbol = string> = { [key in K]: T }

/** Wrap a value in `Promise`, preserving the resolved type of existing promises. */
export type Promisify<T> = Promise<T extends Promise<infer S> ? S : T>

/** Accept a value or promise unless the value type is already promise-like. */
export type Awaitable<T> = [T] extends [Promise<unknown>] ? T : T | Promise<T>

/** Return true when a value is `null` or `undefined`. */
export function isNullable(value: any): value is null | undefined | void {
  return value === null || value === undefined
}

/** Define a non-enumerable writable property with a typed key. */
export function defineProperty<T, K extends keyof T>(object: T, key: K, value: T[K]): T

/** Define a non-enumerable writable property with an arbitrary key. */
export function defineProperty<T, K extends keyof any>(object: T, key: K, value: any): T

/** Define a non-enumerable writable property and return the object. */
export function defineProperty<T, K extends keyof any>(object: T, key: K, value: any) {
  return Object.defineProperty(object, key, { writable: true, value, enumerable: false })
}

// Retain the logger’s existing name conversion.
export function hyphenate(value: string): string {
  return value.replace(/([A-Z])/g, '-$1').toLowerCase()
}
