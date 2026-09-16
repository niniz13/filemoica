import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { FileStorage } from '../storage/file-storage';
import type { EncryptedUpload } from './encrypted-upload.storage';
import { QuotaService } from './quota.service';

/** Un fichier tel que son propriétaire le voit. */
export interface OwnedFile {
  id: string;
  originalName: string;
  sizeBytes: number;
  createdAt: Date;
}

/**
 * Gestion des fichiers déposés.
 *
 * Le chiffrement du contenu a déjà eu lieu au moment où ce service intervient :
 * il ne manipule que des métadonnées. Sa responsabilité est le **cloisonnement**
 * — un utilisateur ne voit et ne touche que ses propres fichiers.
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly storage: FileStorage,
    private readonly quota: QuotaService,
  ) {}

  /**
   * Enregistre un fichier fraîchement chiffré.
   *
   * Si l'écriture en base échoue, le contenu déjà présent sur le support est
   * retiré : mieux vaut perdre le dépôt que laisser un fichier que plus rien ne
   * référence et que personne ne nettoiera.
   */
  async register(
    ownerId: string,
    upload: EncryptedUpload,
  ): Promise<OwnedFile> {
    const originalName = this.decodeFilename(upload.originalname);

    try {
      const file = await this.prisma.file.create({
        data: {
          ownerId,
          storageName: upload.storageName,
          // Le nom d'origine est une information en soi : « bilan-2026.pdf »
          // en dit déjà long, même sans le contenu.
          originalNameEnc: this.crypto.seal(originalName),
          dekWrapped: upload.dekWrapped,
          keyVersion: upload.keyVersion,
          contentIv: upload.contentIv,
          contentAuthTag: upload.contentAuthTag,
          sizeBytes: upload.sizeBytes,
        },
        select: { id: true, sizeBytes: true, createdAt: true },
      });

      // Après l'enregistrement seulement : un dépôt qui échoue ne doit pas
      // consommer de quota.
      await this.quota.record(ownerId, upload.sizeBytes);

      this.logger.log(`Fichier déposé : ${file.id} (${file.sizeBytes} octets)`);

      return { ...file, originalName };
    } catch (error) {
      await this.storage.remove(upload.storageName);
      throw error;
    }
  }

  /**
   * Liste les fichiers d'un utilisateur.
   *
   * Le filtre sur le propriétaire est appliqué **par la base**, pas après coup :
   * un fichier d'autrui ne remonte jamais, même le temps d'un traitement.
   */
  async listOwnedBy(ownerId: string): Promise<OwnedFile[]> {
    const files = await this.prisma.file.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        originalNameEnc: true,
        sizeBytes: true,
        createdAt: true,
      },
    });

    return files.map((file) => ({
      id: file.id,
      originalName: this.crypto.openToString(file.originalNameEnc),
      sizeBytes: file.sizeBytes,
      createdAt: file.createdAt,
    }));
  }

  /**
   * Supprime un fichier et son contenu.
   *
   * @throws {NotFoundException} Si le fichier n'existe pas **ou** appartient à
   * quelqu'un d'autre — voir {@link requireOwned}.
   */
  async remove(ownerId: string, fileId: string): Promise<void> {
    const file = await this.requireOwned(ownerId, fileId);

    // La base d'abord : si la suppression du contenu échoue, il reste un
    // fichier orphelin sur le support, sans conséquence. Dans l'autre sens, on
    // garderait une entrée dont le téléchargement échouerait.
    await this.prisma.file.delete({ where: { id: file.id } });
    await this.storage.remove(file.storageName);

    this.logger.log(`Fichier supprimé : ${fileId}`);
  }

  /**
   * Efface un fichier dont plus aucun lien ne permet le téléchargement.
   *
   * Appelé après qu'un lien à usage unique a servi. **Sans contrôle de
   * propriétaire** : c'est une décision du système, prise en application de ce
   * que le déposant avait demandé au moment du partage.
   *
   * La vérification préalable est essentielle : le déposant a pu créer
   * plusieurs liens sur le même fichier, et effacer sans regarder casserait
   * silencieusement les autres.
   *
   * @returns `true` si le fichier a réellement été effacé.
   */
  async removeIfNoUsableShare(fileId: string): Promise<boolean> {
    const exploitables = await this.prisma.share.count({
      where: {
        // Un partage couvre plusieurs fichiers : on passe par la table de
        // jointure plutôt que par une colonne, qui n'existe plus.
        files: { some: { fileId } },
        revoked: false,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
    });

    if (exploitables > 0) {
      this.logger.log(
        `Fichier ${fileId} conservé : ${exploitables} lien(s) encore exploitable(s)`,
      );
      return false;
    }

    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: { storageName: true },
    });

    if (!file) {
      return false;
    }

    // La base d'abord : les partages tombent en cascade, et le fichier
    // disparaît de la liste du déposant. C'est bien ce qui a été demandé — la
    // donnée ne survit pas à sa transmission.
    await this.prisma.file.delete({ where: { id: fileId } });
    await this.storage.remove(file.storageName);

    this.logger.log(
      `Fichier ${fileId} effacé du serveur après un téléchargement à usage unique`,
    );

    return true;
  }

  /**
   * Récupère un fichier en vérifiant qu'il appartient bien au demandeur.
   *
   * Renvoie **404 et non 403** quand le fichier appartient à quelqu'un d'autre.
   * Un 403 confirmerait son existence : en essayant des identifiants, on
   * pourrait dénombrer les fichiers du service. Un 404 ne distingue pas
   * « n'existe pas » de « n'est pas à vous ».
   */
  async requireOwned(
    ownerId: string,
    fileId: string,
  ): Promise<{ id: string; storageName: string }> {
    const file = await this.prisma.file.findFirst({
      where: { id: fileId, ownerId },
      select: { id: true, storageName: true },
    });

    if (!file) {
      throw new NotFoundException({
        error: 'FILE_NOT_FOUND',
        message: 'Fichier introuvable.',
      });
    }

    return file;
  }

  /**
   * Rétablit un nom de fichier accentué.
   *
   * Le format d'envoi de formulaire ne transporte pas d'indication d'encodage
   * pour le nom du fichier ; l'analyseur le décode donc en latin1 par défaut.
   * Sans cette correction, « rapport-générique.pdf » deviendrait
   * « rapport-gÃ©nÃ©rique.pdf » — et resterait ainsi, puisqu'on le chiffre
   * aussitôt.
   */
  private decodeFilename(raw: string): string {
    const reinterpreted = Buffer.from(raw, 'latin1').toString('utf8');

    // Une reinterprétation ratée produit le caractère de remplacement. Dans ce
    // cas, le nom était déjà correctement encodé : on garde l'original.
    return reinterpreted.includes('�') ? raw : reinterpreted;
  }
}
