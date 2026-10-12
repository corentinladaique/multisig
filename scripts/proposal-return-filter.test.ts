import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { classifyProposal, type ProposalFilterGroup } from '../src/squads/proposalFilters';
import { resolveReturnFilter } from '../src/ui/proposalReturnFilter';

/**
 * RETOUR VERS LE BON FILTRE (P1).
 *
 * Defaut reproduit : une proposition ouverte depuis Done revenait sur To do,
 * parce que le filtre To do / Open / Done vivait DANS `ProposalListBody`, dont
 * le demontage (ouvrir une proposition monte un autre ecran) reinitialisait la
 * selection a 'todo'. Le filtre est desormais POSSEDE par l'ecran appelant, et
 * la regle de retour est une fonction PURE (`resolveReturnFilter`), testee ici a
 * l'EXECUTION ; l'isolation (aucun wallet, aucune transaction) est verifiee sur
 * les handlers reels.
 *
 * Aucun RPC, aucun wallet, aucune transaction.
 * npx tsx scripts/proposal-return-filter.test.ts
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

const CONNECT = readFileSync('src/screens/ConnectScreen.tsx', 'utf8');
const MDS = readFileSync('src/screens/MultisigDetailsScreen.tsx', 'utf8');
const RETURN_HELPER = readFileSync('src/ui/proposalReturnFilter.ts', 'utf8');

/** Wallet membre, droits Vote + Execute. */
const MEMBER = 'MemberWallet1111111111111111111111111111111';
/** Contexte de classement d'une proposition « vote en attente ». */
const BASE = {
  index: 7,
  approvals: 1,
  threshold: 2,
  approvedAddresses: [] as string[],
  walletAddress: MEMBER,
  walletCanApprove: true,
  walletCanExecute: true,
};

// --- Règle de retour, exécutée ------------------------------------------------

check('1. To do -> detail -> Back -> To do (catégorie inchangée)', () => {
  const got = resolveReturnFilter('todo', 'Active', BASE);
  assert.equal(got, 'todo');
  // La proposition est TOUJOURS « à faire » : la catégorie n'a pas bougé.
  assert.equal(classifyProposal({ ...BASE, status: 'Active' }), 'todo');
});

check('2. Open -> detail -> Back -> Open (catégorie inchangée)', () => {
  // Valeur du vote déjà posée : ce wallet n'a rien à faire -> groupe « open ».
  const openBase = { ...BASE, walletCanApprove: false, walletCanExecute: false };
  assert.equal(classifyProposal({ ...openBase, status: 'Active' }), 'open');
  assert.equal(resolveReturnFilter('open', 'Active', openBase), 'open');
});

check('3. Done -> detail -> Back -> Done (catégorie inchangée)', () => {
  assert.equal(classifyProposal({ ...BASE, status: 'Executed' }), 'done');
  assert.equal(resolveReturnFilter('done', 'Executed', BASE), 'done');
});

check('4. To do -> execution VÉRIFIÉE -> Back -> Done', () => {
  // La catégorie a changé (la relecture on-chain prouve Executed) : Done gagne.
  assert.equal(resolveReturnFilter('todo', 'Executed', BASE), 'done');
});

check('5. Open -> execution VÉRIFIÉE -> Back -> Done', () => {
  const openBase = { ...BASE, walletCanApprove: false, walletCanExecute: false };
  assert.equal(resolveReturnFilter('open', 'Executed', openBase), 'done');
});

check('7. une proposition exécutée n’apparaît ni dans To do ni dans Open', () => {
  const executed = { ...BASE, status: 'Executed' };
  const group = classifyProposal(executed);
  assert.equal(group, 'done');
  assert.notEqual(group, 'todo');
  assert.notEqual(group, 'open');
  // Elle reste dans Done après retour, quelle que soit l’origine.
  for (const origin of ['todo', 'open', 'done'] as ProposalFilterGroup[]) {
    assert.equal(resolveReturnFilter(origin, 'Executed', BASE), 'done');
  }
});

check('10. un échec réseau (statut non vérifié) ne classe PAS dans Done', () => {
  // Aucune relecture aboutie : le statut est inconnu -> on garde l’ORIGINE,
  // jamais un groupe deviné (et surtout jamais Done).
  assert.equal(resolveReturnFilter('todo', null, BASE), 'todo');
  assert.equal(resolveReturnFilter('open', null, BASE), 'open');
  assert.equal(resolveReturnFilter('done', null, BASE), 'done');
  assert.notEqual(resolveReturnFilter('todo', null, BASE), 'done');
});

check('11. aucune SECONDE logique de classement : la règle réutilise classifyProposal', () => {
  assert.ok(RETURN_HELPER.includes("from '../squads/proposalFilters'"), 'import du module partagé');
  assert.ok(RETURN_HELPER.includes('classifyProposal({ ...input, status: verifiedStatus })'));
  // Le helper ne décide pas lui-même d’un groupe : il n’a aucune comparaison de statut locale.
  assert.ok(!RETURN_HELPER.includes("=== 'Executed'"), 'aucune classification dupliquée');
  assert.ok(!RETURN_HELPER.includes("=== 'Approved'"), 'aucune classification dupliquée');
});

// --- Intégration : filtres possédés par l’appelant, isolation -----------------

check('6. la liste est rafraîchie SANS appui manuel au retour du détail', () => {
  const connectBack = CONNECT.slice(
    CONNECT.indexOf('onBack={(verifiedStatus) => {'),
    CONNECT.indexOf('proposal={{ approvedAddresses: decision.approvedAddresses'),
  );
  assert.ok(connectBack.includes('refreshProposalsReadOnly();'), 'home : relecture read-only');
  const mdsBack = MDS.slice(
    MDS.indexOf('onBack={(verifiedStatus) => {'),
    MDS.indexOf('vaultTransactionAddress={openProposal.vaultTransactionAddress}'),
  );
  assert.ok(mdsBack.includes('void reloadFromChain();'), 'vault details : relecture read-only');
});

check('8. la navigation de retour ne déclenche AUCUN wallet ni aucune transaction', () => {
  const connectBack = CONNECT.slice(
    CONNECT.indexOf('onBack={(verifiedStatus) => {'),
    CONNECT.indexOf('proposal={{ approvedAddresses: decision.approvedAddresses'),
  );
  const mdsBack = MDS.slice(
    MDS.indexOf('onBack={(verifiedStatus) => {'),
    MDS.indexOf('vaultTransactionAddress={openProposal.vaultTransactionAddress}'),
  );
  for (const path of [connectBack, mdsBack]) {
    for (const forbidden of [
      'signAndSend',
      'signTransaction',
      'sendRawTransaction',
      'authorize(',
      'useMobileWallet()',
    ]) {
      assert.ok(!path.includes(forbidden), `interdit dans le retour : ${forbidden}`);
    }
  }
});

check('9. le filtre survit et reste correct après PLUSIEURS ouvertures successives', () => {
  // L’origine est réenregistrée à CHAQUE ouverture, à partir du filtre courant.
  assert.ok(
    CONNECT.includes('setOpenDecisionOrigin(proposalFilter);'),
    'home : origine mémorisée à chaque ouverture',
  );
  assert.ok(
    MDS.includes('setOpenProposalOrigin(proposalFilter);'),
    'vault details : origine mémorisée à chaque ouverture',
  );
  // Le filtre est un état de l’ÉCRAN APPELANT (jamais du corps de liste).
  assert.ok(CONNECT.includes("const [proposalFilter, setProposalFilter] = useState<ProposalFilterGroup>('todo');"));
  assert.ok(MDS.includes("const [proposalFilter, setProposalFilter] = useState<ProposalFilterGroup>('todo');"));
  const BODY = readFileSync('src/screens/ProposalListScreen.tsx', 'utf8');
  assert.ok(
    !BODY.includes("useState<ProposalFilterGroup>('todo')"),
    'le filtre n’est PLUS un état local de ProposalListBody',
  );
});

check('12. la sélection de filtre est un état CONTROLE (props), pas un état local', () => {
  const BODY = readFileSync('src/screens/ProposalListScreen.tsx', 'utf8');
  assert.ok(BODY.includes('filter: ProposalFilterGroup;'), 'filtre reçu en prop');
  assert.ok(BODY.includes('onFilterChange: (group: ProposalFilterGroup) => void;'), 'changement remonté');
  assert.ok(BODY.includes('onPress={() => onFilterChange(entry.key)}'), 'le tap remonte au propriétaire');
  // Le corps ne possède plus le filtre : il le reçoit et le renvoie.
  assert.ok(!BODY.includes('setFilter('), 'plus de setter local');
});

console.log(`\n${passed} test(s) OK`);
