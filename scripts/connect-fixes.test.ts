import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Tests FOCALISES des 3 correctifs de ConnectScreen :
 *  1. « Disconnect this vault » retombe sur une carte neutre ACTIONNABLE
 *     (« No multisig loaded » + les DEUX actions) au lieu d'un faux
 *     « Loading your multisig… » sans controle.
 *  2. « Reset wallet session » a ete SUPPRIME : seule « Disconnect wallet »
 *     subsiste (le meme `disconnect()` local, deja supporte).
 *  3. « Amener au champ » repose sur une MESURE REELLE (`measureInWindow` du
 *     champ ET du ScrollView + offset de defilement `onScroll`) sur la frame
 *     suivante — plus aucun decalage fixe (`onMultisigBlockLayout` /
 *     `multisigBlockYRef` retires).
 *  + le cablage `onClose` de l'etape 1 du parcours Learn.
 *
 * Tests PURS (lecture de la source) : aucun RPC, aucun wallet, aucune
 * transaction, aucun stockage. Execution :
 *   npx tsx scripts/connect-fixes.test.ts
 */

const CONNECT = readFileSync('src/screens/ConnectScreen.tsx', 'utf8');
const RUNNER = readFileSync('scripts/run-pure-tests.sh', 'utf8');

let passed = 0;

function check(name: string, run: () => void): void {
  try {
    run();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (caught: unknown) {
    console.error(`FAIL ${name}`);
    console.error(`  ${caught instanceof Error ? caught.message : String(caught)}`);
    process.exitCode = 1;
  }
}

// --- Correctif 1 : disconnect -> carte ACTIONNABLE, jamais un faux chargement -

check('1. « loading-vault » n’est annonce QUE si un chargement est REEL', () => {
  assert.ok(
    CONNECT.includes(
      "const vaultLoadReal = msig.status === 'loading' || !autoLoadAttemptedRef.current;",
    ),
    'le chargement est qualifie de REEL (en cours, ou auto-chargement pas encore tente)',
  );
  const derived = CONNECT.slice(
    CONNECT.indexOf('const computedVaultBodyState = describeVaultBody({'),
    CONNECT.indexOf('const headerVaultLabel = describeVaultHeader({'),
  );
  assert.ok(
    /computedVaultBodyState === 'loading-vault' && !vaultLoadReal\s*\?\s*'no-saved'\s*:\s*computedVaultBodyState/.test(
      derived,
    ),
    '« loading-vault » non reel retombe sur « no-saved » (jamais un faux chargement)',
  );
  // L'auto-chargement du lancement n'est PAS casse : la tentative est tracee.
  assert.ok(
    CONNECT.includes('autoLoadAttemptedRef.current = true'),
    'la tentative d’auto-chargement reste tracee (le lancement garde loading-vault)',
  );
});

check('2. « Disconnect this vault » DECHARGE le vault (aucun chargement fantome)', () => {
  const at = CONNECT.indexOf('accessibilityLabel="Disconnect this vault"');
  assert.ok(at !== -1, 'le controle existe');
  const block = CONNECT.slice(at, at + 400);
  assert.ok(block.includes("setMultisigInput('')"), 'le champ saisi est vide');
  assert.ok(block.includes('msig.clear()'), 'la vue est liberee (etat neutre)');
});

check('3. la carte neutre « no-saved » rend les DEUX actions', () => {
  const start = CONNECT.indexOf("vaultBodyState === 'no-saved' ? (");
  assert.ok(start !== -1, 'la branche no-saved existe');
  const end = CONNECT.indexOf("vaultBodyState === 'no-active' ? (", start);
  assert.ok(end > start, 'branche bornee');
  const card = CONNECT.slice(start, end);
  assert.ok(card.includes('No multisig loaded'), 'copie neutre « No multisig loaded »');
  assert.ok(card.includes('label="Create a vault"'), 'action « Create a vault » presente');
  assert.ok(
    card.includes('label="Add existing multisig"'),
    'action « Add existing multisig » presente',
  );
});

// --- Correctif 2 : reset de session SUPPRIME (seule « Disconnect wallet ») ----

check('4. « Reset wallet session » est SUPPRIME (plus de bouton ni de libelle)', () => {
  assert.ok(!CONNECT.includes('Reset wallet session'),
    'le libelle du bouton a disparu');
  assert.ok(!CONNECT.includes('Reset the mobile wallet adapter session'),
    'le libelle d’accessibilite a disparu');
  assert.ok(!CONNECT.includes('onResetWalletSession'),
    'le handler dedie a disparu (aucun handler orphelin)');
});

check('5. le texte d’explication du reset local a disparu, la deconnexion locale subsiste', () => {
  assert.ok(!CONNECT.includes('Clears the local authorization on this device'),
    'le paragraphe explicatif a disparu');
  assert.ok(!CONNECT.includes('Wallet-side revocation ignored'),
    'le rapport de reset a disparu');
  assert.ok(!CONNECT.includes('resetReport'),
    'aucun etat de rapport residuel');
  // La deconnexion locale reste la SEULE voie exposee.
  assert.ok(CONNECT.includes('await disconnect();'), 'la deconnexion locale subsiste');
});

check('6. la destructure du hook n’embarque plus connectAnd/store', () => {
  const hook = CONNECT.match(/const \{([^}]*)\} = useMobileWallet\(\);/);
  assert.ok(hook !== null, 'destructure du hook presente');
  assert.ok(!/\bconnectAnd\b/.test(hook[1]), 'plus de connectAnd parmi les champs du hook');
  assert.ok(!/\bstore\b/.test(hook[1]), 'plus de store parmi les champs du hook');
});

// --- Correctif 3 : defilement par MESURE REELLE ------------------------------

check('7. la position vient d’une mesure REELLE (measureInWindow + offset)', () => {
  // Offset de defilement suivi par onScroll.
  assert.ok(CONNECT.includes('const scrollOffsetRef = useRef(0)'), 'offset de defilement suivi');
  assert.ok(
    CONNECT.includes('scrollOffsetRef.current = event.nativeEvent.contentOffset.y'),
    'onScroll met a jour l’offset courant',
  );
  const scrollAt = CONNECT.indexOf('<ScrollView\n');
  assert.ok(scrollAt !== -1, 'le ScrollView est rendu');
  const scrollBlock = CONNECT.slice(scrollAt, scrollAt + 500);
  assert.ok(scrollBlock.includes('onScroll={onScrollContent}'), 'ScrollView ecoute onScroll');
  assert.ok(scrollBlock.includes('ref={scrollViewRef}'), 'ScrollView reference pour la mesure');

  // L'effet d'amenee mesure le champ ET le ScrollView, sur la frame suivante.
  const effectStart = CONNECT.indexOf('if (focusMultisigToken === 0) return;');
  assert.ok(effectStart !== -1, 'effet d’amenee present');
  const effectEnd = CONNECT.indexOf('}, [focusMultisigToken]);', effectStart);
  const effect = CONNECT.slice(effectStart, effectEnd);
  assert.ok(effect.includes('requestAnimationFrame('), 'mesure a la frame SUIVANTE');
  assert.ok(
    effect.includes('measureInWindow?.('),
    'mesure reelle du champ et du ScrollView (pas une position estimee)',
  );
  const formula =
    'scrollOffsetRef.current + fieldY - viewY - MULTISIG_KEYBOARD_MARGIN';
  assert.ok(effect.includes(formula), 'position = offset + champ - vue - marge');
  assert.ok(effect.includes('multisigInputRef.current?.focus()'), 'le champ recoit le focus');
});

check('8. AUCUN decalage fixe : onMultisigBlockLayout / multisigBlockYRef retires', () => {
  assert.ok(!CONNECT.includes('onMultisigBlockLayout'), 'plus de mesure du bloc entier');
  assert.ok(!CONNECT.includes('multisigBlockYRef'), 'plus d’ancrage de position fige');
});

check('9. la marge clavier est une valeur de confort locale (aucune dimension codee)', () => {
  assert.ok(
    /const MULTISIG_KEYBOARD_MARGIN = 24;/.test(CONNECT),
    'marge nommee, unique source',
  );
});

// --- Cablage onClose de l'etape 1 du parcours Learn --------------------------

check('10. OnboardingScreen recoit onClose (la fleche « ‹ » ferme le parcours)', () => {
  const at = CONNECT.indexOf('<OnboardingScreen');
  assert.ok(at !== -1, 'OnboardingScreen rendu');
  const block = CONNECT.slice(at, at + 400);
  assert.ok(block.includes('onClose={onboarding.close}'), 'onClose branche sur onboarding.close');
});

check('11. la suite est enregistree dans npm test', () => {
  assert.ok(
    RUNNER.includes('scripts/connect-fixes.test.ts'),
    'suite des correctifs dans le runner',
  );
});

console.log(`\n${passed} test(s) OK`);
if (process.exitCode === 1) process.exit(1);
