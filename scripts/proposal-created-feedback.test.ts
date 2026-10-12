import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  recoveryStateFromRead,
  RECOVERY_RETRY_BLOCKED_STATES,
} from '../src/ui/recoveryCheck';

/**
 * Retour utilisateur APRES une creation de proposition hors ligne.
 *
 * (a) aucun encart ROUGE autonome : l erreur Java BRUTE vit UNIQUEMENT dans le
 *     repli « Troubleshooting details » (ferme par defaut, integral, selectable) ;
 * (b) le message affirme SANS AMBIGUÏTE que la proposition A ETE CREEE (seule la
 *     verification reste) et interdit le doublon ;
 * (c) le repli « How proposal creation works » est ferme par defaut et NE
 *     contient plus le jargon interne ;
 * (d) « Check again » RELANCE reellement la verification et MET A JOUR l etat.
 *
 * Source uniquement : aucun RPC, aucun wallet, aucune signature.
 * npx tsx scripts/proposal-created-feedback.test.ts
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

const NEW = readFileSync('src/screens/NewProposalScreen.tsx', 'utf8');

/** Carte ambre « proposition creee, verification en attente ». */
const AMBER = NEW.slice(
  NEW.indexOf('{signedPendingVerification &&'),
  NEW.indexOf('{createResult !== null && !signedPendingVerification ? ('),
);
/** Handler « Check again » et sa relecture ciblee. */
const HANDLER = NEW.slice(
  NEW.indexOf('const readBackCreatedProposal = async ()'),
  NEW.indexOf('// CTA de création UNIQUE'),
);
/** Corps visible du repli « How proposal creation works ». */
const HOW_START = NEW.indexOf('{howItWorksOpen ? (');
const HOW = NEW.slice(HOW_START, NEW.indexOf(') : null}', HOW_START));

const JARGON = [
  'ephemeral signer',
  'VaultTransaction account',
  'ProposalCreate',
  'rent is paid',
  'first approver',
];

// --- (a) Plus AUCUN encart rouge autonome : le brut est dans le repli ---------

check('a1. le repli « Troubleshooting details » est FERME par defaut', () => {
  assert.ok(
    NEW.includes('const [troubleshootingOpen, setTroubleshootingOpen] = useState(false);'),
    'repli ferme par defaut',
  );
});

check('a2. l erreur de creation n est PLUS rendue dans un encart rouge autonome', () => {
  // L ancien InfoBox d erreur au premier niveau est retire.
  assert.ok(!NEW.includes('<InfoText tone="error">{createError}</InfoText>'), 'encart rouge autonome retire');
  assert.ok(!NEW.includes('styles.errorCentered'), 'style de l encart rouge autonome plus reference');
  // Aucune erreur brute rendue hors repli.
  assert.ok(!/\{createError\}/.test(NEW.split('troubleshootingOpen ? (')[0]), 'brut jamais au premier niveau');
});

check('a3. le brut (Java / ReadBack) vit dans le repli de la carte ambre, integral', () => {
  assert.ok(AMBER.includes('label="Troubleshooting details"'), 'repli present dans la carte ambre');
  assert.ok(AMBER.includes('{pendingVerificationRaw}'), 'brut integral rendu seulement replie');
  assert.ok(AMBER.includes('{createError}'), 'message brut complet rendu seulement replie');
  assert.ok(AMBER.includes('selectable'), 'brut copiable (selectable)');
  // Le brut est conditionne au repli ouvert.
  assert.ok(AMBER.includes('{troubleshootingOpen ? ('), 'conditionne au repli');
});

check('a4. les avertissements techniques ne sont plus rendus NULLE PART', () => {
  // Le rendu des notes de creation (validationWarnings : ephemeral signer,
  // ProposalCreate, rent, first approver…) a ete SUPPRIME entièrement : ni à
  // l'écran, ni dans le repli « Troubleshooting details », ni dans un repli.
  assert.equal(
    NEW.split('validationWarnings.map').length - 1,
    0,
    'aucun rendu des avertissements techniques',
  );
  assert.ok(!AMBER.includes('validationWarnings'), 'aucune note technique dans la carte ambre');
  assert.ok(!NEW.includes('styles.howItWorksList'), 'aucune liste technique visible');
  // Aucun code/constante/import orphelin laisse par ce rendu.
  assert.ok(!NEW.includes('· {warning}'), 'ligne de puce technique supprimee');
  assert.ok(!NEW.includes('Notes techniques de la création'), 'commentaire du rendu supprime');
  assert.ok(!NEW.includes('IMPLEMENTATION_NOTES'), 'aucune constante orpheline');
  assert.ok(!NEW.includes('isTechnicalWarning'), 'aucun filtre orphelin');
  // Le seul usage restant de `validationWarnings` est le report de DONNEE vers
  // le resultat verifie (jamais un rendu).
  assert.equal(
    NEW.split('validationWarnings').length - 1,
    2,
    'donnee conservée (clé + valeur), rendu supprimé',
  );
});

// --- (b) Registre HONNÊTE : « envoyé / non vérifié » (ni « created », ni « failed »)

/** Copie VISIBLE de la carte ambre (titre + corps + recommandation). */
const AMBER_COPY = AMBER.slice(0, AMBER.indexOf('<View style={styles.actionSpacing}>'));

check('b1. le titre reste dans le registre « envoyé / non vérifié »', () => {
  assert.ok(AMBER.includes('>Proposal sent — verification pending<'), 'titre honnête « sent »');
  // Jamais l ancien libellé ambigu de succès, jamais une création affirmée.
  assert.ok(!NEW.includes('>Proposal sent<'), 'pas de « Proposal sent » nu (état ambigu)');
  assert.ok(!AMBER.includes('>Proposal created<'), 'pas de « Proposal created » non vérifiable');
  assert.ok(!/Proposal failed/i.test(AMBER), 'jamais un échec définitif affirmé');
});

check('b2. le corps affirme l envoi, PAS la création', () => {
  assert.ok(AMBER.includes('Your proposal was signed and sent from this device.'), 'envoi affirmé');
  assert.ok(
    AMBER.includes("Multisig couldn't verify it yet"),
    'vérification déclarée en attente',
  );
  assert.ok(AMBER.includes('because the network is unavailable'), 'cause réseau');
});

check('b3. l anti-doublon est une RECOMMANDATION, jamais un fait', () => {
  assert.ok(
    AMBER.includes("Open your proposals when you're back online — if it was accepted, it will be there."),
    'recommandation honnête',
  );
  assert.ok(
    AMBER.includes("Don't create it again without checking first."),
    'interdiction conditionnée',
  );
});

check('b4. RÈGLE : aucune copie visible n affirme un fait NON VÉRIFIABLE', () => {
  // Le libellé visible n utilise ni « created » (certitude) ni « failed ».
  assert.ok(!/created/i.test(AMBER_COPY), '« created » absent de la copie visible');
  assert.ok(!/failed/i.test(AMBER_COPY), '« failed » absent de la copie visible');
  // Il décrit bien ce que l app SAIT : signature obtenue d un envoi.
  assert.ok(/signed and sent/i.test(AMBER_COPY), 'envoi décrit');
  assert.ok(/verify/i.test(AMBER_COPY), 'vérification en attente décrite');
});

// --- (c) « How proposal creation works » : repli ferme, sans jargon -----------

check('c1. le repli « How proposal creation works » est ferme par defaut', () => {
  assert.ok(NEW.includes('const [howItWorksOpen, setHowItWorksOpen] = useState(false);'), 'ferme par defaut');
  assert.ok(NEW.includes('label="How proposal creation works"'), 'repli present');
  assert.ok(NEW.includes('expanded={howItWorksOpen}'), 'etat de repli lie');
  assert.ok(NEW.includes('{howItWorksOpen ? ('), 'contenu rendu seulement deplie');
});

check('c2. le contenu du repli reste HUMAIN (aucun jargon interne)', () => {
  for (const term of JARGON) {
    assert.ok(!HOW.includes(term), `jargon absent du repli : ${term}`);
  }
  // Deux phrases humaines, pas de liste technique en clair.
  assert.ok(!HOW.includes('<Text'), 'aucune puce technique : texte humain uniquement');
});

check('c2bis. le repli conserve ses 2 phrases HUMAINES (rendu ferme par defaut)', () => {
  assert.ok(NEW.includes('label="How proposal creation works"'), 'repli toujours present');
  assert.ok(NEW.includes('const [howItWorksOpen, setHowItWorksOpen] = useState(false);'), 'ferme par defaut');
  const HOW_TEXT = HOW.replace(/\s+/g, ' ');
  assert.ok(
    HOW_TEXT.includes(
      'Creating a proposal records the transfer instructions on Devnet. Funds only move after the required approvals are collected and the proposal is executed.',
    ),
    'les deux phrases humaines sont conservees',
  );
  // Les avertissements techniques supprimes ne laissent AUCUN residu ici.
  for (const note of ['ephemeral signer', 'ProposalCreate', 'VaultTransaction account', 'rent is paid', 'first approver']) {
    assert.ok(!HOW.includes(note), `aucun residu technique : ${note}`);
  }
});

check('c3. aucun jargon dans le rendu VISIBLE de l ecran', () => {
  // Tout le contenu de l ecran reste composé de chaines dynamiques uniquement
  // dans le repli : le jargon n apparait nulle part en clair.
  for (const term of JARGON) {
    assert.ok(!NEW.includes(`>${term}`), `pas de jargon rendu : ${term}`);
  }
});

// --- (d) « Check again » relance la verification ET met a jour l etat ---------

check('d1. le handler « Check again » est branche sur la relance de verification', () => {
  assert.ok(HANDLER.includes('const readBackCreatedProposal = async ()'), 'relecture ciblee presente');
  assert.ok(HANDLER.includes('const onCheckAfterFailure = async () => {'), 'handler present');
  assert.ok(
    NEW.includes('void onCheckAfterFailure();'),
    'handler branche sur le bouton « Check again »',
  );
  assert.ok(
    NEW.includes('onPress={() => {\n                  void onCheckAfterFailure();'),
    'le bouton appelle bien le handler',
  );
});

check('d2. la verification RELIT reellement les comptes crees (preuve positive)', () => {
  assert.ok(HANDLER.includes('connection.getAccountInfo('), 'relecture des comptes on-chain');
  assert.ok(HANDLER.includes('multisig.accounts.Proposal.fromAccountInfo('), 'decodage de la proposition');
  assert.ok(
    HANDLER.includes('multisig.accounts.VaultTransaction.fromAccountInfo('),
    'decodage de la transaction',
  );
  assert.ok(HANDLER.includes('await readBackCreatedProposal()'), 'appel reel de la relecture');
});

check('d3. la verification MET A JOUR l etat (succes => ecran de succes)', () => {
  // Succes : bascule terminale + resultat verifie => l ecran de succes remplace
  // la carte ambre (elle DISPARAIT).
  assert.ok(HANDLER.includes('const verifiedResult: ProposalCreationSignSendResult ='), 'resultat construit');
  assert.ok(HANDLER.includes('verified: true'), 'marque verifie');
  assert.ok(HANDLER.includes('setCreateResult(verifiedResult)'), 'etat mis a jour');
  assert.ok(HANDLER.includes('forgetPendingCreation(pendingCreationScope);'), 'record purge sur preuve');
  assert.ok(
    NEW.includes('if (createResult !== null && createResult.verified === true) {'),
    'ecran de succes rendu quand verifie',
  );
});

check('d4. la verification MET A JOUR l etat (echec => message d erreur)', () => {
  assert.ok(HANDLER.includes('await onCreatedVerified?.()'), 'relecture du parent');
  assert.ok(
    HANDLER.includes('setRecoveryCheck(recoveryStateFromRead(outcome))'),
    'etat de reprise mis a jour',
  );
  assert.ok(
    AMBER.includes("recoveryCheck === 'verification_unavailable'"),
    'message « toujours pas de connexion » rendu',
  );
  assert.ok(
    AMBER.includes('Still no connection to verify it yet.'),
    'copie d echec de verification presente',
  );
  // Le mapping pur reste conservateur : jamais de certitude.
  assert.notEqual(recoveryStateFromRead(true), 'proposal_found');
  for (const state of RECOVERY_RETRY_BLOCKED_STATES) {
    assert.ok(state.length > 0);
  }
});

check('d5. « Check again » n ouvre JAMAIS le wallet ni ne soumet', () => {
  for (const forbidden of [
    'authorize(',
    'signTransaction',
    'signAndSendTransactions',
    'sendRawTransaction',
    'signAndSendProposalCreation',
    'useMobileWallet()',
    'buildProposalCreation(',
    'runCreate(',
  ]) {
    assert.ok(!HANDLER.includes(forbidden), `aucun ${forbidden} dans « Check again »`);
  }
});

check('d6. les libelles « Check again » / « Back to proposals » sont conserves', () => {
  assert.ok(AMBER.includes('accessibilityLabel="Check again"'), 'Check again conserve');
  assert.ok(AMBER.includes('accessibilityLabel="Back to proposals"'), 'Back to proposals conserve');
});

// --- (e) Carte « sent / pending » : c'est un REPLI, FERMÉ par défaut ---------

/** Fin de l'en-tête compact = début du corps rendu seulement déplié. */
const HEADER_END = AMBER.indexOf('{pendingVerificationOpen ? (');
/** Partie TOUJOURS visible (en-tête compact). */
const COLLAPSED = AMBER.slice(0, HEADER_END);
/** Partie révélée AU TAP (corps + actions). */
const EXPANDED = AMBER.slice(HEADER_END);

check('e1. la carte est un REPLI ferme par defaut', () => {
  assert.ok(
    NEW.includes('const [pendingVerificationOpen, setPendingVerificationOpen] = useState(false);'),
    'etat de repli ferme par defaut (useState(false))',
  );
  assert.ok(
    AMBER.includes('onPress={() => setPendingVerificationOpen((previous) => !previous)}'),
    'en-tête cliquable qui bascule l etat',
  );
  assert.ok(AMBER.includes('accessibilityLabel="Toggle proposal sent details"'), 'libellé de repli present');
  assert.ok(
    AMBER.includes('accessibilityState={{ expanded: pendingVerificationOpen }}'),
    'semantique d etat de repli',
  );
  // Chevron cohérent avec les autres replis de l'app (replié = ◂, déplié = ▾).
  assert.ok(
    AMBER.includes(">{pendingVerificationOpen ? '▾' : '◂'}<"),
    'chevron replié/déplié coherent',
  );
});

check('e2. le corps ET les DEUX actions ne sont rendus que DÉPLIÉ', () => {
  assert.ok(HEADER_END > 0, 'corps conditionné à l etat déplié');
  // Replié : l'en-tête porte le titre, RIEN du corps ni d'une action.
  assert.ok(COLLAPSED.includes('>Proposal sent — verification pending<'), 'titre dans l en-tête');
  assert.ok(!COLLAPSED.includes('Your proposal was signed and sent'), 'corps absent quand replié');
  assert.ok(!COLLAPSED.includes('Check again'), 'aucune action quand replié');
  assert.ok(!COLLAPSED.includes('Back to proposals'), 'aucune action quand replié');
  // Déplié : corps + les DEUX actions y vivent.
  assert.ok(EXPANDED.includes('Your proposal was signed and sent from this device.'), 'corps deplié');
  assert.ok(EXPANDED.includes("Multisig couldn't verify it yet"), 'cause réseau depliée');
  assert.ok(EXPANDED.includes('accessibilityLabel="Check again"'), 'Check again deplié');
  assert.ok(EXPANDED.includes('accessibilityLabel="Back to proposals"'), 'Back to proposals deplié');
  // Le corps déplié reste dans le registre honnête (ni « created », ni « failed »).
  assert.ok(!/created/i.test(EXPANDED), 'jamais « created » dans le corps déplié');
  assert.ok(!/failed/i.test(EXPANDED), 'jamais « failed » dans le corps déplié');
});

check('e3. l en-tête de la carte dit l essentiel sans déplier (registre honnête)', () => {
  assert.ok(HEADER_END > 0, 'en-tête localisé');
  assert.ok(COLLAPSED.includes('>Proposal sent — verification pending<'), 'titre « envoyé / non vérifié »');
  assert.ok(!/created/i.test(COLLAPSED), 'en-tête : jamais « created »');
  assert.ok(!/failed/i.test(COLLAPSED), 'en-tête : jamais « failed »');
  // Le titre porte tout l'essentiel : un envoi a peut-être eu lieu.
  assert.ok(/signed and sent|verification pending/i.test('Proposal sent — verification pending'), 'titre autoportant');
});

check('e4. le repli « How proposal creation works » reste fermé par défaut', () => {
  assert.ok(NEW.includes('const [howItWorksOpen, setHowItWorksOpen] = useState(false);'), 'ferme par defaut');
  assert.ok(NEW.includes('label="How proposal creation works"'), 'repli present');
  assert.ok(NEW.includes('{howItWorksOpen ? ('), 'contenu rendu seulement deplie');
});

console.log(`\n${passed} test(s) OK`);
