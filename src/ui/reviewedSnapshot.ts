/**
 * INSTANTANÉ REVU d'une création de proposition.
 *
 * Le Review rend EXCLUSIVEMENT depuis cet instantané figé au succès de la
 * simulation — jamais depuis les champs de formulaire mutables. Toute
 * modification d'un paramètre MATÉRIEL invalide l'instantané (voir
 * `snapshotMatchesForm`) : la création redevient impossible jusqu'à une
 * nouvelle revue.
 *
 * Pur : aucun RPC, aucun wallet, aucun effet de bord.
 */

/** Paramètres material : tout ce qui change la proposition résultante. */
export type ReviewedSnapshot = {
  destination: string;
  amountLamports: number;
  memo: string;
  /** Buffer explicite du chemin Max, en lamports (0 si aucun). */
  bufferLamports: number;
  cluster: string;
  vaultAddress: string;
  transactionIndexNext: number | null;
  /** Coût estimé (rent + frais), en lamports ; null si non mesurable. */
  estimatedCreatorBalanceDelta: number | null;
  proposalPda: string | null;
  transactionPda: string | null;
};

/** Entrées COURANTES du formulaire, comparées à l'instantané. */
export type CurrentProposalInputs = {
  destination: string;
  amountLamports: number | null;
  memo: string;
  bufferLamports: number;
  cluster: string;
  vaultAddress: string;
};

/**
 * Vrai si l'instantané correspond ENCORE à tous les paramètres matériels
 * courants. Un montant courant nul (non calculable) ne correspond à rien.
 */
export function snapshotMatchesForm(
  snapshot: ReviewedSnapshot,
  current: CurrentProposalInputs,
): boolean {
  if (current.amountLamports === null) return false;
  return (
    snapshot.destination === current.destination &&
    snapshot.amountLamports === current.amountLamports &&
    snapshot.memo === current.memo &&
    snapshot.bufferLamports === current.bufferLamports &&
    snapshot.cluster === current.cluster &&
    snapshot.vaultAddress === current.vaultAddress
  );
}
