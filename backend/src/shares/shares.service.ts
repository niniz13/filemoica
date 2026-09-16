import {
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PasswordService } from '../auth/password.service';
import { CryptoService } from '../crypto/crypto.service';
import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateShareDto } from './dto/create-share.dto';
import type { ShareStatus } from './dto/share.response';

/** Métadonnées nécessaires pour servir un fichier partagé. */
export interface GrantedDownload {
  /** Le lien concerné, nécessaire au suivi des liens à usage unique. */
  shareId: string;
  storageName: string;
  originalName: string;
  sizeBytes: number;
  dekWrapped: string;
  contentIv: string;
  contentAuthTag: string;
  /** Le lien doit-il se consumer une fois le fichier transmis ? */
  burnAfterDownload: boolean;
}

/** Un fichier tel qu'exposé par un partage. */
export interface SharedFile {
  id: string;
  fileName: string;
  sizeBytes: number;
}

const FILE_SELECT = {
  id: true,
  storageName: true,
  originalNameEnc: true,
  sizeBytes: true,
  dekWrapped: true,
  contentIv: true,
  contentAuthTag: true,
} as const;

/**
 * Création, révocation et contrôle des liens de partage.
 *
 * ## Un lien, une session de dépôt
 *
 * Un partage couvre un ou plusieurs fichiers derrière un seul jeton : le
 * destinataire n'a qu'une seule adresse à ouvrir pour récupérer tout ce qui
 * lui a été envoyé, plutôt qu'un lien par fichier.
 *
 * ## Le lien se suffit à lui-même
 *
 * Le destinataire **n'a pas besoin de compte**. Déposer exige un compte,
 * recevoir non : demander à un correspondant de s'inscrire pour récupérer un
 * fichier reviendrait à lui imposer une démarche pour rendre service à
 * quelqu'un d'autre.
 *
 * La conséquence est nette : **le jeton est le secret**. D'où ses 32 octets
 * aléatoires, qui le rendent indevinable, et les trois moyens laissés au
 * déposant pour en limiter la portée — une durée de vie, un mot de passe
 * facultatif, et la révocation à tout moment.
 *
 * ## Le jeton n'existe qu'une fois
 *
 * À la création, il est renvoyé puis oublié : seule son empreinte est
 * conservée. Une fuite de la base ne livre donc aucun lien utilisable.
 */
@Injectable()
export class SharesService {
  private readonly logger = new Logger(SharesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly files: FilesService,
    private readonly passwords: PasswordService,
  ) {}

  /**
   * Crée un lien de partage sur un ou plusieurs fichiers que l'on possède.
   *
   * @returns Le partage **et** le jeton en clair, seule occasion de le lire.
   */
  async create(
    ownerId: string,
    input: CreateShareDto,
  ): Promise<{ id: string; token: string; expiresAt: Date; createdAt: Date }> {
    // Lève 404 si l'un des fichiers n'existe pas ou appartient à quelqu'un
    // d'autre : on ne partage que ce qu'on possède, et entièrement.
    await Promise.all(
      input.fileIds.map((fileId) => this.files.requireOwned(ownerId, fileId)),
    );

    const token = this.crypto.generateToken();
    const expiresAt = new Date(
      Date.now() + input.expiresInHours * 60 * 60 * 1000,
    );

    const share = await this.prisma.share.create({
      data: {
        ownerId,
        tokenHash: this.crypto.hashToken(token),
        // Facultatif, et purement informatif : c'est le jeton qui donne accès.
        recipientEmailEnc: input.recipientEmail
          ? this.crypto.seal(input.recipientEmail)
          : null,
        recipientEmailHmac: input.recipientEmail
          ? this.crypto.blindIndex(input.recipientEmail)
          : null,
        // argon2id, comme un mot de passe de compte : c'est un secret choisi
        // par un humain, donc devinable, et il doit coûter cher à éprouver.
        passwordHash: input.password
          ? await this.passwords.hash(input.password)
          : null,
        burnAfterDownload: input.burnAfterDownload,
        expiresAt,
        files: {
          create: input.fileIds.map((fileId) => ({ fileId })),
        },
      },
      select: { id: true, expiresAt: true, createdAt: true },
    });

    this.logger.log(
      `Partage créé : ${share.id} (${input.fileIds.length} fichier(s), expire le ${expiresAt.toISOString()})`,
    );

    return { ...share, token };
  }

  /** Liste les partages portant sur les fichiers d'un utilisateur. */
  async listOwnedBy(ownerId: string): Promise<
    {
      id: string;
      files: SharedFile[];
      recipientEmail?: string;
      protectedByPassword: boolean;
      singleUse: boolean;
      status: ShareStatus;
      expiresAt: Date;
      createdAt: Date;
    }[]
  > {
    const shares = await this.prisma.share.findMany({
      // Filtre sur le propriétaire du lien, et non sur celui de ses fichiers :
      // un lien à usage unique consommé n'a plus de fichier, et disparaîtrait
      // de cette liste au moment où son créateur veut vérifier le transfert.
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        recipientEmailEnc: true,
        passwordHash: true,
        burnAfterDownload: true,
        consumedAt: true,
        revoked: true,
        expiresAt: true,
        createdAt: true,
        files: {
          select: {
            file: { select: { id: true, originalNameEnc: true, sizeBytes: true } },
          },
        },
      },
    });

    return shares.map((share) => ({
      id: share.id,
      files: share.files.map(({ file }) => this.toSharedFile(file)),
      ...(share.recipientEmailEnc
        ? { recipientEmail: this.crypto.openToString(share.recipientEmailEnc) }
        : {}),
      // L'empreinte elle-même ne sort jamais : on n'en expose que l'existence,
      // pour que le déposant sache quels liens il a protégés.
      protectedByPassword: share.passwordHash !== null,
      singleUse: share.burnAfterDownload,
      status: this.statusOf(share),
      expiresAt: share.expiresAt,
      createdAt: share.createdAt,
    }));
  }

  /**
   * Révoque un lien.
   *
   * Idempotent : révoquer deux fois n'est pas une erreur. Un utilisateur qui
   * clique deux fois sur « révoquer » veut avant tout que le lien soit mort.
   *
   * @throws {NotFoundException} Si le partage n'existe pas ou porte sur des
   * fichiers de quelqu'un d'autre.
   */
  async revoke(ownerId: string, shareId: string): Promise<void> {
    const share = await this.prisma.share.findFirst({
      where: { id: shareId, ownerId },
      select: { id: true, revoked: true },
    });

    if (!share) {
      throw new NotFoundException({
        error: 'SHARE_NOT_FOUND',
        message: 'Partage introuvable.',
      });
    }

    if (share.revoked) {
      return;
    }

    await this.prisma.share.update({
      where: { id: share.id },
      data: { revoked: true, revokedAt: new Date() },
    });

    this.logger.log(`Partage révoqué : ${shareId}`);
  }

  /**
   * Décrit un lien sans le consommer, pour que le front sache quoi afficher.
   *
   * Volontairement avare quand le lien est protégé et qu'aucun mot de passe
   * n'est fourni : la liste des fichiers n'est révélée qu'une fois le mot de
   * passe franchi. Quelqu'un qui intercepterait le lien apprendrait sinon ce
   * qu'il contient sans jamais avoir à le déverrouiller.
   *
   * Recevoir un mot de passe ici permet au front de le vérifier **une seule
   * fois** pour tout le partage, plutôt que de le redemander à chaque fichier
   * téléchargé individuellement.
   *
   * @throws {ForbiddenException} `SHARE_PASSWORD_INVALID` si un mot de passe
   * est fourni mais incorrect — pour que le front le signale immédiatement,
   * avant toute tentative de téléchargement.
   */
  async describe(
    token: string,
    password?: string,
  ): Promise<{
    requiresPassword: boolean;
    singleUse: boolean;
    expiresAt: Date;
    files?: SharedFile[];
  }> {
    const share = await this.findUsable(token);
    const requiresPassword = share.passwordHash !== null;

    if (requiresPassword && password) {
      await this.verifyPassword(share.passwordHash!, password);
    }

    const unlocked = !requiresPassword || Boolean(password);

    return {
      requiresPassword,
      // Le front doit pouvoir prévenir : « ce lien ne servira qu'une fois ».
      singleUse: share.burnAfterDownload,
      expiresAt: share.expiresAt,
      ...(unlocked
        ? { files: share.files.map((file) => this.toSharedFile(file)) }
        : {}),
    };
  }

  /**
   * Vérifie qu'un jeton donne bien droit au téléchargement d'un fichier
   * précis parmi ceux du partage.
   *
   * Quatre contrôles, dans cet ordre :
   *
   * 1. le jeton correspond à un partage — sinon **404** ;
   * 2. le partage n'est pas révoqué — sinon **403** ;
   * 3. il n'a pas expiré — sinon **410** ;
   * 4. le mot de passe, s'il y en a un, est le bon — sinon **401** ou **403**.
   *
   * Le fichier demandé doit en outre faire partie du partage — sinon **404** :
   * un jeton valide ne donne accès qu'aux fichiers qu'il couvre.
   *
   * La révocation est vérifiée avant l'expiration : c'est le geste délibéré du
   * propriétaire, et il doit primer sur une date atteinte entre-temps.
   *
   * Aucune session n'est requise : le destinataire n'a pas de compte.
   */
  async authorizeDownload(
    token: string,
    fileId: string,
    password?: string,
  ): Promise<GrantedDownload> {
    const share = await this.findUsable(token);

    if (share.passwordHash) {
      if (!password) {
        throw new UnauthorizedException({
          error: 'SHARE_PASSWORD_REQUIRED',
          message: 'Ce lien est protégé par un mot de passe.',
        });
      }

      await this.verifyPassword(share.passwordHash, password);
    }

    const file = share.files.find((candidate) => candidate.id === fileId);

    if (!file) {
      throw new NotFoundException({
        error: 'FILE_NOT_IN_SHARE',
        message: 'Ce fichier ne fait pas partie de ce partage.',
      });
    }

    return {
      shareId: share.id,
      storageName: file.storageName,
      originalName: this.crypto.openToString(file.originalNameEnc),
      sizeBytes: file.sizeBytes,
      dekWrapped: file.dekWrapped,
      contentIv: file.contentIv,
      contentAuthTag: file.contentAuthTag,
      burnAfterDownload: share.burnAfterDownload,
    };
  }

  /**
   * Vérifie le mot de passe d'un lien protégé, ou échoue avec le même refus
   * partout où ce contrôle est fait — à la consultation comme au téléchargement.
   *
   * @throws {ForbiddenException} `SHARE_PASSWORD_INVALID` si le mot de passe est incorrect.
   */
  private async verifyPassword(
    passwordHash: string,
    password: string,
  ): Promise<void> {
    const valid = await this.passwords.verify(passwordHash, password);

    if (!valid) {
      this.logger.warn('Mot de passe incorrect sur un lien de partage protégé');

      throw new ForbiddenException({
        error: 'SHARE_PASSWORD_INVALID',
        message: 'Mot de passe incorrect.',
      });
    }
  }

  /** Déchiffre le nom d'un fichier pour l'exposer au propriétaire ou au destinataire. */
  private toSharedFile(file: {
    id: string;
    originalNameEnc: string;
    sizeBytes: number;
  }): SharedFile {
    return {
      id: file.id,
      fileName: this.crypto.openToString(file.originalNameEnc),
      sizeBytes: file.sizeBytes,
    };
  }

  /**
   * Réserve un fichier d'un lien à usage unique avant de l'envoyer.
   *
   * La mise à jour est **conditionnée à la nullité de `downloadedAt`** : si deux
   * téléchargements du même fichier partent en même temps, la base n'en laisse
   * passer qu'un et le second se voit refusé. Sans ce verrou, les deux
   * serviraient le fichier avant que l'un ait eu le temps de le marquer.
   *
   * La réservation porte sur **le fichier** et non sur le lien : celui-ci en
   * couvre plusieurs, et le destinataire les récupère l'un après l'autre.
   *
   * @throws {GoneException} Si ce fichier a déjà été téléchargé via ce lien.
   */
  async claimFile(shareId: string, fileId: string): Promise<void> {
    const claimed = await this.prisma.shareFile.updateMany({
      where: { shareId, fileId, downloadedAt: null },
      data: { downloadedAt: new Date() },
    });

    if (claimed.count === 0) {
      throw new GoneException({
        error: 'FILE_ALREADY_DOWNLOADED',
        message: 'Ce fichier a déjà été téléchargé via ce lien à usage unique.',
      });
    }
  }

  /**
   * Rend un fichier dont le transfert a échoué.
   *
   * Une coupure réseau ou un onglet fermé ne doit pas consommer le fichier : le
   * destinataire n'aurait rien reçu et n'aurait plus aucun moyen de réessayer.
   */
  async releaseFile(shareId: string, fileId: string): Promise<void> {
    await this.prisma.shareFile.updateMany({
      where: { shareId, fileId },
      data: { downloadedAt: null },
    });

    this.logger.warn(
      `Fichier ${fileId} du lien ${shareId} libéré : le téléchargement a échoué`,
    );
  }

  /**
   * Consomme le lien si **tous** ses fichiers ont été téléchargés.
   *
   * ## Pourquoi « tous » et non « le premier »
   *
   * Un lien couvre une session de dépôt entière. Le consumer au premier fichier
   * téléchargé laisserait un destinataire ayant trois fichiers à récupérer n'en
   * obtenir qu'un — l'option deviendrait un piège plutôt qu'une protection.
   *
   * ## Ce qui se passe ensuite
   *
   * Chaque fichier n'est effacé que s'il ne lui reste **aucun autre lien
   * exploitable** : supprimer sans vérifier casserait silencieusement les
   * partages que le déposant aurait créés en parallèle.
   *
   * @returns Le nombre de fichiers réellement effacés du serveur.
   */
  async completeIfFullyDownloaded(shareId: string): Promise<number> {
    const restants = await this.prisma.shareFile.count({
      where: { shareId, downloadedAt: null },
    });

    if (restants > 0) {
      this.logger.log(
        `Lien ${shareId} : ${restants} fichier(s) restant(s) avant consommation`,
      );
      return 0;
    }

    const couverts = await this.prisma.shareFile.findMany({
      where: { shareId },
      select: { fileId: true },
    });

    // Le lien est marqué consommé **avant** l'effacement : même si la
    // suppression échoue, il ne doit plus servir.
    await this.prisma.share.updateMany({
      where: { id: shareId, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    this.logger.log(`Lien à usage unique consommé : ${shareId}`);

    let efface = 0;
    for (const { fileId } of couverts) {
      if (await this.files.removeIfNoUsableShare(fileId)) {
        efface += 1;
      }
    }

    return efface;
  }

  /**
   * Retrouve un partage encore exploitable, ou échoue.
   *
   * Regroupe les trois contrôles communs à la consultation et au
   * téléchargement, pour qu'ils ne puissent pas diverger : un lien révoqué doit
   * être refusé partout de la même façon.
   */
  private async findUsable(token: string): Promise<{
    id: string;
    passwordHash: string | null;
    expiresAt: Date;
    burnAfterDownload: boolean;
    files: {
      id: string;
      storageName: string;
      originalNameEnc: string;
      sizeBytes: number;
      dekWrapped: string;
      contentIv: string;
      contentAuthTag: string;
    }[];
  }> {
    const share = await this.prisma.share.findUnique({
      where: { tokenHash: this.crypto.hashToken(token) },
      select: {
        id: true,
        revoked: true,
        expiresAt: true,
        passwordHash: true,
        burnAfterDownload: true,
        consumedAt: true,
        files: { select: { file: { select: FILE_SELECT } } },
      },
    });

    if (!share) {
      throw new NotFoundException({
        error: 'SHARE_NOT_FOUND',
        message: 'Ce lien de partage n\'existe pas.',
      });
    }

    if (share.revoked) {
      throw new ForbiddenException({
        error: 'SHARE_REVOKED',
        message: 'Ce lien de partage a été révoqué.',
      });
    }

    if (share.expiresAt.getTime() <= Date.now()) {
      // 410 plutôt que 404 : le lien a existé, il a simplement expiré. La
      // nuance permet au front de proposer d'en demander un nouveau.
      throw new GoneException({
        error: 'SHARE_EXPIRED',
        message: 'Ce lien de partage a expiré.',
      });
    }

    if (share.consumedAt) {
      throw new GoneException({
        error: 'SHARE_ALREADY_USED',
        message: 'Ce lien à usage unique a déjà servi.',
      });
    }

    return {
      id: share.id,
      passwordHash: share.passwordHash,
      expiresAt: share.expiresAt,
      burnAfterDownload: share.burnAfterDownload,
      files: share.files.map(({ file }) => file),
    };
  }

  /**
   * Détermine l'état affiché d'un partage.
   *
   * L'ordre traduit une hiérarchie : ce que le propriétaire a décidé prime sur
   * ce qui est arrivé, et ce qui est arrivé prime sur le simple écoulement du
   * temps.
   */
  private statusOf(share: {
    revoked: boolean;
    consumedAt: Date | null;
    expiresAt: Date;
  }): ShareStatus {
    if (share.revoked) {
      return 'REVOKED';
    }

    if (share.consumedAt) {
      return 'CONSUMED';
    }

    return share.expiresAt.getTime() <= Date.now() ? 'EXPIRED' : 'ACTIVE';
  }
}
