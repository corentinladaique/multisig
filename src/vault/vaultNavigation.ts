import type { MultisigRegistryEntry } from './multisigRegistry';

/**
 * Model PURE de l'usage local des vaults (selection, recence, migration).
 *
 * Module PUR : aucune I/O, aucun RPC, aucun wallet, aucun stockage, aucune
 * blockchain. Il ne manipule que des donnees publiques deja stockees
 * localement (adresses, noms locaux, dates) et ne contient aucun secret.
 *
 * Objet : savoir QUEL vault a ete utilise en dernier, sans jamais s'appuyer sur
 * un etat d'UI, et sans jamais solliciter le reseau. La recence (`lastUsedAt`)
 * vit a cote du registre (cle locale dediee) et n'est ecrite qu'apres un
 * chargement REUSSI d'un vault. Les entrees anciennes sont migrees de facon
 * DETERMINISTE : la date de creation quand elle est exploitable, sinon un
 * horodatage stable derive de l'ordre. JAMAIS l'heure courante.
 */

export const VAULT_USAGE_VERSION = 1;

/** Cle unique de stockage de l'usage : une seule entree locale. */
export const VAULT_USAGE_STORAGE_KEY = 'pocket-multisig.vault-usage.v1';

/**
 * Base des horodatages de repli pour les entrees anciennes sans date
 * exploitable. Fixe et lointaine (an 2000) pour ne jamais entrer en collision
 * avec une vraie date de creation, et surtout pour ne JAMAIS dependre de
 * l'heure courante : l'ordre reste stable entre deux lancements.
 */
export const LEGACY_USAGE_BASE_MS = Date.UTC(2000, 0, 1);

export type VaultUsageRecord = {
  /** Horodatage ISO 8601 du dernier chargement REUSSI de ce vault. */
  lastUsedAt: string;
  /** Threshold lu on-chain au dernier chargement reussi (sinon null). */
  threshold: number | null;
  /** Nombre de membres lu on-chain au dernier chargement reussi (sinon null). */
  memberCount: number | null;
};

export type VaultUsage = {
  version: number;
  /** Recence par adresse de multisig (base58). Aucune donnee sensible. */
  records: Record<string, VaultUsageRecord>;
};

export function createEmptyUsage(): VaultUsage {
  return { version: VAULT_USAGE_VERSION, records: {} };
}

/** Un horodatage est exploitable s'il est present et parseable. */
export function isUsableTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !Number.isNaN(Date.parse(value));
}

/**
 * Horodatage DETERMINISTE pour une entree ancienne sans date exploitable.
 * Fonction pure de l'index : deux executions donnent la meme valeur, et l'ordre
 * de stockage est preserve (index 0 = plus recent en tri decroissant).
 */
export function deterministicLegacyTimestamp(index: number): string {
  const safeIndex = Number.isFinite(index) && index > 0 ? Math.floor(index) : 0;
  return new Date(LEGACY_USAGE_BASE_MS - safeIndex * 1000).toISOString();
}

function cleanCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/**
 * Repli de migration : date de creation quand elle est exploitable, sinon
 * horodatage deterministe issu de l'ordre. JAMAIS l'heure courante.
 */
export function deriveLastUsedAt(entry: MultisigRegistryEntry, index: number): string {
  return isUsableTimestamp(entry.addedAt) ? entry.addedAt : deterministicLegacyTimestamp(index);
}

/** Enregistrement effectif d'une entree : usage persiste, sinon migration. */
export function effectiveRecord(
  entry: MultisigRegistryEntry,
  usage: VaultUsage,
  index: number,
): VaultUsageRecord {
  const stored = usage.records[entry.address];
  if (stored !== undefined && isUsableTimestamp(stored.lastUsedAt)) return stored;
  return { lastUsedAt: deriveLastUsedAt(entry, index), threshold: null, memberCount: null };
}

export function effectiveLastUsedAt(
  entry: MultisigRegistryEntry,
  usage: VaultUsage,
  index: number,
): string {
  return effectiveRecord(entry, usage, index).lastUsedAt;
}

/**
 * Tri du plus recemment utilise au plus ancien. Deterministe : aucun temps
 * courant, repli stable par ordre/date/adresse.
 */
export function sortEntriesByLastUsed(
  entries: MultisigRegistryEntry[],
  usage: VaultUsage,
): MultisigRegistryEntry[] {
  return entries
    .map((entry, index) => ({ entry, value: effectiveLastUsedAt(entry, usage, index) }))
    .sort((left, right) => {
      if (left.value !== right.value) return right.value.localeCompare(left.value);
      if (left.entry.addedAt !== right.entry.addedAt) {
        return right.entry.addedAt.localeCompare(left.entry.addedAt);
      }
      return left.entry.address.localeCompare(right.entry.address);
    })
    .map((item) => item.entry);
}

/** Adresse du vault le plus recemment utilise, ou null si aucun vault. */
export function mostRecentlyUsedAddress(
  entries: MultisigRegistryEntry[],
  usage: VaultUsage,
): string | null {
  const ordered = sortEntriesByLastUsed(entries, usage);
  return ordered.length > 0 ? ordered[0].address : null;
}

/**
 * Enregistre un chargement REUSSI. A appeler UNIQUEMENT apres un chargement
 * confirme : jamais a l'affichage, jamais a l'ouverture du selecteur, jamais
 * apres un echec. Le threshold/membres sont ceux deja lus on-chain.
 */
export function markUsed(
  usage: VaultUsage,
  address: string,
  stats: { threshold?: number | null; memberCount?: number | null } | undefined,
  now: string,
): VaultUsage {
  const target = address.trim();
  if (target.length === 0) return usage;
  const previous = usage.records[target];
  return {
    version: VAULT_USAGE_VERSION,
    records: {
      ...usage.records,
      [target]: {
        lastUsedAt: now,
        threshold: cleanCount(stats?.threshold) ?? previous?.threshold ?? null,
        memberCount: cleanCount(stats?.memberCount) ?? previous?.memberCount ?? null,
      },
    },
  };
}

/** Etats possibles du corps de l'ecran Vault (aucune logique d'UIC). */
export type VaultBodyState =
  | 'vault'
  | 'loading-registry'
  | 'no-saved'
  | 'no-active'
  | 'load-failed'
  | 'loading-vault';

/**
 * Etat du corps Vault. « No multisig loaded » ne doit apparaitre QUE s'il
 * n'existe AUCUNE sauvegarde locale — jamais pendant un chargement ni un echec.
 * « No active multisig » apparait quand des sauvegardes existent mais qu'elles
 * sont TOUTES archivees (etape 3) : aucune n'est chargee et aucune ne peut
 * l'etre automatiquement.
 */
export function describeVaultBody(input: {
  registryStatus: 'loading' | 'ready' | 'error';
  savedCount: number;
  /** Nombre d'entrees archivees ; 0 (defaut) reproduit le comportement etape 1. */
  archivedCount?: number;
  hasView: boolean;
  loadFailed: boolean;
}): VaultBodyState {
  if (input.hasView) return 'vault';
  if (input.registryStatus === 'loading') return 'loading-registry';
  const archived =
    typeof input.archivedCount === 'number' && Number.isFinite(input.archivedCount)
      ? Math.max(0, Math.floor(input.archivedCount))
      : 0;
  if (input.savedCount === 0) return 'no-saved';
  if (input.savedCount <= archived) return 'no-active';
  if (input.loadFailed) return 'load-failed';
  return 'loading-vault';
}

/**
 * Libelle de l'en-tete Vault. Sans vault actif : « Select a multisig » (ouvre
 * le selecteur). Aucune adresse de wallet n'apparait dans cet en-tete.
 */
export function describeVaultHeader(input: {
  hasView: boolean;
  activeName: string | null;
}): { label: string } {
  if (!input.hasView) return { label: 'Select a multisig' };
  const name = input.activeName !== null && input.activeName.trim().length > 0
    ? input.activeName.trim()
    : 'Main vault';
  return { label: name };
}

/**
 * Faut-il auto-charger le vault le plus recemment utilise ? Uniquement quand
 * aucun vault n'est charge, que le registre ET l'usage sont prets, qu'aucune
 * tentative n'a deja eu lieu et qu'il existe au moins une sauvegarde.
 */
export function shouldAutoLoad(input: {
  registryStatus: 'loading' | 'ready' | 'error';
  usageStatus: 'loading' | 'ready' | 'error';
  hasView: boolean;
  attempted: boolean;
  savedCount: number;
  loading: boolean;
}): boolean {
  if (input.attempted) return false;
  if (input.hasView) return false;
  if (input.loading) return false;
  if (input.registryStatus !== 'ready' || input.usageStatus !== 'ready') return false;
  return input.savedCount > 0;
}

// --- Persistance locale (backend injectable, partie PURE) --------------------

export interface UsageStorage {
  load: () => Promise<string | null>;
  save: (raw: string) => Promise<void>;
}

/** Backend en memoire (tests, ou repli documente si le stockage est absent). */
export function createMemoryUsageStorage(initial: string | null = null): UsageStorage {
  let value = initial;
  return {
    load: async () => value,
    save: async (raw: string) => {
      value = raw;
    },
  };
}

export async function loadUsage(storage: UsageStorage): Promise<{
  usage: VaultUsage;
  errors: string[];
}> {
  let raw: string | null;
  try {
    raw = await storage.load();
  } catch (caught: unknown) {
    const detail = caught instanceof Error ? caught.message : String(caught);
    return { usage: createEmptyUsage(), errors: [`StorageReadFailed: ${detail}`] };
  }
  return parseUsage(raw);
}

export async function saveUsage(storage: UsageStorage, usage: VaultUsage): Promise<void> {
  try {
    await storage.save(serializeUsage(usage));
  } catch (caught: unknown) {
    const detail = caught instanceof Error ? caught.message : String(caught);
    throw new Error(`StorageWriteFailed: ${detail}`);
  }
}

export function serializeUsage(usage: VaultUsage): string {
  return JSON.stringify(usage);
}

/**
 * Lit un contenu d'usage potentiellement corrompu ou etranger. Ne leve jamais :
 * les enregistrements invalides sont ecartes, seuls les champs reconnus sont
 * conserves (aucun secret ne peut passer).
 */
export function parseUsage(raw: string | null): { usage: VaultUsage; errors: string[] } {
  const errors: string[] = [];
  if (raw === null || raw.trim().length === 0) {
    return { usage: createEmptyUsage(), errors };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    errors.push('InvalidJson: the stored vault usage is not valid JSON.');
    return { usage: createEmptyUsage(), errors };
  }

  if (parsed === null || typeof parsed !== 'object') {
    errors.push('InvalidUsage: the stored vault usage is not an object.');
    return { usage: createEmptyUsage(), errors };
  }

  const container = parsed as { version?: unknown; records?: unknown };
  if (container.version !== VAULT_USAGE_VERSION) {
    errors.push(`UnsupportedUsageVersion: expected ${VAULT_USAGE_VERSION}.`);
  }
  if (container.records === null || typeof container.records !== 'object') {
    errors.push('InvalidRecords: records must be an object.');
    return { usage: createEmptyUsage(), errors };
  }

  const records: Record<string, VaultUsageRecord> = {};
  for (const [address, candidate] of Object.entries(container.records as Record<string, unknown>)) {
    if (candidate === null || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    if (!isUsableTimestamp(record.lastUsedAt)) continue;
    records[address] = {
      lastUsedAt: record.lastUsedAt,
      threshold: cleanCount(record.threshold),
      memberCount: cleanCount(record.memberCount),
    };
  }

  return { usage: { version: VAULT_USAGE_VERSION, records }, errors };
}

// ===========================================================================
// Archivage LOCAL (etape 3)
// ---------------------------------------------------------------------------
// L'archivage est un ETAT LOCAL A L'APPAREIL, range a cote de la recence dans
// une cle dediee (jamais le registre lui-meme : on ne reecrit aucune donnee
// existante). Aucun RPC, aucune blockchain, aucune signature, aucune
// transaction. Le modele est PUR et deterministe ; l'horodatage est fourni par
// l'appelant (`now`), jamais lu ici (aucune dependance a l'heure courante).
// ===========================================================================

export const VAULT_ARCHIVE_VERSION = 1;

/** Cle unique de stockage de l'archivage local : une seule entree. */
export const VAULT_ARCHIVE_STORAGE_KEY = 'pocket-multisig.vault-archive.v1';

export type VaultArchiveRecord = {
  /** Vrai si le vault est archive sur cet appareil. */
  archived: boolean;
  /** Horodatage ISO de l'archivage, sinon null. */
  archivedAt: string | null;
};

export type VaultArchive = {
  version: number;
  /** Etat d'archivage par adresse de multisig (base58). Aucune donnee sensible. */
  records: Record<string, VaultArchiveRecord>;
};

export function createEmptyArchive(): VaultArchive {
  return { version: VAULT_ARCHIVE_VERSION, records: {} };
}

/**
 * Enregistrement effectif d'une adresse : un enregistrement absent vaut
 * « non archive ». C'est la MIGRATION : toute entree existante (ajoutee avant
 * l'arrivee de l'archivage) est donc vue comme active, sans reecriture.
 */
export function archiveRecordFor(archive: VaultArchive, address: string): VaultArchiveRecord {
  const stored = archive.records[address.trim()];
  return stored !== undefined ? stored : { archived: false, archivedAt: null };
}

export function isArchived(archive: VaultArchive, address: string): boolean {
  return archiveRecordFor(archive, address).archived === true;
}

/** Archive une adresse. `now` est un horodatage ISO fourni par l'appelant. */
export function markArchived(archive: VaultArchive, address: string, now: string): VaultArchive {
  const target = address.trim();
  if (target.length === 0) return archive;
  return {
    version: VAULT_ARCHIVE_VERSION,
    records: { ...archive.records, [target]: { archived: true, archivedAt: now } },
  };
}

/** Restaure une adresse (archived=false), sans perdre les autres enregistrements. */
export function markRestored(archive: VaultArchive, address: string): VaultArchive {
  const target = address.trim();
  if (target.length === 0) return archive;
  return {
    version: VAULT_ARCHIVE_VERSION,
    records: { ...archive.records, [target]: { archived: false, archivedAt: null } },
  };
}

/** Oublie l'etat d'archivage d'une adresse (retrait complet de l'appareil). */
export function forgetArchived(archive: VaultArchive, address: string): VaultArchive {
  const target = address.trim();
  const records: Record<string, VaultArchiveRecord> = {};
  for (const [key, value] of Object.entries(archive.records)) {
    if (key !== target) records[key] = value;
  }
  return { version: VAULT_ARCHIVE_VERSION, records };
}

export function serializeArchive(archive: VaultArchive): string {
  return JSON.stringify(archive);
}

/**
 * Lit un contenu d'archivage potentiellement corrompu ou etranger. Ne leve
 * jamais : les enregistrements invalides sont ecartes, seuls les champs
 * reconnus sont conserves (aucun secret ne peut passer).
 */
export function parseArchive(raw: string | null): { archive: VaultArchive; errors: string[] } {
  const errors: string[] = [];
  if (raw === null || raw.trim().length === 0) {
    return { archive: createEmptyArchive(), errors };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    errors.push('InvalidJson: the stored vault archive is not valid JSON.');
    return { archive: createEmptyArchive(), errors };
  }

  if (parsed === null || typeof parsed !== 'object') {
    errors.push('InvalidArchive: the stored vault archive is not an object.');
    return { archive: createEmptyArchive(), errors };
  }

  const container = parsed as { version?: unknown; records?: unknown };
  if (container.version !== VAULT_ARCHIVE_VERSION) {
    errors.push(`UnsupportedArchiveVersion: expected ${VAULT_ARCHIVE_VERSION}.`);
  }
  if (container.records === null || typeof container.records !== 'object') {
    errors.push('InvalidRecords: records must be an object.');
    return { archive: createEmptyArchive(), errors };
  }

  const records: Record<string, VaultArchiveRecord> = {};
  for (const [address, candidate] of Object.entries(container.records as Record<string, unknown>)) {
    if (candidate === null || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    if (typeof record.archived !== 'boolean') continue;
    records[address] = {
      archived: record.archived,
      archivedAt:
        record.archived === true && isUsableTimestamp(record.archivedAt) ? record.archivedAt : null,
    };
  }

  return { archive: { version: VAULT_ARCHIVE_VERSION, records }, errors };
}

// --- Persistance locale de l'archivage (backend injectable) -----------------

export interface ArchiveStorage {
  load: () => Promise<string | null>;
  save: (raw: string) => Promise<void>;
}

/** Backend en memoire (tests, ou repli documente si le stockage est absent). */
export function createMemoryArchiveStorage(initial: string | null = null): ArchiveStorage {
  let value = initial;
  return {
    load: async () => value,
    save: async (raw: string) => {
      value = raw;
    },
  };
}

export async function loadArchive(storage: ArchiveStorage): Promise<{
  archive: VaultArchive;
  errors: string[];
}> {
  let raw: string | null;
  try {
    raw = await storage.load();
  } catch (caught: unknown) {
    const detail = caught instanceof Error ? caught.message : String(caught);
    return { archive: createEmptyArchive(), errors: [`StorageReadFailed: ${detail}`] };
  }
  return parseArchive(raw);
}

export async function saveArchive(storage: ArchiveStorage, archive: VaultArchive): Promise<void> {
  try {
    await storage.save(serializeArchive(archive));
  } catch (caught: unknown) {
    const detail = caught instanceof Error ? caught.message : String(caught);
    throw new Error(`StorageWriteFailed: ${detail}`);
  }
}

// --- Vues archivees (entrees actives vs archivees) --------------------------

/** Entrees NON archivees, dans l'ordre de stockage fourni. */
export function activeEntries(
  entries: MultisigRegistryEntry[],
  archive: VaultArchive,
): MultisigRegistryEntry[] {
  return entries.filter((entry) => !isArchived(archive, entry.address));
}

/** Entrees archivees, dans l'ordre de stockage fourni. */
export function archivedEntries(
  entries: MultisigRegistryEntry[],
  archive: VaultArchive,
): MultisigRegistryEntry[] {
  return entries.filter((entry) => isArchived(archive, entry.address));
}

/** Entrees ACTIVES ordonnees par recence (plus recent d'abord). */
export function orderActiveEntries(
  entries: MultisigRegistryEntry[],
  usage: VaultUsage,
  archive: VaultArchive,
): MultisigRegistryEntry[] {
  return sortEntriesByLastUsed(activeEntries(entries, archive), usage);
}

/** Entrees ARCHIVEES ordonnees par recence (plus recent d'abord). */
export function orderArchivedEntries(
  entries: MultisigRegistryEntry[],
  usage: VaultUsage,
  archive: VaultArchive,
): MultisigRegistryEntry[] {
  return sortEntriesByLastUsed(archivedEntries(entries, archive), usage);
}

/** Adresse active la plus recemment utilisee, ou null si aucune active. */
export function mostRecentlyUsedActiveAddress(
  entries: MultisigRegistryEntry[],
  usage: VaultUsage,
  archive: VaultArchive,
): string | null {
  const ordered = orderActiveEntries(entries, usage, archive);
  return ordered.length > 0 ? ordered[0].address : null;
}

/**
 * Adresse active a charger apres avoir archive `archivingAddress` : la plus
 * recemment utilisee des AUTRES vaults actifs, ou null si aucune ne reste. Ne
 * renvoie jamais un vault archive (exclusion explicite).
 */
export function nextActiveAfterArchiving(
  entries: MultisigRegistryEntry[],
  usage: VaultUsage,
  archive: VaultArchive,
  archivingAddress: string,
): string | null {
  const target = archivingAddress.trim();
  const remaining = activeEntries(entries, archive).filter((entry) => entry.address !== target);
  const ordered = sortEntriesByLastUsed(remaining, usage);
  return ordered.length > 0 ? ordered[0].address : null;
}

/** Vrai si l'adresse correspond a une entree locale DEJA archivee. */
export function matchesArchivedEntry(
  entries: MultisigRegistryEntry[],
  archive: VaultArchive,
  address: string,
): boolean {
  const target = address.trim();
  if (target.length === 0) return false;
  return entries.some((entry) => entry.address === target) && isArchived(archive, target);
}

// --- Copies d'interface (etape 3) ------------------------------------------

/** Libelle de la section repliee, ou null quand N=0 (section NON rendue). */
export function archivedSectionLabel(count: number): string | null {
  const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return safe > 0 ? `Archived (${safe})` : null;
}

/**
 * Avertissement « pending proposal » (singulier/pluriel correct), ou null quand
 * aucun compte fiable n'est disponible. Le compte doit venir d'une source
 * VERIFIEE deja disponible : jamais d'une lecture declenchee pour cet
 * avertissement.
 */
export function pendingProposalWarning(count: number): string | null {
  const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (safe <= 0) return null;
  return `This vault has ${safe} proposal${safe > 1 ? 's' : ''} waiting for your approval.`;
}

/** Copie de confirmation d'archivage : etat local uniquement. */
export const ARCHIVE_CONFIRMATION_COPY =
  'Hidden from this device only. The vault and its funds are not affected. You can restore it anytime.';

/** Copie de confirmation de retrait de l'appareil (entrees archivees seulement). */
export const REMOVE_CONFIRMATION_COPY =
  'Removes this vault from this device only. You can add it again with its address.';

/** Invite quand on ajoute une adresse deja archivee : pas de doublon. */
export const RESTORE_ARCHIVED_PROMPT = 'This vault is archived. Restore it?';
