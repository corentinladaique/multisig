import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { computeProposalIndexes } from '../src/squads/proposals';
import {
  classifyProposal,
  filterProposals,
  type ProposalFilterInput,
} from '../src/squads/proposalFilters';
import { shouldReloadForWalletIdentity } from '../src/wallet/walletIdentityRefresh';

/**
 * BUG DE FRAÎCHEUR : après un CHANGEMENT DE WALLET DANS l'app (wallet A
 * signataire 1 -> wallet B signataire 2, sans quitter l'app), la proposition
 * fraîchement créée et les compteurs/badges « waiting for your vote » ne
 * s'affichaient pas tant qu'on ne relançait pas l'app.
 *
 * Cause racine reproduite ici : la vue du multisig (dont le `transactionIndex`
 * lu on-chain) et la liste des propositions sont lues une fois puis mises en
 * cache. Aucune dépendance ne les relisait quand l'IDENTITÉ DU SIGNATAIRE
 * changeait — donc une proposition créée après le dernier chargement (index
 * on-chain devenu supérieur au `transactionIndex` en cache) restait invisible,
 * et le badge de vote restait à zéro, jusqu'à une relance de l'app (qui, elle,
 * relit le compte à neuf).
 *
 * MÊME FAMILLE que le bug de persistance déjà corrigé (deux instances de hook,
 * instantané chargé une seule fois, deps `[storage]`).
 *
 * Tests PURS : le module de décision (aucune I/O) + les fonctions pures de
 * lecture des propositions + lecture des sources. Aucun RPC, aucun wallet,
 * aucune signature. Ce fichier ÉCHOUE sans le correctif (module absent + effet
 * de relecture absent de ConnectScreen).
 *
 * Execution : npx tsx scripts/wallet-identity-refresh.test.ts
 */

const CONNECT = readFileSync('src/screens/ConnectScreen.tsx', 'utf8');
const PROPOSALS = readFileSync('src/squads/proposals.ts', 'utf8');
const RUNNER = readFileSync('scripts/run-pure-tests.sh', 'utf8');

// Deux signataires distincts (le second est un MEMBRE avec droit de vote).
const WALLET_A = 'GZUrVZnw4QoHf3SvXrYvWfFzVbXXHxoA9UKSajWBfUuM';
const WALLET_B = '9hvAFWYxp2mbZeF7JmvnWZqrhxNrT8tCA2PMvcshHeuR';

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

// ===========================================================================
// (1) DÉCISION PURE : QUAND FAUT-IL RELIRE LES DONNÉES DU MULTISIG ?
// ===========================================================================

check('1. déconnecté (identité null) : aucune relecture', () => {
  assert.equal(shouldReloadForWalletIdentity(WALLET_A, null, true), false);
  assert.equal(shouldReloadForWalletIdentity(null, null, true), false);
});

check('2. même signataire : le cache reste valable, aucune relecture', () => {
  assert.equal(shouldReloadForWalletIdentity(WALLET_A, WALLET_A, true), false);
});

check('3. aucun vault chargé : l auto-chargement s en charge, pas cet effet', () => {
  assert.equal(shouldReloadForWalletIdentity(null, WALLET_A, false), false);
  assert.equal(shouldReloadForWalletIdentity(WALLET_A, WALLET_B, false), false);
});

check('4. CHANGEMENT DE WALLET avec un vault affiché : relecture OBLIGATOIRE', () => {
  // C'est exactement le scénario du bug : A -> B, dans l'app, vault chargé.
  assert.equal(shouldReloadForWalletIdentity(WALLET_A, WALLET_B, true), true);
});

check('5. déconnexion puis reconnexion du MÊME wallet : aucune relecture inutile', () => {
  // L'implémentation NE mémorise PAS `null` : après une déconnexion, l'identité
  // connue reste A, donc le retour de A n'est pas vu comme un changement.
  const knownAfterDisconnect = WALLET_A; // l'écran n'efface pas l'identité sur null
  assert.equal(shouldReloadForWalletIdentity(knownAfterDisconnect, WALLET_A, true), false);
});

// ===========================================================================
// (2) LE CACHE MASQUE UNE PROPOSITION CRÉÉE APRÈS LE DERNIER CHARGEMENT
//     (reproduction pure du bug)
// ===========================================================================

check('6. transactionIndex en cache périmé : la proposition #4 n est PAS lue', () => {
  // On-chain : la proposition #4 vient d'être créée, le compte Multisig est à
  // `transactionIndex = 4`. MAIS la vue mise en cache date d'avant (index 3).
  const onChainTransactionIndex = 4;
  const cachedTransactionIndex = 3;

  // Ce que l'on relit avec l'index EN CACHE : #4 hors de la plage -> invisible.
  const withCache = computeProposalIndexes(cachedTransactionIndex, 0);
  assert.deepEqual(withCache, [1, 2, 3], 'sans relecture du compte, #4 est absent (bug)');
  assert.ok(!withCache.includes(onChainTransactionIndex), 'la proposition fraîche est manquante');

  // Après relecture du COMPTE (transactionIndex frais), #4 apparaît.
  const afterReload = computeProposalIndexes(onChainTransactionIndex, 0);
  assert.deepEqual(afterReload, [1, 2, 3, 4], 'après relecture, #4 est lu');
  // Contre-preuve que l'index fait toute la différence.
  assert.ok(afterReload.includes(onChainTransactionIndex));
});

// ===========================================================================
// (3) LE COMPTEUR / BADGE « waiting for your vote » SE RECALCULE PAR WALLET
// ===========================================================================

check('7. badge « waiting for your vote » : 1 pour B, 0 pour A (déjà voté)', () => {
  // La proposition #4 est Active, approuvée UNE fois (par A), seuil 2.
  const proposalsList = [
    { index: 4, status: 'Active', approvals: 1, approvedAddresses: [WALLET_A] },
  ];
  const build = (walletAddress: string): ProposalFilterInput[] =>
    proposalsList.map((proposal) => ({
      index: proposal.index,
      status: proposal.status,
      approvals: proposal.approvals,
      threshold: 2,
      approvedAddresses: proposal.approvedAddresses,
      walletAddress,
      walletCanApprove: true,
      walletCanExecute: false,
    }));

  // Le badge Home = nombre de propositions « To do » (Active + vote possible +
  // pas déjà approuvée par CE wallet). Il est DÉRIVÉ du rendu : dès que la liste
  // contient #4, il se recalcule pour le wallet courant — aucun état mémorisé.
  const todoForB = filterProposals(build(WALLET_B), 'todo');
  assert.equal(todoForB.length, 1, 'B doit voir #4 en attente de son vote (badge = 1)');
  const todoForA = filterProposals(build(WALLET_A), 'todo');
  assert.equal(todoForA.length, 0, 'A a déjà approuvé : rien en attente pour lui');
  // B est en « Needs your approval » ; A est classé « open » (déjà approuvé).
  assert.equal(classifyProposal(build(WALLET_B)[0]), 'todo');
  assert.equal(classifyProposal(build(WALLET_A)[0]), 'open');
});

// ===========================================================================
// (4) L'ÉCRAN EST BRANCHÉ SUR L'IDENTITÉ DU WALLET (le correctif)
// ===========================================================================

check('8. ConnectScreen relit le multisig + les propositions au changement de wallet', () => {
  assert.ok(
    CONNECT.includes("import { shouldReloadForWalletIdentity } from '../wallet/walletIdentityRefresh';"),
    'la décision pure est importée',
  );
  // L'effet existe et est borné par ses dépendances.
  const start = CONNECT.indexOf('const lastWalletIdentityRef = useRef<string | null>(null);');
  const endMarker = '}, [loadVault, viewAddress, walletAddress]);';
  const end = CONNECT.indexOf(endMarker, start);
  assert.ok(start > -1 && end > start, 'effet de relecture présent et borné');
  const effect = CONNECT.slice(start, end);
  // Dépendances : l'IDENTITÉ (walletAddress), l'adresse du vault et le loader.
  assert.ok(effect.includes('shouldReloadForWalletIdentity(previous, walletAddress, viewAddress !== null)'));
  // Relecture du COMPTE Multisig (transactionIndex à jour) ...
  assert.ok(effect.includes('loadVault(viewAddress);'), 'le compte Multisig est relu');
  // ... PUIS relecture forcée des propositions (garde relâché + nonce).
  assert.ok(effect.includes('proposalsRefreshRef.current = false;'));
  assert.ok(effect.includes('setProposalsNonce((previousNonce) => previousNonce + 1);'));
  // L'identité RÉELLE est mémorisée, la déconnexion (`null`) ne l'efface pas.
  assert.ok(effect.includes('if (walletAddress === null) return;'));
  assert.ok(effect.includes('lastWalletIdentityRef.current = walletAddress;'));
});

check('9. cette relecture ne sollicite JAMAIS le wallet', () => {
  const start = CONNECT.indexOf('const lastWalletIdentityRef = useRef<string | null>(null);');
  const effect = CONNECT.slice(start, CONNECT.indexOf('}, [loadVault, viewAddress, walletAddress]);', start));
  for (const forbidden of [
    'signAndSendTransactions',
    'signTransaction',
    'sendRawTransaction',
    'useMobileWallet(',
    'authorize(',
    'connect(',
  ]) {
    assert.ok(!effect.includes(forbidden), `interdit dans la relecture : ${forbidden}`);
  }
});

check('10. filet de sécurité (focus) : revenir sur Proposals relit la liste', () => {
  assert.ok(CONNECT.includes('const previousTabRef = useRef<TabKey>(tab);'));
  const effect = CONNECT.slice(
    CONNECT.indexOf('const previousTabRef = useRef<TabKey>(tab);'),
    CONNECT.indexOf('}, [tab, refreshProposalsReadOnly]);'),
  );
  assert.ok(effect.includes("if (tab !== 'proposals') return;"));
  assert.ok(effect.includes('refreshProposalsReadOnly();'));
  assert.ok(effect.includes('if (leftTab === tab) return;'), 'ne se declenche pas sur le rendu courant');
});

// ===========================================================================
// (5) LE CORRECTIF RESTE HORS DES MODULES PURS DE LECTURE
// ===========================================================================

check('11. la relecture vit dans l écran, pas dans proposals.ts (module pur inchangé)', () => {
  // `useProposals` ne dépend QUE de l'identité du multisig : la relecture au
  // changement de wallet est une décision d'ÉCRAN, pas une seconde source.
  const deps = PROPOSALS.slice(
    PROPOSALS.indexOf('}, [multisigAddress'),
    PROPOSALS.indexOf(']);', PROPOSALS.indexOf('}, [multisigAddress')) + 3,
  );
  assert.ok(deps.includes('multisigAddress'));
  assert.ok(!deps.includes('walletAddress'), 'proposals.ts ne connait pas le wallet');
  assert.ok(!PROPOSALS.includes('walletIdentityRefresh'));
});

check('12. la suite est enregistree dans npm test', () => {
  assert.ok(RUNNER.includes('scripts/wallet-identity-refresh.test.ts'), 'suite dans le runner');
});

console.log(`\n${passed} test(s) OK`);
