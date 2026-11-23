/** Assert existence when an earlier test action promises an element or record. */
export function expectPresent<T>(value: T | null | undefined, description: string): NonNullable<T> {
  if (value === undefined || value === null) throw new Error('Expected ' + description + ' to exist');
  return value as NonNullable<T>;
}
