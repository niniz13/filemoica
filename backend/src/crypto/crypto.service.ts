import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
  type Cipheriv,
  type Decipheriv,
} from 'node:crypto';
import type { EnvironmentVariables } from '../config/env.validation';

/** Algorithme unique du service : chiffrement **et** contrôle d'intégrité. */
const ALGORITHM = 'aes-256-gcm';

/** Taille d'IV recommandée pour GCM (96 bits). */
const IV_BYTES = 12;

/** Taille du tag d'authentification GCM (128 bits). */
const AUTH_TAG_BYTES = 16;

/** Taille d'une clé AES-256. */
const KEY_BYTES = 32;

/** Sépare les champs d'une valeur scellée. Absent du base64, donc sans ambiguïté. */
const SEALED_SEPARATOR = '.';

/**
 * Erreur de déchiffrement.
 *
 * Levée aussi bien quand la valeur est mal formée que quand le tag
 * d'authentification ne correspond pas — c'est-à-dire quand la donnée a été
 * altérée. Le message reste volontairement vague : il ne faut pas indiquer à un
 * attaquant *quelle* partie de sa tentative a échoué.
 */
export class DecryptionError extends Error {
  constructor(message = 'Déchiffrement impossible') {
    super(message);
    this.name = 'DecryptionError';
  }
}

/**
 * Toutes les opérations cryptographiques du service.
 *
 * ## Chiffrement enveloppe
 *
 * Le contenu d'un fichier n'est jamais chiffré directement avec la clé maître.
 * Chaque fichier reçoit sa propre clé (DEK, *data encryption key*), tirée au
 * hasard ; c'est cette petite clé qui est chiffrée par la clé maître (KEK, *key
 * encryption key*) et stockée en base.
 *
 * L'intérêt est la rotation. Avec une clé unique, changer de clé imposerait de
 * relire et re-chiffrer **tous les fichiers**. Ici, on ne re-chiffre que les
 * DEK — quelques dizaines d'octets par fichier — et les fichiers eux-mêmes ne
 * sont pas touchés. C'est le modèle d'AWS KMS et de Google Cloud KMS.
 *
 * ## Format scellé
 *
 * Toute valeur chiffrée par ce service est une chaîne unique :
 *
 *     <version>.<iv base64>.<tag base64>.<chiffré base64>
 *
 * La version de clé voyage avec la donnée : pendant une rotation, d'anciennes
 * valeurs en `v1` et de nouvelles en `v2` cohabitent sans ambiguïté.
 *
 * ## Ce que ce service ne fait pas
 *
 * Il ne hache pas les mots de passe. Un mot de passe demande une fonction
 * volontairement lente (argon2id) ; confondre les deux usages est une erreur
 * classique. Le hachage de mot de passe vit dans le module d'authentification.
 */
@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);

  /** Clés maîtres disponibles, indexées par version (`v1`, `v2`...). */
  private readonly keys: ReadonlyMap<string, Buffer>;

  /** Version utilisée pour tout nouveau chiffrement. */
  private readonly currentVersion: string;

  /** Clé de l'index aveugle, distincte des clés de chiffrement. */
  private readonly indexKey: Buffer;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    const keys = new Map<string, Buffer>();

    keys.set(
      'v1',
      Buffer.from(config.get('ENCRYPTION_KEY_V1', { infer: true }), 'hex'),
    );

    const v2 = config.get('ENCRYPTION_KEY_V2', { infer: true });
    if (v2) {
      keys.set('v2', Buffer.from(v2, 'hex'));
    }

    this.keys = keys;
    // La version la plus récente devient la version d'écriture : ajouter
    // ENCRYPTION_KEY_V2 à la configuration suffit à amorcer une rotation, sans
    // toucher au code.
    this.currentVersion = v2 ? 'v2' : 'v1';

    this.indexKey = Buffer.from(
      config.get('HMAC_INDEX_KEY', { infer: true }),
      'hex',
    );

    // On trace la version active, jamais la clé.
    this.logger.log(
      `Chiffrement au repos actif — version de clé : ${this.currentVersion}`,
    );
  }

  /** Version de clé utilisée pour les nouveaux chiffrements. */
  get keyVersion(): string {
    return this.currentVersion;
  }

  /**
   * Chiffre une valeur avec la clé maître courante.
   *
   * Réservé aux petites données : champs de base (nom de fichier, email de
   * destinataire) et clés de fichier. Le contenu des fichiers, lui, passe par
   * les flux de `createContentCipher`.
   */
  seal(plaintext: string | Buffer): string {
    const key = this.keyFor(this.currentVersion);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);

    const ciphertext = Buffer.concat([
      cipher.update(
        typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext,
      ),
      cipher.final(),
    ]);

    return [
      this.currentVersion,
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      ciphertext.toString('base64'),
    ].join(SEALED_SEPARATOR);
  }

  /**
   * Déchiffre une valeur scellée, quelle que soit la version de clé employée.
   *
   * @throws {DecryptionError} Valeur mal formée, version de clé inconnue, ou
   * tag d'authentification invalide — ce dernier cas signalant une donnée
   * altérée.
   */
  open(sealed: string): Buffer {
    const parts = sealed.split(SEALED_SEPARATOR);

    if (parts.length !== 4) {
      throw new DecryptionError();
    }

    const [version, ivB64, tagB64, ciphertextB64] = parts;
    const key = this.keys.get(version);

    if (!key) {
      throw new DecryptionError();
    }

    try {
      const decipher = createDecipheriv(
        ALGORITHM,
        key,
        Buffer.from(ivB64, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));

      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextB64, 'base64')),
        decipher.final(),
      ]);
    } catch {
      // L'erreur d'origine indiquerait si c'est l'IV, le tag ou la clé qui
      // pose problème : autant d'indices à ne pas donner.
      throw new DecryptionError();
    }
  }

  /** Variante de {@link open} pour les valeurs textuelles. */
  openToString(sealed: string): string {
    return this.open(sealed).toString('utf8');
  }

  /**
   * Indique avec quelle version de clé une valeur a été scellée.
   *
   * Sert à la rotation : c'est ce qui permet de repérer les données restées sur
   * l'ancienne clé, sans avoir à les déchiffrer pour le savoir.
   *
   * @returns La version, ou `null` si la valeur n'est pas au format attendu.
   */
  versionOf(sealed: string): string | null {
    const version = sealed.split(SEALED_SEPARATOR)[0];

    return this.keys.has(version) ? version : null;
  }

  /**
   * Tire une clé de fichier (DEK) au hasard.
   *
   * Elle ne quitte jamais la mémoire en clair : l'appelant la passe à
   * `createContentCipher` pour chiffrer le fichier, puis la scelle avec
   * {@link seal} avant de la stocker.
   */
  generateDataKey(): Buffer {
    return randomBytes(KEY_BYTES);
  }

  /**
   * Prépare le chiffrement d'un contenu de fichier en flux.
   *
   * Le flux évite de charger un fichier entier en mémoire. Le tag
   * d'authentification n'est disponible qu'une fois **tout** le contenu passé :
   * d'où la fonction `authTag()`, à n'appeler qu'à la fin.
   *
   * @param dataKey Clé du fichier, obtenue par {@link generateDataKey}.
   */
  createContentCipher(dataKey: Buffer): {
    cipher: Cipheriv;
    iv: Buffer;
    authTag: () => Buffer;
  } {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, dataKey, iv);

    return {
      cipher,
      iv,
      authTag: () => cipher.getAuthTag(),
    };
  }

  /**
   * Prépare le déchiffrement d'un contenu de fichier en flux.
   *
   * Le tag est fourni d'entrée : c'est lui qui fera échouer le flux si le
   * fichier a été modifié sur le disque. Un fichier altéré provoque donc une
   * erreur plutôt qu'un contenu corrompu servi au destinataire.
   */
  createContentDecipher(
    dataKey: Buffer,
    iv: Buffer,
    authTag: Buffer,
  ): Decipheriv {
    const decipher = createDecipheriv(ALGORITHM, dataKey, iv);
    decipher.setAuthTag(authTag);
    return decipher;
  }

  /**
   * Calcule l'index aveugle d'un email.
   *
   * Permet de retrouver et comparer un destinataire sans jamais déchiffrer son
   * adresse. Deux précautions :
   *
   * - un HMAC, pas un simple hachage : sans la clé, impossible de tester une
   *   liste d'emails contre la base pour découvrir qui a reçu quoi ;
   * - une normalisation préalable, sinon `Alice@X.fr` et `alice@x.fr`
   *   produiraient deux index différents pour une même personne.
   */
  blindIndex(email: string): string {
    return createHmac('sha256', this.indexKey)
      .update(email.trim().toLowerCase(), 'utf8')
      .digest('hex');
  }

  /**
   * Tire un jeton de partage imprévisible.
   *
   * 32 octets d'entropie : il n'est pas devinable par force brute. Encodé en
   * base64url pour tenir dans une URL sans échappement.
   */
  generateToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * Hache un jeton avant stockage.
   *
   * SHA-256 sans sel, volontairement : contrairement à un mot de passe, un
   * jeton de 32 octets aléatoires n'est pas attaquable par dictionnaire, et il
   * faut pouvoir le retrouver par un simple index en base. Conséquence : une
   * fuite de la base ne livre aucun lien de partage utilisable.
   */
  hashToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  /**
   * Compare deux empreintes sans fuite de temps.
   *
   * Une comparaison `===` s'arrête au premier caractère différent : en mesurant
   * ce temps, un attaquant peut reconstituer la valeur attendue caractère par
   * caractère. Utile partout où la valeur comparée vient du client.
   */
  safeEquals(a: string, b: string): boolean {
    const bufferA = Buffer.from(a, 'utf8');
    const bufferB = Buffer.from(b, 'utf8');

    // timingSafeEqual exige des longueurs égales. Comparer les longueurs
    // d'abord ne fuite rien d'exploitable : elles sont fixes ici.
    if (bufferA.length !== bufferB.length) {
      return false;
    }

    return timingSafeEqual(bufferA, bufferB);
  }

  /** Récupère une clé maître, ou échoue si la version est inconnue. */
  private keyFor(version: string): Buffer {
    const key = this.keys.get(version);

    if (!key) {
      throw new DecryptionError(`Version de clé inconnue : ${version}`);
    }

    return key;
  }
}

export { ALGORITHM, AUTH_TAG_BYTES, IV_BYTES, KEY_BYTES };
