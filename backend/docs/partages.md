<!-- Extrait du README pour le garder lisible. -->

## Partages et téléchargement

| Méthode | Route | Accès | Rôle |
|---|---|---|---|
| `POST` | `/api/shares` | **session** | Crée un lien |
| `GET` | `/api/shares` | **session** | Liste ses partages avec leur état |
| `PATCH` | `/api/shares/:id/revoke` | **session** | Coupe l'accès immédiatement |
| `GET` | `/api/download/:token/info` | *public* | Liste les fichiers du lien, sans le consommer |
| `GET` | `/api/download/:token/file/:fileId` | *public* | Télécharge un fichier du lien |

### Un lien couvre une session de dépôt entière

Un partage porte sur **un ou plusieurs fichiers**, jusqu'à 50. Qui envoie trois
documents transmet **un seul lien**, pas trois — c'est l'usage attendu d'un
service de transfert, et cela évite au destinataire de jongler entre des adresses.

Le destinataire ouvre le lien, voit la liste, et récupère les fichiers un par
un. Il n'y a pas d'archive assemblée côté serveur : elle obligerait à déchiffrer
et recompresser l'ensemble avant le premier octet envoyé, là où le
téléchargement fichier par fichier reste en flux continu.

### Déposer exige un compte, recevoir non

Le destinataire **n'a pas de compte et n'en a pas besoin**. Il clique sur le
lien qu'on lui a transmis et récupère le fichier. Lui imposer une inscription
reviendrait à exiger une démarche de sa part pour rendre service à quelqu'un
d'autre.

La conséquence est nette : **le jeton est le secret**. Trois choses le rendent
acceptable, dont deux sont à la main du déposant :

| Protection | Qui la décide |
|---|---|
| 32 octets aléatoires, hors de portée d'une attaque par essais | le service |
| Une durée de vie, de 1 heure à 30 jours | le déposant |
| Un mot de passe facultatif | le déposant |
| Un usage unique, avec effacement des fichiers | le déposant |
| La révocation, immédiate et à tout moment | le déposant |

### Le lien à usage unique

Option `burnAfterDownload` à la création. Le lien se consume une fois que
**tous** ses fichiers ont été téléchargés, et ceux-ci sont alors **effacés du
serveur** — base et disque — s'il ne leur reste aucun autre lien exploitable.

C'est la garantie la plus forte que le service puisse offrir : *la donnée ne
survit pas à sa transmission*.

**Par défaut un lien reste réutilisable** jusqu'à son expiration ou sa
révocation : le destinataire peut avoir raté son téléchargement, ou le même lien
servir à plusieurs personnes. L'usage unique est donc une option, jamais le
comportement implicite.

Cinq points de conception qui font la différence entre une version correcte et
une version naïve :

**Le lien se consume au dernier fichier, pas au premier.** Un lien couvrant trois
documents et mourant au premier téléchargement serait un piège : le destinataire
n'en récupérerait qu'un. Chaque fichier est marqué à son passage, et le lien
n'est consommé qu'une fois la liste épuisée.

**Chaque fichier est réservé avant son envoi.** Deux personnes qui ouvrent le
même fichier en même temps ne doivent pas repartir toutes les deux avec. La
réservation est une mise à jour conditionnée à la nullité de la date de
téléchargement : la base ne laisse passer qu'un seul gagnant. Un test lance deux
téléchargements simultanés et vérifie qu'il y a exactement un `200` et un `410`.

**Un transfert interrompu rend le fichier.** Coupure réseau, onglet fermé : le
destinataire n'a rien reçu, le compter comme servi serait le pire des deux
mondes. Un fichier n'est définitivement marqué qu'une fois transmis en entier.

**Un fichier n'est effacé que s'il n'a plus aucun lien exploitable.** Le déposant
a pu créer plusieurs partages du même fichier ; brûler l'un d'eux ne doit pas
casser silencieusement les autres.

**Le lien consommé répond `410 SHARE_ALREADY_USED`, et non `404`.** Les fichiers
sont effacés, mais la trace du partage subsiste : le destinataire comprend ce qui
s'est passé plutôt que de recevoir un « ce lien n'existe pas » déroutant, et le
déposant voit dans sa liste que le transfert a bien eu lieu.

> **À dire à l'utilisateur avant qu'il coche la case :** l'effacement est
> irréversible et touche **aussi le déposant**. Les fichiers disparaissent de sa
> propre liste — c'est précisément ce qui est demandé, mais cela doit être
> annoncé.

### Le mot de passe de lien

Quand il est défini, le lien seul ne suffit plus. C'est ce qui protège un lien
intercepté, transféré à la mauvaise personne ou publié par erreur.

Il est haché en argon2id, comme un mot de passe de compte, et transmis par le
destinataire dans l'en-tête **`X-Share-Password`** — jamais dans l'URL, où il
finirait dans l'historique du navigateur et dans les journaux des serveurs
traversés.

Tant qu'il n'est pas franchi, `/info` ne révèle **ni le nom ni la taille** du
fichier : quelqu'un qui intercepterait le lien apprendrait sinon ce qu'il
contient sans jamais avoir à le déverrouiller.

### Le jeton n'existe qu'une fois

Il est renvoyé à la création, puis oublié : la base n'en conserve que
l'empreinte SHA-256. Une fuite de la base ne livre donc **aucun lien
utilisable**. Un jeton perdu n'est pas récupérable, il faut créer un nouveau
partage.

L'email du destinataire est facultatif et **purement informatif** : il sert à
savoir à qui un partage était destiné, et servira à la notification. Il ne
conditionne pas l'accès. Il est tout de même chiffré en base.

### Les contrôles et leurs réponses

| Contrôle | Réponse | Code |
|---|---|---|
| Le jeton correspond à un partage | `404` | `SHARE_NOT_FOUND` |
| Le partage n'est pas révoqué | `403` | `SHARE_REVOKED` |
| Le partage n'a pas expiré | `410` | `SHARE_EXPIRED` |
| Le lien à usage unique n'a pas déjà servi | `410` | `SHARE_ALREADY_USED` |
| Ce fichier n'a pas déjà été pris sur ce lien | `410` | `FILE_ALREADY_DOWNLOADED` |
| Le fichier demandé fait partie du lien | `404` | `FILE_NOT_IN_SHARE` |
| Le mot de passe est fourni, s'il en faut un | `401` | `SHARE_PASSWORD_REQUIRED` |
| Le mot de passe est le bon | `403` | `SHARE_PASSWORD_INVALID` |

La révocation est vérifiée **avant** l'expiration : c'est un geste délibéré du
propriétaire, il doit primer sur une date atteinte entre-temps.

Le `410` distingue « a expiré » de « n'a jamais existé », ce qui permet au front
de proposer de demander un nouveau lien plutôt qu'un message d'erreur sec.

Les mêmes refus s'appliquent à `/info` : un lien révoqué est refusé partout de
la même façon.

### Le durcissement du téléchargement

C'est **la** protection réelle contre un fichier malveillant, bien plus que la
liste des formats acceptés :

| En-tête | Effet |
|---|---|
| `Content-Disposition: attachment` | Force l'enregistrement, jamais l'affichage |
| `Content-Type: application/octet-stream` | Prive le navigateur de raison d'interpréter |
| `X-Content-Type-Options: nosniff` | L'empêche de deviner le type malgré tout |

Sans ces en-têtes, un document HTML ou une image vectorielle téléchargés depuis
notre domaine s'exécuteraient **dans notre origine** — ce qui contournerait
précisément la défense CSRF assurée par `SameSite=Strict`.

Deux en-têtes s'ajoutent pour protéger le lien lui-même, puisqu'il est le seul
secret : `Referrer-Policy: no-referrer` l'empêche de partir vers un site tiers,
et `Cache-Control: no-store` évite qu'un relais conserve le fichier déchiffré.

Le nom d'origine est préservé sous deux formes, dont une encodée pour les
accents ; les guillemets en sont retirés, faute de quoi un nom de fichier
pourrait injecter des directives dans l'en-tête.

### Déchiffrement à la volée

Le contenu est déchiffré en flux vers le destinataire : il n'existe en clair **à
aucun moment** sur le disque du serveur.

> **Une conséquence à connaître.** L'intégrité GCM ne se vérifie qu'à la fin du
> flux, donc après l'envoi des en-têtes : un fichier altéré sur le disque ne
> peut plus donner lieu à un code d'erreur propre. La connexion est alors
> coupée, ce qui donne au destinataire un téléchargement manifestement
> interrompu plutôt qu'un fichier corrompu qu'il croirait valide. C'est le prix
> du flux ; l'alternative serait de lire le fichier entier avant d'en envoyer le
> premier octet.

---

