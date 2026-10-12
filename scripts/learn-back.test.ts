import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Tests FOCALISES du retour Android (bouton ET geste de balayage) sur le
 * parcours « Learn about multisig ».
 *
 * Objectif :
 *  (a) un BackHandler est enregistre QUAND le parcours est ouvert et
 *      DESENREGISTRE sinon (aucun listener toujours actif) ;
 *  (b) le retour REFERME le parcours ;
 *  (c) le retour « post-creation -> inbox » existant reste intact ;
 *  (d) le parcours ouvert depuis Account revient sur Account (meme ecran, pas
 *      de navigation : la fermeture repose `show` a false et re-rend la vue).
 *
 * Tests PURS (lecture des sources) ; aucun RPC, aucun wallet, aucune
 * transaction, aucun stockage natif. Execution :
 * npx tsx scripts/learn-back.test.ts
 */

const CONNECT = readFileSync('src/screens/ConnectScreen.tsx', 'utf8');
const CREATE = readFileSync('src/screens/CreateVaultScreen.tsx', 'utf8');
const HOOK = readFileSync('src/onboarding/useOnboarding.ts', 'utf8');
const RUNNER = readFileSync('scripts/run-pure-tests.sh', 'utf8');

// Fenetre du listener de retour du parcours : autour de l'enregistrement.
const ADD = "BackHandler.addEventListener('hardwareBackPress', () => {";
const addIndex = CONNECT.indexOf(ADD);
const LEARN_BACK = CONNECT.slice(Math.max(0, addIndex - 500), addIndex + 400);

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

// --- (a) enregistrement / desenregistrement --------------------------------

check('1. ConnectScreen enregistre UN SEUL BackHandler (celui du parcours)', () => {
  assert.ok(addIndex !== -1, 'le parcours enregistre un listener de retour Android');
  assert.equal(
    CONNECT.split(ADD).length - 1,
    1,
    'un seul BackHandler dans ConnectScreen (celui du parcours Learn)',
  );
});

check('2. le listener n est enregistre QUE quand le parcours est OUVERT', () => {
  // Garde en amont de l'enregistrement : rien n'est pose si le parcours est ferme.
  assert.ok(
    LEARN_BACK.includes('if (!(onboarding.ready && onboarding.show)) return;'),
    'enregistrement conditionne a l ouverture du parcours',
  );
  const guard = LEARN_BACK.indexOf('onboarding.ready && onboarding.show');
  const register = LEARN_BACK.indexOf(ADD);
  assert.ok(guard !== -1 && register !== -1 && guard < register, 'la garde precede l enregistrement');
});

check('3. le listener est DESENREGISTRE (retour de la fonction de nettoyage)', () => {
  assert.ok(LEARN_BACK.includes('return () => subscription.remove();'), 'desenregistrement au demontage/fermeture');
  // Les dependances incluent `show` : un changement de visibilite re-evalue
  // l'enregistrement (abonnement quand ouvert, desabonnement quand ferme).
  assert.ok(
    LEARN_BACK.includes('}, [onboarding.ready, onboarding.show, onboarding.close]);'),
    'show/ready pilote l abonnement',
  );
});

// --- (b) le retour referme le parcours --------------------------------------

check('4. le retour REFERME le parcours et consomme l evenement', () => {
  assert.ok(LEARN_BACK.includes('onboarding.close();'), 'le retour ferme le parcours');
  assert.ok(/onboarding\.close\(\);[\s\S]{0,80}?return true;/.test(LEARN_BACK), 'l evenement est consomme (return true)');
});

// --- (d) retour a l ecran d origine (Account si ouvert d Account) -----------

check('5. fermer le parcours re-rend l ecran d origine sans navigation', () => {
  // `close` pose uniquement `show` a false : ConnectScreen re-rend la vue
  // precedente, avec l'onglet Account toujours selectionne s'il l'etait.
  assert.ok(
    HOOK.includes('const close = useCallback(() => setShow(false), []);'),
    'close = simple bascule d etat, aucune navigation',
  );
  // Le parcours est rendu par ConnectScreen (rendu anticipe), pas par un routeur.
  assert.ok(CONNECT.includes('if (onboarding.ready && onboarding.show)'), 'parcours rendu par ConnectScreen');
  assert.ok(CONNECT.includes('<OnboardingScreen'), 'ecran du parcours monte ici');
  // Aucune pile de navigation ajoutee pour ce parcours.
  assert.ok(!/navigation\.navigate|useNavigation|createNativeStackNavigator/.test(CONNECT),
    'aucune navigation ajoutee');
});

check('6. les DEUX points d entree (connexion + Account) ouvrent le meme parcours', () => {
  // Ouvrir depuis Account comme depuis l'ecran de connexion : meme `open`,
  // aucun parametre d'origine -> le retour rend l'ecran ou l'on etait.
  assert.equal(CONNECT.split('onPress={onboarding.open}').length - 1, 2, 'deux surfaces Learn, un seul open');
  assert.ok(!CONNECT.includes('onboarding.open('), 'open sans argument (aucune origine codee en dur)');
  // L'entree Account existe bien dans la branche Account.
  assert.ok(CONNECT.includes("accessibilityLabel=\"Learn how multisig works\""), 'surface Learn presente');
});

// --- (c) retour post-creation inchange --------------------------------------

check('7. le retour « post-creation -> inbox » existant reste INTACT', () => {
  const index = CREATE.indexOf(ADD);
  assert.ok(index !== -1, 'CreateVaultScreen garde son BackHandler');
  const window = CREATE.slice(index, index + 500);
  assert.ok(window.includes('createdAndVerified'), 'branche post-creation presente');
  assert.ok(window.includes('onGoToInbox()'), 'retour Android -> inbox conserve');
  assert.ok(window.includes('return true;'), 'evenement consomme');
});

// --- enregistrement dans la suite -------------------------------------------

check('8. la suite est enregistree dans npm test', () => {
  assert.ok(RUNNER.includes('scripts/learn-back.test.ts'), 'suite du retour Learn dans le runner');
});

console.log(`\n${passed} test(s) OK`);
if (process.exitCode === 1) process.exit(1);
