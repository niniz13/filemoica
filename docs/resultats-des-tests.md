# Résultats des tests : backend

**Version de référence :** `b151eda` · **Relevé du** 16 au 17/09/2026

## Environnement

**Cet environnement vaut pour toutes les lignes du document.** Une ligne qui
s'en écarte le précise dans sa colonne « Preuve ».

| Élément | Valeur |
|---|---|
| Exécution | Node.js 24.19.0 |
| Base de données | PostgreSQL 17.11 (conteneur `postgres:17-alpine`) |
| Application | NestJS 12, compilée, lancée depuis `dist/` |
| Prisma | 7.10.0, adaptateur `pg` |
| Migrations appliquées | 10 |
| Poste | Windows 11, base exposée sur le port 5433 |
| Conteneurs | Docker, images construites depuis `backend/Dockerfile` et `frontend/Dockerfile` |

## Comment lire ce tableau

Chaque ligne porte le résultat **attendu**, le résultat **obtenu**, la **date**
du relevé et la **preuve**. Trois natures de preuve, distinguées à dessein :

- **Automatisé** : le test tourne dans la suite ; la preuve est reproductible
  par `npm test` ou `npm run test:e2e`, et la colonne « Preuve » nomme le
  fichier de test.
- **Observé** : manipulation faite à la main contre le service réel, avec la
  sortie recopiée telle quelle.
- **Mesuré** : observé, avec une durée relevée.

Ce qui n'a pas été vérifié est listé en fin de document, séparément.

Les sections couvrent, dans l'ordre : le **parcours** complet (1), les **cas
d'erreur** (2), les **accès** (3 et 3 bis), le **chiffrement** (4), la
**détection d'incident et la reprise** (5), les **journaux** (6), le
**déploiement** (7) et la **suite automatisée** (8).

---

## 1. Usage complet

| # | Test | Attendu | Obtenu | Date | Nature | Preuve |
|---|---|---|---|---|---|---|
| 1.1 | Un destinataire **sans compte** ouvre un lien et récupère le fichier | Contenu identique à l'original | ✅ Identique | 17/09 | Automatisé | `shares.e2e-spec.ts`, « un inconnu sans compte télécharge le contenu exact » |
| 1.2 | Parcours réel : dépôt → lien → téléchargement | `200` + contenu | ✅ `200`, `Contrat signe - montant : 42000 euros.` | 16/09 | Observé | service depuis `dist/` |
| 1.3 | Un lien couvre **plusieurs fichiers** | Les deux fichiers listés et téléchargeables | ✅ `a.txt` et `b.txt` derrière un seul jeton | 16/09 | Observé | Relevé manuel, voir « Environnement » |
| 1.4 | Consultation d'un lien avant téléchargement | Nom, taille, échéance | ✅ `{"requiresPassword":false,"singleUse":true,"files":[…]}` | 16/09 | Observé | Relevé manuel, voir « Environnement » |

## 2. Cas d'erreur pris en charge

| # | Test | Attendu | Obtenu | Date | Nature | Preuve |
|---|---|---|---|---|---|---|
| 2.1 | Jeton de partage inconnu | `404` | ✅ `404 SHARE_NOT_FOUND` | 17/09 | Automatisé | `shares.e2e-spec.ts` |
| 2.2 | Lien expiré | `410`, distinct de « n'existe pas » | ✅ `410 SHARE_EXPIRED` | 17/09 | Automatisé | « refuse un lien expiré » |
| 2.3 | Dépôt sans fichier | `400` explicite | ✅ `400 FILE_REQUIRED` | 17/09 | Automatisé | `files.e2e-spec.ts` |
| 2.4 | Erreur interne inattendue | Aucune fuite technique au client | ✅ `500 INTERNAL_ERROR`, trace côté serveur uniquement | 17/09 | Automatisé | `all-exceptions.filter.spec.ts` |
| 2.5 | Identifiants de connexion erronés | Même réponse qu'un email inconnu | ✅ `401 INVALID_CREDENTIALS` dans les deux cas | 17/09 | Automatisé | `auth.e2e-spec.ts` |

## 3. Accès vérifiés

*Le critère central. Chaque refus est vérifié séparément, avec son propre code.*

| # | Test | Attendu | Obtenu | Date | Nature | Preuve |
|---|---|---|---|---|---|---|
| 3.1 | Requête sans session sur une route protégée | `401` | ✅ `401 NOT_AUTHENTICATED` | 17/09 | Automatisé | `auth.e2e-spec.ts` |
| 3.2 | Jeton de session inventé, mal formé, ou signé avec une autre clé | `401` | ✅ `401 SESSION_INVALID` (3 variantes) | 17/09 | Automatisé | `auth.e2e-spec.ts` |
| 3.3 | Un utilisateur liste les fichiers d'un autre | Liste vide | ✅ `[]` | 17/09 | Automatisé | `files.e2e-spec.ts` |
| 3.4 | Un utilisateur supprime le fichier d'un autre | `404`, **pas** `403`, un 403 confirmerait l'existence | ✅ `404 FILE_NOT_FOUND`, fichier intact | 17/09 | Automatisé | `files.e2e-spec.ts` |
| 3.5 | Lien protégé, sans mot de passe | `401` | ✅ `401 SHARE_PASSWORD_REQUIRED` | 17/09 | Automatisé | `shares.e2e-spec.ts` |
| 3.6 | Lien protégé, mauvais mot de passe | `403` | ✅ `403 SHARE_PASSWORD_INVALID` | 17/09 | Automatisé | `shares.e2e-spec.ts` |
| 3.7 | Lien protégé : le nom du fichier avant déverrouillage | Non divulgué | ✅ `fileName` absent de la réponse | 17/09 | Automatisé | « ne divulgue pas le nom du fichier avant le mot de passe » |
| 3.8 | **Révocation** : lien coupé pendant qu'il fonctionnait | Accès refusé immédiatement | ✅ `200` puis `403 SHARE_REVOKED`, même lien | 16/09 | Automatisé + Observé | suite e2e, et relevé manuel |
| 3.9 | Déconnexion : le jeton reste-t-il utilisable ? | Refus immédiat, pas à l'expiration | ✅ `200` puis `401 SESSION_INVALID` | 17/09 | Automatisé | `auth.e2e-spec.ts` |
| 3.10 | Refresh token rejoué après usage | Toute la lignée révoquée | ✅ `401`, 0 session active restante | 17/09 | Automatisé | `auth.e2e-spec.ts` |
| 3.11 | Compte ordinaire sur le panneau d'administration | `403` malgré une session valide | ✅ `403 INSUFFICIENT_ROLE` | 16/09 | Automatisé + Observé | suite e2e, et relevé manuel |
| 3.12 | Rôle d'administrateur retiré, **sans reconnexion** | Accès coupé immédiatement | ✅ `200` puis `403`, même cookie | 17/09 | Automatisé | `admin.e2e-spec.ts` |
| 3.13 | Un administrateur accède-t-il aux fichiers d'autrui ? | Non | ✅ Liste vide, suppression `404`, aucun nom de fichier exposé | 17/09 | Automatisé | `admin.e2e-spec.ts` |
| 3.14 | Formulaire posté depuis un site tiers (CSRF) | Refusé | ✅ `403 CSRF_HEADER_MISSING` | 17/09 | Automatisé | `csrf.guard.spec.ts` |
| 3.15 | Tentative d'élévation à l'inscription (`role: ADMIN`) | Refusée, pas ignorée | ✅ `400 VALIDATION_ERROR` | 17/09 | Automatisé | `auth.e2e-spec.ts` |
| 3.16 | 11ᵉ tentative de connexion consécutive | Blocage temporaire | ✅ 10 × `401` puis `429` + `Retry-After` | 16/09 | Observé | Relevé manuel, voir « Environnement » |

## 3 bis. Authentification renforcée

*Confirmation d'adresse obligatoire à l'inscription (16/09), et double
authentification par courriel, activable compte par compte depuis la page de
profil (17/09).*

| # | Test | Attendu | Obtenu | Date | Nature | Preuve |
|---|---|---|---|---|---|---|
| 3.17 | Connexion avec une adresse non confirmée | Refus, malgré un mot de passe valide | ✅ `403 EMAIL_NOT_VERIFIED` | 17/09 | Automatisé | `auth.e2e-spec.ts` |
| 3.18 | Le refus vient-il **après** la vérification du mot de passe ? | Oui, sinon on énumère les comptes | ✅ Vérifié unitairement | 17/09 | Automatisé | `auth.service.spec.ts` |
| 3.19 | Date de confirmation **absente** (et non nulle) | Refus aussi | ✅ Refusé | 17/09 | Automatisé | « refuse aussi quand la date est absente » |
| 3.20 | Jeton de confirmation en base | Empreinte seule | ✅ SHA-256, jeton absent | 17/09 | Automatisé | `auth.e2e-spec.ts` |
| 3.21 | Redemander un lien invalide-t-il le précédent ? | Oui | ✅ L'ancien est consommé | 17/09 | Automatisé | `auth.e2e-spec.ts` |
| 3.22 | `resend-verification` sur une adresse inconnue | **Même réponse** qu'un compte réel | ✅ `204` dans les deux cas | 17/09 | Automatisé | Sinon la route dit qui est inscrit |
| 3.23 | Première étape de connexion, second facteur armé | **Aucun cookie posé** | ✅ `{mfaRequired:true}`, `Set-Cookie` absent | 17/09 | Automatisé | `auth.e2e-spec.ts` |
| 3.24 | Code de connexion en base | Empreinte argon2id | ✅ `$argon2id$…`, aucun chiffre lisible | 17/09 | Automatisé | Six chiffres en SHA-256 se cassent en millisecondes |
| 3.25 | Code faux | Refus | ✅ `401 MFA_CODE_INVALID` | 17/09 | Automatisé | `auth.e2e-spec.ts` |
| 3.26 | **Cinq essais infructueux**, puis le bon code | Refusé quand même | ✅ Le défi est clos | 17/09 | Automatisé | C'est cela qui rend six chiffres suffisants |
| 3.27 | Rejouer un défi déjà utilisé | Refus | ✅ `401` | 17/09 | Automatisé | `auth.e2e-spec.ts` |
| 3.28 | Défi expiré | Refus | ✅ `401` | 17/09 | Automatisé | `auth.e2e-spec.ts` |
| 3.29 | Relancer une connexion | Le défi précédent est invalidé | ✅ L'ancien code ne passe plus | 17/09 | Automatisé | Sinon deux codes valides coexistent |
| 3.30 | Compte neuf | Second facteur **inactif**, connexion en une étape | ✅ `{mfaRequired:false}` et cookies posés | 17/09 | Automatisé | Le réglage est par compte |
| 3.31 | Bascule du réglage avec un **mot de passe faux** | Refus, réglage inchangé | ✅ `401 INVALID_CREDENTIALS`, `mfaEnabled` toujours `false` | 17/09 | Automatisé | Une session volée ne doit pas désarmer la protection |
| 3.32 | Bascule sans session | Refus | ✅ `401` | 17/09 | Automatisé | `auth.e2e-spec.ts` |
| 3.33 | Activation puis reconnexion | Un code est exigé | ✅ `{mfaRequired:true}` | 17/09 | Automatisé | Le réglage prend effet immédiatement |
| 3.34 | Désactivation puis reconnexion | Connexion directe | ✅ `{mfaRequired:false}` | 17/09 | Automatisé | La bascule fonctionne dans les deux sens |

**Ce qui rend un code à six chiffres défendable** : ce n'est pas sa longueur ,
un million de combinaisons se parcourt vite. C'est la conjonction de **cinq
essais**, **dix minutes de validité**, et d'une empreinte **argon2id** qui rend
coûteuse toute tentative hors ligne si la base fuyait pendant la fenêtre.

## 4. Chiffrement au repos

| # | Test | Attendu | Obtenu | Date | Nature | Preuve |
|---|---|---|---|---|---|---|
| 4.1 | Lecture directe du fichier sur le disque | Illisible | ✅ `5f c9 6f 0e 39 27 52 bf 17 fe 73 40…`, ni « SECRET » ni « 4815162342 » | 16/09 | Observé | fichier `b364eeb8…` |
| 4.2 | Le fichier reste-t-il **récupérable** ? | Oui, avec sa clé | ✅ Contenu d'origine restitué | 17/09 | Automatisé | `files.e2e-spec.ts` |
| 4.3 | Nom du fichier en base | Chiffré | ✅ `v1.zRjydQEV+jIKkUy+.FgOZd/XZJE3Q9wcxN5lrTw==.…` | 16/09 | Observé | relevé `psql` du 16/09 |
| 4.4 | Clé du fichier en base | Chiffrée par la clé maître | ✅ `v1.bokb2HpIqxnTJFzP.GnWwyDDHnp…` | 16/09 | Observé | relevé `psql` du 16/09 |
| 4.5 | Nom sur le disque | Sans rapport avec le nom d'origine | ✅ `b364eeb8da1b5786e7fa9504b19c2307` | 16/09 | Observé | Relevé manuel, voir « Environnement » |
| 4.6 | Jeton de partage en base | Empreinte seule | ✅ SHA-256, jeton absent | 17/09 | Automatisé | `shares.e2e-spec.ts` |
| 4.7 | Mot de passe de compte en base | Empreinte argon2id | ✅ `$argon2id$…`, mot de passe absent | 17/09 | Automatisé | `auth.e2e-spec.ts` |
| 4.8 | **Intégrité** : un octet modifié sur le disque | Le déchiffrement échoue, pas de fichier corrompu servi | ✅ Erreur levée | 17/09 | Automatisé | `files.e2e-spec.ts` |
| 4.9 | Deux fichiers de même nom | Chiffrés différemment | ✅ Résultats distincts | 17/09 | Automatisé | `crypto.service.spec.ts` |

## 5. Incident maîtrisé

### 5.1 Panne de base de données, 15/09, 17 h 03

Application lancée depuis `dist/`, base réelle.

| Étape | Action | Attendu | Obtenu |
|---|---|---|---|
| 1 | État nominal | `200` | ✅ `{"status":"ok","checks":{"database":"up"}}` |
| 2 | `docker compose stop db` | `503` | ✅ `503` |
| 3 | `docker compose start db` | Retour à `200` | ✅ `{"status":"ok","checks":{"database":"up"}}` |

**Reprise en ~8 secondes, sans redémarrer l'application** : le pool de connexions
se rétablit seul. *(Mesuré.)*

### 5.2 Rotation des clés de chiffrement, 16/09, 11 h 03

| Étape | Action | Attendu | Obtenu |
|---|---|---|---|
| 1 | État initial |, | 4 fichiers en `key_version = v1` |
| 2 | Empreinte SHA-256 d'un fichier du disque |, | `9CE048D0…` |
| 3 | `npm run keys:rotate -- --dry-run` | Compte sans modifier | ✅ 4 fichiers + 1 partage annoncés, **rien modifié** |
| 4 | `npm run keys:rotate` | Bascule complète | ✅ 4 fichiers + 1 partage re-scellés en **101 ms** |
| 5 | État final | Tout en `v2` | ✅ `dek_wrapped` commençant par `v2.` |
| 6 | Empreinte du même fichier | **Inchangée** | ✅ Identique, le disque n'a pas été touché |
| 7 | Seconde exécution | Idempotente | ✅ 0 re-scellé |
| 8 | Lecture via l'API après rotation | Données intactes | ✅ Noms de fichiers déchiffrés correctement |

*Mesuré.* Changer la clé maître de tout le service sans relire un seul octet de
fichier, c'est l'intérêt du chiffrement enveloppe.

### 5.3 Lien à usage unique, 16/09

| Étape | Action | Attendu | Obtenu |
|---|---|---|---|
| 1 | Dépôt de `a.txt` et `b.txt`, un seul lien |, | ✅ 2 fichiers, 1 jeton |
| 2 | Téléchargement du premier | Les deux fichiers survivent | ✅ Toujours présents |
| 3 | Téléchargement du second | **Les deux effacés** | ✅ Disparus de la base et du disque |
| 4 | Nouvelle tentative | Refus explicite | ✅ `410 SHARE_ALREADY_USED` |
| 5 | Liste du déposant | Trace du transfert conservée | ✅ Statut `CONSUMED` |

*Observé.*

### 5.4 Conservation et purge des fichiers, 16/09, 14 h 23

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

*Automatisé, `retention.e2e-spec.ts`, 9 / 9.*

**Le cas 1 est celui qui compte.** La règle naïve, « effacer les fichiers sans
partage exploitable », aurait détruit les fichiers déposés mais pas encore
partagés. C'est la donnée de l'utilisateur, pas un déchet.

Exécution réelle sur la base de développement :

| Étape | Attendu | Obtenu |
|---|---|---|
| `npm run files:purge -- --dry-run` | Ne rien effacer, tous les fichiers étant récents | ✅ **4 examinés, 0 effacé**, 103 ms |

*Mesuré.*

### 5.5 Sauvegarde et restauration, 16/09, 15 h 30

**Le critère « incident maîtrisé » du sujet.** Joué contre la pile conteneurisée
complète, donc dans les conditions de la production.

| Étape | Action | Attendu | Obtenu |
|---|---|---|---|
| 1 | Dépôt + lien, téléchargement témoin | Fonctionnel | ✅ 337 o, SHA-256 `a74f4a44…` |
| 2 | `pg_dump` puis archive du volume | Deux artefacts | ✅ 14 453 o en 0,6 s · 510 o en 0,9 s |
| 3 | `docker compose down -v` | Destruction réelle | ✅ 2,0 s, plus aucun volume |
| 4 | Restauration fichiers **puis** base | Aucune erreur | ✅ 1,1 s · **0 erreur** |
| 5 | Migrations au redémarrage | Rien à appliquer | ✅ « No pending migrations to apply » |
| 6 | **Re-téléchargement du même lien** | **Contenu identique** | ✅ SHA-256 **identique au bit près** |

**Restauration complète en ~30 secondes.** *(Mesuré.)*

L'étape 6 est la preuve : le nom `contrat.txt` revient déchiffré et le lien
d'origine fonctionne, donc la clé maître, la DEK chiffrée, le contenu et le tag
d'intégrité sont tous cohérents entre eux.

#### Le défaut trouvé en jouant la procédure, et c'est tout l'intérêt

**La procédure documentée échouait.** Au premier passage : **42 erreurs**, et un
résultat pire qu'un échec franc ,

```
users=1  files=0  shares=0
```

Une base qui *paraît* restaurée. Deux causes, toutes deux corrigées :

1. Le conteneur de migrations recréait le schéma **avant** la restauration, donc
   chaque `CREATE TABLE` du dump échouait, puis les données tombaient en cascade
   sur les clés étrangères. → La base démarre désormais **seule**, vierge.
2. `psql` **continue après chaque erreur** par défaut. → `-v ON_ERROR_STOP=1`,
   pour qu'une restauration ratée échoue franchement au lieu de se taire.

Une procédure jamais exécutée n'est pas une procédure : celle-ci l'a prouvé sur
elle-même.

#### La règle des deux artefacts, vérifiée

Rejoué en ne restaurant **que la base** :

| Observation | Résultat |
|---|---|
| Consultation du lien | **200**, le lien paraît valide |
| Téléchargement | **Échec**, `ENOENT` dans les journaux |
| État du service | Reste sain |

*(Observé.)* « Restaurer l'un sans l'autre ne donne rien d'exploitable » est
désormais une observation, pas une affirmation de principe.

#### Un défaut du service corrigé dans la foulée

Ce scénario a révélé que le téléchargement **coupait la connexion sans rien
expliquer** quand le contenu manquait : les en-têtes étaient déjà partis
lorsque la lecture échouait.

| # | Test | Attendu | Obtenu | Nature |
|---|---|---|---|---|
| 5.5a | Contenu absent du disque, lien valide | Erreur explicite | ✅ `500 CONTENT_UNAVAILABLE` | Automatisé |
| 5.5b | Lien à usage unique après cet échec | **Non consumé** | ✅ `consumedAt` reste nul | Automatisé |

`500` et non `404` : le lien est valide et le fichier devrait exister, le
destinataire n'a rien à corriger de son côté. Le contrôle est placé avant la
réservation du fichier, de sorte qu'un échec ne consume pas le lien : une fois
le volume remonté, le destinataire peut réessayer.

## 6. Journaux et confidentialité

| # | Test | Attendu | Obtenu | Date | Nature | Preuve |
|---|---|---|---|---|---|---|
| 6.1 | Un jeton de partage apparaît-il dans les journaux ? | Non | ✅ `/api/download/:token`, jeton absent de toute la sortie | 16/09 | Observé | après correction |
| 6.2 | Format des journaux | JSON exploitable | ✅ `{"level":"log","context":"HTTP","message":{…}}` | 16/09 | Observé | Relevé manuel, voir « Environnement » |
| 6.3 | La sonde divulgue-t-elle l'infrastructure ? | Non | ✅ Ni hôte, ni port, ni nom de base | 17/09 | Automatisé | `health.e2e-spec.ts` |
| 6.4 | Un secret mal formé fuit-il au démarrage ? | Non | ✅ Le nom de la variable seul | 17/09 | Automatisé | `env.validation.spec.ts` |

## 7. Déploiement

*Rejoué depuis un clone neuf, dans un répertoire vierge, en suivant le README à
la lettre : c'est le seul moyen de savoir si la procédure écrite fonctionne pour
quelqu'un d'autre que son auteur.*

| # | Test | Attendu | Obtenu | Date | Nature | Preuve |
|---|---|---|---|---|---|---|
| 7.1 | Construction des trois images depuis un clone neuf | Succès | ✅ backend, migrations et frontend construites | 17/09 | Observé | `docker compose up -d --build` |
| 7.2 | Ordre de démarrage imposé | L'application ne démarre **pas** avant la fin des migrations | ✅ `db Healthy` → `migrate Exited(0)` → `backend Started` | 17/09 | Observé | sortie de `docker compose up` |
| 7.3 | Sonde après déploiement | `200` et état de la base | ✅ `{"status":"ok","version":"dev","checks":{"database":"up"}}` | 17/09 | Observé | `GET /health` |
| 7.4 | Connexion contre la pile conteneurisée | Session ouverte | ✅ `200`, `mfaRequired:false`, cookies `access_token` et `refresh_token` posés | 17/09 | Observé | `POST /api/auth/login` |
| 7.5 | Jeu de démonstration dans le conteneur | 3 comptes créés et confirmés | ✅ `admin`, `alice`, `bob` | 17/09 | Observé | `docker compose exec backend node dist/seed.js` |
| 7.6 | Configuration invalide au démarrage | Refus de démarrer, message nommant la variable **sans sa valeur** | ✅ `BREVO_API_KEY must be longer than or equal to 1 characters`, aucune valeur affichée | 17/09 | Observé | journaux du conteneur |
| 7.7 | Utilisateur d'exécution de l'image | Compte non privilégié | ✅ `USER node`, uid 1000 | 16/09 | Observé | `backend/Dockerfile`, audit de l'image |
| 7.8 | Vérification automatique avant fusion | Suite complète rejouée sur la pull request | ✅ « Tests backend » au vert ; les deux jobs de publication écartés, comme prévu | 17/09 | Observé | GitHub Actions, `.github/workflows/ci.yml` |
| 7.9 | Migrations rejouées sur une base **vierge** | Les 10 migrations s'appliquent | ✅ `All migrations have been successfully applied` | 17/09 | Automatisé | étape du pipeline, et `npx prisma migrate deploy` |

Le point 7.9 mérite une mention : la chaîne d'intégration continue repart d'une
base vide à chaque exécution. Une migration peut très bien fonctionner sur la
base de développement, qui a tout l'historique, et échouer sur une base créée du
jour. C'est précisément ce qu'un déploiement neuf ferait.

## 8. Suite automatisée

| Commande | Résultat | Date |
|---|---|---|
| `npm test` | **145 / 145** | 17/09 |
| `npm run test:e2e` | **189 / 189** (8 suites) | 17/09 |
| `npm run lint` | 0 avertissement | 17/09 |
| `npx tsc --noEmit` | 0 erreur | 17/09 |
| `npm run build` | Succès | 17/09 |

**334 tests**, dont 189 de bout en bout contre une vraie base PostgreSQL et un
vrai répertoire de stockage, pas des doubles.

---

## Tests qui ont échoué, et ce qu'on en a tiré

*Un test qui échoue en dit souvent plus qu'un test qui passe.*

### Un mot de passe d'exemple qui ne correspondait à rien

En rejouant le démarrage depuis un clone neuf, `npm run db:deploy` a échoué sur
`P1000: Authentication failed`. Cause : `backend/.env.example` livrait
`DATABASE_URL=postgresql://filemoica:motdepasse@…`, alors que le compose de
développement crée l'utilisateur avec le mot de passe `filemoica`. Les deux
fichiers ne pouvaient pas se parler.

**Ce qu'on en a tiré :** une valeur d'exemple dans un fichier destiné à être
copié tel quel n'est pas une précaution, c'est un piège. Le fichier porte
désormais les identifiants que le compose crée réellement, et un commentaire qui
explique pourquoi il ne faut pas y remettre un mannequin. *Trouvé en suivant la
documentation à la lettre, pas par les tests.*

### Une variable vide traitée comme une valeur

Le backend refusait de démarrer en conteneur sur
`BREVO_API_KEY must be longer than or equal to 1 characters`, alors que cette
clé est facultative hors production. Cause : `@IsOptional()` ne considère pas la
chaîne vide comme absente, or `BREVO_API_KEY=` est exactement ce que contient le
fichier d'exemple et ce que produit Docker Compose pour une variable non
renseignée.

**Ce qu'on en a tiré :** « absent » et « vide » sont deux choses différentes
pour le validateur, une seule pour l'utilisateur. Une conversion explicite
ramène la seconde à la première, et **deux tests la verrouillent**, dont un qui
vérifie qu'une clé vide reste refusée en production.

### Un fichier de 0 octet que les tests déclaraient conforme

Le dépôt écrivait des fichiers **vides** pendant que l'API répondait `201` avec
la bonne taille. Cause : le compteur d'octets écoutait le flux entrant, ce qui le
met en écoulement immédiat, les octets partaient dans le vide pendant
l'ouverture du fichier de destination.

**Les tests passaient malgré tout** : ils vérifiaient que le disque *ne contient
pas* le texte en clair, ce qu'un fichier vide satisfait trivialement. Découvert
en inspectant le disque à la main.

**Ce qu'on en a tiré :** une garantie négative ne suffit pas. Deux tests ont été
ajoutés, déchiffrer le fichier stocké et retrouver le contenu d'origine, et
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

## Ce qui n'a pas été vérifié (A check avec les SRC)

À distinguer de ce qui précède : ces points sont **envisagés**, pas observés.

| Point | État |
|---|---|
| **Sauvegarde et restauration** | Procédure écrite, **non jouée**. Dépend de l'infrastructure. |
| Dépôt d'un fichier de 200 Mo | Limite configurée et testée à petite échelle ; le volume réel n'a pas été éprouvé |
| Comportement à disque plein | Non provoqué |
| Montée en charge | Aucun test de charge, le service vise une instance |
| Analyse antivirale des dépôts | Absente, et impossible sur du contenu chiffré. **Le contrôle de format ne filtre pas les menaces** : un document à macros ou un PDF piégé passent |
| Nettoyage des fichiers dont tous les partages ont expiré | Aucun automatisme ; ils restent sur le disque |
