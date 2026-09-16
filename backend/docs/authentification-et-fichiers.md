<!-- Extrait du README pour le garder lisible. -->

## Authentification

### Routes

| Méthode | Route | Accès | Rôle |
|---|---|---|---|
| `POST` | `/api/auth/register` | public | Crée un compte |
| `POST` | `/api/auth/login` | public | Ouvre une session, pose les cookies |
| `POST` | `/api/auth/refresh` | cookie de rafraîchissement | Renouvelle la session |
| `POST` | `/api/auth/logout` | public | Ferme la session et révoque les jetons |
| `GET` | `/api/auth/me` | **session requise** | Compte courant |

**Aucun jeton n'apparaît dans les corps de réponse.** Ils partent uniquement
dans des cookies `httpOnly` : le front n'a rien à stocker, et le JavaScript de
la page ne peut pas lire la session.

### Deux jetons, deux rôles

- **Access token** — un JWT de 15 minutes, présenté à chaque requête. Autoportant,
  donc validé sans consulter la base.
- **Refresh token** — une valeur **opaque** de 32 octets, valable 7 jours, dont le
  seul rôle est d'obtenir un nouvel access token.

Pourquoi le second n'est-il pas un JWT ? Parce qu'un JWT ne peut pas être
révoqué : il reste valide jusqu'à expiration. Le refresh token, lui, est une
ligne en base — le révoquer est immédiat. La durée courte de l'access token borne
la fenêtre pendant laquelle un vol reste exploitable.

Son cookie est restreint au chemin `/api/auth` : le navigateur ne l'envoie jamais
sur les routes de fichiers ou de partage. Un jeton qui ne circule pas est un
jeton qu'on ne peut pas intercepter au passage.

### Détection de vol de session

Chaque utilisation d'un refresh token le consomme et en émet un nouveau. Tous les
jetons issus d'une même connexion partagent une lignée (`family_id`).

Si un jeton **déjà consommé** est présenté, il n'y a que deux explications : il a
été volé et l'attaquant le rejoue, ou il a été volé et c'est la victime qui le
rejoue. Dans les deux cas, quelqu'un d'autre en détient une copie — la **lignée
entière** est donc révoquée.

La victime est déconnectée elle aussi. C'est un choix assumé : mieux vaut une
reconnexion contrariante qu'un attaquant qui garde un accès silencieux.

### Révocation immédiate à la déconnexion

Se déconnecter fait deux choses : révoquer le refresh token et sa lignée en base,
et inscrire l'identifiant (`jti`) de l'access token sur une liste de refus,
consultée à chaque requête.

Sans cette seconde action, un jeton volé resterait valable **jusqu'à 15 minutes
après** la déconnexion. La liste ne contient jamais que quelques minutes de
déconnexions, et une purge suffit à la vider.

### Mots de passe

argon2id, avec les paramètres recommandés par l'OWASP (19 Mio de mémoire,
2 passes). Le coût mémoire est le paramètre décisif : il neutralise l'avantage
des cartes graphiques, là où un attaquant testerait des millions de mots de passe
par seconde contre du SHA-256.

**Un seul critère à l'inscription : 12 caractères minimum.** Les règles de
composition (« une majuscule, un chiffre, un caractère spécial ») poussent en
pratique vers des mots de passe courts et prévisibles du type `Password1!`,
quand une phrase longue résiste bien mieux. C'est la recommandation actuelle de
l'ANSSI et du NIST.

### Contre l'énumération des comptes

Deux précautions rendent impossible de découvrir quels emails ont un compte :

- le message d'erreur est **identique** pour un email inconnu et pour un mot de
  passe faux ;
- une vérification **factice** est exécutée quand l'email n'existe pas. Sans
  elle, la réponse serait immédiate dans ce cas et prendrait plusieurs dizaines
  de millisecondes dans l'autre : ce seul écart de temps suffirait à énumérer les
  comptes, sans jamais connaître un mot de passe.

L'inscription, elle, révèle qu'un email est déjà pris. C'est un compromis
assumé : l'alternative — accepter silencieusement — rendrait l'inscription
incompréhensible pour quelqu'un qui a simplement oublié qu'il avait un compte.

### Routes fermées par défaut

Le garde de session est **global**. Une route est protégée tant qu'elle n'est pas
explicitement ouverte par `@Public()`.

C'est l'inverse de la configuration habituelle, et c'est voulu : un oubli produit
une route **inaccessible**, qu'on remarque au premier essai, plutôt qu'une route
ouverte à tous, qu'on ne remarque jamais.

---

## Fichiers

| Méthode | Route | Rôle |
|---|---|---|
| `POST` | `/api/files` | Dépose un fichier (`multipart/form-data`, champ `file`) |
| `GET` | `/api/files` | Liste ses propres fichiers |
| `GET` | `/api/files/quota` | Volume déposé ce mois-ci et solde restant |
| `DELETE` | `/api/files/:id` | Supprime un fichier et son contenu |

### Le chiffrement a lieu pendant la réception

Les deux modes de réception fournis par la bibliothèque standard étaient
inutilisables ici :

- écrire d'abord sur le disque puis chiffrer laisserait le contenu **en clair**,
  ne serait-ce qu'un instant — et définitivement si le service s'arrêtait
  entre-temps ;
- tout garder en mémoire ferait tomber le service au bout de quelques dépôts
  simultanés.

Un [moteur de réception sur mesure](src/files/encrypted-upload.storage.ts)
branche donc le chiffrement directement sur le flux entrant. Les octets passent
de la requête au fichier chiffré **sans jamais s'arrêter en clair**, ni sur le
disque ni en mémoire.

C'est ce qui permet d'affirmer, sans nuance : à aucun moment le serveur ne
détient une version lisible d'un fichier déposé.

### Cloisonnement entre utilisateurs

Le filtre sur le propriétaire est appliqué **par la requête en base**, pas après
coup : un fichier d'autrui ne remonte jamais, même le temps d'un traitement.

La suppression d'un fichier appartenant à quelqu'un d'autre renvoie **404, pas
403**. Un 403 confirmerait l'existence du fichier : en essayant des
identifiants, on pourrait dénombrer les fichiers du service. Le 404 ne distingue
pas « n'existe pas » de « n'est pas à vous ».

### Contrôle du format par les octets, pas par l'extension

L'extension et le type annoncé viennent tous deux du client : renommer
`virus.exe` en `rapport.pdf` suffirait à tromper une vérification qui s'y
fierait. Le [contrôle](src/files/mime-sniffer.stream.ts) lit donc les **octets de
signature** du fichier.

Il est placé **dans le flux, avant le chiffrement** : un format refusé n'est
jamais écrit sur le disque. Seuls quatre kilo-octets sont retenus en mémoire, y
compris pour un fichier de 200 Mo.

Les [formats acceptés](src/files/allowed-types.ts) couvrent documents, images,
vidéo, audio et archives. En ajouter un tient en une ligne.

**Cas particulier du texte.** Un `.txt` ou un `.csv` n'a aucune signature —
rien ne le distingue d'un fragment quelconque. Ces formats sont donc acceptés
sur la foi du type déclaré, doublée d'une vérification sommaire du contenu
(absence d'octet nul). Sans cette porte, aucun fichier texte ne passerait ; sans
la vérification, il suffirait de déclarer `text/plain` pour contourner la liste.

**Ce que ce contrôle ne fait pas**, et qu'il ne faut pas prétendre : il ne
détecte ni un document porteur de macros, ni un PDF piégé, ni une archive
malveillante — tous figurent dans les formats acceptés. Seule une analyse
antivirale les repérerait, et elle est impossible sur un contenu chiffré dès sa
réception.

La liste sert donc surtout à **définir le périmètre du service**. La protection
réelle est ailleurs : le serveur n'exécute ni n'affiche jamais un fichier
déposé, et le téléchargement force l'enregistrement plutôt que l'ouverture dans
le navigateur.

### Limites appliquées

| Limite | Valeur | Raison |
|---|---|---|
| Taille d'un fichier | `MAX_FILE_SIZE_MB`, **200 par défaut** | Sans borne, un seul dépôt peut remplir le disque |
| Fichiers par requête | 1 | Réduire ce qu'on accepte réduit ce qu'il faut valider |
| Champs supplémentaires | 0 | Idem |

Un dépôt interrompu, trop volumineux ou d'un format refusé voit son contenu
partiel **retiré du support** : sans cela, chaque échec laisserait un fichier
orphelin que personne ne nettoierait.

### Quota mensuel et offres

Deux offres, portées par le champ `plan` du compte :

| Offre | Volume mensuel | Variable |
|---|---|---|
| Gratuite | 200 Mo | `FREE_PLAN_QUOTA_MB` |
| Payante | 20 Go | `PREMIUM_PLAN_QUOTA_MB` |

Les valeurs sont dans la configuration : ajuster l'offre après un retour
d'utilisateur ne demande pas de modifier le code.

**Aucun module de paiement.** Le passage en offre payante se fait en écrivant
`PREMIUM` dans la base. Ce qui est démontré, c'est la **mécanique du quota** —
brancher un prestataire reviendrait à écrire cette même valeur après une
transaction réussie.

**Le quota mesure ce qui a été déposé, pas l'espace occupé.** Supprimer un
fichier ne rend donc pas de quota : sinon, envoyer puis effacer en boucle
suffirait à contourner l'offre gratuite. Un test le vérifie.

Le compteur vit dans une table `monthly_usage`, une ligne par compte et par
mois. Aucune remise à zéro n'est à programmer : le mois suivant crée simplement
une nouvelle ligne.

Un dépassement répond **402 Paiement requis**, et non 413. Le code dit ce dont
il s'agit : la requête est légitime, c'est l'offre qui est atteinte. Le front
peut y accrocher sa proposition de passage à l'offre supérieure, là où un 413 ne
parlerait que de taille.

> **Où le refus a lieu, et pourquoi.** Le contrôle s'applique **pendant** la
> réception, à l'octet de trop, et non avant l'envoi. Refuser plus tôt sur la
> foi de la taille annoncée a été essayé puis abandonné : répondre avant que le
> client ait fini d'envoyer coupe la connexion, et il reçoit une erreur réseau
> au lieu du message expliquant que son quota est atteint. C'est le même
> compromis que celui de la taille maximale.

---

