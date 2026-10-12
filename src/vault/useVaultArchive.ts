import { useCallback, useEffect, useRef, useState } from 'react';

import { deviceVaultArchiveStorage } from './deviceVaultArchiveStorage';
import {
  createEmptyArchive,
  loadArchive,
  markArchived as markArchivedPure,
  markRestored as markRestoredPure,
  forgetArchived as forgetArchivedPure,
  saveArchive,
  type ArchiveStorage,
  type VaultArchive,
} from './vaultNavigation';

/**
 * Hook de lecture/ecriture de l'ARCHIVAGE local des vaults (etape 3).
 *
 * Aucun RPC, aucune blockchain, aucun wallet, aucune signature, aucune
 * transaction : il ne touche que le stockage local, dans une cle DEDIEE, a cote
 * de la recence. Aucun secret. Le chargement se fait au montage ; l'ecriture se
 * fait uniquement sur action explicite (archive / restore / remove). L'horodatage
 * est pose ici (`new Date()`), jamais dans le module pur.
 */

export type VaultArchiveStatus = 'loading' | 'ready' | 'error';

export interface VaultArchiveApi {
  /** Etat d'archivage local (par adresse). */
  archive: VaultArchive;
  error: string | null;
  status: VaultArchiveStatus;
  /** Archive un vault (etat LOCAL uniquement). */
  markArchived: (address: string) => Promise<{ errors: string[] }>;
  /** Restaure un vault archive (etat LOCAL uniquement). */
  markRestored: (address: string) => Promise<{ errors: string[] }>;
  /** Oublie l'etat d'archivage local d'une adresse. */
  forget: (address: string) => Promise<{ errors: string[] }>;
  refresh: () => void;
}

export function useVaultArchive(
  storage: ArchiveStorage = deviceVaultArchiveStorage,
): VaultArchiveApi {
  const [archive, setArchive] = useState<VaultArchive>(() => createEmptyArchive());
  const [status, setStatus] = useState<VaultArchiveStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  // Etat courant en ref : une ecriture sequentielle ne repart jamais d'un etat perime.
  const archiveRef = useRef<VaultArchive>(archive);
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
      const result = await loadArchive(storage);
      if (!mountedRef.current) return;
      archiveRef.current = result.archive;
      setArchive(result.archive);
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

  const persist = useCallback(
    async (next: VaultArchive): Promise<{ errors: string[] }> => {
      try {
        await saveArchive(storage, next);
      } catch (caught: unknown) {
        const detail = caught instanceof Error ? caught.message : String(caught);
        if (mountedRef.current) setError(detail);
        return { errors: [detail] };
      }
      archiveRef.current = next;
      if (mountedRef.current) {
        setArchive(next);
        setError(null);
        setStatus('ready');
      }
      return { errors: [] };
    },
    [storage],
  );

  const markArchived = useCallback<VaultArchiveApi['markArchived']>(
    async (address) => await persist(markArchivedPure(archiveRef.current, address, new Date().toISOString())),
    [persist],
  );

  const markRestored = useCallback<VaultArchiveApi['markRestored']>(
    async (address) => await persist(markRestoredPure(archiveRef.current, address)),
    [persist],
  );

  const forget = useCallback<VaultArchiveApi['forget']>(
    async (address) => await persist(forgetArchivedPure(archiveRef.current, address)),
    [persist],
  );

  return { archive, error, forget, markArchived, markRestored, refresh, status };
}
