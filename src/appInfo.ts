// Identité RÉELLE de l'application, lue depuis `app.json` (la source de build
// d'Expo) — jamais une valeur codée en dur, qui deviendrait fausse au build
// suivant.
//
// Pourquoi ce module plutôt que `expo-constants` ? `expo-constants` N'EST PAS
// une dépendance du projet et il est interdit d'en ajouter une. En revanche
// `resolveJsonModule` est activé (via `expo/tsconfig.base`), donc importer
// `app.json` est la voie propre : la version suit automatiquement chaque bump
// de `app.json` (et de `android/app/build.gradle`, tenus en phase).
//
// Module PUR (aucun import `react-native`), donc importable depuis un test
// `tsx` comme depuis l'app.
import appJson from '../app.json';

const expo = appJson.expo;

/** Nom affiché de l'application (accorde avec `app.json` -> expo.name). */
export const APP_NAME = expo.name;

/** Version affichée, lue depuis `app.json` -> expo.version. */
export const APP_VERSION = expo.version;

/** Numéro de build Android, lu depuis `app.json` -> expo.android.versionCode. */
export const APP_BUILD = String(expo.android.versionCode);
