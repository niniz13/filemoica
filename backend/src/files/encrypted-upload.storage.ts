import {
  HttpException,
  HttpStatus,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { StorageEngine } from 'multer';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CryptoService } from '../crypto/crypto.service';
import { FileStorage } from '../storage/file-storage';
import { MimeTypeSniffer } from './mime-sniffer.stream';

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
    req: Request,
    file: Express.Multer.File,
    callback: (error?: unknown, info?: Partial<EncryptedUpload>) => void,
  ): void {
    this.encrypt(file, req.quotaRemainingBytes)
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

  /**
   * @param quotaRemainingBytes Solde mensuel du compte, posé par le garde de
   * quota. Le dépôt est interrompu dès qu'il est dépassé — l'en-tête de
   * longueur annoncé par le client ne suffit pas, puisqu'il vient du client.
   */
  private async encrypt(
    file: Express.Multer.File,
    quotaRemainingBytes?: number,
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

        // Quota dépassé : on interrompt à l'octet de trop. Le contrôle vit ici
        // plutôt que dans un garde, car multer sait vider proprement la
        // requête en cours — refuser plus tôt couperait la connexion et le
        // client verrait une erreur réseau au lieu du message.
        if (
          quotaRemainingBytes !== undefined &&
          sizeBytes > quotaRemainingBytes
        ) {
          const resteMo = (quotaRemainingBytes / (1024 * 1024)).toFixed(1);

          callback(
            new HttpException(
              {
                error: 'QUOTA_EXCEEDED',
                message: `Quota mensuel atteint : il ne vous reste que ${resteMo} Mo. Le compteur repart le 1er du mois.`,
              },
              HttpStatus.PAYMENT_REQUIRED,
            ),
          );
          return;
        }

        callback(null, chunk);
      },
    });

    try {
      // L'ordre compte : on identifie le format **avant** de chiffrer, pour
      // pouvoir refuser un fichier sans jamais l'avoir écrit.
      await pipeline(
        file.stream,
        new MimeTypeSniffer(file.mimetype),
        compteur,
        cipher,
        destination,
      );
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
