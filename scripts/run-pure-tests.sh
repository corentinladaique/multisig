#!/usr/bin/env bash
#
# Tests PURS du projet : aucun RPC, aucun wallet, aucune signature, aucune
# transaction, aucune fixture on-chain.
#
# Les scripts « *.check.ts » sont VOLONTAIREMENT EXCLUS : ils font des lectures
# reseau / des fixtures devnet et ne doivent jamais tourner automatiquement.
#
# Usage : npm test
set -u

cd "$(dirname "$0")/.." || exit 1

files=(
  scripts/account-tab.test.ts
  scripts/account-tab-alignment.test.ts
  scripts/address-paste.test.ts
  scripts/approval-auto-verify.test.ts
  scripts/approval-hotfix-sol.test.ts
  scripts/attempt-outcome.test.ts
  scripts/build-proposal-creation.test.ts
  scripts/check-transaction-again.test.ts
  scripts/connect-fixes.test.ts
  scripts/create-vault-add-signers.test.ts
  scripts/create-vault-cancelled.test.ts
  scripts/create-vault-end.test.ts
  scripts/create-vault-offline-feedback.test.ts
  scripts/create-vault-preview-removed.test.ts
  scripts/create-vault-step5.test.ts
  scripts/create-vault-threshold-guidance.test.ts
  scripts/execution-approval-contradiction.test.ts
  scripts/execution-guard-runtime.test.ts
  scripts/execution-verification-recovery.test.ts
  scripts/home-dashboard.test.ts
  scripts/home-hotfix.test.ts
  scripts/hook-order.test.ts
  scripts/learn-back.test.ts
  scripts/learn-step-one-back.test.ts
  scripts/max-transfer.test.ts
  scripts/multisig-creation-build.test.ts
  scripts/multisig-creation-readback.test.ts
  scripts/multisig-keyboard-load.test.ts
  scripts/multisig-registry-storage.test.ts
  scripts/multisig-registry.test.ts
  scripts/mwa-diagnostics.test.ts
  scripts/navigation-refresh.test.ts
  scripts/new-proposal-ux.test.ts
  scripts/onboarding.test.ts
  scripts/onboarding-answers.test.ts
  scripts/operation-state.test.ts
  scripts/proposal-creation-preflight.test.ts
  scripts/proposal-creation-steps.test.ts
  scripts/proposal-created-feedback.test.ts
  scripts/proposal-detail-decode.test.ts
  scripts/proposal-details-states.test.ts
  scripts/proposal-list-refresh.test.ts
  scripts/proposal-network-incident.test.ts
  scripts/proposal-preparation-cancelled.test.ts
  scripts/proposal-return-filter.test.ts
  scripts/refresh-on-resume.test.ts
  scripts/safe-area.test.ts
  scripts/sign-and-send-proposal-creation.test.ts
  scripts/signing-window.test.ts
  scripts/simulate-proposal-creation.test.ts
  scripts/sol-cost-display.test.ts
  scripts/transaction-review-read-only.test.ts
  scripts/ui-release-review.test.ts
  scripts/ui-v2.test.ts
  scripts/ui-v2-corrections.test.ts
  scripts/ui-v2-coherence.test.ts
  scripts/ui-v2-group2.test.ts
  scripts/ui-v2-group4.test.ts
  scripts/ui-v2-group25.test.ts
  scripts/ui-v2-ux-p0.test.ts
  scripts/ui-v2-group3-form.test.ts
  scripts/ui-v2-group3-details.test.ts
  scripts/vault-add-persist.test.ts
  scripts/vault-address-toggle.test.ts
  scripts/vault-archive.test.ts
  scripts/vault-balance.test.ts
  scripts/vault-create-persist.test.ts
  scripts/vault-draft.test.ts
  scripts/vault-load-failure-panel.test.ts
  scripts/vault-loading-conditional.test.ts
  scripts/vault-loading-mark.test.ts
  scripts/vault-mark-seams.test.ts
  scripts/vault-manage-collapse.test.ts
  scripts/vault-selector.test.ts
  scripts/vault-name-required.test.ts
  scripts/view-proposals-success.test.ts
  scripts/wallet-help.test.ts
  scripts/wallet-identity-refresh.test.ts
)

failed=0
log=/tmp/pocket-multisig-tests.log

for file in "${files[@]}"; do
  if ! npx tsx "$file" >"$log" 2>&1; then
    echo "FAIL $file"
    tail -n 20 "$log"
    failed=$((failed + 1))
  else
    echo "ok   $file"
  fi
done

echo
if [ "$failed" -ne 0 ]; then
  echo "$failed fichier(s) de test en echec."
  exit 1
fi
echo "Tous les tests purs passent (${#files[@]} fichiers)."
