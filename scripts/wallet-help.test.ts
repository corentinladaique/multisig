import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Tests FOCALISES de l'aide « Wallet help » de l'ecran de connexion du wallet.
 *
 * Tests PURS (lecture des sources) : aucun RPC, aucun wallet, aucune signature,
 * aucune transaction. Ils figent :
 *   (a) le libelle « Open wallet help » present sur la BRANCHE NON CONNECTEE ;
 *   (b) le titre EXACT « Wallet help » et l'item EXACT « A wallet won't open? »
 *       avec la consigne Android ;
 *   (c) l'ABSENCE des deux autres depannages (un seul item) ;
 *   (d) l'absence de couleur codee en dur dans le nouveau code ;
 *   (e) le ghost pill SANS bordure ni fond vif.
 * Execution : npx tsx scripts/wallet-help.test.ts
 */

const CONNECT = readFileSync('src/screens/ConnectScreen.tsx', 'utf8');
const SHEET = readFileSync('src/ui/v2/WalletHelpSheet.tsx', 'utf8');
const PKG = readFileSync('package.json', 'utf8');
const RUNNER = readFileSync('scripts/run-pure-tests.sh', 'utf8');

const ANDROID_STEP = 'Settings → Apps → [your wallet] → Open by default → Clear defaults';
const ITEM_BODY =
  "If you tapped \u201cAlways\u201d in Android's \u201cOpen with\u201d dialog, one wallet may be blocking the others.";

/** Bloc de style d'une cle donnee du StyleSheet (corps entre accolades). */
function styleBlock(source: string, key: string): string | null {
  const match = new RegExp(`${key}:\\s*\\{[^}]*\\}`, 's').exec(source);
  return match === null ? null : match[0];
}

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

// --- (a) Libellé présent sur la BRANCHE NON CONNECTÉE -------------------------

check('a. « Open wallet help » present sur la branche non connectee', () => {
  assert.ok(SHEET.length > 0, 'la feuille d aide existe');
  assert.ok(CONNECT.includes('accessibilityLabel="Open wallet help"'), 'etiquette presente');
  assert.ok(
    CONNECT.includes('<Text style={styles.walletHelpPillText}>Open wallet help</Text>'),
    'libelle EXACT « Open wallet help »',
  );
  // La pilule vit DANS le bloc `account === undefined ? (` de l'ecran de
  // connexion : entre cette porte et la suivante (bloc « Learn »).
  const firstGate = CONNECT.indexOf('{account === undefined ? (');
  const secondGate = CONNECT.indexOf('{account === undefined ? (', firstGate + 1);
  const pillAt = CONNECT.indexOf('Open wallet help');
  assert.ok(firstGate !== -1 && secondGate !== -1, 'les portes non connectees existent');
  assert.ok(
    pillAt > firstGate && pillAt < secondGate,
    'la pilule est bien sur la branche wallet NON connecte',
  );
  // Le tap ouvre la feuille, rendue sous la meme garde non connectee.
  assert.ok(CONNECT.includes('onPress={() => setWalletHelpOpen(true)}'), 'le tap ouvre la feuille');
  assert.ok(
    /account === undefined \?\s*\(\s*<WalletHelpSheet onClose=\{\(\) => setWalletHelpOpen\(false\)\} visible=\{walletHelpOpen\} \/>/s.test(
      CONNECT,
    ),
    'la feuille est montee sous la garde non connectee',
  );
});

// --- (b) Titre et item EXACTS avec la consigne Android ------------------------

check('b1. titre EXACT « Wallet help » + intro discrète', () => {
  assert.ok(SHEET.includes('<Text style={styles.title}>Wallet help</Text>'), 'titre exact');
  assert.ok(
    SHEET.includes('<Text style={styles.subtitle}>Quick fixes when the wallet does not open.</Text>'),
    'intro exacte',
  );
});

check('b2. item EXACT « A wallet won\'t open? » + consigne Android', () => {
  assert.ok(
    SHEET.includes('<Text style={styles.itemTitle}>A wallet won\'t open?</Text>'),
    'titre de l item exact',
  );
  assert.ok(SHEET.includes(ITEM_BODY), 'corps de l item exact');
  assert.ok(SHEET.includes(ANDROID_STEP), 'consigne Android exacte');
  // La consigne est mise en evidence (encart dedie + texte mint).
  assert.ok(styleBlock(SHEET, 'instructionBox') !== null, 'la consigne a son encart');
  const instructionText = styleBlock(SHEET, 'instructionText');
  assert.ok(instructionText !== null && instructionText.includes('colors.mint'), 'consigne en mint');
});

// --- (c) ABSENCE des deux autres dépannages (UN SEUL item) --------------------

check('c. un SEUL depannage : les deux items retires sont absents', () => {
  const items = SHEET.split('styles.item}').length - 1;
  assert.equal(items, 1, 'un seul item de depannage');
  assert.equal(
    SHEET.split('styles.itemTitle}').length - 1,
    1,
    'un seul titre d item (aucun autre depannage)',
  );
  // Une seule question dans toute la feuille : le titre d'item.
  assert.equal((SHEET.match(/\?/g) ?? []).length, 1, 'une seule question (un seul depannage)');
});

// --- (d) Aucune couleur codée en dur dans le nouveau code ---------------------

check('d. aucune couleur codee en dur dans le nouveau code', () => {
  assert.ok(!SHEET.includes('#'), 'la feuille ne contient aucune couleur hex codee en dur');
  // Region JSX du ghost pill (du libelle au commentaire Devnet qui suit).
  const jsxStart = CONNECT.indexOf('Open wallet help');
  const jsxEnd = CONNECT.indexOf('Note Devnet', jsxStart);
  assert.ok(jsxStart !== -1 && jsxEnd !== -1, 'region JSX localisee');
  const jsxRegion = CONNECT.slice(jsxStart, jsxEnd);
  assert.ok(!jsxRegion.includes('#'), 'le JSX du ghost pill ne code aucune couleur en dur');
  // Region de styles ajoutee, en fin de StyleSheet (de walletHelpRow a la fin).
  const stylesAt = CONNECT.lastIndexOf('walletHelpRow:');
  assert.ok(stylesAt !== -1, 'les styles du ghost pill existent');
  const stylesRegion = CONNECT.slice(stylesAt);
  assert.ok(!stylesRegion.includes('#'), 'les styles du ghost pill ne codent aucune couleur en dur');
});

// --- (e) Ghost pill : ni bordure ni fond vif ---------------------------------

check('e. ghost pill SANS bordure ni fond vif', () => {
  const pill = styleBlock(CONNECT, 'walletHelpPill');
  assert.ok(pill !== null, 'le style walletHelpPill existe');
  assert.ok(!/border(Color|Width|Style|Top|Bottom|Left|Right)/.test(pill), 'AUCUNE bordure sur la pilule');
  assert.ok(
    pill.includes('backgroundColor: colors.surfaceElevated'),
    'fond doux = token surfaceElevated',
  );
  assert.ok(!/colors\.(text|mint|background|success|warning|error)/.test(pill), 'aucun fond vif');
  assert.ok(pill.includes('borderRadius: radii.pill'), 'rayon pilule du theme');
  const text = styleBlock(CONNECT, 'walletHelpPillText');
  assert.ok(text !== null && text.includes('color: colors.mint'), 'texte en mint (token)');
});

// --- Aucune dépendance interdite (grep de garde) ------------------------------

check('f. aucune dependance interdite ajoutee', () => {
  for (const dep of [
    'react-native-svg',
    'lottie',
    'reanimated',
    'expo-linear-gradient',
    'moti',
    'skia',
    'qrcode',
  ]) {
    assert.ok(!PKG.includes(dep), `package.json ne contient pas ${dep}`);
  }
  const forbiddenInSheet =
    /@expo\/vector-icons|react-native-svg|lottie|reanimated|expo-linear-gradient|moti|skia|qrcode/;
  assert.ok(!forbiddenInSheet.test(SHEET), 'la feuille importe uniquement des primitives natives');
  const jsxStart = CONNECT.indexOf('Open wallet help');
  const jsxEnd = CONNECT.indexOf('Note Devnet', jsxStart);
  assert.ok(
    !/Ionicons|MaterialCommunityIcons/.test(CONNECT.slice(jsxStart, jsxEnd)),
    'le ghost pill n utilise aucune icone de package',
  );
});

// --- Enregistrement dans la suite npm test -----------------------------------

check('g. la suite est enregistree dans npm test', () => {
  assert.ok(RUNNER.includes('scripts/wallet-help.test.ts'), 'suite dans le runner');
  assert.ok(!RUNNER.includes('scripts/wallet-help.check.ts'), 'aucun script reseau enregistre');
});

console.log(`\n${passed} test(s) OK`);
if (process.exitCode === 1) process.exit(1);
