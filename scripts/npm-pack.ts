/** npm 12 returns an object keyed by package name; earlier npm versions return an array. */
export interface PackedArtifact {
  name: string;
  filename: string;
  files: { path: string }[];
}

export function parseNpmPackResult(output: string): PackedArtifact {
  const decoded: unknown = JSON.parse(output);
  const entries: unknown[] = Array.isArray(decoded) ? decoded :
    decoded !== null && typeof decoded === 'object' ? Object.values(decoded) : [];
  if (entries.length !== 1 || !entries[0] || typeof entries[0] !== 'object')
    throw new Error('Unexpected npm pack output: expected one artifact');
  const artifact = entries[0] as Partial<PackedArtifact>;
  if (typeof artifact.name !== 'string' || !artifact.name ||
      typeof artifact.filename !== 'string' || !/^[^/\\]+\.tgz$/.test(artifact.filename) ||
      !Array.isArray(artifact.files) || artifact.files.some((file) => !file || typeof file.path !== 'string'))
    throw new Error('Unexpected npm pack output: invalid artifact metadata');
  return artifact as PackedArtifact;
}
