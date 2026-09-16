import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { Plan, Role } from '../../generated/prisma/enums';

/** Changement d'offre d'un compte. */
export class ChangePlanDto {
  @ApiProperty({ enum: Plan, example: Plan.PREMIUM })
  @IsEnum(Plan, { message: 'Offre inconnue.' })
  plan: Plan;
}

/** Changement de rôle d'un compte. */
export class ChangeRoleDto {
  @ApiProperty({ enum: Role, example: Role.ADMIN })
  @IsEnum(Role, { message: 'Rôle inconnu.' })
  role: Role;
}

/**
 * Un compte tel que l'administration l'expose.
 *
 * Ne contient **ni nom de fichier, ni contenu** : l'administration porte sur les
 * comptes, pas sur ce qu'ils déposent.
 */
export class ManagedUserResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'email' })
  email: string;

  @ApiProperty({ enum: Role })
  role: Role;

  @ApiProperty({ enum: Plan })
  plan: Plan;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({
    description: 'Nombre de fichiers déposés — jamais lesquels.',
    example: 12,
  })
  fileCount: number;

  @ApiProperty({ description: 'Volume déposé ce mois-ci, en octets.' })
  usedBytesThisMonth: number;

  @ApiProperty({ description: 'Volume mensuel autorisé par l\'offre.' })
  quotaBytes: number;
}

/** Vue d'ensemble du service. */
export class ServiceStatsResponse {
  @ApiProperty({
    example: { total: 42, free: 38, premium: 4 },
    description: 'Répartition des comptes par offre.',
  })
  users: { total: number; free: number; premium: number };

  @ApiProperty({
    example: { total: 137, totalBytes: 2_147_483_648 },
    description:
      'Volume stocké — c\'est lui qui détermine la facture d\'hébergement.',
  })
  files: { total: number; totalBytes: number };

  @ApiProperty({
    example: { total: 58, active: 12 },
    description: 'Partages créés, et ceux encore exploitables.',
  })
  shares: { total: number; active: number };
}

/** Résultat d'une révocation de sessions. */
export class RevokedSessionsResponse {
  @ApiProperty({ description: 'Nombre de sessions coupées.', example: 3 })
  revoked: number;
}
