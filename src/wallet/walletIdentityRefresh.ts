/**
 * Décision PURE : faut-il relire les données on-chain du multisig courant quand
 * l'identité du signataire (clé publique du wallet) vient de changer ?
 *
 * Module PUR : aucune I/O, aucun RPC, aucun wallet, aucune signature, aucun
 * stockage. Il ne fait que répondre à une question booléenne sur deux identités
 * et la présence d'un vault chargé — donc testable hors ligne.
 *
 * Raison d'être (bug de fraîcheur de cache) :
 * la liste des propositions et la vue du multisig (dont le `transactionIndex`
 * lu on-chain) sont lues une fois puis mises en cache. Tant que le wallet ne
 * change pas, AUCUNE dépendance ne déclenche de relecture : une proposition
 * créée après le dernier chargement (index on-chain devenu supérieur au
 * `transactionIndex` en cache) et les compteurs « waiting for your vote »
 * restaient donc invisibles jusqu'à une RELANCE de l'app (qui, elle, relit le
 * compte à neuf). Changer de wallet DANS l'app (disconnect puis connect) ne
 * remonte pas l'écran : il faut une dépendance explicite sur l'identité du
 * signataire, exactement comme la relecture du registre au retour d'une
 * création.
 *
 * Règles :
 * - `next === null` (déconnecté) : rien à relire, aucune donnée affichée ;
 * - identité inchangée : aucune raison de relire (le cache reste valable) ;
 * - aucun vault chargé : l'auto-chargement du lancement s'en charge ;
 * - sinon (identité RÉELLE différente, avec un vault affiché) : relire.
 */
export function shouldReloadForWalletIdentity(
  previous: string | null,
  next: string | null,
  hasVault: boolean,
): boolean {
  if (next === null) return false;
  if (previous === next) return false;
  if (!hasVault) return false;
  return true;
}
