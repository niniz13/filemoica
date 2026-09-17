# Architecture : partie backend

Les diagrammes sont en Mermaid

---

## 1. Composants et échanges

```mermaid
flowchart LR
    subgraph internet[" "]
        direction TB
        U["👤 Déposant<br/><i>compte requis</i>"]
        D["👤 Destinataire<br/><i>aucun compte</i>"]
    end

    subgraph src["Périmètre SRC"]
        direction TB
        RP["Reverse proxy<br/><b>HTTPS</b>"]
    end

    subgraph iw["Périmètre IW : backend"]
        direction TB
        API["API NestJS<br/><i>HTTP, port 3000</i>"]
    end

    subgraph donnees["Données"]
        direction TB
        DB[("PostgreSQL<br/><i>métadonnées chiffrées</i>")]
        FS[("Volume de fichiers<br/><i>contenus chiffrés</i>")]
    end

    KEY["🔑 Clé maître<br/><i>variable d'environnement</i>"]
    MAIL["✉️ Brevo<br/><i>API transactionnelle</i>"]

    U -->|"dépose, partage, révoque"| RP
    D -->|"ouvre un lien"| RP
    RP -->|"HTTP interne"| API
    API <-->|"Prisma"| DB
    API <-->|"flux chiffré"| FS
    API -->|"lien de confirmation,<br/>code à six chiffres"| MAIL
    MAIL -->|"courriel"| U
    KEY -.->|"déchiffre les clés de fichiers"| API

    style KEY fill:#fff3cd,stroke:#d39e00
    style src fill:#e7f1ff,stroke:#0d6efd
    style iw fill:#e8f5e9,stroke:#2e7d32
```

**Ce que le schéma doit faire comprendre :** la clé maître n'est **ni en base ni
sur le volume**. Voler l'un des deux, ou les deux, ne suffit pas.

Brevo est la seule dépendance externe. Elle n'est sollicitée qu'à l'inscription
et à la connexion des comptes ayant armé le second facteur : une panne de ce
service n'empêche ni le dépôt, ni le partage, ni le téléchargement.

---

## 2. Le chiffrement enveloppe

```mermaid
flowchart TB
    F["Fichier déposé"] -->|"chiffré par"| DEK["🔑 Clé du fichier<br/><i>tirée au hasard, unique</i>"]
    DEK -->|"chiffrée par"| KEK["🔑 Clé maître<br/><i>variable d'environnement</i>"]

    F -.->|"stocké sur"| FS[("Volume<br/>contenu chiffré")]
    DEK -.->|"stockée en base,<br/>sous forme chiffrée"| DB[("PostgreSQL<br/>dek_wrapped")]
    KEK -.->|"n'est stockée<br/><b>nulle part</b>"| X["❌"]

    style KEK fill:#fff3cd,stroke:#d39e00
    style X fill:#f8d7da,stroke:#dc3545
```

**Pourquoi ce détour plutôt qu'une clé unique :** changer la clé maître ne
demande de réécrire que les clés de fichiers, quelques dizaines d'octets
chacune. Les fichiers ne sont jamais relus. *Mesuré : 101 ms pour tout le
service, contre plusieurs heures s'il fallait tout re-chiffrer.*

---

## 3. Ouverture d'une session

```mermaid
flowchart TB
    L["POST /api/auth/login"] --> PWD{"Mot de passe<br/>correct ?"}
    PWD -->|non| E401a["401 INVALID_CREDENTIALS<br/><i>même réponse qu'un<br/>email inconnu</i>"]
    PWD -->|oui| VER{"Adresse<br/>confirmée ?"}
    VER -->|non| E403["403 EMAIL_NOT_VERIFIED"]
    VER -->|oui| MFA{"Second facteur<br/>armé sur ce compte ?"}
    MFA -->|non| OK["Cookies posés<br/><i>mfaRequired: false</i>"]
    MFA -->|oui| DEFI["Code à six chiffres<br/>envoyé par courriel<br/><i>aucun cookie</i>"]
    DEFI --> V["POST /api/auth/mfa/verify"]
    V --> CODE{"Code bon ?<br/><i>5 essais, 10 min</i>"}
    CODE -->|non| E401b["401 MFA_CODE_INVALID"]
    CODE -->|oui| OK

    style E401a fill:#f8d7da
    style E403 fill:#f8d7da
    style E401b fill:#f8d7da
    style OK fill:#d1e7dd
```

**La confirmation d'adresse est contrôlée après le mot de passe**, jamais avant.
Répondre « adresse non confirmée » à qui n'a pas les identifiants transformerait
la connexion en oracle révélant quels comptes existent.

**Le second facteur est un réglage par compte**, désactivé par défaut et
basculé depuis la page de profil. L'imposer à tous ferait dépendre chaque
connexion d'un envoi de courriel qui aboutit. Sa bascule exige le mot de passe :
une session volée ne doit pas suffire à désarmer la protection qui rend
justement le vol difficile.

---

## 4. Les contrôles d'accès, dans l'ordre

```mermaid
flowchart TB
    R["Requête"] --> LOG["Journal<br/><i>jetons masqués</i>"]
    LOG --> CSRF{"En-tête<br/>X-Requested-With ?"}
    CSRF -->|non, sur écriture| E403a["403 CSRF_HEADER_MISSING"]
    CSRF -->|oui, ou lecture| RATE{"Sous la limite<br/>de tentatives ?"}
    RATE -->|non| E429["429 TOO_MANY_ATTEMPTS"]
    RATE -->|oui| PUB{"Route publique ?"}
    PUB -->|oui| H["Traitement"]
    PUB -->|non| SESS{"Session valide<br/>et non révoquée ?"}
    SESS -->|non| E401["401"]
    SESS -->|oui| ROLE{"Rôle suffisant ?<br/><i>relu en base</i>"}
    ROLE -->|non| E403b["403 INSUFFICIENT_ROLE"]
    ROLE -->|oui| OWN{"Propriétaire<br/>de la ressource ?"}
    OWN -->|non| E404["404<br/><i>et non 403 :<br/>ne pas confirmer<br/>l'existence</i>"]
    OWN -->|oui| H

    style E403a fill:#f8d7da
    style E429 fill:#f8d7da
    style E401 fill:#f8d7da
    style E403b fill:#f8d7da
    style E404 fill:#f8d7da
    style H fill:#d1e7dd
```

**Le rôle est relu en base à chaque appel**, pas porté par le jeton : un retrait
de privilège prend effet immédiatement, au lieu d'attendre l'expiration de la
session.

---

## 5. Dépôt d'un fichier

```mermaid
sequenceDiagram
    participant C as Client
    participant A as API
    participant S as Volume
    participant D as PostgreSQL

    C->>A: POST /api/files (flux)
    A->>A: Identifie le format<br/>sur les octets de signature
    Note over A: Format refusé → 415,<br/>rien n'est écrit
    A->>A: Tire une clé de fichier
    A->>A: Chiffre <b>au fil du flux</b>
    A->>S: Écrit le contenu chiffré
    Note over A: Quota dépassé → 402,<br/>le fichier partiel est retiré
    A->>D: Nom chiffré + clé chiffrée + tag
    A->>D: Incrémente le volume du mois
    A-->>C: 201
```

**Le contenu n'existe en clair à aucun moment sur le serveur**, ni sur le
disque, ni en mémoire complète. Les deux modes de réception fournis par la
bibliothèque standard ont été écartés pour cette raison.

---

## 6. Téléchargement par un destinataire sans compte

```mermaid
sequenceDiagram
    participant D as Destinataire
    participant A as API
    participant B as PostgreSQL
    participant S as Volume

    D->>A: GET /api/download/:token/info
    A->>B: Cherche par <b>empreinte</b> du jeton
    A-->>D: Fichiers, échéance, mot de passe requis ?
    Note over A,D: Si protégé : ni nom ni taille<br/>tant que le mot de passe n'est pas fourni

    D->>A: GET /api/download/:token/file/:id
    A->>B: Révoqué ? Expiré ? Déjà consommé ?
    A->>A: Vérifie le mot de passe (argon2id)
    A->>B: Déballe la clé du fichier
    A->>S: Lit le contenu chiffré
    A-->>D: Déchiffre <b>à la volée</b><br/>attachment + nosniff
    Note over A,S: Usage unique : si c'était le dernier<br/>fichier, tout est effacé
```

---

## 7. Modèle de données

```mermaid
erDiagram
    User ||--o{ File : "possède"
    User ||--o{ Share : "crée"
    User ||--o{ RefreshToken : "sessions"
    User ||--o{ MonthlyUsage : "consommation"
    User ||--o{ EmailVerification : "confirmations"
    User ||--o{ MfaChallenge : "défis"
    Share ||--|{ ShareFile : "couvre"
    File ||--o{ ShareFile : ""

    User {
        uuid id
        string email "en clair, recherche à la connexion"
        string password_hash "argon2id"
        bool mfa_enabled "second facteur, par compte"
        datetime email_verified_at "null tant que non confirmée"
        enum role "USER / ADMIN"
        enum plan "FREE / PREMIUM"
    }
    File {
        uuid id
        string storage_name "aléatoire"
        string original_name_enc "chiffré"
        string dek_wrapped "clé chiffrée"
        string key_version "rotation"
        string content_iv
        string content_auth_tag "intégrité"
        int size_bytes
    }
    EmailVerification {
        string token_hash "SHA-256, jamais le jeton"
        datetime expires_at "24 h"
        datetime consumed_at "à usage unique"
    }
    MfaChallenge {
        string code_hash "argon2id, jamais le code"
        int attempts "clos à 5"
        datetime expires_at "10 min"
        datetime consumed_at
    }
    RevokedAccessToken {
        string jti "liste de refus"
        datetime expires_at "purgée après expiration"
    }
    Share {
        uuid id
        string token_hash "SHA-256, jamais le jeton"
        string recipient_email_enc "chiffré, facultatif"
        string password_hash "argon2id, facultatif"
        datetime expires_at
        bool burn_after_download
        datetime consumed_at
    }
    ShareFile {
        datetime downloaded_at "verrou de l'usage unique"
    }
```

**Ce qui est en clair, et pourquoi :** seul `users.email`, parce que la connexion doit
pouvoir chercher par email. La donnée sensible d'un partage, c'est l'email du
*destinataire*, et celui-là est chiffré.

---

## 8. Répartition des responsabilités

```mermaid
flowchart LR
    subgraph SRC["🔵 SRC : infrastructure"]
        direction TB
        S1["HTTPS / reverse proxy"]
        S2["Conteneurisation"]
        S3["Volume et sauvegardes"]
        S4["Supervision, collecte des logs"]
        S5["Secrets de production"]
    end

    subgraph IW["🟢 IW : application"]
        direction TB
        I1["Chiffrement au repos"]
        I2["Sessions et rôles"]
        I3["Contrôles d'accès"]
        I4["Sonde /health"]
        I5["Journaux structurés"]
    end

    S1 -.->|"chiffrement<br/><b>en transit</b>"| I1
    I1 -.->|"chiffrement<br/><b>au repos</b>"| S3
    I4 -.->|"200 / 503"| S4
    I5 -.->|"JSON, sortie standard"| S4

    style SRC fill:#e7f1ff,stroke:#0d6efd
    style IW fill:#e8f5e9,stroke:#2e7d32
```

**La décision commune structurante :** l'infrastructure protège les données **en
transit**, le backend les protège **au repos**. Ni l'un ni l'autre ne couvre les
deux, et aucun des deux n'est suffisant seul.

---

## Limites assumées

- **Une seule instance.** Le stockage est un volume attaché à une machine : pas
  de répartition de charge ni de bascule automatique.
- **Perte de la machine = perte des fichiers** depuis la dernière sauvegarde.
- **Le serveur détient les clés.** Ce n'est pas du chiffrement de bout en bout :
  un administrateur système y a techniquement accès. L'API, elle, n'offre aucun
  chemin vers le contenu, y compris aux administrateurs du service.
- **Indisponibilité de quelques secondes** au redémarrage.
- **Dépendance à un service tiers pour les courriels.** Sans Brevo joignable,
  aucune inscription ne peut aboutir et les comptes ayant armé le second facteur
  ne peuvent plus se connecter. Le reste du service continue de fonctionner.

---

## Conservation des fichiers

Un fichier n'est pas effacé à l'expiration de son lien, mais **N jours après la
fin de son dernier partage** : 30 jours pour l'offre gratuite, 90 pour l'offre
payante. Un fichier partagé pour 30 jours survit donc à son lien, et le délai ne
commence à courir qu'ensuite.

Deux exceptions l'effacent plus tôt : la suppression par son propriétaire, et la
consommation d'un lien à usage unique.

La purge est une tâche planifiée (`npm run files:purge`), pas un effet de bord
d'une requête : elle est déclenchée par l'infrastructure, journalisée, et son
échec est visible. Voir [configuration-deploiement.md](configuration-deploiement.md).
