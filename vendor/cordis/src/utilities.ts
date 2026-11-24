// Selected utilities from Cosmokit 1.8.1. See ../COSMOKIT.LICENSE.
export type Dict<T = any, K extends string | symbol = string> = { [key in K]: T }
export type Promisify<T> = Promise<T extends Promise<infer S> ? S : T>
export type Awaitable<T> = [T] extends [Promise<unknown>] ? T : T | Promise<T>

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


export function hyphenate(value: string): string {
  return value.replace(/([A-Z])/g, '-$1').toLowerCase()
}
