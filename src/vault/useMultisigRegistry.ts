import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createEmptyRegistry,
  listEntries,
  makeEntry,
  removeEntry,
  upsertEntryPreserving,
  type MultisigRegistry,
  type MultisigRegistryEntry,
  type MultisigSource,
} from './multisigRegistry';
import {
  loadRegistry,
  saveRegistry,
  type RegistryStorage,
} from './multisigRegistryStorage';
import { deviceRegistryStorage } from './deviceRegistryStorage';

/**
 * Hook de lecture/ecriture du registre local des multisigs.
 *
 * Aucun RPC, aucune blockchain, aucune signature : ce hook ne touche que le
 * stockage local. Il ne contient aucun secret. Le chargement se fait au montage,
 * l'ecriture uniquement sur action explicite (add / remove) : jamais de
 * reecriture automatique au chargement.
 */

export type RegistryStatus = 'loading' | 'ready' | 'error';

export interface MultisigRegistryApi {
  /** Liste triee du plus recent au plus ancien. */
  entries: MultisigRegistryEntry[];
  add: (input: {
    address: string;
    vaultName: string;
    memberLabels?: Record<string, string>;
    source: MultisigSource;
  }) => Promise<{ entry: MultisigRegistryEntry | null; errors: string[] }>;
  error: string | null;
  /** Avertissements non bloquants (entrees ecartees, version inconnue...). */
  warnings: string[];
  refresh: () => void;
  remove: (address: string) => Promise<{ errors: string[] }>;
  status: RegistryStatus;
}

/**
 * Base AUTORITAIRE d'une ecriture : le dernier registre PERSISTE, jamais un
 * instantane en memoire qui pourrait avoir ete depasse par une autre instance
 * du hook (ecran de creation vs ecran d'accueil). Repli sur l'instantane
 * courant uniquement si la relecture du stockage elle-meme echoue — pour ne
 * jamais repartir d'un registre vide et effacer les donnees existantes.
 */
async function latestPersistedRegistry(
  storage: RegistryStorage,
  fallback: MultisigRegistry,
): Promise<MultisigRegistry> {
  const result = await loadRegistry(storage);
  if (result.errors.some((entry) => entry.startsWith('StorageReadFailed'))) return fallback;
  return result.registry;
}

export function useMultisigRegistry(
  storage: RegistryStorage = deviceRegistryStorage,
): MultisigRegistryApi {
  const [registry, setRegistry] = useState<MultisigRegistry>(() => createEmptyRegistry());
  const [status, setStatus] = useState<RegistryStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  // Le registre courant en ref : les ecritures sequentielles ne doivent jamais
  // repartir d'un etat perime.
  const registryRef = useRef<MultisigRegistry>(registry);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    setStatus('loading');
    void (async () => {
      const result = await loadRegistry(storage);
      if (!mountedRef.current) return;
      registryRef.current = result.registry;
      setRegistry(result.registry);
      setWarnings(result.errors);
      setError(result.errors.some((entry) => entry.startsWith('StorageReadFailed')) ? result.errors[0] ?? null : null);
      setStatus('ready');
    })();
  }, [storage]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const add = useCallback<MultisigRegistryApi['add']>(
    async (input) => {
      const { entry, errors } = makeEntry({
        address: input.address,
        vaultName: input.vaultName,
        memberLabels: input.memberLabels ?? {},
        now: new Date().toISOString(),
        source: input.source,
      });
      if (entry === null) {
        setError(errors[0] ?? 'InvalidEntry');
        return { entry: null, errors };
      }
      // Base = dernier registre PERSISTE (jamais un instantane perime) : une
      // ecriture d'un ecran ne doit jamais ecraser les entrees ecrites par un
      // autre. L'upsert protege conserve en plus une entree riche existante
      // face a un placeholder `manual` vide.
      const base = await latestPersistedRegistry(storage, registryRef.current);
      const next = upsertEntryPreserving(base, entry);
      try {
        await saveRegistry(storage, next);
      } catch (caught: unknown) {
        const detail = caught instanceof Error ? caught.message : String(caught);
        setError(detail);
        return { entry: null, errors: [detail] };
      }
      registryRef.current = next;
      if (mountedRef.current) {
        setRegistry(next);
        setError(null);
        setStatus('ready');
      }
      return { entry, errors: [] };
    },
    [storage],
  );

  const remove = useCallback<MultisigRegistryApi['remove']>(
    async (address) => {
      // Base = dernier registre PERSISTE : retirer une entree ne doit jamais
      // emporter les entrees ajoutees par une autre instance du hook.
      const base = await latestPersistedRegistry(storage, registryRef.current);
      const next = removeEntry(base, address);
      try {
        await saveRegistry(storage, next);
      } catch (caught: unknown) {
        const detail = caught instanceof Error ? caught.message : String(caught);
        setError(detail);
        return { errors: [detail] };
      }
      registryRef.current = next;
      if (mountedRef.current) {
        setRegistry(next);
        setError(null);
      }
      return { errors: [] };
    },
    [storage],
  );

  const entries = useMemo(() => listEntries(registry), [registry]);

  return { add, entries, error, refresh, remove, status, warnings };
}