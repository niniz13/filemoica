# Architecture — partie backend

Ma part du schéma commun. Les diagrammes sont en Mermaid : ils se rendent
directement sur GitHub et restent modifiables, contrairement à une image.

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

    subgraph iw["Périmètre IW — backend"]
        direction TB
        API["API NestJS<br/><i>HTTP, port 3000</i>"]
    end

    subgraph donnees["Données"]
        direction TB
        DB[("PostgreSQL<br/><i>métadonnées chiffrées</i>")]
        FS[("Volume de fichiers<br/><i>contenus chiffrés</i>")]
    end

    KEY["🔑 Clé maître<br/><i>variable d'environnement</i>"]

    U -->|"dépose, partage, révoque"| RP
    D -->|"ouvre un lien"| RP
    RP -->|"HTTP interne"| API
    API <-->|"Prisma"| DB
    API <-->|"flux chiffré"| FS
    KEY -.->|"déchiffre les clés de fichiers"| API

    style KEY fill:#fff3cd,stroke:#d39e00
    style src fill:#e7f1ff,stroke:#0d6efd
    style iw fill:#e8f5e9,stroke:#2e7d32
```

**Ce que le schéma doit faire comprendre :** la clé maître n'est **ni en base ni
sur le volume**. Voler l'un des deux — ou les deux — ne suffit pas.

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
demande de réécrire que les clés de fichiers — quelques dizaines d'octets
chacune. Les fichiers ne sont jamais relus. *Mesuré : 101 ms pour tout le
service, contre plusieurs heures s'il fallait tout re-chiffrer.*

---

## 3. Les contrôles d'accès, dans l'ordre

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

## 4. Dépôt d'un fichier

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

**Le contenu n'existe en clair à aucun moment sur le serveur** — ni sur le
disque, ni en mémoire complète. Les deux modes de réception fournis par la
bibliothèque standard ont été écartés pour cette raison.

---

## 5. Téléchargement par un destinataire sans compte

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

## 6. Modèle de données

```mermaid
erDiagram
    User ||--o{ File : "possède"
    User ||--o{ Share : "crée"
    User ||--o{ RefreshToken : "sessions"
    User ||--o{ MonthlyUsage : "consommation"
    Share ||--|{ ShareFile : "couvre"
    File ||--o{ ShareFile : ""

    User {
        uuid id
        string email "en clair — recherche à la connexion"
        string password_hash "argon2id"
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
    }
    Share {
        uuid id
        string token_hash "SHA-256 — jamais le jeton"
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

**Ce qui est en clair, et pourquoi :** seul `users.email` — la connexion doit
pouvoir chercher par email. La donnée sensible d'un partage, c'est l'email du
*destinataire*, et celui-là est chiffré.

---

## 7. Répartition des responsabilités

```mermaid
flowchart LR
    subgraph SRC["🔵 SRC — infrastructure"]
        direction TB
        S1["HTTPS / reverse proxy"]
        S2["Conteneurisation"]
        S3["Volume et sauvegardes"]
        S4["Supervision, collecte des logs"]
        S5["Secrets de production"]
    end

    subgraph IW["🟢 IW — application"]
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
  chemin vers le contenu — y compris aux administrateurs du service.
- **Indisponibilité de quelques secondes** au redémarrage.
