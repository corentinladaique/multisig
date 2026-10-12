import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  THREE_MEMBER_RECOMMENDATION,
  THREE_MEMBER_RECOMMENDATION_DETAIL,
} from '../src/vault/thresholdRecommendation';
import { thresholdGuidanceFor } from '../src/vault/thresholdGuidance';

/**
 * Guidance de seuil de l'etape « Threshold » (vault de TROIS signataires) :
 * le TON et les TEXTES suivent le seuil choisi. Aucun wallet, aucun reseau.
 * npx tsx scripts/create-vault-threshold-guidance.test.ts
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

check('1. seuil 1 (of 3) : ton danger + textes de risque', () => {
  const guidance = thresholdGuidanceFor(3, 1);
  assert.ok(guidance !== null);
  assert.equal(guidance?.tone, 'error', 'ton danger (rouge)');
  assert.equal(guidance?.label, 'Not recommended: 1 of 3');
  assert.equal(
    guidance?.detail,
    'Any single signer can move funds alone. One compromised or malicious signer takes everything.',
  );
  assert.equal(
    guidance?.summary,
    'With 1 of 3, a single signer can approve alone. Approval is never shared.',
  );
  // Le danger n'est JAMAIS un ton de recommandation.
  assert.notEqual(guidance?.tone, 'success');
});

check('2. seuil 2 (of 3) : ton vert recommande, textes INCHANGES', () => {
  const guidance = thresholdGuidanceFor(3, 2);
  assert.ok(guidance !== null);
  assert.equal(guidance?.tone, 'success', 'ton recommande (vert)');
  assert.equal(guidance?.label, THREE_MEMBER_RECOMMENDATION);
  assert.equal(guidance?.label, 'Recommended: 2 of 3');
  assert.equal(guidance?.detail, THREE_MEMBER_RECOMMENDATION_DETAIL);
  assert.equal(
    guidance?.detail,
    'Two members must approve. One unavailable member cannot block the vault.',
  );
  assert.equal(
    guidance?.summary,
    'With 2 of 3, any two signers can approve. The vault remains accessible if one signer is unavailable.',
  );
});

check('3. seuil 3 (of 3) : ton avertissement + textes de disponibilite', () => {
  const guidance = thresholdGuidanceFor(3, 3);
  assert.ok(guidance !== null);
  assert.equal(guidance?.tone, 'warning', 'ton avertissement (ambre)');
  assert.equal(guidance?.label, 'Risky: 3 of 3');
  assert.equal(
    guidance?.detail,
    'All three members must approve. If one signer is unavailable, the vault is blocked.',
  );
  assert.equal(
    guidance?.summary,
    'With 3 of 3, all three approvals are required. Losing one signer makes the vault unusable.',
  );
  // L'avertissement n'est jamais ni recommande ni un danger destructif.
  assert.notEqual(guidance?.tone, 'success');
  assert.notEqual(guidance?.tone, 'error');
});

check('4. hors 3 signataires : aucune guidance forcee', () => {
  assert.equal(thresholdGuidanceFor(2, 1), null);
  assert.equal(thresholdGuidanceFor(2, 2), null);
  assert.equal(thresholdGuidanceFor(4, 3), null);
  assert.equal(thresholdGuidanceFor(5, 2), null);
});

check('5. seuil hors bornes (3 signataires) : aucune guidance', () => {
  assert.equal(thresholdGuidanceFor(3, 0), null);
  assert.equal(thresholdGuidanceFor(3, 4), null);
});

check('6. la recommandation 2 of 3 reste la SEULE source du panneau vert', () => {
  // Le panneau vert ne doit jamais diverger des constantes figees du module.
  const guidance = thresholdGuidanceFor(3, 2, null);
  assert.equal(guidance?.label, THREE_MEMBER_RECOMMENDATION);
  assert.equal(guidance?.detail, THREE_MEMBER_RECOMMENDATION_DETAIL);
});

check('7. le module de guidance reste PUR (aucun react-native)', () => {
  const module = readFileSync('src/vault/thresholdGuidance.ts', 'utf8');
  assert.ok(!/from\s+['"]react-native['"]/.test(module), "aucun import react-native");
  for (const forbidden of ['Connection', 'signAndSend', 'authorize', 'await ']) {
    assert.ok(!module.includes(forbidden), `interdit: ${forbidden}`);
  }
});

check('8. l ecran rend le panneau depuis la guidance, tons du theme uniquement', () => {
  // Le panneau ET la phrase proviennent de la MEME guidance (aucun texte fige).
  assert.ok(CREATE.includes('thresholdGuidanceFor('), 'guidance derivee du seuil');
  assert.ok(CREATE.includes('thresholdGuidance !== null'), 'rendu conditionne a la guidance');
  assert.ok(CREATE.includes('tone={thresholdGuidance.tone}'), 'ton du panneau selon le choix');
  assert.ok(CREATE.includes('{thresholdGuidance.label}'), 'titre selon le choix');
  assert.ok(CREATE.includes('{thresholdGuidance.detail}'), 'corps selon le choix');
  assert.ok(CREATE.includes('{thresholdGuidance.summary}'), 'phrase recapitulative selon le choix');
  // Ancien texte fige (incoherent des qu'on change de seuil) retire de l ecran.
  assert.ok(
    !CREATE.includes('With 2 of 3, any two signers can approve. The vault remains accessible if one signer'),
    'recapitulatif code en dur retire',
  );
  // Aucune couleur codee en dur dans l ecran : uniquement des tokens du theme.
  assert.ok(!CREATE.includes('#'), 'aucune couleur codee en dur');
});

setTimeout(() => {
  console.log(`\n${passed} test(s) OK`);
  if (process.exitCode === 1) process.exit(1);
}, 50);
