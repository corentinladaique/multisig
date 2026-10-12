/**
 * ETAT DE REPRISE apres un echec wallet NON CLASSE, et son mapping depuis le
 * resultat d'une relecture LECTURE SEULE.
 *
 * POURQUOI UN BOOLEEN NE SUFFIT PAS
 * ---------------------------------
 * `checkedAfterFailure: boolean` confondait deux faits SANS RAPPORT :
 *   1. « la promesse de relecture s'est terminee » ;
 *   2. « une nouvelle tentative est sure ».
 * Le second n'est PAS deductible du premier. Une erreur RPC, un `false`, un
 * `null`, un refresh concurrent ou une proposition momentanement introuvable
 * terminent tous la promesse — sans rien prouver.
 *
 * PREUVE EXACTE EXIGEE POUR `safe_to_retry`
 * -----------------------------------------
 * Aucun booleen ne peut la fournir. Il faudrait que la relecture rende un
 * resultat DISCRIMINE permettant d'etablir qu'AUCUNE transaction n'a ete
 * enregistree, c'est-a-dire typiquement :
 *   - `loadMultisig` a reussi (compte Multisig relu, pas d'erreur RPC) ;
 *   - et le `transactionIndex` relu est INCHANGE par rapport a l'index attendu
 *     a la creation (`transactionIndexNext` capture dans l'instantane revu) ;
 *   - et la signature soumise n'existe pas / la lecture des signatures confirme
 *     qu'aucune approbation n'a ete enregistree pour cette tentative.
 * Tant que le contrat `onCreatedVerified: () => Promise<boolean>` ne rend pas
 * ces informations, `safe_to_retry` et `proposal_found` restent DEFINIS MAIS
 * SANS PRODUCTEUR : ce module ne les emet jamais.
 */

export type RecoveryCheckState =
  | 'not_checked'
  | 'checking'
  | 'proposal_found'
  | 'verification_unavailable'
  | 'still_unknown'
  | 'safe_to_retry';

/** Resultat brut d'une relecture lecture seule : booleen, ou rien du tout. */
export type ReadOutcome = boolean | null | undefined;

/**
 * Etats dans lesquels « Try again » doit rester DESACTIVE. Seul
 * `safe_to_retry` autorise une nouvelle tentative.
 */
export const RECOVERY_RETRY_BLOCKED_STATES: readonly RecoveryCheckState[] = [
  'not_checked',
  'checking',
  'proposal_found',
  'verification_unavailable',
  'still_unknown',
];

/**
 * Mapping VOLONTAIREMENT CONSERVATEUR : rien n'est jamais conclu a partir d'une
 * simple terminaison de promesse.
 *
 * - `true`        : la lecture a abouti, mais elle ne prouve PAS l'absence de la
 *                   proposition (elle peut etre encore non confirmee) -> inconnu.
 * - `false`       : echec RPC / refresh concurrent / reponse invalide -> la
 *                   verification est indisponible.
 * - `null` / `undefined` : aucun resultat exploitable -> inconnu.
 *
 * Cette fonction ne retourne JAMAIS `safe_to_retry` ni `proposal_found`.
 */
export function recoveryStateFromRead(outcome: ReadOutcome): RecoveryCheckState {
  if (outcome === true) return 'still_unknown';
  if (outcome === false) return 'verification_unavailable';
  return 'still_unknown';
}

/** Une nouvelle tentative n'est permise que dans le SEUL etat prouve. */
export function canRetryAfterFailure(state: RecoveryCheckState): boolean {
  return state === 'safe_to_retry';
}
