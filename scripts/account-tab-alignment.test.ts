import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { spacing } from '../src/ui/theme';

/**
 * Test PUR d'ALIGNEMENT de l'onglet ACCOUNT.
 *
 * Il FIGE la coherence geometrique : le bord GAUCHE du TEXTE des lignes du BAS
 * d'Account (« Network », « Learn how multisig works », « About »,
 * « X (Twitter) ») doit tomber EXACTEMENT sur celui du texte des cartes de
 * vaults du HAUT (« Test Train »…). Toute regression future de marge/padding
 * sur l'une des deux zones casse ce test.
 *
 * Les valeurs sont LUES dans la source (et non recopiees) : les tokens du theme
 * (`spacing.*`) sont resolus via le module PUR `src/ui/theme`. Aucun RPC, aucun
 * wallet, aucune transaction, aucun stockage. Execution :
 * npx tsx scripts/account-tab-alignment.test.ts
 */

const CONNECT = readFileSync('src/screens/ConnectScreen.tsx', 'utf8');

/** Extrait le CORPS d'un objet de style nomme du StyleSheet.create du fichier. */
function styleBody(name: string): string {
  const re = new RegExp(`\\n  ${name}: \\{([\\s\\S]*?)\\n  \\},`);
  const match = re.exec(CONNECT);
  assert.ok(match !== null, `style « ${name} » introuvable dans ConnectScreen.tsx`);
  return match[1];
}

/** Resout un token de theme (« spacing.md ») ou un nombre litteral (signe gere). */
function value(raw: string): number {
  const trimmed = raw.trim();
  const sign = trimmed.startsWith('-') ? -1 : 1;
  const body = trimmed.replace(/^[-+]/, '');
  const tokenMatch = /^spacing\.(\w+)$/.exec(body);
  if (tokenMatch !== null) {
    const resolved = (spacing as Record<string, number>)[tokenMatch[1]];
    assert.ok(typeof resolved === 'number', `espacement « ${trimmed} » inconnu du theme`);
    return sign * resolved;
  }
  const numeric = Number(body);
  assert.ok(!Number.isNaN(numeric), `valeur de style illisible : « ${trimmed} »`);
  return sign * numeric;
}

/** Lit une propriete de padding/marge d'un corps de style (0 si absente). */
function pad(body: string, prop: string): number {
  const match = new RegExp(`(?:^|[\\s,])${prop}:\\s*([^,\\n]+)`).exec(body);
  if (match === null) return 0;
  return value(match[1]);
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

// --- Valeurs reelles des deux zones -----------------------------------------

const container = styleBody('container');
const vaultCardRow = styleBody('accountMultisigRow'); // cartes/bulles du HAUT
const footerLinks = styleBody('accountFooterLinks'); // lignes du BAS
const archivedHeader = styleBody('accountArchivedHeaderRow');

const containerPad = pad(container, 'padding'); // spacing.lg = 16
const cardTextPad = pad(vaultCardRow, 'paddingHorizontal'); // spacing.md = 12
const footerTextPad = pad(footerLinks, 'paddingHorizontal'); // spacing.md = 12

// Bord gauche du TEXTE, en dp : retrait du conteneur + retrait de la zone.
const topTextLeft = containerPad + cardTextPad;
const bottomTextLeft = containerPad + footerTextPad;

// Taille REELLE du chevron de l'en-tete « Archived (N) », lue dans le JSX.
const chevronMatch = /name=\{accountArchivedOpen \? 'chevron-down' : 'chevron-forward'\}[\s\S]{0,160}?size=\{(\d+)\}/.exec(
  CONNECT,
);
assert.ok(chevronMatch !== null, 'chevron de l en-tete « Archived » introuvable dans le JSX');

check('1. le conteneur d Account pose un retrait horizontal connu (spacing.lg)', () => {
  assert.equal(containerPad, spacing.lg, 'retrait du conteneur = spacing.lg');
  assert.ok(containerPad > 0, 'le conteneur n est pas colle au bord');
});

check('2. les cartes du HAUT ont un retrait propre (spacing.md)', () => {
  assert.equal(cardTextPad, spacing.md, 'accountMultisigRow.paddingHorizontal = spacing.md');
});

check('3. les lignes du BAS ont le MEME retrait propre (spacing.md)', () => {
  assert.equal(footerTextPad, spacing.md, 'accountFooterLinks.paddingHorizontal = spacing.md');
});

check('4. BORD GAUCHE du texte identique entre cartes du haut et lignes du bas (ecart 0)', () => {
  assert.equal(
    topTextLeft,
    bottomTextLeft,
    `haut=${topTextLeft} dp, bas=${bottomTextLeft} dp : le texte doit demarrer au meme x`,
  );
  assert.equal(bottomTextLeft - topTextLeft, 0, 'ecart residuel nul');
  assert.equal(topTextLeft, spacing.lg + spacing.md, 'repere commun = 28 dp');
});

check('5. bord DROIT coherent : meme retrait horizontal des deux cotes', () => {
  // paddingHorizontal couvre gauche ET droite : les deux zones sont donc
  // symetriques, aucun bord droit ne touche ailleurs.
  assert.equal(cardTextPad, footerTextPad, 'retrait droit identique aux deux zones');
});

check('6. le TEXTE de l en-tete « Archived (N) » tombe sur le meme bord gauche', () => {
  const chevronSize = Number(chevronMatch?.[1]);
  const headerGap = pad(archivedHeader, 'gap');
  const headerMarginLeft = pad(archivedHeader, 'marginLeft');
  const headerTextLeft = containerPad + headerMarginLeft + chevronSize + headerGap;
  assert.equal(
    headerTextLeft,
    bottomTextLeft,
    `en-tete=${headerTextLeft} dp, lignes du bas=${bottomTextLeft} dp : meme repere de texte`,
  );
});

check('7. les deux zones sont bien celles RENDUES dans l onglet Account', () => {
  const accountStart = CONNECT.indexOf("{tab === 'account' ? (");
  const accountEnd = CONNECT.indexOf('</>', accountStart);
  assert.ok(accountStart !== -1 && accountEnd > accountStart, 'bloc Account localise');
  const account = CONNECT.slice(accountStart, accountEnd);
  assert.ok(account.includes('styles.accountFooterLinks'), 'les lignes du bas sont dans accountFooterLinks');
  assert.ok(account.includes('styles.accountMultisigRow'), 'les cartes du haut utilisent accountMultisigRow');
  assert.ok(account.includes('styles.accountArchivedHeaderRow'), 'en-tete Archived toujours present');
});

console.log(`\n${passed} test(s) OK`);
if (process.exitCode === 1) process.exit(1);
