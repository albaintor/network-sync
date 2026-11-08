import { ValidationError } from './security.js';
import { matchesExtensions } from './extensions.js';
import type { SizeFilter, SyncJob } from './models.js';

export const BYTES_PER_MO = 1024 * 1024;

export function normalizeSizeFilter(input: unknown): SizeFilter | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Filtre de taille invalide.');
  }
  const value = input as Record<string, unknown>;
  if ((value.operator !== 'gt' && value.operator !== 'lt') ||
      typeof value.megabytes !== 'number' || !Number.isFinite(value.megabytes) ||
      value.megabytes < 0 || value.megabytes > 100_000_000) {
    throw new ValidationError('Indiquez une taille en Mo entre 0 et 100 000 000, avec > ou <.');
  }
  return { operator: value.operator, megabytes: value.megabytes };
}

/**
 * Avoid potentially catastrophic expressions. Quantified groups, lookarounds,
 * backreferences, possessive constructs and repeated quantifiers are rejected.
 * Basic regexes with anchors, character classes and alternatives are supported.
 */
function validateRegexSafety(pattern: string): void {
  if (pattern.length > 200 || /[\u0000-\u001f\u007f]/.test(pattern)) {
    throw new ValidationError('Expression régulière trop longue ou avec des caractères interdits (200 maximum).');
  }
  let inClass = false;
  let last: 'none' | 'atom' | 'group' | 'quantified' = 'none';
  let depth = 0;
  let quantifiers = 0;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') {
      if (i + 1 >= pattern.length) throw new ValidationError('Expression régulière invalide : échappement incomplet.');
      const next = pattern[++i];
      if (/[1-9k]/.test(next) && !inClass) {
        throw new ValidationError('Les références de groupes ne sont pas autorisées dans la regex.');
      }
      if (!inClass) last = 'atom';
      continue;
    }
    if (inClass) {
      if (char === ']') { inClass = false; last = 'atom'; }
      continue;
    }
    if (char === '[') { inClass = true; continue; }
    if (char === '(') {
      if (pattern[i + 1] === '?') {
        throw new ValidationError('Les groupes spéciaux et assertions avancées ne sont pas autorisés.');
      }
      depth++;
      last = 'none';
      continue;
    }
    if (char === ')') {
      depth--;
      if (depth < 0) throw new ValidationError('Parenthèses regex déséquilibrées.');
      last = 'group';
      continue;
    }
    if (char === '|' || char === '^' || char === '$') {
      last = 'none';
      continue;
    }
    if (char === '*' || char === '+' || char === '?') {
      if (last === 'group' || last === 'quantified') {
        throw new ValidationError('La répétition de groupes et les quantificateurs imbriqués ne sont pas autorisés.');
      }
      if (++quantifiers > 8) throw new ValidationError('Expression régulière trop complexe (8 répétitions maximum).');
      last = 'quantified';
      continue;
    }
    if (char === '{') {
      const suffix = pattern.slice(i).match(/^\{(\d+)(?:,(\d*))?\}/);
      if (suffix) {
        if (last === 'group' || last === 'quantified') {
          throw new ValidationError('La répétition de groupes et les quantificateurs imbriqués ne sont pas autorisés.');
        }
        const upper = suffix[2] && Number(suffix[2]);
        if (Number(suffix[1]) > 1000 || (upper && upper > 1000) || ++quantifiers > 8) {
          throw new ValidationError('Quantificateur regex trop grand ou expression trop complexe.');
        }
        last = 'quantified';
        i += suffix[0].length - 1;
        continue;
      }
    }
    last = 'atom';
  }
  if (inClass || depth) throw new ValidationError('Expression régulière invalide : groupe ou classe incomplet.');
}

export function compileFilenameRegex(pattern: string | null | undefined, ignoreCase = false): RegExp | null {
  if (!pattern) return null;
  validateRegexSafety(pattern);
  try {
    return new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch {
    throw new ValidationError('Expression régulière invalide (syntaxe JavaScript).');
  }
}

export function normalizeFilenameRegex(input: unknown): string | null {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input !== 'string') throw new ValidationError('La regex sur le nom doit être du texte.');
  const pattern = input.trim();
  if (!pattern) return null;
  compileFilenameRegex(pattern);
  return pattern;
}

export function normalizeFilenameRegexIgnoreCase(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== 'boolean') throw new ValidationError('Option de casse regex invalide.');
  return value;
}

export function matchesFileFilters(
  name: string, sizeBytes: number, job: Pick<SyncJob, 'extensions' | 'sizeFilter'>, regex: RegExp | null
): boolean {
  if (!matchesExtensions(name, job.extensions)) return false;
  const size = job.sizeFilter;
  if (size) {
    const boundary = size.megabytes * BYTES_PER_MO;
    if (size.operator === 'gt' ? !(sizeBytes > boundary) : !(sizeBytes < boundary)) return false;
  }
  return regex === null || regex.test(name);
}
