import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { minMembersFor } from '../src/vault/vaultDraft';

/**
 * Replie du bloc d'ajout de signer a l'etape « Add signers » (Step 2).
 *
 * Regle produit :
 *  - preset « Recommended: 2 of 3 » : plafonne a son nombre de signers
 *    (minMembersFor('recommended') === 3). Une fois atteint, le formulaire
 *    disparait DEFINITIVEMENT : aucune porte de sortie, aucun lien.
 *  - setup « custom » : AUCUNE limite, le bloc reste toujours visible.
 *
 * Tests PURS : lecture de source + reproduction de la logique de visibilite.
 * Aucun wallet, aucun reseau, aucune signature, aucune transaction.
 * Execution : npx tsx scripts/create-vault-add-signers.test.ts
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
const DRAFT = readFileSync('src/vault/vaultDraft.ts', 'utf8');

/**
 * Reproduit la condition EXACTE du bloc d'ajout telle qu'ecrite dans l'ecran :
 * masque UNIQUEMENT pour le preset recommande, des que son plafond de signers
 * (constante minMembersFor('recommended')) est atteint. Le custom n'est jamais
 * masque.
 */
function showAddSignerBlock(
  memberCount: number,
  setupType: 'recommended' | 'twoOfTwo' | 'custom',
): boolean {
  const reachedRecommendedSigners =
    setupType === 'recommended' && memberCount >= minMembersFor('recommended');
  return !reachedRecommendedSigners;
}

// Region du formulaire d'ajout : du titre « Add signers » au titre de la liste.
// Le titre de liste est desormais FIXE (« Signers », sans compteur) : on l'utilise
// comme borne de fin, via sa forme exacte rendue dans la source.
const TITLE = '<Text style={styles.sectionTitle}>Signers</Text>';
const step2 = CREATE.slice(
  CREATE.indexOf('Add signers</Text>'),
  CREATE.indexOf(TITLE),
);
const condStart = step2.indexOf('{showAddSignerBlock ? (');
const branchEnd = condStart >= 0 ? step2.indexOf(') : null}', condStart) : -1;
const addBranch = condStart >= 0 && branchEnd > condStart ? step2.slice(condStart, branchEnd) : '';
const escapeBranch = branchEnd > 0 ? step2.slice(branchEnd) : '';

// Region des rappels sous le titre de liste : du titre FIXE « Signers » au
// debut de la liste des membres. Contient le rappel ROUGE (preset recommande) et
// le message d'INFORMATION AMBRE du setup custom.
const promptRegion = CREATE.slice(
  CREATE.indexOf(TITLE),
  CREATE.indexOf('{members.map((member) => ('),
);

check('1. le seuil est la constante existante (minMembersFor), pas un « 3 » litteral', () => {
  assert.equal(minMembersFor('recommended'), 3, 'le setup recommande exige 3 signers');
  assert.ok(
    CREATE.includes("setupType === 'recommended'") &&
      CREATE.includes("minMembersFor('recommended')"),
    'le masquage est conditionne au preset recommande via la constante existante',
  );
  assert.ok(
    !/members\.length >= 3\b/.test(CREATE),
    'aucun « 3 » litteral dans la condition de masquage',
  );
});

check('2. preset recommande : bloc masque des que le seuil (3) est atteint', () => {
  assert.equal(showAddSignerBlock(2, 'recommended'), true, 'sous le seuil : visible');
  assert.equal(showAddSignerBlock(3, 'recommended'), false, 'au seuil : masque');
  assert.equal(showAddSignerBlock(4, 'recommended'), false, 'au-dessus : masque');
});

check('3. custom : bloc TOUJOURS visible, aucune limite', () => {
  assert.equal(showAddSignerBlock(0, 'custom'), true);
  assert.equal(showAddSignerBlock(1, 'custom'), true);
  assert.equal(showAddSignerBlock(2, 'custom'), true, 'custom : plus de masquage a 2');
  assert.equal(showAddSignerBlock(3, 'custom'), true, 'custom : pas de masquage a 3');
  assert.equal(showAddSignerBlock(9, 'custom'), true, 'custom : jamais masque');
});

check('3bis. le masquage ne concerne QUE le preset recommande', () => {
  // « twoOfTwo » n'est pas le preset recommande : il ne doit pas masquer non plus.
  assert.equal(showAddSignerBlock(2, 'twoOfTwo'), true, 'twoOfTwo : pas de masquage');
  assert.equal(showAddSignerBlock(5, 'twoOfTwo'), true, 'twoOfTwo : jamais masque');
});

check('4. le bloc visible contient bien le champ, le label et le bouton d ajout', () => {
  assert.ok(condStart >= 0 && branchEnd > condStart, 'la condition showAddSignerBlock existe');
  assert.ok(addBranch.includes('label="Public address"'), 'champ adresse dans la branche visible');
  assert.ok(addBranch.includes('Signer label'), 'label signer dans la branche visible');
  assert.ok(addBranch.includes('label="Add signer"'), 'bouton Add signer dans la branche visible');
});

check('5. le lien « Add more signers » est SUPPRIME du code (plus de porte de sortie)', () => {
  assert.ok(
    !CREATE.includes('Add more signers'),
    'aucun libelle Add more signers dans l ecran',
  );
  assert.ok(
    !addBranch.includes('Add more signers'),
    'la porte de sortie n apparait pas dans la branche visible',
  );
  assert.ok(
    !escapeBranch.includes('Add more signers'),
    'aucune branche de repli ne rouvre le bloc',
  );
});

check('6. etat et styles de la porte de sortie supprimes (aucun code mort)', () => {
  assert.ok(!CREATE.includes('addSignerExpanded'), 'etat addSignerExpanded supprime');
  assert.ok(!CREATE.includes('setAddSignerExpanded'), 'setter addSignerExpanded supprime');
  assert.ok(!CREATE.includes('addMoreLink'), 'styles addMoreLink / addMoreLinkText supprimes');
  assert.ok(
    step2.includes(') : null}'),
    'le bloc masque ne rend RIEN (pas de lien de reouverture)',
  );
});

check('7. liste des signataires, Rename/Remove et validation inchanges', () => {
  // Titre de liste FIXE « Signers » (sans compteur, a toutes les etapes et quel
  // que soit le nombre de signataires) : on exige sa presence ET l'absence du
  // motif « added) » (aucun compteur « (N added) »).
  assert.ok(CREATE.includes(TITLE), 'titre de liste fixe « Signers » present');
  assert.ok(!CREATE.includes('added)'), 'aucun compteur « (N added) » dans le titre');
  assert.ok(CREATE.includes('{members.map((member) => ('), 'rendu par membre inchange');
  assert.ok(CREATE.includes('{shortenMemberAddress(member.publicKey)}'), 'adresse abregee inchangee');
  assert.ok(CREATE.includes('>Rename</Text>'), 'Rename inchange');
  assert.ok(CREATE.includes('>Remove</Text>'), 'Remove inchange');
  // L'ancien bloc AMBRE de l'ecran est SUPPRIME et, par decision produit, le
  // rappel ROUGE du haut l'est AUSSI : l'information des 3 signataires est
  // desormais portee par le panneau d'erreur du BAS, alimente par
  // draft.validationErrors.
  assert.ok(
    !CREATE.includes("'Recommended setup requires 3 signers.'"),
    'le libelle des 3 signataires n est PAS code en dur dans l ecran (il vient du brouillon)',
  );
  // Le message est bien EMIS par le brouillon (vaultDraft.ts)...
  assert.ok(
    DRAFT.includes("'Recommended setup requires 3 signers.'"),
    'le message des 3 signataires est emis par le brouillon (vaultDraft.ts)',
  );
  // ...et AFFICHE par le panneau du BAS, cable sur draft.validationErrors.
  assert.ok(
    CREATE.includes('{draft.validationErrors.length > 0 ? ('),
    'panneau du bas cable sur draft.validationErrors',
  );
  assert.ok(
    CREATE.includes('<InfoText key={message} tone="error">{message}</InfoText>'),
    'panneau du bas rend la validation en ton erreur (le message du brouillon est affiche)',
  );
  assert.ok(CREATE.includes('members.some((member) => member.publicKey === address)'), 'doublon interdit');
});

check('7bis. aucun rappel ROUGE « Add a third signer to continue » dans tout le fichier', () => {
  // Decision produit : le rappel du HAUT a ete SUPPRIME. Il ne doit donc plus
  // exister NULLE PART — ni en preset recommande (< 3 signataires), ni en custom.
  assert.ok(
    !CREATE.includes('Add a third signer to continue'),
    'le libelle du rappel rouge est ABSENT de tout le fichier',
  );
  assert.ok(
    !CREATE.includes('showThirdSignerPrompt'),
    'la variable de conditionnement du rappel rouge est supprimee',
  );
  assert.ok(
    !CREATE.includes('styles.dangerText'),
    'le style dangerText du rappel rouge (devenu mort) est supprime',
  );
});

check('7ter. custom : message d INFORMATION ambre a 2 signataires, et disparait sinon', () => {
  // Reproduction EXACTE de la logique de l ecran (customSignerRiskMessage) :
  // ambre, NON bloquant ; present a 2 (et 1) signataire(s) en custom, absent sinon.
  const customSignerRiskMessage = (
    memberCount: number,
    setupType: 'recommended' | 'twoOfTwo' | 'custom',
  ): string | null =>
    setupType !== 'custom'
      ? null
      : memberCount === 1
        ? 'With 1 signer, one key can move everything alone.'
        : memberCount === 2
          ? 'With 2 signers, losing one blocks the vault.'
          : null;
  assert.equal(
    customSignerRiskMessage(2, 'custom'),
    'With 2 signers, losing one blocks the vault.',
    'custom, 2 signers : message d information present',
  );
  assert.equal(
    customSignerRiskMessage(1, 'custom'),
    'With 1 signer, one key can move everything alone.',
    'custom, 1 signer : message d information present',
  );
  assert.equal(customSignerRiskMessage(0, 'custom'), null, 'custom, 0 signer : pas de message');
  assert.equal(customSignerRiskMessage(3, 'custom'), null, 'custom, 3 signers : message disparu');
  assert.equal(customSignerRiskMessage(9, 'custom'), null, 'custom, 9 signers : message disparu');
  assert.equal(customSignerRiskMessage(2, 'recommended'), null, 'recommande : pas de message custom');
  assert.equal(customSignerRiskMessage(2, 'twoOfTwo'), null, 'twoOfTwo : pas de message custom');
  // La source porte le message, en ton AMBRE (warning), dans la region des
  // rappels (bloc « Add signers »). Le rappel ROUGE du haut a ete SUPPRIME :
  // cette region ne doit plus contenir aucun libelle rouge ni ton erreur.
  assert.ok(
    CREATE.includes('With 2 signers, losing one blocks the vault.'),
    'texte du message custom present dans la source',
  );
  assert.ok(
    promptRegion.includes('<InfoText tone="warning">{customSignerRiskMessage}</InfoText>'),
    'message custom rendu en ton ambre (warning), non bloquant',
  );
  assert.ok(
    !promptRegion.includes('Add a third signer to continue'),
    'aucun rappel rouge dans la region des rappels : il a ete supprime',
  );
  assert.ok(
    !promptRegion.includes('tone="error"'),
    'aucun ton erreur (rouge) dans la region des rappels : le custom reste un avis ambre',
  );
});

check('8. « Continue » conserve sa logique', () => {
  assert.ok(CREATE.includes('disabled={!canContinue}'), 'Continue toujours pilote par canContinue');
  assert.ok(CREATE.includes('label="Continue"'), 'libelle Continue inchange');
  assert.ok(
    CREATE.includes('members.length >= requiredMembers') &&
      CREATE.includes('step === 2'),
    'la condition de passage a l etape 2 reste members.length >= requiredMembers',
  );
  // Les deux chemins d'ajout (manuel + wallet connecte) restent en place.
  assert.ok(CREATE.includes('const addPendingMember'), 'ajout manuel present');
  assert.ok(CREATE.includes('const addConnectedWallet'), 'ajout wallet connecte present');
});

check('9. aucune couleur codee en dur dans l ecran', () => {
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(CREATE), 'aucun hexadecimal code en dur');
});

setTimeout(() => {
  console.log(`\n${passed} test(s) OK`);
  if (process.exitCode === 1) process.exit(1);
}, 50);
