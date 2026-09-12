export const createProjectIdFromPath = (projectPath: string): string => {
  const normalized = projectPath.replace(/\\/g, '/').replace(/\/+$/g, '').trim();
  if (!normalized) {
    return '';
  }

  const data = new TextEncoder().encode(normalized);
  let binary = '';
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }

  const encoded = typeof btoa === 'function'
    ? btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
    : normalized.replace(/[^A-Za-z0-9._-]+/g, '_');

  return `path_${encoded}`;
};

/**
 * Display-side inverse of the btoa branch above: a stored `path_` id decodes
 * back to the project path it was derived from, so cross-project surfaces can
 * show a human name without the server recording source directories. Ids from
 * the non-btoa fallback branch (or anything malformed) decode to null.
 */
export const projectPathFromProjectId = (projectId: string): string | null => {
  if (!projectId.startsWith('path_') || projectId.length <= 'path_'.length) {
    return null;
  }
  try {
    // An environment without atob (the encoder's fallback branch) throws
    // here and reads as a non-decodable id, which is the honest answer.
    const base64 = projectId.slice('path_'.length).replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
};
