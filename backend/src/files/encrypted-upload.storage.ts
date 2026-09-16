import { PayloadTooLargeException } from '@nestjs/common';
import type { Request } from 'express';
import type { StorageEngine } from 'multer';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CryptoService } from '../crypto/crypto.service';
import { FileStorage } from '../storage/file-storage';

/**
 * Métadonnées produites par le chiffrement, rattachées au fichier reçu.
 *
 * Tout est nécessaire pour relire le fichier plus tard : sans la clé
 * enveloppée, sans l'IV ou sans le tag, le contenu est définitivement perdu.
 */
export interface EncryptedUpload extends Express.Multer.File {
  /** Nom aléatoire sous lequel le contenu chiffré est rangé. */
  storageName: string;
  /** Clé du fichier, chiffrée par la clé maître. */
  dekWrapped: string;
  /** Version de la clé maître utilisée. */
  keyVersion: string;
  /** Vecteur d'initialisation du contenu, en base64. */
  contentIv: string;
  /** Tag d'authentification GCM du contenu, en base64. */
  contentAuthTag: string;
  /** Taille du contenu **en clair**, en octets. */
  sizeBytes: number;
}

/**
 * Chiffre les fichiers reçus au fil de leur arrivée.
 *
 * ## Pourquoi un moteur sur mesure
 *
 * Les deux modes fournis par multer posent chacun un problème :
 *
 * - `diskStorage` écrit le fichier **en clair** sur le disque avant qu'on puisse
 *   le chiffrer. Le contenu existerait donc en clair, ne serait-ce qu'un
 *   instant — et resterait tel quel si le service s'arrêtait entre-temps. Cela
 *   annulerait l'intérêt du chiffrement au repos.
 * - `memoryStorage` garde tout le fichier en mémoire : quelques dépôts
 *   simultanés suffisent à faire tomber le service.
 *
 * Ce moteur branche le chiffrement directement sur le flux entrant. Les octets
 * passent de la requête au fichier chiffré sans jamais s'arrêter en clair, ni
 * sur le disque ni en mémoire.
 *
 * ## Le tag d'authentification
 *
 * Il n'est disponible qu'une fois tout le contenu traité, d'où sa lecture après
 * le flux. C'est lui qui permettra de détecter une altération du fichier sur le
 * disque au moment du téléchargement.
 */
export class EncryptedUploadStorage implements StorageEngine {
  constructor(
    private readonly crypto: CryptoService,
    private readonly storage: FileStorage,
  ) {}

  _handleFile(
    _req: Request,
    file: Express.Multer.File,
    callback: (error?: unknown, info?: Partial<EncryptedUpload>) => void,
  ): void {
    this.encrypt(file)
      .then((info) => callback(null, info))
      .catch((error: unknown) => callback(error));
  }

  /**
   * Retire un fichier déjà écrit.
   *
   * Appelé par multer quand la requête échoue après l'écriture — dépassement de
   * taille, connexion interrompue. Sans cela, chaque dépôt raté laisserait un
   * fichier chiffré orphelin, invisible et jamais nettoyé.
   */
  _removeFile(
    _req: Request,
    file: Express.Multer.File,
    callback: (error: Error | null) => void,
  ): void {
    const storageName = (file as EncryptedUpload).storageName;

    if (!storageName) {
      callback(null);
      return;
    }

    this.storage
      .remove(storageName)
      .then(() => callback(null))
      .catch((error: Error) => callback(error));
  }

  private async encrypt(
    file: Express.Multer.File,
  ): Promise<Partial<EncryptedUpload>> {
    const dataKey = this.crypto.generateDataKey();
    const { cipher, iv, authTag } = this.crypto.createContentCipher(dataKey);
    const storageName = this.storage.newName();

    // Ouvrir la destination **avant** de toucher au flux entrant : la moindre
    // attente asynchrone après l'avoir mis en mouvement ferait perdre les
    // premiers octets.
    const destination = await this.storage.openWrite(storageName);

    let sizeBytes = 0;
    const compteur = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length;
        callback(null, chunk);
      },
    });

    try {
      await pipeline(file.stream, compteur, cipher, destination);
    } catch (error) {
      // Un fichier partiellement écrit ne serait jamais déchiffrable : on le
      // retire tout de suite plutôt que de laisser un déchet sur le support.
      await this.storage.remove(storageName);
      throw error;
    }

    // multer interrompt le flux au-delà de la taille maximale et le marque
    // tronqué. Sans cette vérification, on enregistrerait un fichier amputé en
    // croyant le dépôt réussi.
    if ((file.stream as { truncated?: boolean }).truncated) {
      await this.storage.remove(storageName);
      throw new PayloadTooLargeException({
        error: 'FILE_TOO_LARGE',
        message: 'Le fichier dépasse la taille maximale autorisée.',
      });
    }

    return {
      storageName,
      sizeBytes,
      // La clé du fichier ne quitte cette méthode que chiffrée.
      dekWrapped: this.crypto.seal(dataKey),
      keyVersion: this.crypto.keyVersion,
      contentIv: iv.toString('base64'),
      contentAuthTag: authTag().toString('base64'),
    };
  }
}
