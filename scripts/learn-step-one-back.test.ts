import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Tests FOCALISES du controle de retour VISIBLE a l'ETAPE 1 du parcours
 * « Learn about multisig ».
 *
 * Contexte : la fleche « ‹ » n'apparaissait qu'a partir de l'etape 2 (`step > 0`).
 * A l'etape 1 il n'y avait AUCUN controle de retour (un simple spacer). Le
 * retour Android (bouton + geste) ferme le parcours via `onboarding.close()`.
 *
 * Objectif :
 *  (a) a l'etape 1 (step === 0) un controle de retour VISIBLE est rendu (plus
 *      de spacer inerte) et il FERME le parcours (meme action que le retour
 *      Android) ;
 *  (b) aux etapes > 1 le comportement EXISTANT est inchange : la fleche recule
 *      d'une etape (`onBack`) ;
 *  (c) le controle porte un accessibilityLabel explicite en anglais ;
 *  (d) le comportement du parcours (reculer d'une etape, boutons internes,
 *      contenu) n'est pas casse.
 *
 * Tests PURS (lecture des sources) ; aucun renderer, aucun wallet, aucun RPC.
 * Execution : npx tsx scripts/learn-step-one-back.test.ts
 */

const SCREEN = readFileSync('src/screens/OnboardingScreen.tsx', 'utf8');
const CONNECT = readFileSync('src/screens/ConnectScreen.tsx', 'utf8');
const RUNNER = readFileSync('scripts/run-pure-tests.sh', 'utf8');

// Bloc d'en-tete : du style headerRow jusqu'a la pastille Devnet.
const headerStart = SCREEN.indexOf('styles.headerRow');
const headerEnd = SCREEN.indexOf('<DevnetPill', headerStart);
const HEADER = SCREEN.slice(headerStart, headerEnd);
// Branche « etapes > 1 » = avant « ) : ( » ; branche « etape 1 » = apres.
const elseIndex = HEADER.indexOf(') : (');
const STEP_N = HEADER.slice(0, elseIndex);
const STEP_1 = HEADER.slice(elseIndex);

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

check('0. l en-tete expose bien les deux branches', () => {
  assert.ok(headerStart !== -1 && headerEnd !== -1 && headerStart < headerEnd, 'bloc headerRow delimite');
  assert.ok(elseIndex !== -1, 'ternaire step > 0 ? ... : ... exposee');
  assert.equal(HEADER.split('<Pressable').length - 1, 2, 'exactement deux controles dans l en-tete');
});

check('1. a l etape 1 un controle de retour VISIBLE est rendu (plus de spacer inerte)', () => {
  assert.ok(!HEADER.includes('backSpacer'), 'le spacer inerte de l etape 1 a disparu');
  assert.ok(STEP_1.includes('<Pressable'), 'l etape 1 rend un vrai bouton');
  assert.ok(STEP_1.includes('accessibilityRole="button"'), 'role bouton');
  assert.ok(STEP_1.includes('‹'), 'meme fleche « ‹ » que les etapes suivantes');
  assert.ok(STEP_1.includes('styles.backButton'), 'reutilise le style existant de la fleche');
  assert.ok(STEP_1.includes('styles.backButtonPressed'), 'etat presse coherent');
  assert.ok(STEP_1.includes('styles.backGlyph'), 'meme glyphe');
});

check('2. a l etape 1 le controle FERME le parcours (equivalent du retour Android)', () => {
  assert.ok(STEP_1.includes('onPress={onClose}'), 'l etape 1 ferme via le callback onClose');
  // Le tour est ferme par `onboarding.close()` cote ConnectScreen : c'est
  // exactement l'action du retour Android (bouton + geste).
  assert.ok(CONNECT.includes('onboarding.close();'), 'retour Android = onboarding.close()');
  assert.ok(
    /onClose\??:\s*\(\)\s*=>\s*void/.test(SCREEN),
    'la prop onClose est declaree sur l ecran',
  );
});

check('3. le libelle du controle est explicite et en anglais', () => {
  assert.ok(STEP_1.includes('accessibilityLabel="Close"'), 'etape 1 : label explicite « Close »');
  // Etapes suivantes : label inchange.
  assert.ok(STEP_N.includes('accessibilityLabel="Back"'), 'etapes suivantes : label « Back » inchange');
});

check('4. les etapes > 1 sont INCHANGEES : la fleche recule d une etape', () => {
  assert.ok(STEP_N.includes('onPress={onBack}'), 'la fleche des etapes > 1 rappelle onBack');
  assert.ok(
    SCREEN.includes('const onBack = () => setStep((previous) => Math.max(previous - 1, 0));'),
    'onBack recule d une etape (comportement d origine)',
  );
  assert.ok(STEP_N.includes('‹'), 'fleche « ‹ » conservee');
});

check('5. la navigation interne et le contenu du parcours ne sont pas casses', () => {
  // Bouton Back interne (rangee d actions) toujours conditionne a step > 0.
  assert.ok(SCREEN.includes('accessibilityLabel="Next"'), 'Next present');
  assert.ok(SCREEN.includes('accessibilityLabel="Skip onboarding"'), 'Skip present');
  assert.ok(SCREEN.includes('accessibilityLabel="Finish onboarding"'), 'Finish present');
  // Aucun etat ni retour n a ete ajoute/supprime.
  assert.ok(SCREEN.includes('const onNext = () => setStep((previous) => Math.min(previous + 1, lastStep));'));
  // Aucun wallet / RPC / transaction (regle du projet).
  assert.ok(!/useMobileWallet|signAndSendTransactions|signTransaction/.test(SCREEN));
  assert.ok(!/connection\.|getBalance|getAccountInfo|fetch\(|https?:/.test(SCREEN));
});

check('6. la suite est enregistree dans npm test', () => {
  assert.ok(
    RUNNER.includes('scripts/learn-step-one-back.test.ts'),
    'suite du retour etape 1 dans le runner',
  );
});

console.log(`\n${passed} test(s) OK`);
if (process.exitCode === 1) process.exit(1);
