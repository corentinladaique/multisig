import { useCallback, useEffect, useRef, useState } from 'react';

import { deviceVaultUsageStorage } from './deviceVaultUsageStorage';
import {
  createEmptyUsage,
  loadUsage,
  markUsed as markUsedPure,
  saveUsage,
  type UsageStorage,
  type VaultUsage,
} from './vaultNavigation';

/**
 * Hook de lecture/ecriture de l'USAGE local des vaults (recence + seuil lu).
 *
 * Aucun RPC, aucune blockchain, aucun wallet, aucune signature : il ne touche
 * que le stockage local, a cote du registre. Aucun secret. Le chargement se
 * fait au montage ; l'ecriture se fait uniquement sur `markUsed`, appele APRES
 * un chargement de vault REUSSI.
 */

export type VaultUsageStatus = 'loading' | 'ready' | 'error';

export interface VaultUsageApi {
  /** Marque un chargement REUSSI. Ne doit jamais etre appele sur un echec. */
  markUsed: (
    address: string,
    stats?: { threshold?: number | null; memberCount?: number | null },
  ) => Promise<{ errors: string[] }>;
  refresh: () => void;
  status: VaultUsageStatus;
  error: string | null;
  /** Usage persiste (recence par adresse). */
  usage: VaultUsage;
}

export function useVaultUsage(
  storage: UsageStorage = deviceVaultUsageStorage,
): VaultUsageApi {
  const [usage, setUsage] = useState<VaultUsage>(() => createEmptyUsage());
  const [status, setStatus] = useState<VaultUsageStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  // Usage courant en ref : une ecriture sequentielle ne repart jamais d'un etat perime.
  const usageRef = useRef<VaultUsage>(usage);
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
      const result = await loadUsage(storage);
      if (!mountedRef.current) return;
      usageRef.current = result.usage;
      setUsage(result.usage);
      setError(
        result.errors.some((entry) => entry.startsWith('StorageReadFailed'))
          ? result.errors[0] ?? null
          : null,
      );
      setStatus('ready');
    })();
  }, [storage]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const markUsed = useCallback<VaultUsageApi['markUsed']>(
    async (address, stats) => {
      const next = markUsedPure(usageRef.current, address, stats, new Date().toISOString());
      try {
        await saveUsage(storage, next);
      } catch (caught: unknown) {
        const detail = caught instanceof Error ? caught.message : String(caught);
        if (mountedRef.current) setError(detail);
        return { errors: [detail] };
      }
      usageRef.current = next;
      if (mountedRef.current) {
        setUsage(next);
        setError(null);
        setStatus('ready');
      }
      return { errors: [] };
    },
    [storage],
  );

  return { error, markUsed, refresh, status, usage };
}
