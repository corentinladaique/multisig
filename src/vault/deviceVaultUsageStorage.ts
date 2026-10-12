import AsyncStorage from '@react-native-async-storage/async-storage';

import { VAULT_USAGE_STORAGE_KEY, type UsageStorage } from './vaultNavigation';

/**
 * Backend appareil de la persistance de l'usage des vaults (recence locale).
 *
 * Seul fichier de cette couche qui importe la dependance native : le reste est
 * pur et testable sans React Native. Une seule cle est utilisee et son contenu
 * ne contient que des donnees publiques (adresses, dates). Aucun secret.
 */
export const deviceVaultUsageStorage: UsageStorage = {
  load: async () => await AsyncStorage.getItem(VAULT_USAGE_STORAGE_KEY),
  save: async (raw: string) => {
    await AsyncStorage.setItem(VAULT_USAGE_STORAGE_KEY, raw);
  },
};
