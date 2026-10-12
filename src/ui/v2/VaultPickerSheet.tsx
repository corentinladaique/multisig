import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import type { MultisigRegistryEntry } from '../../vault/multisigRegistry';
import { archivedSectionLabel } from '../../vault/vaultNavigation';
import { shortenMemberAddress } from '../../vault/vaultDraft';
import { colors, radii, spacing, typography } from '../theme';
import { InfoBox, InfoText } from './primitives';

/**
 * Feuille « My multisigs » — selecteur de vault de l'en-tete Vault.
 *
 * Purement presentationnelle : aucun RPC, aucun wallet, aucune transaction,
 * aucun etat global. Elle recoit les entrees LOCALES deja triees (plus recent
 * d'abord), marque le vault actif et remonte les choix de l'utilisateur. Le
 * chargement reel et la mise a jour de la recence restent au parent.
 *
 * Etape 3 : chaque vault ACTIF porte un menu « ⋯ » (Rename / Archive) ; une
 * section « Archived (N) » repliee, rendue SEULEMENT quand N > 0, liste les
 * vaults archives avec Restore et un menu « ⋯ » (Remove from this device). Les
 * confirmations et les effets vivent dans le parent (source partagee) : cette
 * feuille ne fait que demander une action.
 */

export type VaultStat = { threshold: number | null; memberCount: number | null };

export function VaultPickerSheet({
  activeAddress,
  archivedEntries,
  entries,
  error,
  loading,
  onAddExisting,
  onArchive,
  onClose,
  onCreate,
  onRemove,
  onRename,
  onRestore,
  onRetry,
  onSelect,
  statsByAddress,
  visible,
}: {
  activeAddress: string | null;
  archivedEntries: MultisigRegistryEntry[];
  entries: MultisigRegistryEntry[];
  error: string | null;
  loading: boolean;
  onAddExisting: () => void;
  onArchive: (address: string) => void;
  onClose: () => void;
  onCreate: () => void;
  onRemove: (address: string) => void;
  onRename: (address: string) => void;
  onRestore: (address: string) => void;
  onRetry: () => void;
  onSelect: (address: string) => void;
  statsByAddress: Record<string, VaultStat>;
  visible: boolean;
}) {
  // Quel menu « ⋯ » est ouvert (par adresse), et si la section archivee est ouverte.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const archivedLabel = archivedSectionLabel(archivedEntries.length);

  const thresholdFor = (address: string): string | null => {
    const stat = statsByAddress[address];
    return stat !== undefined && stat.threshold !== null && stat.memberCount !== null
      ? `${stat.threshold} of ${stat.memberCount}`
      : null;
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      transparent
      visible={visible}
    >
      <View style={styles.backdrop}>
        <Pressable
          accessibilityLabel="Close the multisig selector"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdropTouch}
        />
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <Text style={styles.title}>My multisigs</Text>
          <Text style={styles.subtitle}>Saved on this device only.</Text>

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {loading ? <Text style={styles.note}>Loading local registry…</Text> : null}

            {!loading && entries.length === 0 && archivedEntries.length === 0 ? (
              <View style={styles.emptyBox}>
                <Text style={styles.emptyTitle}>No multisigs yet</Text>
                <Text style={styles.emptyText}>Create a vault or add an existing multisig.</Text>
              </View>
            ) : null}

            {entries.map((entry) => {
              const active = entry.address === activeAddress;
              const thresholdLabel = thresholdFor(entry.address);
              const menuOpen = menuFor === entry.address;
              return (
                <View key={entry.address} style={styles.rowBlock}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Select ${entry.vaultName.length > 0 ? entry.vaultName : entry.address}`}
                    accessibilityState={{ selected: active }}
                    onPress={() => {
                      setMenuFor(null);
                      onSelect(entry.address);
                    }}
                    style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                  >
                    <View style={styles.rowBody}>
                      <Text numberOfLines={1} style={styles.rowName}>
                        {entry.vaultName.length > 0 ? entry.vaultName : 'Untitled vault'}
                      </Text>
                      <Text numberOfLines={1} style={styles.rowAddress}>
                        {shortenMemberAddress(entry.address)}
                      </Text>
                      {thresholdLabel !== null ? (
                        <Text style={styles.rowMeta}>{thresholdLabel}</Text>
                      ) : null}
                    </View>
                    {active ? (
                      <Ionicons color={colors.mint} name="checkmark" size={20} />
                    ) : null}
                    {/* Menu « ⋯ » de la ligne active : Rename / Archive. */}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Options for ${entry.vaultName.length > 0 ? entry.vaultName : entry.address}`}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      onPress={() => setMenuFor(menuOpen ? null : entry.address)}
                      style={({ pressed }) => [styles.menuTrigger, pressed && styles.rowPressed]}
                    >
                      <Text style={styles.menuGlyph}>⋯</Text>
                    </Pressable>
                  </Pressable>
                  {menuOpen ? (
                    <View style={styles.menu}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Rename ${entry.vaultName.length > 0 ? entry.vaultName : entry.address}`}
                        onPress={() => {
                          setMenuFor(null);
                          onRename(entry.address);
                        }}
                        style={({ pressed }) => [styles.menuItem, pressed && styles.rowPressed]}
                      >
                        <Text style={styles.menuItemText}>Rename</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Archive ${entry.vaultName.length > 0 ? entry.vaultName : entry.address}`}
                        onPress={() => {
                          setMenuFor(null);
                          onArchive(entry.address);
                        }}
                        style={({ pressed }) => [styles.menuItem, pressed && styles.rowPressed]}
                      >
                        <Text style={styles.menuItemText}>Archive</Text>
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              );
            })}

            {/* Section « Archived (N) » : rendue SEULEMENT quand N > 0. */}
            {archivedLabel !== null ? (
              <View style={styles.archivedSection}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={archivedLabel}
                  accessibilityState={{ expanded: archivedOpen }}
                  onPress={() => setArchivedOpen((previous) => !previous)}
                  style={({ pressed }) => [styles.archivedHeader, pressed && styles.rowPressed]}
                >
                  <Ionicons
                    color={colors.textSecondary}
                    name={archivedOpen ? 'chevron-down' : 'chevron-forward'}
                    size={16}
                  />
                  <Text style={styles.archivedHeaderText}>{archivedLabel}</Text>
                </Pressable>
                {archivedOpen
                  ? archivedEntries.map((entry) => {
                      const thresholdLabel = thresholdFor(entry.address);
                      const menuOpen = menuFor === entry.address;
                      return (
                        <View key={entry.address} style={styles.rowBlock}>
                          <View style={styles.row}>
                            <View style={styles.rowBody}>
                              <Text numberOfLines={1} style={styles.rowName}>
                                {entry.vaultName.length > 0 ? entry.vaultName : 'Untitled vault'}
                              </Text>
                              <Text numberOfLines={1} style={styles.rowAddress}>
                                {shortenMemberAddress(entry.address)}
                              </Text>
                              {thresholdLabel !== null ? (
                                <Text style={styles.rowMeta}>{thresholdLabel}</Text>
                              ) : null}
                            </View>
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`Restore ${entry.vaultName.length > 0 ? entry.vaultName : entry.address}`}
                              onPress={() => onRestore(entry.address)}
                              style={({ pressed }) => [styles.restoreAction, pressed && styles.rowPressed]}
                            >
                              <Text style={styles.restoreText}>Restore</Text>
                            </Pressable>
                            {/* « Remove from this device » N'EXISTE que pour les archives. */}
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`Options for archived ${entry.vaultName.length > 0 ? entry.vaultName : entry.address}`}
                              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                              onPress={() => setMenuFor(menuOpen ? null : entry.address)}
                              style={({ pressed }) => [styles.menuTrigger, pressed && styles.rowPressed]}
                            >
                              <Text style={styles.menuGlyph}>⋯</Text>
                            </Pressable>
                          </View>
                          {menuOpen ? (
                            <View style={styles.menu}>
                              <Pressable
                                accessibilityRole="button"
                                accessibilityLabel="Remove from this device"
                                onPress={() => {
                                  setMenuFor(null);
                                  onRemove(entry.address);
                                }}
                                style={({ pressed }) => [styles.menuItem, pressed && styles.rowPressed]}
                              >
                                <Text style={styles.menuItemTextDanger}>Remove from this device</Text>
                              </Pressable>
                            </View>
                          ) : null}
                        </View>
                      );
                    })
                  : null}
              </View>
            ) : null}

            {error !== null ? (
              <InfoBox glyph="⚠" style={styles.infoBox} tone="warning">
                <InfoText tone="warning">{error}</InfoText>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Retry loading this multisig"
                  onPress={onRetry}
                  style={styles.inlineAction}
                >
                  <Text style={styles.inlineActionText}>Retry</Text>
                </Pressable>
              </InfoBox>
            ) : null}
          </ScrollView>

          <View style={styles.footer}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Create a vault"
              onPress={onCreate}
              style={({ pressed }) => [styles.footerAction, pressed && styles.footerActionPressed]}
            >
              <Text style={styles.footerPrimary}>Create a vault</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add existing multisig"
              onPress={onAddExisting}
              style={({ pressed }) => [styles.footerAction, pressed && styles.footerActionPressed]}
            >
              <Text style={styles.footerSecondary}>Add existing multisig</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
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
  sheet: {
    backgroundColor: colors.background,
    borderColor: colors.divider,
    borderTopLeftRadius: radii.card,
    borderTopRightRadius: radii.card,
    borderWidth: 1,
    maxHeight: '80%',
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
  list: {
    marginTop: spacing.md,
  },
  listContent: {
    paddingBottom: spacing.sm,
  },
  note: {
    color: colors.textMuted,
    fontSize: typography.secondary,
    marginTop: spacing.sm,
  },
  emptyBox: {
    backgroundColor: colors.surface,
    borderColor: colors.divider,
    borderRadius: radii.card,
    borderStyle: 'dashed',
    borderWidth: 1,
    marginTop: spacing.md,
    padding: spacing.lg,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '800',
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: typography.secondary,
    marginTop: spacing.sm,
  },
  rowBlock: {
    marginTop: spacing.sm,
  },
  row: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.divider,
    borderRadius: radii.card,
    borderWidth: 1,
    flexDirection: 'row',
    minHeight: 64,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  rowPressed: {
    backgroundColor: colors.surfaceElevated,
  },
  rowBody: {
    flex: 1,
    marginRight: spacing.sm,
  },
  rowName: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '800',
  },
  rowAddress: {
    color: colors.textSecondary,
    fontFamily: 'monospace',
    fontSize: typography.caption,
    marginTop: 2,
  },
  rowMeta: {
    color: colors.mint,
    fontSize: typography.caption,
    fontWeight: '700',
    marginTop: 2,
  },
  menuTrigger: {
    alignItems: 'center',
    borderRadius: radii.pill,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  menuGlyph: {
    color: colors.textSecondary,
    fontSize: 22,
    fontWeight: '800',
  },
  menu: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.divider,
    borderRadius: radii.card,
    borderWidth: 1,
    marginTop: spacing.xs,
    paddingVertical: spacing.xs,
  },
  menuItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  menuItemText: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '700',
  },
  menuItemTextDanger: {
    color: colors.error,
    fontSize: typography.body,
    fontWeight: '700',
  },
  archivedSection: {
    borderTopColor: colors.divider,
    borderTopWidth: 1,
    marginTop: spacing.lg,
    paddingTop: spacing.sm,
  },
  archivedHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
  },
  archivedHeaderText: {
    color: colors.textSecondary,
    fontSize: typography.bodySmall,
    fontWeight: '800',
  },
  restoreAction: {
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  restoreText: {
    color: colors.mint,
    fontSize: typography.secondary,
    fontWeight: '800',
  },
  // Encart d'avertissement du chargement (ton `warning`, tokens du theme
  // `warningSoft` / `warning` — aucune couleur codee en dur).
  //
  // VARIANTE C (decision utilisateur) : le glyphe ⚠ est CONSERVE (`glyph="⚠"`
  // passe a la primitive `InfoBox`) et le panneau reste ALIGNE sur le bord des
  // cartes de vault (bord du panneau = bord des cartes = `padding: spacing.lg`
  // de la feuille ; aucun inset negatif, aucune indentation). Le titre
  // « Could not load this multisig » demarre donc APRES le glyphe, a l'interieur
  // du corps du message : le leger decalage a droite est accepte explicitement.
  //
  // `alignItems: 'flex-start'` (token de mise en page, pas de valeur codee en
  // dur) place le glyphe sur la MEME PREMIERE LIGNE que le titre : sans cela,
  // l'alignement CENTRE herite par le style local centrerait verticalement le ⚠
  // au milieu du bloc titre+bouton. La primitive `InfoBox` empile deja le glyphe
  // (largeur + `marginRight: spacing.sm`) PUIS le corps (`flex: 1`) sur une
  // meme rangee ; titre et bouton « Retry » partagent donc la meme colonne, a
  // droite du glyphe.
  infoBox: {
    alignItems: 'flex-start',
    marginTop: spacing.md,
  },
  inlineAction: {
    alignSelf: 'flex-start',
    borderRadius: radii.pill,
    marginTop: spacing.xs,
    paddingVertical: spacing.xs,
  },
  inlineActionText: {
    color: colors.mint,
    fontSize: typography.secondary,
    fontWeight: '700',
  },
  footer: {
    borderTopColor: colors.divider,
    borderTopWidth: 1,
    gap: spacing.sm,
    marginTop: spacing.lg,
    paddingTop: spacing.lg,
  },
  footerAction: {
    alignItems: 'center',
    borderRadius: radii.button,
    justifyContent: 'center',
    minHeight: 48,
  },
  footerActionPressed: {
    opacity: 0.82,
  },
  footerPrimary: {
    color: colors.mint,
    fontSize: typography.body + 1,
    fontWeight: '700',
  },
  footerSecondary: {
    color: colors.textSecondary,
    fontSize: typography.body + 1,
    fontWeight: '700',
  },
});
