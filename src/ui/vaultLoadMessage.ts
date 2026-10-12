/**
 * Message d'échec de chargement d'un vault, DESTINÉ À L'UTILISATEUR.
 *
 * Module PUR : aucune I/O, aucun RPC, aucun wallet, aucun stockage. Il ne
 * transforme qu'une chaîne d'erreur déjà disponible en une copie COURTE et
 * HUMAINE — jamais le texte technique brut (exception Java, nom d'hôte RPC,
 * adresse base58), qui ne doit jamais être affiché par défaut.
 *
 * DÉCISION PRODUIT : le titre est VOLONTAIREMENT GÉNÉRIQUE en toutes
 * circonstances. On ne prétend PAS distinguer une absence de réseau d'une autre
 * panne (aucune heuristique n'influence l'affichage). Le corps donne seulement
 * la piste la plus probable sans affirmer la cause.
 */

export type VaultLoadMessage = {
  /** Titre court (une ligne). */
  title: string;
  /** Explication courte (une phrase). */
  body: string;
};

/**
 * Copie utilisateur de l'échec de chargement. Ne renvoie JAMAIS le texte brut :
 * un titre GÉNÉRIQUE et sûr (aucune cause inventée) + une phrase.
 */
export function describeVaultLoadError(error: string | null | undefined): VaultLoadMessage {
  // Le paramètre est conservé pour l'API (les appelants passent `msig.error`),
  // mais il n'influence PLUS la copie : on ne distingue plus les causes.
  void error;
  return {
    title: 'Could not load this multisig',
    body: 'Check your connection and try again.',
  };
}
