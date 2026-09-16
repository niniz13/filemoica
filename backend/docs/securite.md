<!-- Extrait du README pour le garder lisible. -->

## Sécurité : ce qui est en place

### Chiffrement au repos : le modèle enveloppe

Le contenu d'un fichier n'est jamais chiffré directement avec la clé maître.
Chaque fichier reçoit **sa propre clé** (DEK), tirée au hasard ; seule cette
petite clé est chiffrée par la clé maître (KEK) et stockée en base. La clé maître
ne vit que dans les variables d'environnement.

```
Fichier ──chiffré par──> DEK ──chiffrée par──> KEK (variable d'environnement)
  sur disque              en base                  jamais stockée
```

L'intérêt est la **rotation de clés**. Avec une clé unique, en changer imposerait
de relire et re-chiffrer tous les fichiers. Ici on ne re-chiffre que les DEK,
quelques dizaines d'octets chacune : les fichiers ne sont pas touchés. C'est le
modèle employé par AWS KMS et Google Cloud KMS.

La version de clé voyage avec chaque donnée : ajouter `ENCRYPTION_KEY_V2` à la
configuration suffit à chiffrer les nouvelles données en v2 tout en continuant à
lire celles en v1, **sans changement de code**.

### Faire tourner les clés

```bash
# 1. Générer la nouvelle clé
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. L'ajouter en ENCRYPTION_KEY_V2, SANS retirer ENCRYPTION_KEY_V1

# 3. Simuler
npm run keys:rotate -- --dry-run

# 4. Exécuter
npm run keys:rotate

# 5. Rapport à zéro reste → retirer ENCRYPTION_KEY_V1
```

**Mesuré sur la base de développement : 4 fichiers et 1 partage re-scellés en
101 ms, et les fichiers sur le disque rigoureusement inchangés** (empreinte
SHA-256 identique avant et après).

C'est tout l'intérêt du chiffrement enveloppe : la rotation réécrit la clé de
chaque fichier — quelques dizaines d'octets — et jamais les fichiers eux-mêmes.
Sur un volume réel, c'est la différence entre quelques secondes et plusieurs
heures d'indisponibilité.

Trois propriétés rendent l'opération sûre :

- **Idempotente** — une donnée déjà sur la clé cible est ignorée ; relancer ne
  fait rien de plus.
- **Reprenable** — chaque enregistrement est écrit indépendamment. Une
  interruption laisse un mélange d'anciennes et de nouvelles versions, que la
  prochaine exécution achève et que le service sait lire entre-temps.
- **Sans interruption de service** — l'application peut continuer de tourner
  pendant la bascule.

### AES-256-GCM, et pourquoi pas CBC

GCM apporte le chiffrement **et** le contrôle d'intégrité. Un seul octet modifié
sur le disque rend le tag d'authentification invalide et fait échouer le
déchiffrement.

La différence est concrète : en CBC, un fichier altéré serait déchiffré et servi
au destinataire dans un état corrompu, sans que personne ne le sache. En GCM,
l'opération échoue. Un test le vérifie explicitement.

### Ce qui est chiffré, haché, ou en clair

| Donnée | Traitement | Pourquoi |
|---|---|---|
| Contenu des fichiers | Chiffré AES-256-GCM (disque) | Le vol du disque ne donne rien |
| Nom d'origine des fichiers | Chiffré en base | Un nom de fichier est déjà une information |
| Nom sur le disque | Aléatoire | Un `ls` du répertoire ne révèle rien |
| Email du destinataire | Chiffré + index HMAC | Comparable sans être déchiffré |
| Jeton de partage | SHA-256 uniquement | Une fuite de la base ne livre aucun lien utilisable |
| Refresh token | SHA-256 uniquement | Idem |
| Email du compte | **En clair** | La connexion doit chercher par email |
| Mot de passe | argon2id *(à venir)* | Fonction lente, conçue pour ça |

**`users.email` en clair est un choix assumé**, pas un oubli. Le chiffrer
imposerait un index aveugle pour permettre la connexion, pour un gain faible : la
donnée sensible d'un partage, c'est l'email du *destinataire*, et celui-là est
chiffré.

### L'index aveugle

Comparer un destinataire sans déchiffrer son adresse suppose un index. Deux
précautions :

- un **HMAC** et non un simple hachage : sans la clé, impossible de tester une
  liste d'emails contre la base pour découvrir qui a reçu quoi ;
- une **clé distincte** de celle du chiffrement — une clé, un usage ;
- une **normalisation** préalable (minuscules, espaces retirés), sans quoi
  `Alice@X.fr` ne retrouverait pas son propre partage.

### Protection CSRF sans jeton

Les sessions vivront dans des cookies `httpOnly`, que le navigateur envoie
automatiquement — y compris sur une requête déclenchée par un site tiers. Trois
couches répondent à ce risque :

1. `SameSite=Strict` sur les cookies : le navigateur ne les joint pas aux
   requêtes venues d'un autre site ;
2. une liste blanche CORS d'**une seule origine**, jamais de joker ;
3. un [garde](src/common/guards/csrf.guard.ts) qui exige l'en-tête
   `X-Requested-With` sur toute requête modifiant l'état.

La troisième couche fonctionne parce qu'un `<form>` HTML ne peut pas poser
d'en-tête personnalisé, et qu'une requête JavaScript qui en pose déclenche un
contrôle préalable que notre CORS refuse.

Le double-submit token classique a été écarté : il aurait imposé un cookie
lisible en JavaScript et du code côté front, pour une protection équivalente une
fois `SameSite=Strict` en place.

### Répartition avec l'infrastructure

**Le chiffrement du transport (HTTPS) est assuré par le reverse proxy géré par
SRC.** L'application tourne en HTTP derrière lui et n'expose aucun port au
public. C'est l'une des décisions communes du sprint : l'infrastructure protège
les données *en transit*, le backend les protège *au repos*.

---

