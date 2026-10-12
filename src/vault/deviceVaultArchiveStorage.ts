import AsyncStorage from '@react-native-async-storage/async-storage';

import { VAULT_ARCHIVE_STORAGE_KEY, type ArchiveStorage } from './vaultNavigation';

/**
 * Backend appareil de la persistance de l'ARCHIVAGE local des vaults (etape 3).
 *
 * Seul fichier de cette couche qui importe la dependance native : le reste est
 * pur et testable sans React Native. Une seule cle est utilisee et son contenu
 * ne contient que des donnees publiques (adresses, horodatages). Aucun secret.
 */
export const deviceVaultArchiveStorage: ArchiveStorage = {
  load: async () => await AsyncStorage.getItem(VAULT_ARCHIVE_STORAGE_KEY),
  save: async (raw: string) => {
    await AsyncStorage.setItem(VAULT_ARCHIVE_STORAGE_KEY, raw);
  },
};
