/**
 * §1 — INTEGRITE D'ETAT : une SEULE verite on-chain pour TOUS les affichages.
 *
 * Les props recues a l'ouverture (`proposal`) sont un instantane d'AVANT
 * approbation. Des qu'une lecture on-chain VERIFIEE existe, elle prime : sans
 * cela, le meme ecran peut afficher « Approved · 1 of 2 » (props) dans la revue
 * en lecture seule pendant que la carte principale affiche « Executed · 2 of 2 »
 * (lecture fraiche).
 */

export type ProposalDisplaySource = {
  approvedAddresses: readonly string[];
  status: string;
};

/**
 * La lecture VERIFIEE prime ; les props ne servent que tant qu'AUCUNE lecture
 * n'a eu lieu. Aucune autre regle ne doit exister ailleurs.
 */
export function effectiveProposalDisplay(
  onchain: ProposalDisplaySource | null | undefined,
  fromProps: ProposalDisplaySource,
): ProposalDisplaySource {
  return onchain ?? fromProps;
}

/**
 * Etat TERMINAL : statut on-chain « Executed », ou execution verifiee.
 */
export function isExecutedProposal(
  display: ProposalDisplaySource,
  executionVerified: boolean,
): boolean {
  return display.status === 'Executed' || executionVerified;
}

/**
 * La copie d'AVANT execution (« le transfert n'a lieu qu'apres le seuil
 * d'approbation ») ne doit JAMAIS etre rendue pour une proposition executee :
 * elle decrit comme a venir un transfert deja effectue.
 */
export function showsPreExecutionCopy(executed: boolean): boolean {
  return !executed;
}

/**
 * Compteur d'approbations affichable. La valeur vient TOUJOURS de la meme source
 * que le statut (lecture verifiee si elle existe).
 */
export function approvalCountLabel(approvedCount: number, threshold: number): string {
  return `${approvedCount} of ${threshold} approvals collected`;
}
