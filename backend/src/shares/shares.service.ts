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
  storageName: string;
  originalName: string;
  sizeBytes: number;
  dekWrapped: string;
  contentIv: string;
  contentAuthTag: string;
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
      status: ShareStatus;
      expiresAt: Date;
      createdAt: Date;
    }[]
  > {
    const shares = await this.prisma.share.findMany({
      where: { files: { some: { file: { ownerId } } } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        recipientEmailEnc: true,
        passwordHash: true,
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
      where: { id: shareId, files: { some: { file: { ownerId } } } },
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
      storageName: file.storageName,
      originalName: this.crypto.openToString(file.originalNameEnc),
      sizeBytes: file.sizeBytes,
      dekWrapped: file.dekWrapped,
      contentIv: file.contentIv,
      contentAuthTag: file.contentAuthTag,
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
   * Retrouve un partage encore exploitable, ou échoue.
   *
   * Regroupe les trois contrôles communs à la consultation et au
   * téléchargement, pour qu'ils ne puissent pas diverger : un lien révoqué doit
   * être refusé partout de la même façon.
   */
  private async findUsable(token: string): Promise<{
    passwordHash: string | null;
    expiresAt: Date;
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
        revoked: true,
        expiresAt: true,
        passwordHash: true,
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

    return {
      passwordHash: share.passwordHash,
      expiresAt: share.expiresAt,
      files: share.files.map(({ file }) => file),
    };
  }

  /** Détermine l'état affiché d'un partage. */
  private statusOf(share: { revoked: boolean; expiresAt: Date }): ShareStatus {
    if (share.revoked) {
      return 'REVOKED';
    }

    return share.expiresAt.getTime() <= Date.now() ? 'EXPIRED' : 'ACTIVE';
  }
}
