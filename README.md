```
███╗   ███╗ █████╗ ██╗██╗         ███████╗ ██████╗ ██████╗ ████████╗███████╗██████╗      █████╗ ██╗
████╗ ████║██╔══██╗██║██║         ██╔════╝██╔═══██╗██╔══██╗╚══██╔══╝██╔════╝██╔══██╗    ██╔══██╗██║
██╔████╔██║███████║██║██║         ███████╗██║   ██║██████╔╝   ██║   █████╗  ██████╔╝    ███████║██║
██║╚██╔╝██║██╔══██║██║██║         ╚════██║██║   ██║██╔══██╗   ██║   ██╔══╝  ██╔══██╗    ██╔══██║██║
██║ ╚═╝ ██║██║  ██║██║███████╗    ███████║╚██████╔╝██║  ██║   ██║   ███████╗██║  ██║    ██║  ██║██║
╚═╝     ╚═╝╚═╝  ╚═╝╚═╝╚══════╝    ╚══════╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝    ╚═╝  ╚═╝╚═╝
              Gmail trié par l'IA · 6 providers · failover auto
```

# Mail Sorter AI

Application **desktop** (Electron + React + TypeScript) qui trie automatiquement
vos mails **Gmail** grâce à des modèles d'IA **gratuits** via **6 fournisseurs**
avec **failover automatique** et **tri par lot**.

> **Installeur Windows** : voir l'onglet
> [Releases](https://github.com/ATSDopi/ATS-Mail-Sorter/releases) — téléchargez
> le `Setup.exe`, installez, suivez le guide de configuration ci-dessous.

L'IA catégorise chaque mail (Travail, Personnel, Factures, Promotions, Spam…),
puis l'app **applique le label Gmail correspondant** et **archive** le mail si la
catégorie est configurée pour.

## Fonctionnalités

- Connexion Gmail via **OAuth 2.0 + PKCE** (loopback redirect, aucune donnée
  envoyée à un tiers).
- **6 fournisseurs IA** avec failover automatique :
  - **OpenRouter** (20 RPM, 50 req/jour gratuit)
  - **NVIDIA NIM** (40 RPM)
  - **Groq** (30 RPM, 1000 req/jour)
  - **Google Gemini** (15 RPM, 1000 req/jour)
  - **SambaNova** (20 RPM)
  - **Cerebras** (30 RPM)
- **Rotation de modèles par clé** : chaque provider porte une file ordonnée
  de modèles (auto-découverts + liste curée). Quota journalier épuisé ou
  modèle rate-limité → bascule immédiate sur le modèle suivant **de la même
  clé**. Les quotas gratuits sont par modèle : une clé Gemini sert
  `flash-lite-latest` → `2.5-flash-lite` → `2.5-flash` → …
- **Taxonomie d'erreurs fine** :
  - 429 RPM → cooldown court **du modèle** (Retry-After honoré)
  - Quota journalier / crédits (429+quota, 402) → pause longue jusqu'au
    reset (minuit PT) + rotation immédiate
  - Clé invalide (401/403/400-clé) → provider entier retiré de la session
  - Modèle mort (404/410/400-modèle) → retiré de la file, rotation
- **RPM suivi par modèle** (pas par clé) : les modèles d'une même clé
  travaillent en parallèle, chacun sous sa propre fenêtre de 60s.
- **Workers IA parallèles** : jusqu'à 4 workers (1 par provider) qui
  pipelinent métadonnées → IA → labels.
- **Tri par lot** : 8 mails catégorisés en une seule requête IA.
- **Auto-discovery multi-modèles** : au save d'une clé, valide jusqu'à 4
  modèles triés par qualité (primary + file de rotation). Si tous les
  modèles échouent au démarrage du tri, relance un discovery.
- **Health scoring** : succès (40%) + latence (25%) + charge RPM (25%)
  − échecs récents, switch immédiat sur erreur.
- **Mode Dry Run** : catégorise sans déplacer les mails (pour tester).
- **Onglet Debug** : logs en temps réel + stats providers + bouton test des providers.
- **ETA en temps réel** : taux de traitement + temps restant estimé.
- **Bouton d'arrêt** du tri en temps réel.
- Catégories **personnalisables** (nom, label Gmail, archivage automatique).
- **Favoris (★)** : les mails marqués d'une étoile dans Gmail sont **intouchables**
  par l'IA.
- Tri **par lot** (N derniers mails) ou **tous les mails** de la boîte de réception.
- Skip automatique des mails **déjà triés** (label de catégorie déjà appliqué).
- Justification + score de confiance affichés pour chaque tri.
- **Onboarding guidé** : checklist de mise en route à la première ouverture.
- **Cartes providers** : statut de chaque clé, modèle auto-découvert, test
  individuel, affichage/masquage, lien direct vers la console du provider.
- **Résumé post-tri** : répartition par catégorie en barres colorées.
- **Santé live des providers** pendant le tri (latence, succès/échecs).
- **Ouverture dans Gmail** d'un mail en un clic.
- **Labels appliqués en masse** via `messages/batchModify` (jusqu'à 1000
  mails par requête Gmail au lieu d'une par mail).
- **Chargement parallèle** des métadonnées mails (pool de 8).
- **Logs persistants** (rotation 5 MB) dans le répertoire de données de l'app.
- Paramètres persistés localement (fichier JSON, **secrets chiffrés**, pas de
  télémétrie).

## Pré-requis

- Node.js 18+ et npm.
- Windows / macOS / Linux.

## Installation

```bash
git clone https://github.com/ATSDopi/ATS-Mail-Sorter.git
cd ATS-Mail-Sorter
npm install
```

> Si l'installation échoue avec une erreur de cache `EBUSY`, relancez
> `npm install --force` puis `node node_modules/electron/install.js` si le
> binaire Electron n'est pas téléchargé automatiquement.

## Lancement en développement

```bash
npm run dev
```

Lance le serveur Vite (renderer) puis l'app Electron qui s'y connecte.

## Build de production

```bash
npm run build        # compile renderer + main process
npm run package      # build + empaquète un installeur (electron-builder)
npm test             # tests unitaires (vitest)
npm run typecheck    # vérification TS renderer + electron
npm run icon         # régénère l'icône de l'app (build/icon.png + icon.ico)
```

L'installeur est généré dans `release/`.

---

## Configuration — étape par étape

### 1. Créer un identifiant OAuth Google (obligatoire)

1. Allez sur **Google Cloud Console** : https://console.cloud.google.com/
2. Créez (ou sélectionnez) un projet.
3. **APIs & Services → Library** → cherchez **Gmail API** → **Enable**.
4. **APIs & Services → OAuth consent screen** :
   - User type : **External** (ou Internal si compte Google Workspace).
   - Remplissez le nom de l'app, votre email.
   - Ajoutez le scope `https://mail.google.com/` (ou `gmail.modify`).
   - Ajoutez votre adresse Gmail dans **Test users**.
5. **APIs & Services → Credentials → Create Credentials → OAuth client ID** :
   - Application type : **Desktop app**.
   - Nom : `Mail Sorter AI`.
   - Récupérez le **Client ID** et le **Client Secret**.

### 2. Renseigner les identifiants dans l'app

Onglet **Paramètres** :

- **Client ID** : collez le Client ID Google.
- **Client Secret** : collez le Client Secret Google.
- **Port de redirection OAuth** : `14250` par défaut.

Cliquez **Enregistrer**, puis **Connecter Gmail** dans la barre supérieure.

### 3. Configurer les fournisseurs IA (au moins 1)

Renseignez au moins une clé API. Plus vous en renseignez, plus le failover est
résilient :

| Provider | RPM | Req/jour | URL clé API |
|---|---|---|---|
| OpenRouter | 20 | 50 | https://openrouter.ai/keys |
| NVIDIA NIM | 40 | ~1000 | https://build.nvidia.com |
| Groq | 30 | 1000 | https://console.groq.com/keys |
| Google Gemini | 15 | 1000 | https://aistudio.google.com/apikey |
| SambaNova | 20 | ~1000 | https://cloud.sambanova.ai |
| Cerebras | 30 | ~1000 | https://cloud.cerebras.ai |

L'**auto-discovery** teste automatiquement les modèles disponibles au moment
de l'enregistrement et sélectionne le meilleur pour chaque provider. Aucune
sélection manuelle nécessaire.

### 4. Catégories

Par défaut : Favoris (★), Travail, Personnel, Factures, Promotions, Réseaux
sociaux, Notifications, Spam, Autre. Vous pouvez :

- Renommer une catégorie.
- Spécifier un **label Gmail** personnalisé (sinon = nom de la catégorie).
- Cocher **Archiver** pour retirer le mail de la boîte de réception après tri.
- Ajouter / supprimer des catégories.
- **Favoris (★)** est protégée : les mails starred ne sont jamais touchés.

### 5. Trier

Onglet **Mails** :

- **Rafraîchir (lot)** : charge les N derniers mails.
- **Charger tous les mails** : récupère toute la boîte de réception (pagination).
- **Trier le lot par IA** : catégorise les N mails chargés (batch de 5 par requête IA).
- **Trier tous les mails par IA** : catégorise toute la boîte de réception.
- **Dry Run** : cochez pour catégoriser **sans déplacer** les mails (test).
- **⏹ Arrêter le tri** : stoppe le tri en cours immédiatement.

Onglet **Debug** :

- **Tester les providers** : teste toutes les clés API configurées en parallèle.
- **Stats providers** : état en temps réel (cooldowns, succès, latence).
- **Logs** : dernières 200 lignes du fichier de log persistant.

---

## Architecture

```
ATS-Mail-Sorter/
├── electron/                  # Main process Electron (Node.js / TypeScript)
│   ├── main.ts                # Création de la fenêtre, entry point, logs persistants
│   ├── preload.ts             # Bridge contextIsolation → window.mailSorter
│   ├── ipc.ts                 # Handlers IPC (settings, gmail, ai, tri par lot)
│   ├── oauth.ts               # OAuth 2.0 + PKCE, serveur loopback
│   ├── gmail.ts               # Client API Gmail REST (metadata + batch labels)
│   ├── ai.ts                  # 6 providers + failover + batch + cooldowns
│   ├── ai-discovery.ts        # Auto-discovery des modèles (6 providers)
│   ├── store.ts               # Persistance JSON atomique + safeStorage
│   ├── simulate.ts            # Simulation du failover sans Gmail
│   └── types.ts               # Types partagés
├── src/                       # Renderer React (UI)
│   ├── App.tsx                # Shell : onglets, alertes, état global, events IPC
│   ├── App.css                # Design system (tokens, dark « mission control »)
│   ├── types.ts               # Types + wrapper window.mailSorter
│   ├── main.tsx               # Point d'entrée React
│   ├── utils/format.ts        # Meta providers, couleurs catégories, dates FR
│   └── components/            # EmailList, MailRow, SortProgress, SortSummary,
│                              # SettingsPanel, DebugPanel, Onboarding,
│                              # ErrorBoundary, icons (SVG inline)
├── tests/                     # Tests vitest (parsing IA, scoring discovery)
├── build/gen-icon.cjs         # Générateur d'icône (raster SDF, zéro dep)
├── .github/workflows/ci.yml   # CI : typecheck + tests + build
├── electron/tsconfig.json     # Compilation TS du main process (CommonJS)
└── package.json
```

### Flux de tri

1. **Test préliminaire** : teste tous les providers configurés (1 requête test chacun,
   en parallèle). Si tous échouent → auto-discovery automatique.
2. L'app récupère les mails (`GET /gmail/v1/users/me/messages`, pagination 500/page).
3. Récupère les labels Gmail existants (1 appel, mis en cache).
4. **Tri par lot de 8 mails, N workers en parallèle** (N = nb de providers,
   max 4) : chaque worker pioche le lot suivant, précharge ses métadonnées
   pendant que l'IA tourne (pipeline).
   a. Métadonnées en parallèle (`format=metadata`, pool de 8).
   b. Skip les **starred** (protégés) et les **déjà triés** (compteur « ignorés »).
   c. Envoie les 8 mails en **une seule requête IA** avec failover +
      rotation de modèles.
   d. Labels via `messages/batchModify` (regroupés, flushés par tranches de ~50).
   e. Si le batch échoue → fallback mail par mail.
5. Progression en temps réel via IPC events avec ETA (`sort:progress`,
   `sort:result`, `sort:error`, `sort:provider`) : puces de santé par
   provider avec modèle actif, compteurs réussis/échoués/ignorés,
   résumé par catégorie en fin de tri.

### Anti-rate-limit & rotation de modèles

1. **Batch** : 8 mails par requête IA = 8x moins de requêtes.
2. **Workers parallèles** : 1 par provider (max 4) — quotas indépendants.
3. **Rotation de modèles** : file ordonnée par clé (défaut → découverts →
   curés) ; modèle en échec → modèle suivant, pas de pause provider.
4. **Sliding window RPM par modèle** : chaque modèle a sa fenêtre 60s —
   plusieurs modèles d'une même clé tournent simultanément.
5. **Cooldowns par type d'erreur** :
   - 429 RPM : exponentiel (20s → 40s → 80s → max 5min) ou Retry-After.
   - Quota journalier (429+quota, 402) : jusqu'au reset (minuit PT, ≤24h).
   - Timeout (15s) : modèle en pause 10s.
   - Modèle mort (404/410) : retiré définitivement de la session.
   - Clé morte (401/403/400-clé) : provider retiré définitivement.
   - Réveil borné à 90s : au-delà, échec net plutôt qu'attente infinie.

## Sécurité

- **Secrets chiffrés au repos** : clés API, secret OAuth et tokens Gmail sont
  chiffrés par `safeStorage` d'Electron (DPAPI sous Windows, Keychain macOS,
  libsecret Linux) dans le fichier de settings local. Migration transparente
  depuis les anciens fichiers en clair.
- Les clés ne sont jamais envoyées ailleurs qu'à Google et au fournisseur
  d'IA choisi.
- Le redirect OAuth se fait sur `http://localhost:{port}` (loopback) — aucun
  serveur distant ; le flow expire après 5 min.
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` :
  le renderer n'a aucun accès Node ; tout passe par le bridge préload typé.
- **CSP stricte** injectée au build de production (`default-src 'self'`).
- Les liens externes (`target="_blank"`) s'ouvrent dans le navigateur
  système, jamais dans une fenêtre Electron non sandboxée.
- Toutes les entrées IPC sont **validées côté main process** (allowlist,
  coercion de types, bornes) — le renderer n'est pas une zone de confiance.
- **Instance unique** : relancer l'app focus la fenêtre existante.

## Limites

- Les modèles gratuits ont des quotas (RPM, req/jour). Avec 4 providers, le
  total théorique est ~105 RPM et ~3050 req/jour.
- Seul Gmail est supporté (via l'API officielle). IMAP générique n'est pas
  implémenté.
