/**
 * Classification PURE d'un échec d'écriture / de décodage : RÉSEAU ou pas.
 *
 * Module PUR : aucune I/O, aucun RPC, aucun wallet. La décision se prend
 * uniquement à partir du TEXTE du message.
 *
 * DÉCISION PRODUIT : une erreur de CONNECTIVITÉ (hôte introuvable, DNS,
 * `fetch failed`, réseau coupé, timeout) n'est NI une panne de l'application NI
 * un échec de la proposition : elle est TRANSITOIRE. Elle doit donc s'afficher
 * en AMBRE (ton `warning` du thème) avec un message HUMAIN, jamais en rouge avec
 * une exception Java brute. Une erreur RÉELLE (décodage impossible, données
 * invalides) garde, elle, le ton ROUGE (`error`).
 */

/** Motifs de connectivité — ceux de la couche réseau JS et d'Android/Java. */
const NETWORK_FAILURE_PATTERNS: RegExp[] = [
  /UnknownHostException/i,
  /Unable to resolve host/i,
  /No address associated with hostname/i,
  /fetch failed/i,
  /Network request failed/i,
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /ETIMEDOUT/i,
  /socket hang up/i,
  /network is unreachable/i,
  /timed? ?out/i,
];

/**
 * Vrai si le message décrit un problème de CONNECTIVITÉ transitoire.
 * Toute entrée nulle / vide / non textuelle renvoie `false` (jamais « réseau »
 * par défaut : une erreur réelle doit rester rouge).
 */
export function isNetworkFailure(message: string | null | undefined): boolean {
  if (typeof message !== 'string' || message.length === 0) return false;
  return NETWORK_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
}

/** Copie HUMAINE d'un incident de vérification réseau. */
export const NETWORK_INCIDENT_TITLE = 'Verification is temporarily unavailable';
export const NETWORK_INCIDENT_BODY =
  'Multisig will check again when the network connection returns.';
/** Rassurance : une vérification en lecture seule ne signe rien, n'envoie rien. */
export const NETWORK_INCIDENT_REASSURANCE = 'Nothing was signed and nothing was sent.';
/** Titre d'une VRAIE erreur de décodage (jamais « réseau »). */
export const DECODE_INCIDENT_TITLE = 'Could not decode this proposal';

export type VerificationIncidentCopy = {
  /** Vrai si l'incident est un problème de connectivité (panneau AMBRE). */
  network: boolean;
  /** Titre court (une ligne). */
  title: string;
  /** Explication courte (une phrase). */
  body: string;
  /** Rassurance optionnelle (uniquement sans signature). */
  reassurance: string | null;
};

/**
 * Copie utilisateur d'un échec de décodage / vérification.
 *
 *  - réseau  → titre et corps humains + rassurance : rien n'a été signé ni envoyé ;
 *  - réel    → titre explicite ; le corps laisse le message d'origine intact
 *              (l'appelant décide de le montrer tel quel, en rouge).
 */
export function describeVerificationIncident(
  message: string | null | undefined,
): VerificationIncidentCopy {
  if (isNetworkFailure(message)) {
    return {
      body: NETWORK_INCIDENT_BODY,
      network: true,
      reassurance: NETWORK_INCIDENT_REASSURANCE,
      title: NETWORK_INCIDENT_TITLE,
    };
  }
  return {
    body: typeof message === 'string' ? message : '',
    network: false,
    reassurance: null,
    title: DECODE_INCIDENT_TITLE,
  };
}
