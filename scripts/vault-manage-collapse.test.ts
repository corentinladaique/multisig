import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Tests FOCALISES du repli du bloc « Multisig address » sur l'ecran Vault
 * lorsqu'un vault est CHARGE (option A decidee par l'utilisateur).
 *
 * Contexte : le controle repliable « More » ayant ete supprime, le bloc
 * « Multisig address » (champ + Paste + Load + note de securite) etait rendu en
 * PERMANENCE, si bien que « Add existing multisig » de la feuille « My multisigs »
 * ne produisait plus aucun effet visible. Option A :
 *  - le bloc est REPLIE PAR DEFAUT quand un vault est charge ;
 *  - un bouton « Add existing multisig » a cote de « Switch multisig » le
 *    deplie/replie via le mecanisme UNIQUE `addMultisigOpen` ;
 *  - « Switch multisig » est INCHANGE (ouvre la feuille « My multisigs ») ;
 *  - « Disconnect this vault » (rouge) reste TOUJOURS visible, HORS du repli ;
 *  - le bouton « Add existing multisig » de la feuille deplie enfin le bloc.
 *
 * Tests PURS (lecture des sources) : aucun RPC, aucun wallet, aucune
 * transaction, aucun stockage, aucun rendu.
 *
 * Execution : npx tsx scripts/vault-manage-collapse.test.ts
 */

const CONNECT = readFileSync('src/screens/ConnectScreen.tsx', 'utf8');
const SHEET = readFileSync('src/ui/v2/VaultPickerSheet.tsx', 'utf8');
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

// Slice du bloc de gestion du vault charge : de « label="Switch multisig" » a la
// fin de son `<View style={styles.manageBody}>` (premiere fermeture suivante).
const switchAt = CONNECT.indexOf('label="Switch multisig"');
const manageEnd = CONNECT.indexOf('</View>', CONNECT.indexOf('{multisigDisconnectBlock}', switchAt));
const manage =
  switchAt >= 0 && manageEnd > switchAt ? CONNECT.slice(switchAt, manageEnd) : '';

// --- (a) REPLIE PAR DEFAUT ---------------------------------------------------

check('a. le bloc « Multisig address » n est PAS rendu quand le champ est replie', () => {
  // Etat de repli faux par defaut...
  assert.ok(
    CONNECT.includes('const [addMultisigOpen, setAddMultisigOpen] = useState(false)'),
    'addMultisigOpen faux par defaut',
  );
  // ...et AUCUN rendu inconditionnel du bloc (il n'est jamais permanent).
  assert.ok(
    !CONNECT.includes('{multisigLoaderBlock}'),
    'plus de rendu inconditionnel (permanent) du bloc',
  );
  // Le bloc de gestion ne rend le chargeur que derriere `addMultisigOpen`.
  assert.ok(
    manage.includes('{addMultisigOpen ? multisigLoaderBlock : null}'),
    'le bloc de gestion conditionne le chargeur a addMultisigOpen',
  );
});

// --- (b) RENDU QUAND addMultisigOpen EST VRAI ---------------------------------

check('b. le bloc est rendu quand addMultisigOpen est vrai', () => {
  assert.ok(
    CONNECT.includes('{addMultisigOpen ? multisigLoaderBlock : null}'),
    'rendu conditionnel du bloc par addMultisigOpen',
  );
  // Le bloc contient bien le champ « Multisig address » et « Load multisig ».
  const blockAt = CONNECT.indexOf('const multisigLoaderBlock = (');
  assert.ok(blockAt >= 0, 'definition du bloc presente');
  const blockEnd = CONNECT.indexOf('const multisigDisconnectBlock', blockAt);
  assert.ok(blockEnd > blockAt, 'borne du bloc trouvee');
  const block = CONNECT.slice(blockAt, blockEnd);
  assert.ok(block.includes('label="Multisig address"'), 'champ adresse dans le bloc');
  assert.ok(block.includes('label="Load multisig"'), 'bouton « Load multisig » dans le bloc');
  assert.ok(block.includes('label="Load"'), 'bouton « Load » (mode large) dans le bloc');
});

// --- (c) LE BOUTON DE L'ECRAN PILOTE LE REPLI ---------------------------------

check('c. « Add existing multisig » de l ecran pilote le repli (toggle)', () => {
  assert.ok(switchAt >= 0, 'le bloc de gestion « Switch multisig » existe');
  // Le bouton est DANS le meme bloc de gestion, a cote de « Switch multisig ».
  assert.ok(
    manage.includes('label="Add existing multisig"'),
    'bouton « Add existing multisig » dans le bloc de gestion',
  );
  assert.ok(
    manage.includes('accessibilityLabel="Add existing multisig"'),
    'repere d accessibilite du bouton ecran',
  );
  // Il bascule le mecanisme UNIQUE `addMultisigOpen`.
  assert.ok(
    /onPress=\{\(\) => setAddMultisigOpen\(\(previous\) => !previous\)\}/.test(manage),
    'le bouton ecran bascule addMultisigOpen',
  );
});

// --- (d) « Disconnect this vault » HORS DU REPLI ------------------------------

check('d. « Disconnect this vault » est rendu INDEPENDAMMENT du repli', () => {
  // La definition du bloc Disconnect n'est gardee QUE par `view !== null` :
  // jamais par `addMultisigOpen`.
  const defAt = CONNECT.indexOf('const multisigDisconnectBlock');
  assert.ok(defAt >= 0, 'definition du bloc Disconnect presente');
  const def = CONNECT.slice(defAt, defAt + 420);
  assert.ok(def.includes('view !== null ?'), 'Disconnect garde par view !== null');
  assert.ok(!def.includes('addMultisigOpen'), 'Disconnect JAMAIS garde par le repli');
  // Le rendu de Disconnect est une expression SŒUR du bloc repliable, juste
  // APRES lui : il n'est donc pas a l'interieur de la condition addMultisigOpen.
  assert.ok(
    /addMultisigOpen \? multisigLoaderBlock : null\}\s*\{multisigDisconnectBlock\}/.test(CONNECT),
    'Disconnect rendu hors du repli, independant de addMultisigOpen',
  );
});

// --- (e) LE BOUTON DE LA FEUILLE DEPLIE ENFIN LE BLOC ------------------------

check('e. « Add existing multisig » de la feuille deplie le bloc', () => {
  // La feuille porte un handler type (jamais `undefined`).
  assert.ok(SHEET.includes('onAddExisting: () => void;'), 'prop onAddExisting typee');
  assert.ok(SHEET.includes('onPress={onAddExisting}'), 'bouton feuille -> onAddExisting');
  // Le parent ferme la feuille ET deplie le bloc (setAddMultisigOpen(true)).
  const start = CONNECT.indexOf('const onAddExistingFromPicker = useCallback');
  assert.ok(start >= 0, 'handler onAddExistingFromPicker present');
  const end = CONNECT.indexOf('}, []);', start);
  const handler = CONNECT.slice(start, end);
  assert.ok(handler.includes('setVaultPickerOpen(false)'), 'la feuille se ferme');
  assert.ok(handler.includes('setAddMultisigOpen(true)'), 'le bloc se deplie');
  // Le cablage feuille -> ecran est bien en place.
  assert.ok(CONNECT.includes('onAddExisting={onAddExistingFromPicker}'), 'cablage feuille -> ecran');
});

// --- (f) « Switch multisig » INCHANGE ----------------------------------------

check('f. « Switch multisig » reste inchange (ouvre la feuille « My multisigs »)', () => {
  assert.ok(manage.includes('label="Switch multisig"'), 'libelle inchange');
  assert.ok(manage.includes('onPress={openVaultPicker}'), 'ouvre toujours le selecteur');
  const helperAt = CONNECT.indexOf('const openVaultPicker = useCallback');
  const helper = CONNECT.slice(helperAt, helperAt + 220);
  assert.ok(helper.includes('setVaultPickerOpen(true)'), 'le selecteur de vault est ouvre');
});

// --- Enregistrement dans npm test --------------------------------------------

check('g. la suite est enregistree dans scripts/run-pure-tests.sh', () => {
  assert.ok(
    RUNNER.includes('scripts/vault-manage-collapse.test.ts'),
    'suite de repli dans le runner',
  );
});

console.log(`\n${passed} test(s) OK`);
if (process.exitCode === 1) process.exit(1);
