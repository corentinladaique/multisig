import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radii, spacing, typography } from '../theme';

/**
 * Feuille « Wallet help » — aide locale de l'écran de connexion du wallet.
 *
 * Purement présentationnelle : aucun RPC, aucun wallet, aucune transaction,
 * aucun état global. Elle n'affiche qu'UN SEUL dépannage (le tap « Always » du
 * dialogue « Open with » d'Android, qui verrouille un wallet par défaut) et
 * rend la main au parent via `onClose` (bouton « Got it », appui sur le fond,
 * ou retour Android). Primitives RN natives uniquement (View / Text / Pressable /
 * Modal) : aucun paquet d'icônes, aucun SVG, aucune couleur codée en dur.
 */
export function WalletHelpSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={visible}>
      <View style={styles.backdrop}>
        <Pressable
          accessibilityLabel="Close wallet help"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdropTouch}
        />
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <Text style={styles.title}>Wallet help</Text>
          <Text style={styles.subtitle}>Quick fixes when the wallet does not open.</Text>

          {/* UN SEUL dépannage. Les deux autres pistes ont été retirées sur
              décision explicite de l'utilisateur : la feuille reste focalisée
              sur le cas le plus fréquent (dialogue « Open with » d'Android). */}
          <View style={styles.item}>
            <Text style={styles.itemTitle}>A wallet won't open?</Text>
            <Text style={styles.itemBody}>
              If you tapped “Always” in Android's “Open with” dialog, one wallet may be blocking the others.
            </Text>
            <View style={styles.instructionBox}>
              <Text style={styles.instructionText}>
                Settings → Apps → [your wallet] → Open by default → Clear defaults
              </Text>
            </View>
          </View>

          <Pressable
            accessibilityLabel="Got it"
            accessibilityRole="button"
            onPress={onClose}
            style={({ pressed }) => [styles.closeAction, pressed && styles.closeActionPressed]}
          >
            <Text style={styles.closeText}>Got it</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // Fond assombri, identique à la feuille « My multisigs » et aux dialogues.
  backdrop: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdropTouch: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  // Feuille remontant du bas, coins arrondis, surface du thème uniquement.
  sheet: {
    backgroundColor: colors.surface,
    borderColor: colors.divider,
    borderTopLeftRadius: radii.card,
    borderTopRightRadius: radii.card,
    borderWidth: 1,
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  grabber: {
    alignSelf: 'center',
    backgroundColor: colors.divider,
    borderRadius: radii.pill,
    height: 4,
    marginBottom: spacing.md,
    width: 44,
  },
  title: {
    color: colors.text,
    fontSize: typography.sectionTitle + 2,
    fontWeight: '800',
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: typography.bodySmall,
    marginTop: spacing.xs,
  },
  item: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.divider,
    borderRadius: radii.card,
    borderWidth: 1,
    marginTop: spacing.lg,
    padding: spacing.lg,
  },
  itemTitle: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '800',
  },
  itemBody: {
    color: colors.textSecondary,
    fontSize: typography.secondary,
    lineHeight: 20,
    marginTop: spacing.sm,
  },
  // Consigne Android mise en évidence : encart creusé, texte mint.
  instructionBox: {
    backgroundColor: colors.surface,
    borderRadius: radii.field,
    marginTop: spacing.md,
    padding: spacing.md,
  },
  instructionText: {
    color: colors.mint,
    fontSize: typography.secondary,
    fontWeight: '700',
  },
  // Bouton de fermeture « Got it » : ghost pill (surface élevée, texte mint).
  closeAction: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderRadius: radii.button,
    justifyContent: 'center',
    marginTop: spacing.lg,
    minHeight: 48,
  },
  closeActionPressed: {
    opacity: 0.82,
  },
  closeText: {
    color: colors.mint,
    fontSize: typography.body,
    fontWeight: '700',
  },
});
