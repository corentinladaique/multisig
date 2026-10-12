import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as ts from 'typescript';

import { isTemporaryNetworkFailure } from '../src/wallet/operationState';

/**
 * Step 5 · hors ligne : deux bugs utilisateur corriges sans reseau.
 *
 *  1. Taper le CTA de creation hors ligne ne doit JAMAIS laisser un bouton mort
 *     sans explication : un retour humain reste visible a cote du CTA, et le
 *     CTA reste actionnable (reessai possible).
 *  2. « Troubleshooting details » ne doit plus etre un mur d'erreurs Java
 *     brutes repetees : resume humain court + detail condense (dedoublonne,
 *     reseau factorise, plafonne), le brut INTEGRAL restant consultable.
 *
 * Le digest est la FONCTION REELLE du fichier (extraction + transpilation),
 * pas une copie : le test prouve le comportement, aucun wallet, aucun reseau.
 * npx tsx scripts/create-vault-offline-feedback.test.ts
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

const CREATE = readFileSync('src/screens/CreateVaultScreen.tsx', 'utf8');

/** Extrait les helpers purs du fichier et les rend executables. */
const DIGEST_START = CREATE.indexOf('const TROUBLESHOOTING_MAX_LINES = 6;');
const DIGEST_END = CREATE.indexOf('/**\n * Création ANNULÉE');
const digestSource = CREATE.slice(DIGEST_START, DIGEST_END);
const transpiled = ts.transpileModule(digestSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const digestModule = new Function(
  `${transpiled}\nreturn { condenseTroubleshootingDetails, countNetworkFailures, TROUBLESHOOTING_MAX_LINES };`,
)() as {
  condenseTroubleshootingDetails: (messages: string[]) => {
    summary: string;
    lines: string[];
    hiddenCount: number;
  };
  countNetworkFailures: (text: string) => number;
  TROUBLESHOOTING_MAX_LINES: number;
};

// La forme EXACTE remontee par le preflight hors ligne : l'hote injoignable est
// repete une fois par compte interroge (ici trois).
const OFFLINE_WALL = [
  'Preflight failed: ProgramConfigUnavailable: failed to get info about account B5Tq1a7Kv9QwErTyUiOpAsDfGhJkLzXcVbNmQwErTyU Error: fetch failed: java.net.UnknownHostException: Unable to resolve host "api.devnet.solana.com": No address associated with hostname',
  'Preflight failed: ProgramConfigUnavailable: failed to get info about account C7x2b8Lw0RxFsYuIoPaSdGhJkLzXcVbNmQwErTyUi Error: fetch failed: java.net.UnknownHostException: Unable to resolve host "api.devnet.solana.com": No address associated with hostname',
  'Preflight failed: ProgramConfigUnavailable: failed to get info about account D9z3c9Mx1SyGtZvJpQbReHkLmNzXcVbNmQwErTyUi Error: fetch failed: java.net.UnknownHostException: Unable to resolve host "api.devnet.solana.com": No address associated with hostname',
].join(' ');

check('1. le digest est la fonction reelle du fichier', () => {
  assert.ok(DIGEST_START > -1 && DIGEST_END > DIGEST_START, 'helpers presents et isolables');
  assert.equal(typeof digestModule.condenseTroubleshootingDetails, 'function');
  assert.equal(digestModule.TROUBLESHOOTING_MAX_LINES, 6, 'plafond de lignes');
});

check('2. hors ligne : resume humain (nature + etape), jamais un pave brut', () => {
  const digest = digestModule.condenseTroubleshootingDetails([OFFLINE_WALL]);
  assert.ok(digest.summary.includes('Vault preparation failed'), 'nature de l echec');
  assert.ok(digest.summary.includes('network was unreachable'), 'reseau injoignable nomme');
  assert.ok(digest.summary.includes('Preparation'), 'etape nommee');
  assert.ok(!/java\.net\.|Exception/.test(digest.summary), 'aucune exception Java dans le resume');
});

check('3. hote injoignable mentionne UNE seule fois, avec le nombre de comptes', () => {
  const digest = digestModule.condenseTroubleshootingDetails([OFFLINE_WALL]);
  const joined = digest.lines.join(' ');
  const hostCount = (joined.match(/api\.devnet\.solana\.com/g) ?? []).length;
  assert.equal(hostCount, 1, 'hote injoignable mentionne une seule fois (etait 3)');
  const exceptionCount = (joined.match(/UnknownHostException/g) ?? []).length;
  assert.equal(exceptionCount, 1, 'exception reseau mentionnee une seule fois (etait 3)');
  assert.ok(/3 requests failed/.test(joined), 'nombre de requetes/comptes concernes');
  // L'hote injoignable n'est plus repete plusieurs fois de suite.
  assert.ok(!/UnknownHostException[\s\S]*UnknownHostException/.test(joined));
});

check('4. le detail technique reste consultable (prefixe conserve + plafond annonce)', () => {
  const digest = digestModule.condenseTroubleshootingDetails([OFFLINE_WALL]);
  assert.ok(
    digest.lines.some((line) => line.includes('ProgramConfigUnavailable')),
    'la nature de l echec (prefixe) est conservee',
  );
  assert.ok(digest.hiddenCount === 0, 'rien masque ici');
});

check('5. repetitions exactes dedoublonnees (×N), pas supprimees', () => {
  const digest = digestModule.condenseTroubleshootingDetails([
    'BalanceReadFailed: request failed',
    'BalanceReadFailed: request failed',
  ]);
  const multiline = digest.lines.find((line) => line.includes('(×2)'));
  assert.ok(multiline !== undefined, 'ligne identique factorisee avec son compte');
  assert.ok(multiline.includes('BalanceReadFailed'), 'information conservee');
});

check('6. affichage plafonne : au dela, le reste est annonce (jamais perdu)', () => {
  const many = Array.from({ length: 10 }, (_entry, index) => `Error ${index}: something failed`);
  const digest = digestModule.condenseTroubleshootingDetails(many);
  assert.equal(digest.lines.length, digestModule.TROUBLESHOOTING_MAX_LINES, 'plafond respecte');
  assert.equal(digest.hiddenCount, 10 - digestModule.TROUBLESHOOTING_MAX_LINES, 'reste annonce');
});

check('7. l ecran rend le digest, pas le mur brut', () => {
  assert.ok(CREATE.includes('condenseTroubleshootingDetails(technicalErrors)'), 'digest calcule');
  assert.ok(CREATE.includes('troubleshootingDigest.summary'), 'resume rendu');
  assert.ok(CREATE.includes('troubleshootingDigest.lines.map'), 'lignes condensees rendues');
  assert.ok(CREATE.includes('troubleshootingDigest.hiddenCount > 0'), 'reste annonce');
});

check('8. second repli « Show raw details » : brut INTEGRAL consultable, ferme par defaut', () => {
  assert.ok(CREATE.includes("'Show raw details'"), 'repli present');
  assert.ok(CREATE.includes("const [rawDetailsOpen, setRawDetailsOpen] = useState(false);"), 'ferme par defaut');
  const troubleshooting = CREATE.slice(CREATE.indexOf('{/* TROUBLESHOOTING DETAILS'));
  assert.ok(troubleshooting.includes('technicalErrors.map'), 'le brut integral reste rendu (repli)');
});

check('9. hors ligne : un retour humain existe a cote du CTA (jamais un bouton mort)', () => {
  assert.ok(isTemporaryNetworkFailure(OFFLINE_WALL), 'le texte hors ligne est bien classe reseau');
  const panel = CREATE.slice(
    CREATE.indexOf('{preparationFailed ? ('),
    CREATE.indexOf('{/* ETAT 2'),
  );
  assert.ok(panel.length > 0, 'panneau de preparation present sur Step 5');
  assert.ok(panel.includes("'You appear to be offline'"), 'raison humaine hors ligne');
  assert.ok(
    panel.includes(
      "'Check your connection and try again. Nothing was signed and nothing was sent.'",
    ),
    'action claire et rassurante',
  );
  assert.ok(panel.includes('{preparationNetworkFailure'), 'message adapte (reseau vs autre)');
  assert.ok(panel.includes('tone="warning"'), 'ton avertissement ambre');
  assert.ok(!panel.includes('tone="error"'), 'jamais rouge');
  assert.ok(!panel.includes('styles.errorBox'), 'jamais une carte rouge');
  assert.ok(!/#[0-9a-fA-F]{3,8}/.test(panel), 'tokens du theme uniquement');
});

check('10. le CTA reste ACTIONNABLE apres l echec : reessai possible', () => {
  // La condition du CTA et le handler de creation sont INCHANGES : canCreate ne
  // prend pas en compte l'erreur de preparation, donc le bouton n'est pas mort.
  assert.ok(CREATE.includes('disabled={!canCreate || creating}'), 'CTA pilote par canCreate');
  assert.ok(
    CREATE.includes(
      'const canCreate =\n    walletAddress !== null &&\n    plan.readyForInstructionBuild &&\n    (createResult === null || attemptOutcome?.allowNewAttempt === true) &&\n    !creating;',
    ),
    'canCreate inchange (aucune desactivation liee a l erreur)',
  );
  assert.equal(CREATE.split('onPress={onCreateOnDevnet}').length - 1, 1, 'un seul flux de reessai');
  // Le panneau de preparation est conditionne a l absence de resultat signe :
  // des qu'une tentative signee existe, ETAT B/C/D prennent le relais.
  assert.ok(
    CREATE.includes(
      'const preparationFailed =\n    createError !== null && createResult === null && !creating && !createdAndVerified;',
    ),
    'condition de preparation claire',
  );
});

console.log(`\n${passed} test(s) OK`);
