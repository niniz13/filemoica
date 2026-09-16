# Résultats des tests — Backend

**Version de référence :** `7540cd8` · **Date du relevé :** 16/09/2026

## Environnement

| Élément | Valeur |
|---|---|
| Exécution | Node.js 24.19.0 |
| Base de données | PostgreSQL 17.11 (conteneur `postgres:17-alpine`) |
| Application | compilée, lancée depuis `dist/` |
| Migrations appliquées | 7 |
| Poste | Windows 11, base exposée sur le port 5433 |

## Comment lire ce tableau

Trois natures de preuve, distinguées à dessein :

- **Automatisé** — le test tourne dans la suite ; la preuve est reproductible par
  `npm test` ou `npm run test:e2e`.
- **Observé** — manipulation faite à la main contre le service réel, avec la
  sortie recopiée telle quelle.
- **Mesuré** — observé, avec une durée relevée.

Ce qui n'a pas été vérifié est listé en fin de document, séparément.

---

## 1. Usage complet

| # | Test | Attendu | Obtenu | Nature | Preuve |
|---|---|---|---|---|---|
| 1.1 | Un destinataire **sans compte** ouvre un lien et récupère le fichier | Contenu identique à l'original | ✅ Identique | Automatisé | `shares.e2e-spec.ts` — « un inconnu sans compte télécharge le contenu exact » |
| 1.2 | Parcours réel : dépôt → lien → téléchargement | `200` + contenu | ✅ `200`, `Contrat signe - montant : 42000 euros.` | Observé | 16/09, service depuis `dist/` |
| 1.3 | Un lien couvre **plusieurs fichiers** | Les deux fichiers listés et téléchargeables | ✅ `a.txt` et `b.txt` derrière un seul jeton | Observé | 16/09 |
| 1.4 | Consultation d'un lien avant téléchargement | Nom, taille, échéance | ✅ `{"requiresPassword":false,"singleUse":true,"files":[…]}` | Observé | 16/09 |

## 2. Cas d'erreur pris en charge

| # | Test | Attendu | Obtenu | Nature | Preuve |
|---|---|---|---|---|---|
| 2.1 | Jeton de partage inconnu | `404` | ✅ `404 SHARE_NOT_FOUND` | Automatisé | `shares.e2e-spec.ts` |
| 2.2 | Lien expiré | `410`, distinct de « n'existe pas » | ✅ `410 SHARE_EXPIRED` | Automatisé | « refuse un lien expiré » |
| 2.3 | Dépôt sans fichier | `400` explicite | ✅ `400 FILE_REQUIRED` | Automatisé | `files.e2e-spec.ts` |
| 2.4 | Erreur interne inattendue | Aucune fuite technique au client | ✅ `500 INTERNAL_ERROR`, trace côté serveur uniquement | Automatisé | `all-exceptions.filter.spec.ts` |
| 2.5 | Identifiants de connexion erronés | Même réponse qu'un email inconnu | ✅ `401 INVALID_CREDENTIALS` dans les deux cas | Automatisé | `auth.e2e-spec.ts` |

## 3. Accès vérifiés

*Le critère central. Chaque refus est vérifié séparément, avec son propre code.*

| # | Test | Attendu | Obtenu | Nature | Preuve |
|---|---|---|---|---|---|
| 3.1 | Requête sans session sur une route protégée | `401` | ✅ `401 NOT_AUTHENTICATED` | Automatisé | `auth.e2e-spec.ts` |
| 3.2 | Jeton de session inventé, mal formé, ou signé avec une autre clé | `401` | ✅ `401 SESSION_INVALID` (3 variantes) | Automatisé | `auth.e2e-spec.ts` |
| 3.3 | Un utilisateur liste les fichiers d'un autre | Liste vide | ✅ `[]` | Automatisé | `files.e2e-spec.ts` |
| 3.4 | Un utilisateur supprime le fichier d'un autre | `404`, **pas** `403` — un 403 confirmerait l'existence | ✅ `404 FILE_NOT_FOUND`, fichier intact | Automatisé | `files.e2e-spec.ts` |
| 3.5 | Lien protégé, sans mot de passe | `401` | ✅ `401 SHARE_PASSWORD_REQUIRED` | Automatisé | `shares.e2e-spec.ts` |
| 3.6 | Lien protégé, mauvais mot de passe | `403` | ✅ `403 SHARE_PASSWORD_INVALID` | Automatisé | `shares.e2e-spec.ts` |
| 3.7 | Lien protégé : le nom du fichier avant déverrouillage | Non divulgué | ✅ `fileName` absent de la réponse | Automatisé | « ne divulgue pas le nom du fichier avant le mot de passe » |
| 3.8 | **Révocation** : lien coupé pendant qu'il fonctionnait | Accès refusé immédiatement | ✅ `200` puis `403 SHARE_REVOKED`, même lien | Automatisé + Observé | 16/09 |
| 3.9 | Déconnexion : le jeton reste-t-il utilisable ? | Refus immédiat, pas à l'expiration | ✅ `200` puis `401 SESSION_INVALID` | Automatisé | `auth.e2e-spec.ts` |
| 3.10 | Refresh token rejoué après usage | Toute la lignée révoquée | ✅ `401`, 0 session active restante | Automatisé | `auth.e2e-spec.ts` |
| 3.11 | Compte ordinaire sur le panneau d'administration | `403` malgré une session valide | ✅ `403 INSUFFICIENT_ROLE` | Automatisé + Observé | 16/09 |
| 3.12 | Rôle d'administrateur retiré, **sans reconnexion** | Accès coupé immédiatement | ✅ `200` puis `403`, même cookie | Automatisé | `admin.e2e-spec.ts` |
| 3.13 | Un administrateur accède-t-il aux fichiers d'autrui ? | Non | ✅ Liste vide, suppression `404`, aucun nom de fichier exposé | Automatisé | `admin.e2e-spec.ts` |
| 3.14 | Formulaire posté depuis un site tiers (CSRF) | Refusé | ✅ `403 CSRF_HEADER_MISSING` | Automatisé | `csrf.guard.spec.ts` |
| 3.15 | Tentative d'élévation à l'inscription (`role: ADMIN`) | Refusée, pas ignorée | ✅ `400 VALIDATION_ERROR` | Automatisé | `auth.e2e-spec.ts` |
| 3.16 | 11ᵉ tentative de connexion consécutive | Blocage temporaire | ✅ 10 × `401` puis `429` + `Retry-After` | Observé | 16/09 |

## 4. Chiffrement au repos

| # | Test | Attendu | Obtenu | Nature | Preuve |
|---|---|---|---|---|---|
| 4.1 | Lecture directe du fichier sur le disque | Illisible | ✅ `5f c9 6f 0e 39 27 52 bf 17 fe 73 40…` — ni « SECRET » ni « 4815162342 » | Observé | 16/09, fichier `b364eeb8…` |
| 4.2 | Le fichier reste-t-il **récupérable** ? | Oui, avec sa clé | ✅ Contenu d'origine restitué | Automatisé | `files.e2e-spec.ts` |
| 4.3 | Nom du fichier en base | Chiffré | ✅ `v1.zRjydQEV+jIKkUy+.FgOZd/XZJE3Q9wcxN5lrTw==.…` | Observé | relevé `psql` du 16/09 |
| 4.4 | Clé du fichier en base | Chiffrée par la clé maître | ✅ `v1.bokb2HpIqxnTJFzP.GnWwyDDHnp…` | Observé | relevé `psql` du 16/09 |
| 4.5 | Nom sur le disque | Sans rapport avec le nom d'origine | ✅ `b364eeb8da1b5786e7fa9504b19c2307` | Observé | 16/09 |
| 4.6 | Jeton de partage en base | Empreinte seule | ✅ SHA-256, jeton absent | Automatisé | `shares.e2e-spec.ts` |
| 4.7 | Mot de passe de compte en base | Empreinte argon2id | ✅ `$argon2id$…`, mot de passe absent | Automatisé | `auth.e2e-spec.ts` |
| 4.8 | **Intégrité** : un octet modifié sur le disque | Le déchiffrement échoue, pas de fichier corrompu servi | ✅ Erreur levée | Automatisé | `files.e2e-spec.ts` |
| 4.9 | Deux fichiers de même nom | Chiffrés différemment | ✅ Résultats distincts | Automatisé | `crypto.service.spec.ts` |

## 5. Incident maîtrisé

### 5.1 Panne de base de données — 15/09, 17 h 03

Application lancée depuis `dist/`, base réelle.

| Étape | Action | Attendu | Obtenu |
|---|---|---|---|
| 1 | État nominal | `200` | ✅ `{"status":"ok","checks":{"database":"up"}}` |
| 2 | `docker compose stop db` | `503` | ✅ `503` |
| 3 | `docker compose start db` | Retour à `200` | ✅ `{"status":"ok","checks":{"database":"up"}}` |

**Reprise en ~8 secondes, sans redémarrer l'application** : le pool de connexions
se rétablit seul. *(Mesuré.)*

### 5.2 Rotation des clés de chiffrement — 16/09, 11 h 03

| Étape | Action | Attendu | Obtenu |
|---|---|---|---|
| 1 | État initial | — | 4 fichiers en `key_version = v1` |
| 2 | Empreinte SHA-256 d'un fichier du disque | — | `9CE048D0…` |
| 3 | `npm run keys:rotate -- --dry-run` | Compte sans modifier | ✅ 4 fichiers + 1 partage annoncés, **rien modifié** |
| 4 | `npm run keys:rotate` | Bascule complète | ✅ 4 fichiers + 1 partage re-scellés en **101 ms** |
| 5 | État final | Tout en `v2` | ✅ `dek_wrapped` commençant par `v2.` |
| 6 | Empreinte du même fichier | **Inchangée** | ✅ Identique — le disque n'a pas été touché |
| 7 | Seconde exécution | Idempotente | ✅ 0 re-scellé |
| 8 | Lecture via l'API après rotation | Données intactes | ✅ Noms de fichiers déchiffrés correctement |

*Mesuré.* Changer la clé maître de tout le service sans relire un seul octet de
fichier — c'est l'intérêt du chiffrement enveloppe.

### 5.3 Lien à usage unique — 16/09

| Étape | Action | Attendu | Obtenu |
|---|---|---|---|
| 1 | Dépôt de `a.txt` et `b.txt`, un seul lien | — | ✅ 2 fichiers, 1 jeton |
| 2 | Téléchargement du premier | Les deux fichiers survivent | ✅ Toujours présents |
| 3 | Téléchargement du second | **Les deux effacés** | ✅ Disparus de la base et du disque |
| 4 | Nouvelle tentative | Refus explicite | ✅ `410 SHARE_ALREADY_USED` |
| 5 | Liste du déposant | Trace du transfert conservée | ✅ Statut `CONSUMED` |

*Observé.*

### 5.4 Conservation et purge des fichiers — 16/09, 14 h 23

La tâche efface de la **donnée utilisateur** : les tests portent autant sur ce
qu'elle épargne que sur ce qu'elle supprime.

| # | Cas | Attendu | Obtenu |
|---|---|---|---|
| 1 | Fichier récent **jamais partagé** | **Conservé** | ✅ 0 effacé |
| 2 | Fichier avec un partage encore actif | Conservé | ✅ 0 effacé |
| 3 | Fichier dont le partage vient d'expirer | Conservé | ✅ 0 effacé |
| 4 | Fichier jamais partagé, 400 jours | Effacé **du disque aussi** | ✅ Base et volume |
| 5 | Fichier dont le partage a expiré il y a 200 jours | Effacé | ✅ |
| 6 | Fichier dont le partage a été révoqué | Effacé | ✅ |
| 7 | Même fichier à 60 jours, compte **payant** | Conservé (délai 90 j) | ✅ 0 effacé |
| 8 | Le même, repassé en compte **gratuit** | Effacé (délai 30 j) | ✅ 1 effacé |
| 9 | `--dry-run` sur un fichier à effacer | Compté, **rien supprimé** | ✅ Base et disque intacts |

*Automatisé — `retention.e2e-spec.ts`, 9 / 9.*

**Le cas 1 est celui qui compte.** La règle naïve — « effacer les fichiers sans
partage exploitable » — aurait détruit les fichiers déposés mais pas encore
partagés. C'est la donnée de l'utilisateur, pas un déchet.

Exécution réelle sur la base de développement :

| Étape | Attendu | Obtenu |
|---|---|---|
| `npm run files:purge -- --dry-run` | Ne rien effacer, tous les fichiers étant récents | ✅ **4 examinés, 0 effacé**, 103 ms |

*Mesuré.*

## 6. Journaux et confidentialité

| # | Test | Attendu | Obtenu | Nature | Preuve |
|---|---|---|---|---|---|
| 6.1 | Un jeton de partage apparaît-il dans les journaux ? | Non | ✅ `/api/download/:token` — jeton absent de toute la sortie | Observé | 16/09, après correction |
| 6.2 | Format des journaux | JSON exploitable | ✅ `{"level":"log","context":"HTTP","message":{…}}` | Observé | 16/09 |
| 6.3 | La sonde divulgue-t-elle l'infrastructure ? | Non | ✅ Ni hôte, ni port, ni nom de base | Automatisé | `health.e2e-spec.ts` |
| 6.4 | Un secret mal formé fuit-il au démarrage ? | Non | ✅ Le nom de la variable seul | Automatisé | `env.validation.spec.ts` |

## 7. Suite automatisée

| Commande | Résultat | Date |
|---|---|---|
| `npm test` | **128 / 128** | 16/09 |
| `npm run test:e2e` | **166 / 166** (8 suites) | 16/09 |
| `npm run lint` | 0 avertissement | 16/09 |
| `npx tsc --noEmit` | 0 erreur | 16/09 |
| `npm run build` | Succès | 16/09 |

**294 tests**, dont 166 de bout en bout contre une vraie base PostgreSQL et un
vrai répertoire de stockage — pas des doubles.

---

## Tests qui ont échoué, et ce qu'on en a tiré

*Un test qui échoue en dit souvent plus qu'un test qui passe.*

### Un fichier de 0 octet que les tests déclaraient conforme

Le dépôt écrivait des fichiers **vides** pendant que l'API répondait `201` avec
la bonne taille. Cause : le compteur d'octets écoutait le flux entrant, ce qui le
met en écoulement immédiat — les octets partaient dans le vide pendant
l'ouverture du fichier de destination.

**Les tests passaient malgré tout** : ils vérifiaient que le disque *ne contient
pas* le texte en clair, ce qu'un fichier vide satisfait trivialement. Découvert
en inspectant le disque à la main.

**Ce qu'on en a tiré :** une garantie négative ne suffit pas. Deux tests ont été
ajoutés — déchiffrer le fichier stocké et retrouver le contenu d'origine, et
vérifier qu'un octet modifié fait échouer le déchiffrement.

### Des jetons de partage écrits dans les journaux

Le journal de requêtes masquait bien le jeton, mais le filtre d'exceptions
écrivait l'URL brute de son côté. Depuis que le destinataire n'a plus besoin de
compte, **ce jeton suffit à accéder au fichier** : les journaux auraient contenu
tous les liens du service.

**Ce qu'on en a tiré :** le masquage est devenu une fonction partagée, utilisée
aux deux endroits, et deux tests le verrouillent. Trouvé par la vérification en
conditions réelles, pas par les tests.

### `RATE_LIMIT_ENABLED=false` interprété comme vrai

La conversion automatique appliquait `Boolean("false")`, qui vaut `true`.
**`ENABLE_API_DOCS=false` souffrait du même défaut** : l'infrastructure aurait cru
couper la documentation en production sans que ce soit le cas.

**Ce qu'on en a tiré :** les booléens sont convertis explicitement avant
validation, et 8 tests couvrent les valeurs possibles.

### Un refus de quota qui coupait la connexion

Refuser un dépôt avant que le client ait fini d'envoyer coupe la connexion : il
reçoit une erreur réseau au lieu du message expliquant son quota. Le test
recevait `ECONNRESET`.

**Ce qu'on en a tiré :** le refus a lieu **pendant** la réception, à l'octet de
trop, là où l'interruption est gérée proprement.

### Huit tests cassés par une clé ajoutée en local

Après l'ajout d'une clé de rotation au `.env` du poste, huit tests de bout en
bout ont échoué : la configuration locale s'invitait dans les tests.

**Ce qu'on en a tiré :** le `.env` est ignoré quand `NODE_ENV=test`. Un test ne
doit jamais dépendre de ce qu'un développeur a dans sa configuration.

---

## Ce qui n'a pas été vérifié

À distinguer de ce qui précède : ces points sont **envisagés**, pas observés.

| Point | État |
|---|---|
| **Sauvegarde et restauration** | Procédure écrite, **non jouée**. Dépend de l'infrastructure. |
| Dépôt d'un fichier de 200 Mo | Limite configurée et testée à petite échelle ; le volume réel n'a pas été éprouvé |
| Comportement à disque plein | Non provoqué |
| Montée en charge | Aucun test de charge — le service vise une instance |
| Analyse antivirale des dépôts | Absente, et impossible sur du contenu chiffré. **Le contrôle de format ne filtre pas les menaces** : un document à macros ou un PDF piégé passent |
| Nettoyage des fichiers dont tous les partages ont expiré | Aucun automatisme ; ils restent sur le disque |
