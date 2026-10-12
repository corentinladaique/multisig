import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Tests FOCALISES du TEXTE CONDITIONNEL de la carte de chargement de l'onglet
 * Vault (version B décidée par l'utilisateur). Tests PURS (lecture des sources) :
 * aucun RPC, aucun wallet, aucune transaction, aucun stockage.
 *
 * Deux arrivées distinctes sur le MÊME écran (vue sans vault) :
 *  - OUVERTURE DE L'APP : l'app recharge silencieusement le dernier vault
 *    (auto-chargement) -> « Loading your multisig… / Getting your most recent
 *    vault. » est EXACT.
 *  - ARRIVÉE VOLONTAIRE POUR CHOISIR (après « Switch multisig ») : rien ne se
 *    charge, l'utilisateur vient choisir -> « Open a multisig / Pick one from
 *    your saved vaults, or paste an address. ».
 *
 * Le chargement lui-même est INCHANGÉ : seul le texte affiché dépend du drapeau
 * LOCAL `choosingVault`, armé uniquement par le « chemin de sélection ».
 *
 * Exécution : npx tsx scripts/vault-loading-conditional.test.ts
 */

const CONNECT = readFileSync('src/screens/ConnectScreen.tsx', 'utf8');
const RUNNER = readFileSync('scripts/run-pure-tests.sh', 'utf8');

/** Balise JSX EXACTE de la marque (identique aux deux emplacements). */
const MARK_TAG = '<CardsMark loop size={132} style={styles.brandMark} tile />';

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

// --- Les DEUX copies existent, à l'identique (ponctuation comprise) -----------

check('1. les deux copies coexistent (chargement automatique ET choix)', () => {
  assert.ok(CONNECT.includes("'Loading your multisig…'"), 'titre auto-chargement présent');
  assert.ok(
    CONNECT.includes("'Getting your most recent vault.'"),
    'sous-titre auto-chargement présent',
  );
  assert.ok(CONNECT.includes("'Open a multisig'"), 'titre choix présent');
  assert.ok(
    CONNECT.includes("'Pick one from your saved vaults, or paste an address.'"),
    'sous-titre choix présent',
  );
  // L'état « registre » reste inchangé et DISTINCT.
  assert.ok(CONNECT.includes("'Loading saved multisigs…'"), 'titre registre intact');
  assert.ok(CONNECT.includes("'Reading the local registry.'"), 'sous-titre registre intact');
});

// --- Bascule RÉELLE du texte sur le drapeau local ----------------------------

check('2. le titre bascule sur choosingVault (choix) sinon auto-chargement', () => {
  const titleBranch =
    /vaultBodyState === 'loading-registry'\s*\?\s*'Loading saved multisigs…'\s*:\s*choosingVault\s*\?\s*'Open a multisig'\s*:\s*'Loading your multisig…'/;
  assert.ok(
    titleBranch.test(CONNECT),
    'le titre de la carte de chargement dépend de choosingVault',
  );
});

check('3. le sous-titre bascule sur choosingVault (choix) sinon auto-chargement', () => {
  const subBranch =
    /vaultBodyState === 'loading-registry'\s*\?\s*'Reading the local registry\.'\s*:\s*choosingVault\s*\?\s*'Pick one from your saved vaults, or paste an address\.'\s*:\s*'Getting your most recent vault\.'/;
  assert.ok(
    subBranch.test(CONNECT),
    'le sous-titre de la carte de chargement dépend de choosingVault',
  );
});

check('4. le texte du registre reste NON conditionné par choosingVault', () => {
  assert.ok(
    /vaultBodyState === 'loading-registry'\s*\?\s*'Loading saved multisigs…'/.test(CONNECT),
    'branche registre inchangée (titre)',
  );
  assert.ok(
    /vaultBodyState === 'loading-registry'\s*\?\s*'Reading the local registry\.'/.test(CONNECT),
    'branche registre inchangée (sous-titre)',
  );
});

// --- Le drapeau local est armé UNIQUEMENT par le chemin de sélection ---------

check('5. un drapeau local minimal existe', () => {
  assert.ok(
    CONNECT.includes('const [choosingVault, setChoosingVault] = useState(false)'),
    'drapeau local choosingVault (faux par défaut)',
  );
});

check('6. « Switch multisig » arme le drapeau via openVaultPicker', () => {
  const helperAt = CONNECT.indexOf('const openVaultPicker = useCallback(() => {');
  assert.ok(helperAt !== -1, 'le handler openVaultPicker existe');
  const helper = CONNECT.slice(helperAt, helperAt + 220);
  assert.ok(helper.includes('setChoosingVault(true)'), 'openVaultPicker arme choosingVault');
  assert.ok(helper.includes('setVaultPickerOpen(true)'), 'openVaultPicker ouvre le sélecteur');

  const switchAt = CONNECT.indexOf('label="Switch multisig"');
  assert.ok(switchAt !== -1, 'le bouton « Switch multisig » existe');
  const switchBlock = CONNECT.slice(switchAt, switchAt + 220);
  assert.ok(
    switchBlock.includes('onPress={openVaultPicker}'),
    '« Switch multisig » est branché sur le chemin de sélection',
  );
});

check('7. le drapeau n\'est armé par AUCUN autre chemin (auto-chargement inchangé)', () => {
  // Une seule arme dans tout le fichier : openVaultPicker, donc le chemin de
  // sélection. L'auto-chargement du lancement ne touche jamais ce drapeau.
  assert.equal(
    CONNECT.split('setChoosingVault(true)').length - 1,
    1,
    'choosingVault est armé une seule fois (chemin de sélection)',
  );
  const autoLoadAt = CONNECT.indexOf('Auto-chargement, AU LANCEMENT UNIQUEMENT');
  assert.ok(autoLoadAt !== -1, 'le bloc d\'auto-chargement existe');
  const autoLoadEnd = CONNECT.indexOf('}, [', autoLoadAt);
  assert.ok(autoLoadEnd > autoLoadAt, 'borne du bloc d\'auto-chargement trouvée');
  assert.ok(
    !CONNECT.slice(autoLoadAt, autoLoadEnd).includes('ChoosingVault'),
    'l\'auto-chargement ne touche pas choosingVault',
  );
});

// --- Rien d'autre n'a bougé --------------------------------------------------

check('8. la marque CardsMark garde des props STRICTEMENT identiques', () => {
  assert.equal(
    CONNECT.split(MARK_TAG).length - 1,
    2,
    'mêmes props aux deux emplacements (connexion + chargement)',
  );
});

check('9. aucun bloc adresse / bouton / navigation ajouté ou retiré', () => {
  assert.equal(CONNECT.split('<AddressInput').length - 1, 1, 'un seul champ adresse');
  assert.ok(
    CONNECT.includes('{addMultisigOpen || choosingVault ? multisigLoaderBlock : null}'),
    'bloc de chargement manuel rendu par « Add existing multisig » OU le chemin de choix',
  );
  assert.ok(CONNECT.includes('label="Multisig address"'), 'bloc adresse présent');
});

// --- Nouveau comportement : le bloc suit le CHEMIN DE CHOIX ------------------

check('9b. sans vault, l’état « choix » rend le bloc (champ + Load multisig)', () => {
  // La garde du bloc DANS la carte d'état vide inclut désormais `choosingVault`
  // (en plus de `addMultisigOpen`) : « Switch multisig »/le sélecteur d'en-tête
  // arme choosingVault, donc le champ d'adresse + « Load multisig » sont rendus
  // — la copie « or paste an address » n'est plus un mensonge.
  assert.ok(
    CONNECT.includes('{addMultisigOpen || choosingVault ? multisigLoaderBlock : null}'),
    'la garde du bloc inclut choosingVault',
  );
  const blockAt = CONNECT.indexOf('const multisigLoaderBlock = (');
  assert.ok(blockAt !== -1, 'la définition du bloc existe');
  const block = CONNECT.slice(blockAt, blockAt + 2700);
  assert.ok(block.includes('label="Multisig address"'), 'champ adresse dans le bloc');
  assert.ok(block.includes('label="Load multisig"'), 'bouton « Load multisig » dans le bloc');
});

check('9c. « Disconnect this vault » n’apparaît PAS dans l’état sans vault', () => {
  // Dans le bloc, ce controle est garde par `view !== null` : la carte d'etat
  // vide (view === null) ne le monte donc jamais.
  const labelAt = CONNECT.indexOf('accessibilityLabel="Disconnect this vault"');
  assert.ok(labelAt !== -1, 'le controle « Disconnect this vault » existe dans le bloc');
  const before = CONNECT.slice(Math.max(0, labelAt - 500), labelAt);
  assert.ok(before.includes('view !== null ?'), '« Disconnect » gardé par view !== null');
});

check('9d. l’auto-chargement au démarrage ne rend PAS le bloc', () => {
  // Au lancement, addMultisigOpen et choosingVault valent tous deux false
  // (defauts) : la garde `addMultisigOpen || choosingVault` est donc fausse,
  // le bloc n'est pas monte. Seul le chemin de selection arme choosingVault.
  assert.ok(
    CONNECT.includes('const [addMultisigOpen, setAddMultisigOpen] = useState(false)'),
    'addMultisigOpen faux par defaut',
  );
  assert.ok(
    CONNECT.includes('const [choosingVault, setChoosingVault] = useState(false)'),
    'choosingVault faux par defaut',
  );
  assert.equal(
    CONNECT.split('setChoosingVault(true)').length - 1,
    1,
    'choosingVault armé une seule fois (chemin de sélection)',
  );
});

check('10. la suite est enregistrée dans npm test', () => {
  assert.ok(
    RUNNER.includes('scripts/vault-loading-conditional.test.ts'),
    'suite conditionnelle dans le runner',
  );
});

console.log(`\n${passed} test(s) OK`);
if (process.exitCode === 1) process.exit(1);
