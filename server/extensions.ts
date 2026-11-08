import { ValidationError } from './security.js';

/** null means no restriction; legacy jobs without the field also allow all files. */
export function normalizeExtensions(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || !value.length || value.length > 100) {
    throw new ValidationError('Sélectionnez de 1 à 100 extensions, ou tous les fichiers.');
  }
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length > 48) {
      throw new ValidationError('Extension de fichier invalide.');
    }
    const ext = entry.trim().toLowerCase().replace(/^\./, '');
    if (!/^[a-z0-9]+(?:[._+-][a-z0-9]+)*$/.test(ext) || ext.length > 32) {
      throw new ValidationError('Extension de fichier invalide : ' + entry);
    }
    if (!normalized.includes(ext)) normalized.push(ext);
  }
  return normalized;
}

/** Case-insensitive filename suffix matching (supports compound extensions). */
export function matchesExtensions(filename: string, extensions: string[] | null | undefined): boolean {
  if (extensions == null) return true;
  const lower = filename.toLowerCase();
  return extensions.some(ext => lower.endsWith('.' + ext));
}
