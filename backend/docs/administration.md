# Administration des comptes

Trois rôles, trois périmètres :

| Rôle | Ce qu'il peut faire |
|---|---|
| Visiteur *(sans compte)* | Ouvrir un lien de partage et télécharger |
| `USER` | Déposer, partager, révoquer — **ses** fichiers uniquement |
| `ADMIN` | Tout ce qui précède, plus la gestion des **comptes** |

## Les routes

| Méthode | Route | Rôle |
|---|---|---|
| `GET` | `/api/admin/stats` | Vue d'ensemble du service |
| `GET` | `/api/admin/users` | Liste des comptes |
| `PATCH` | `/api/admin/users/:id/plan` | Bascule l'offre gratuite / payante |
| `PATCH` | `/api/admin/users/:id/role` | Accorde ou retire l'administration |
| `POST` | `/api/admin/users/:id/revoke-sessions` | Coupe les sessions d'un compte |

Toutes exigent une session **et** le rôle `ADMIN`. Une session parfaitement
valide mais sans le rôle reçoit `403 INSUFFICIENT_ROLE`.

## La frontière que l'administration ne franchit pas

**Un administrateur gère des comptes, jamais du contenu.**

Il voit *combien* de fichiers un compte possède. Jamais *lesquels*. Aucune route
d'administration ne renvoie un nom de fichier, un contenu, ou de quoi en
déchiffrer un — et les routes de fichiers restent cloisonnées par propriétaire,
le rôle n'y changeant rien. Deux tests le vérifient, dont un qui dépose un
fichier nommé `secret.txt` et s'assure que ce nom n'apparaît nulle part dans la
réponse du panneau.

C'est une **frontière de conception, pas une limitation technique**. Le serveur
détient les clés et pourrait tout lire. Ne pas offrir ce chemin dans l'API est
précisément ce qui rend la promesse de confidentialité défendable : sans cette
règle, l'argumentaire s'effondre en une phrase — « vos fichiers sont chiffrés,
mais l'administrateur lit tout ».

## Le rôle est relu en base, pas porté par le jeton

Le mettre dans le jeton de session serait plus rapide. Mais un jeton vit 15
minutes : un administrateur rétrogradé garderait ses pouvoirs jusqu'à
l'expiration de sa session. Pour une élévation de privilèges, ce délai est
inacceptable.

Le rôle est donc relu à chaque appel d'administration. Le coût est d'une requête
sur un index primaire, sur des routes rares. **Un retrait prend effet
immédiatement**, sans reconnexion — un test le vérifie avec le même cookie avant
et après.

> **Pourquoi ne pas mettre le rôle dans le jeton et invalider celui-ci ?**
> Parce qu'un jeton autoportant n'est pas reconnaissable : le serveur ne garde
> pas la liste de ceux qu'il a émis. Pour pouvoir en révoquer un, il faudrait
> stocker chaque identifiant de jeton émis, ou poser sur le compte une date
> « jetons valides à partir de » — et dans les deux cas relire la base **à
> chaque requête**. On retomberait donc sur ce que fait déjà ce garde, avec une
> table de plus à maintenir et à purger. L'économie recherchée en portant le
> rôle dans le jeton disparaît dès qu'on veut pouvoir le révoquer.

## Rétrograder n'est pas déconnecter

Ce sont **deux gestes distincts**, et c'est volontaire :

| Geste | Question à laquelle il répond |
|---|---|
| Changer le rôle | *A-t-il encore le droit de faire ceci ?* |
| Révoquer les sessions | *Doit-il encore être connecté ?* |

Rétrograder un administrateur lui retire le panneau **instantanément**, mais le
laisse connecté comme utilisateur ordinaire. Les fusionner — couper les sessions
à chaque changement de rôle — a été envisagé puis écarté.

Le raisonnement, sur les cas réels :

- **Réorganisation.** Un collègue cesse d'être administrateur mais reste dans
  l'équipe. Le déconnecter interromprait son travail en cours — un transfert de
  150 Mo, par exemple — sans rien protéger : il n'a jamais été une menace.
- **Compte compromis.** C'est le seul cas où couper la session compte vraiment.
  Mais on ne *rétrograde* pas la victime, qui n'a rien fait : on révoque ses
  sessions et on lui fait changer son mot de passe. La rétrogradation est le
  mauvais levier, et l'outil adapté existe déjà.
- **Enquête interne.** Retirer les pouvoirs sans signaler qu'on a repéré
  quelque chose. Une déconnexion brutale est un signal ; la perte silencieuse du
  panneau, non.
- **Erreur de manipulation.** Une promotion corrigée trente secondes plus tard
  ne doit déconnecter personne.

Fusionner les deux retirerait donc une décision à celui qui administre, sans
protéger davantage.

## Un administrateur ne peut pas se rétrograder

Tenter de retirer ses propres droits répond `400 CANNOT_DEMOTE_SELF`.

Sans ce garde-fou, le dernier administrateur peut se verrouiller dehors, et il
faut alors rouvrir la base à la main pour réparer. Le refus est plus utile qu'un
service à réparer.

Rétrograder **un autre** administrateur reste possible : c'est le cas légitime.

## Ce que le panneau ne fait pas, et pourquoi

**Il n'expose pas les journaux.** Ils partent sur la sortie standard et sont
collectés par l'infrastructure. Les republier via l'API ferait doublon avec
l'outillage de supervision, et ces lignes contiennent des identifiants
d'utilisateurs : ce serait ajouter une surface d'attaque pour réimplémenter
moins bien ce qui existe déjà.

**Il ne supprime pas de compte.** Une suppression emporterait en cascade les
fichiers, les partages et l'historique de consommation. Tant que la politique de
conservation n'est pas décidée, la révocation des sessions couvre le besoin
urgent — couper l'accès d'un compte compromis — sans décision irréversible.

## Comptes de démonstration

```bash
npm run seed
```

| Compte | Rôle | Offre | À quoi il sert dans la démonstration |
|---|---|---|---|
| `admin@filemoica.fr` | `ADMIN` | payante | Montrer le panneau et le refus opposé aux autres |
| `alice@filemoica.fr` | `USER` | gratuite | Montrer la limite de quota |
| `bob@filemoica.fr` | `USER` | payante | Montrer la levée de cette limite |

Mot de passe commun : `demonstration-filemoica-2026`.

Le script **refuse de s'exécuter en production** : il crée des comptes dont le
mot de passe est public. Il est rejouable sans erreur, et remet rôles et offres
dans leur état attendu si une démonstration les a modifiés.

Il ne dépose aucun fichier : le dépôt passe par le chiffrement en flux de l'API,
et le court-circuiter en écrivant directement en base produirait des données
incohérentes — précisément le genre de raccourci qui casse une démonstration.

## La limite de la révocation de sessions

Elle coupe les refresh tokens, donc l'utilisateur ne peut plus renouveler sa
session. En revanche, **un access token déjà émis reste valide jusqu'à 15
minutes** : les inscrire sur liste de refus demanderait de connaître leurs
identifiants, que le serveur ne conserve pas.

C'est la contrepartie assumée de jetons autoportants et de courte durée. La
fenêtre est bornée par leur durée de vie, elle-même choisie courte pour cette
raison.
