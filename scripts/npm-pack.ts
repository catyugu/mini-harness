/** npm 12 returns an object keyed by package name; earlier npm versions return an array. */
export interface PackedArtifact {
  name: string;
  filename: string;
  files: { path: string }[];
}

export function parseNpmPackResult(output: string): PackedArtifact {
  const decoded: unknown = JSON.parse(output);
  const keyed = !Array.isArray(decoded) && decoded !== null && typeof decoded === 'object';
  const entries: [string | undefined, unknown][] = Array.isArray(decoded)
    ? decoded.map((entry) => [undefined, entry])
    : keyed
      ? Object.entries(decoded)
      : [];
  if (entries.length !== 1 || !entries[0][1] || typeof entries[0][1] !== 'object')
    throw new Error('Unexpected npm pack output: expected one artifact');
  const [packageName, value] = entries[0];
  const artifact = value as Partial<PackedArtifact>;
  const name = artifact.name ?? packageName;
  if (
    typeof name !== 'string' ||
    !name ||
    typeof artifact.filename !== 'string' ||
    !/^[^/\\]+\.tgz$/.test(artifact.filename) ||
    !Array.isArray(artifact.files) ||
    artifact.files.some((file) => !file || typeof file.path !== 'string')
  )
    throw new Error('Unexpected npm pack output: invalid artifact metadata');
  return { ...artifact, name } as PackedArtifact;
}
