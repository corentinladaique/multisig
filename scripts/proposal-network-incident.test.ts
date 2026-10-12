import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  describeVerificationIncident,
  isNetworkFailure,
  NETWORK_INCIDENT_BODY,
  NETWORK_INCIDENT_REASSURANCE,
  NETWORK_INCIDENT_TITLE,
} from '../src/ui/networkFailure';

/**
 * Incident RÉSEAU de l'écran de détail d'une proposition — tests PURS.
 *
 * Un seul incident (le réseau) ne doit produire qu'UN seul encart, en AMBRE,
 * avec un message HUMAIN ; le détail technique brut reste accessible, INTÉGRAL,
 * derrière un repli FERMÉ par défaut. Les VRAIES erreurs de décodage restent
 * ROUGES. Aucun RPC, aucun wallet, aucune signature.
 *
 * npx tsx scripts/proposal-network-incident.test.ts
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
    console.log(
      detail
        .split('\n')
        .filter((line) => !line.includes('node:internal'))
        .slice(0, 4)
        .join('\n'),
    );
    process.exitCode = 1;
  }
}

const DETAILS = readFileSync('src/screens/ProposalDetailsScreen.tsx', 'utf8');
const THEME = readFileSync('src/ui/theme.ts', 'utf8');

// Erreur réseau réelle, telle que produite par le SDK en bout de chaîne.
const NETWORK_ERROR =
  'failed to get info about account 4QhZJiGQKzb88A55mtg1Pp3jfa3AtdZrDv8AJDbZnToS: Error: fetch failed: java.net.UnknownHostException: Unable to resolve host "api.devnet.solana.com": No address associated with hostname';
// Vraie erreur de décodage (données/état, pas de connectivité).
const REAL_DECODE_ERROR =
  'No vault transaction found for this proposal index: the account does not hold a decodable message.';

// Encart réseau FUSIONNÉ (le seul de l'écran).
const MERGED_START = DETAILS.indexOf('{decodeNetworkIncident || executionSentIncident ? (');
const MERGED_END = DETAILS.indexOf(
  '{decodeError !== null && !decodeNetworkIncident ? (',
  MERGED_START,
);
const MERGED = DETAILS.slice(MERGED_START, MERGED_END);

// Encart des VRAIES erreurs de décodage (rouge).
const REAL_START = MERGED_END;
const REAL_END = DETAILS.indexOf('Refresh this proposal and decode it again', REAL_START);
const REAL = DETAILS.slice(REAL_START, REAL_END);

check('1. Classifieur : une erreur réseau est reconnue (hôte introuvable, DNS)', () => {
  assert.equal(isNetworkFailure(NETWORK_ERROR), true);
  assert.equal(isNetworkFailure('Unable to resolve host "api.devnet.solana.com"'), true);
  assert.equal(isNetworkFailure('TypeError: fetch failed'), true);
  assert.equal(isNetworkFailure('java.net.UnknownHostException: no address'), true);
});

check('2. Classifieur : une VRAIE erreur n est jamais prise pour du réseau', () => {
  assert.equal(isNetworkFailure(REAL_DECODE_ERROR), false);
  assert.equal(isNetworkFailure('No vault transaction found'), false);
  // Entrées nulles/vides : jamais « réseau » par défaut.
  assert.equal(isNetworkFailure(null), false);
  assert.equal(isNetworkFailure(undefined), false);
  assert.equal(isNetworkFailure(''), false);
});

check('3. Copie utilisateur : réseau = titre + corps humains + rassurance', () => {
  const copy = describeVerificationIncident(NETWORK_ERROR);
  assert.equal(copy.network, true);
  assert.equal(copy.title, NETWORK_INCIDENT_TITLE);
  assert.equal(copy.title, 'Verification is temporarily unavailable');
  assert.equal(copy.body, NETWORK_INCIDENT_BODY);
  assert.equal(copy.body, 'Multisig will check again when the network connection returns.');
  assert.equal(copy.reassurance, NETWORK_INCIDENT_REASSURANCE);
  assert.equal(copy.reassurance, 'Nothing was signed and nothing was sent.');
  // Le texte technique brut ne fuit JAMAIS dans le titre ni le corps.
  assert.ok(!copy.title.includes('UnknownHost'), 'titre sans exception Java');
  assert.ok(!copy.body.includes('api.devnet'), 'corps sans hôte RPC');
});

check('4. Copie utilisateur : vraie erreur = message d origine intact, rouge', () => {
  const copy = describeVerificationIncident(REAL_DECODE_ERROR);
  assert.equal(copy.network, false);
  assert.equal(copy.title, 'Could not decode this proposal');
  assert.equal(copy.body, REAL_DECODE_ERROR, 'message d origine conservé');
  assert.equal(copy.reassurance, null, 'aucune rassurance trompeuse');
});

check('5. Un SEUL encart réseau fusionné (décodage + envoi signé non vérifié)', () => {
  assert.ok(MERGED_START > 0 && MERGED_END > MERGED_START, 'encart fusionné présent');
  // Le panneau porte le texte humain dédié.
  assert.ok(MERGED.includes('{NETWORK_INCIDENT_TITLE}'), 'titre humain rendu');
  assert.ok(MERGED.includes('{NETWORK_INCIDENT_BODY}'), 'corps humain rendu');
  // Les DEUX sources d'incident réseau sont regroupées par la MEME condition.
  const SOURCE = DETAILS.slice(DETAILS.indexOf('const decodeNetworkIncident'), MERGED_START);
  assert.ok(SOURCE.includes('decodeNetworkIncident = decodeError !== null && isNetworkFailure(decodeError)'));
  assert.ok(SOURCE.includes('executionResult === null && rememberedSignature !== null && !executed'));
  // Aucun doublon : les anciens encarts d'incident réseau sont neutralisés.
  assert.ok(DETAILS.includes('executionSentIncident ? null : ('), 'envoi non vérifié non dupliqué');
});

check('6. L encart réseau est AMBRE, jamais rouge', () => {
  assert.ok(MERGED.includes('tone="warning"'), 'ton ambre');
  assert.ok(MERGED.includes('<InfoText tone="warning">'), 'texte ambre');
  assert.ok(!MERGED.includes('tone="error"'), 'jamais le ton erreur');
  assert.ok(!MERGED.includes('styles.errorBox'), 'jamais la carte rouge');
  // Le ton ambre provient des tokens du thème (aucune couleur codée en dur).
  assert.ok(THEME.includes("warning: '#F4C56A'"), 'token warning du thème');
  assert.ok(THEME.includes("warningSoft: '#382A0D'"), 'token warningSoft du thème');
});

check('7. Détail technique brut: repli FERMÉ par défaut, texte INTÉGRAL accessible', () => {
  // Le repli est fermé par défaut.
  assert.ok(
    DETAILS.includes('const [showTechnicalDetails, setShowTechnicalDetails] = useState(false)'),
    'repli fermé par défaut',
  );
  // Libellé explicite présent, avec bascule.
  assert.ok(MERGED.includes("'Show technical details'"), 'libellé de repli');
  assert.ok(MERGED.includes("'Hide technical details'"), 'repli refermable');
  // Le brut n'est rendu QUE lorsque le repli est ouvert, et il est INTÉGRAL.
  assert.ok(
    MERGED.includes('{showTechnicalDetails && networkIncidentRaw !== null ? ('),
    'brut rendu seulement à l ouverture',
  );
  assert.ok(MERGED.includes('{networkIncidentRaw}'), 'brut intégral rendu');
  assert.ok(MERGED.includes('selectable'), 'brut copiable');
  // networkIncidentRaw = l erreur de décodage complète, jamais tronquée.
  const SOURCE = DETAILS.slice(DETAILS.indexOf('const networkIncidentRaw'), MERGED_START);
  assert.ok(SOURCE.includes('decodeNetworkIncident'), 'source du brut = erreur de décodage');
  assert.ok(SOURCE.includes('? decodeError'), 'brut = decodeError intégral');
});

check('8. Reprise conservée : Retry decode et Check execution again', () => {
  assert.ok(MERGED.includes('Retry decode'), 'reprise de décodage présente');
  assert.ok(MERGED.includes('void runDecode();'), 'reprise branchée sur runDecode');
  assert.ok(MERGED.includes('Check execution again'), 'reprise de vérification présente');
  assert.ok(MERGED.includes('void onCheckExecutionAgain();'), 'reprise branchée');
});

check('9. Une VRAIE erreur de décodage reste ROUGE, avec reprise', () => {
  assert.ok(REAL_START > 0 && REAL_END > REAL_START, 'encart réel présent');
  assert.ok(REAL.includes('{decodeError !== null && !decodeNetworkIncident ? ('), 'seulement hors réseau');
  assert.ok(REAL.includes('tone="error"'), 'ton rouge conservé');
  assert.ok(REAL.includes('{decodeError}'), 'message brut d origine rendu');
  assert.ok(REAL.includes('Retry decode'), 'reprise conservée');
});

check('10. Etat « signé / confirmation en attente » : AMBRE, jamais rouge', () => {
  // Le grand encart d'état bascule success → warning (ambre) → error.
  assert.ok(DETAILS.includes("executionOutcome.tone === 'warning'"), 'branche ambre');
  assert.ok(DETAILS.includes('styles.warningPanel'), 'style ambre appliqué');
  assert.ok(DETAILS.includes('styles.warningPanelText'), 'texte ambre appliqué');
  // Signature + statut + reprise conservés dans cet encart.
  assert.ok(DETAILS.includes('Signature: {abbreviateAddress(executionResult.signature)}'), 'signature conservée');
  assert.ok(DETAILS.includes('Status before:'), 'ligne de statut conservée');
});

console.log(`\n${passed} test(s) OK`);
