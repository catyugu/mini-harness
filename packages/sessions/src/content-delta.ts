/** JSON-string splice, avoiding a second copy of a large tool result. */
export interface ContentDelta {
  prefix: number;
  suffix: number;
  insert: string;
}

/** Reversible splice for the serialized JSON representation of a tool result. */
export function contentDelta(original: string, transformed: string): ContentDelta | undefined {
  if (original === transformed) return;
  let prefix = 0;
  while (prefix < original.length && prefix < transformed.length && original[prefix] === transformed[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < original.length - prefix &&
    suffix < transformed.length - prefix &&
    original[original.length - suffix - 1] === transformed[transformed.length - suffix - 1]
  )
    suffix++;
  return { prefix, suffix, insert: transformed.slice(prefix, transformed.length - suffix) };
}

export function applyContentDelta(original: string, patch?: ContentDelta) {
  if (!patch) return original;
  if (
    !Number.isSafeInteger(patch.prefix) ||
    patch.prefix < 0 ||
    !Number.isSafeInteger(patch.suffix) ||
    patch.suffix < 0 ||
    typeof patch.insert !== 'string' ||
    patch.prefix + patch.suffix > original.length
  )
    throw new Error('Invalid tool content delta');
  return original.slice(0, patch.prefix) + patch.insert + original.slice(original.length - patch.suffix);
}
