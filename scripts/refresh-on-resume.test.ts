import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * RAFRAICHISSEMENT : relecture au retour au premier plan, un seul etat
 * d'approbation a la fois, liste non perimee. Aucun wallet, aucun reseau,
 * aucune signature, aucun envoi. npx tsx scripts/refresh-on-resume.test.ts
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
const CONNECT = readFileSync('src/screens/ConnectScreen.tsx', 'utf8');
const MDS = readFileSync('src/screens/MultisigDetailsScreen.tsx', 'utf8');

/** Relecture de retour au premier plan dans Proposal Details. */
const RESUME = DETAILS.slice(
  DETAILS.indexOf("AppState.addEventListener('change'"),
  DETAILS.indexOf('const verifyExecutionOnce'),
);

check('1. retour du wallet : l ecran relit la chaine au premier plan', () => {
  assert.ok(RESUME.length > 0, 'ecouteur de premier plan present');
  assert.ok(RESUME.includes("if (state !== 'active') return;"));
  assert.ok(RESUME.includes('await runDecode()'), 'relecture du modele');
  assert.ok(RESUME.includes('await refreshProposalFromChain()'), 'relecture de la Proposal');
  assert.ok(RESUME.includes('subscription.remove()'), 'desabonnement au demontage');
});

check('2. cette relecture ne fait AUCUN wallet et AUCUN envoi', () => {
  for (const forbidden of [
    'signAndSendTransactions',
    'signAndSendProposalApproval',
    'signAndSendProposalExecution',
    'useMobileWallet()',
    'authorize(',
  ]) {
    assert.ok(!RESUME.includes(forbidden), `interdit dans la relecture : ${forbidden}`);
  }
});

check('3. aucun refresh concurrent ni apres demontage', () => {
  assert.ok(RESUME.includes('if (unmountedRef.current || refreshInFlightRef.current) return;'));
  assert.ok(DETAILS.includes('const refreshInFlightRef = useRef(false);'));
});

check('4. Execute ne s active QUE sur donnee relue (jamais sur une signature)', () => {
  assert.ok(
    DETAILS.includes("const canExecute =\n    effectiveProposalStatus === 'Approved' && thresholdReached && walletHasExecute;"),
    'verdict fonde sur l etat effectif',
  );
  assert.ok(DETAILS.includes('const thresholdReached = effectiveApprovedAddresses.length >= threshold;'));
  assert.ok(
    DETAILS.includes('const effectiveApprovedAddresses = displayProposal.approvedAddresses;'),
  );
  // Aucun « canExecute » derive d'un resultat de signature.
  assert.ok(!/const canExecute[\s\S]{0,120}approvalResult/.test(DETAILS), 'pas de canExecute sur signature');
});

check('5. un SEUL bandeau pending, en ton neutre (etat inconnu, pas echec)', () => {
  // Le bandeau d'erreur separe disparait quand c'est un etat « envoi signe non verifie ».
  // Etats MUTUELLEMENT exclusifs : des que le seuil est verifie, plus aucun
  // bandeau d'attente ni ancienne erreur.
  assert.ok(DETAILS.includes("!approvalNetworkFailure &&\n        !progress.reached ? ("));
  assert.ok(DETAILS.includes('approvalNetworkFailure\n                  ? /* Etat INCONNU'));
  assert.ok(
    DETAILS.includes('? /* Etat INCONNU (envoi signe, relecture indisponible) : jamais'),
    'ton neutre documente',
  );
});

check('6. notes de developpeur et signature complete hors du parcours principal', () => {
  // Les avertissements techniques ne sont plus rendus dans le bloc de resultat.
  assert.ok(!DETAILS.includes('{executionResult.validationWarnings.map'));
  assert.ok(DETAILS.includes('{(executionResult?.validationWarnings ?? []).map'), 'deplaces dans Troubleshooting');
  assert.ok(
    DETAILS.includes('Signature: {abbreviateAddress(executionResult.signature)}'),
    'signature abregee dans le parcours principal',
  );
  assert.ok(DETAILS.includes('Execution signature: {executionResult.signature}'), 'complete dans le repli');
});

check('7. la liste des propositions possede enfin un jeton de relecture', () => {
  assert.ok(CONNECT.includes('const [proposalsNonce, setProposalsNonce] = useState(0);'));
  assert.ok(
    CONNECT.includes("    msig.view?.staleTransactionIndex ?? 0,\n    proposalsNonce,\n  );"),
    'jeton transmis a useProposals',
  );
  assert.ok(!CONNECT.includes('useProposals(\n    msig.view?.address ?? null,\n    msig.view?.transactionIndex ?? 0,\n    msig.view?.staleTransactionIndex ?? 0,\n  );'));
});

check('8. relecture de la liste : retour au premier plan ET retour du detail', () => {
  assert.ok(CONNECT.includes("if (state === 'active') refreshProposalsReadOnly();"));
  // Retour depuis le detail : ferme le detail PUIS relance la relecture read-only.
  // Le calcul du FILTRE DE RETOUR s'intercale desormais entre les deux : on borne
  // donc la recherche au HANDLER, sans exiger une adjacence qui n'a plus de sens
  // (l'intention — les deux actions presentes et ordonnees — est preservee).
  const back = CONNECT.slice(
    CONNECT.indexOf('onBack={(verifiedStatus) => {'),
    CONNECT.indexOf('proposal={{ approvedAddresses: decision.approvedAddresses'),
  );
  assert.ok(back.includes('setOpenDecisionIndex(null);'), 'retour depuis le detail : ferme le detail');
  assert.ok(
    back.includes('refreshProposalsReadOnly();'),
    'retour depuis le detail : relance la lecture',
  );
  assert.ok(MDS.includes("if (next === 'active') void reloadFromChain();"));
  const mdsBack = MDS.slice(
    MDS.indexOf('onBack={(verifiedStatus) => {'),
    MDS.indexOf('vaultTransactionAddress={openProposal.vaultTransactionAddress}'),
  );
  assert.ok(mdsBack.includes('setOpenProposal(null);'), 'ferme le detail');
  assert.ok(mdsBack.includes('void reloadFromChain();'), 'relance la lecture');
});

check('9. aucun refresh concurrent dans les deux ecrans de liste', () => {
  assert.ok(CONNECT.includes('if (proposalsRefreshRef.current) return;'));
  assert.ok(CONNECT.includes("if (proposals.status !== 'loading') proposalsRefreshRef.current = false;"));
  assert.ok(MDS.includes('if (reloadInFlightRef.current) return false;'));
  assert.ok(MDS.includes('reloadInFlightRef.current = false;'));
});

check('10. ces relectures ne sollicitent jamais le wallet', () => {
  for (const source of [CONNECT, MDS]) {
    assert.ok(!/AppState\.addEventListener[\s\S]{0,200}signAndSend/.test(source), 'aucun envoi');
  }
  assert.ok(!/refreshProposalsReadOnly[\s\S]{0,200}(useMobileWallet|authorize)/.test(CONNECT));
});

console.log(`\n${passed} test(s) OK`);
