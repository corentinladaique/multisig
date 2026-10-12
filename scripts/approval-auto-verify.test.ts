import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * REPRISES AUTOMATIQUES de la VERIFICATION D'APPROBATION (P0).
 *
 * Defaut reproduit sur le Seeker : apres une approbation signee, une panne
 * RPC/DNS temporaire laissait l'ecran sur « Approval sent » / « Verification is
 * temporarily unavailable » / « Check approval again » — l'utilisateur devait
 * relancer a la main meme apres le retour du reseau. L'execution avait deja des
 * reprises bornees ; l'approbation n'en avait aucune.
 *
 * Ces reprises sont LECTURES SEULES : statut de la signature + relecture de la
 * Proposal. Jamais de wallet, jamais de signature, jamais de reconstruction,
 * jamais de second envoi.
 *
 * Aucun RPC, aucun wallet, aucun envoi : assertions sur le source, comme le
 * reste de la suite pour cet ecran (un composant RN de 2000 lignes n'expose pas
 * l'effet a un test runtime sans un remaniement interdit par la mission).
 *
 * npx tsx scripts/approval-auto-verify.test.ts
 */

let passed = 0;
function check(name: string, run: () => void): void {
  try {
    run();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (caught: unknown) {
    console.log(`FAIL ${name}`);
    const detail = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
    console.log(detail.split('\n').slice(0, 4).join('\n'));
    process.exitCode = 1;
  }
}

const DETAILS = readFileSync('src/screens/ProposalDetailsScreen.tsx', 'utf8');

/** Effet de reprise AUTOMATIQUE d'approbation : de sa garde a ses dependances. */
const RETRY = DETAILS.slice(
  DETAILS.indexOf('if (!approvalNetworkFailure) return;'),
  DETAILS.indexOf('}, [approvalNetworkFailure, approvalVerificationRound]);'),
);
/** Handler manuel « Check approval again » : de sa signature a sa fin. */
const MANUAL = DETAILS.slice(
  DETAILS.indexOf('const onCheckApprovalAgain = async () => {'),
  DETAILS.indexOf('const latestApprovalCheckRef'),
);

check('1. declencheur : signature d approbation EXISTE, NON verifiee, echec reseau temporaire', () => {
  assert.ok(DETAILS.includes('const approvalNetworkFailure ='), 'condition nommee');
  const CONDITION = DETAILS.slice(
    DETAILS.indexOf('const approvalNetworkFailure ='),
    DETAILS.indexOf('const latestCheckRef'),
  );
  assert.ok(CONDITION.includes('approvalResult.signature !== null'), 'signature reelle exigee');
  assert.ok(CONDITION.includes('!approvalResult.verified'), 'non encore verifiee');
  assert.ok(CONDITION.includes('isTemporaryNetworkFailure(approvalError ?? \'\')'), 'echec reseau seulement');
  assert.ok(RETRY.includes('if (!approvalNetworkFailure) return;'), 'garde d entree de la reprise');
});

check('2. bornees : maximum 3 tentatives, cadence 4 s / 8 s / 15 s (barème PARTAGE avec l execution)', () => {
  assert.ok(DETAILS.includes('const MAX_VERIFICATION_ATTEMPTS = 3;'), 'plafond de 3');
  assert.ok(
    DETAILS.includes('const VERIFICATION_RETRY_DELAYS_MS = [4000, 8000, 15000];'),
    'cadence conservative partagee',
  );
  assert.ok(
    RETRY.includes('approvalVerificationAttemptsRef.current >= MAX_VERIFICATION_ATTEMPTS'),
    'garde du plafond',
  );
  assert.ok(RETRY.includes('VERIFICATION_RETRY_DELAYS_MS['), 'reutilise le barème, n en cree pas un second');
  assert.equal(
    RETRY.split('approvalVerificationAttemptsRef.current += 1;').length - 1,
    1,
    'un seul increment par armement',
  );
});

check('3. LECTURES SEULES : aucun wallet, aucune signature, aucune reconstruction, aucun envoi', () => {
  for (const forbidden of [
    'signAndSendProposalApproval',
    'signAndSendTransactions',
    'authorize(',
    'useMobileWallet()',
    'sendRawTransaction',
    'signTransaction',
    'runApproval',
  ]) {
    assert.ok(!RETRY.includes(forbidden), `interdit dans la reprise : ${forbidden}`);
  }
  // La reprise n atteint QUE la relecture manuelle, elle-meme lecture seule.
  assert.ok(RETRY.includes('latestApprovalCheckRef.current();'), 'reprise -> relecture');
  assert.ok(DETAILS.includes('const latestApprovalCheckRef = useRef<() => void>(() => {});'));
  assert.ok(
    DETAILS.includes('void onCheckApprovalAgain();'),
    'la reprise ne fait que relancer la relecture manuelle',
  );
  // Le handler de relecture ne signe ni n envoie.
  for (const forbidden of ['signAndSendProposalApproval', 'runApproval', 'authorize(']) {
    assert.ok(!MANUAL.includes(forbidden), `interdit dans la relecture : ${forbidden}`);
  }
  assert.ok(MANUAL.includes('confirmSignature'), 'relecture du statut de signature');
  assert.ok(MANUAL.includes('await refreshProposalFromChain()'), 'relecture de la Proposal');
});

check('4. aucune reprise concurrente : une seule verification en vol', () => {
  assert.ok(DETAILS.includes('const approvalCheckInFlightRef = useRef(false);'), 'verrou de vol');
  assert.ok(
    MANUAL.includes('checkingApproval || approvalCheckInFlightRef.current) return;'),
    'garde d overlap sur la relecture manuelle',
  );
  assert.ok(MANUAL.includes('approvalCheckInFlightRef.current = true;'), 'acquis avant tout await');
  assert.ok(MANUAL.includes('approvalCheckInFlightRef.current = false;'), 'rendu en finally');
  assert.ok(
    RETRY.includes('if (unmountedRef.current || approvalCheckInFlightRef.current) return;'),
    'le minuteur ne tire pas si une relecture est deja en vol',
  );
  // Minuteur PROPRE a l approbation : jamais celui de l execution.
  assert.ok(RETRY.includes('approvalVerificationTimerRef.current = setTimeout('));
  assert.equal(
    RETRY.split('verificationTimerRef.current').length - 1,
    0,
    'la reprise d approbation ne touche pas au minuteur d execution',
  );
});

check('5. arret immediat apres approbation VERIFIEE : plus aucune reprise ne s arme', () => {
  assert.ok(
    MANUAL.includes('approvalVerificationAttemptsRef.current = MAX_VERIFICATION_ATTEMPTS;'),
    'l etat tranche desarme les reprises',
  );
  assert.ok(MANUAL.includes('setApprovalError(null);'), 'ancienne erreur retiree du bloc principal');
  assert.ok(
    MANUAL.includes('setApprovalVerificationRound((round) => round + 1);'),
    'un tour de relecture rearme la boucle bornee',
  );
});

check('6. arret au DEMONTAGE : le minuteur d approbation est annule', () => {
  const UNMOUNT = DETAILS.slice(
    DETAILS.indexOf('unmountedRef.current = false;'),
    DETAILS.indexOf('useEffect(() => {\n    if (!executionNetworkFailure) return;'),
  );
  assert.ok(UNMOUNT.includes('unmountedRef.current = true;'), 'drapeau de demontage');
  assert.ok(
    UNMOUNT.includes('clearTimeout(approvalVerificationTimerRef.current)'),
    'minuteur d approbation annule au demontage',
  );
});

check('7. arret au CHANGEMENT DE PROPOSITION : minuteur annule et compteur remis a zero', () => {
  const CHANGE = DETAILS.slice(
    DETAILS.indexOf('if (proposalKeyRef.current === proposalKey) return;'),
    DETAILS.indexOf('unmountedRef.current = false;'),
  );
  assert.ok(CHANGE.includes('clearTimeout(approvalVerificationTimerRef.current)'), 'minuteur annule');
  assert.ok(CHANGE.includes('approvalVerificationAttemptsRef.current = 0;'), 'compteur remis a zero');
});

check('8. « Check approval again » reste disponible apres les reprises automatiques', () => {
  assert.ok(
    DETAILS.includes('label={checkingApproval ? \'Checking…\' : \'Check approval again\'}'),
    'l action de relecture manuelle reste offerte',
  );
  assert.ok(DETAILS.includes('void onCheckApprovalAgain();'), 'handler toujours branche');
  // Aucun spinner permanent : la relecture rend toujours checkingApproval a false.
  assert.ok(MANUAL.includes('setCheckingApproval(false);'), 'etat occupe rendu en finally');
});

check('9. une SIGNATURE seule ne peut pas activer Execute', () => {
  // Execute depend du STATUT verifie et du SEUIL, jamais d une signature d approbation.
  assert.ok(DETAILS.includes('const thresholdReached = effectiveApprovedAddresses.length >= threshold;'));
  assert.ok(DETAILS.includes("effectiveProposalStatus === 'Approved' && thresholdReached && walletHasExecute"),);
  assert.ok(
    DETAILS.includes("const executeState = deriveProposalExecuteState({"),
    'etat d execution deduit du seuil verifie',
  );
  // La relecture (seule preuve admise) met a jour le compteur affiche.
  assert.ok(DETAILS.includes('const effectiveApprovedAddresses = displayProposal.approvedAddresses;'));
  assert.ok(DETAILS.includes('setOnchainApproval(fresh);'), 'seule la relecture on-chain fait foi');
});

check('10. la relecture reussie met a jour le MEME ecran et peut atteindre 2 of 2', () => {
  // Onchain approval relu -> seuil recalcule -> Execute disponible, tout SEUL.
  assert.ok(MANUAL.includes('const fresh = await refreshProposalFromChain();'));
  assert.ok(MANUAL.includes('walletHasApproved(fresh.approvedAddresses, walletAddress)'));
  assert.ok(DETAILS.includes('{progress.collectedLabel}'), 'compteur « 2 of 2 » re-rendu');
  assert.equal(
    DETAILS.split('const thresholdReached =').length - 1,
    1,
    'une seule definition du seuil : aucun doublon de comptage',
  );
});

console.log(`\n${passed} test(s) OK`);
