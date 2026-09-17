import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { PasswordService } from './auth/password.service';
import { NodeEnv } from './config/env.validation';
import { PrismaService } from './prisma/prisma.service';

/**
 * Mot de passe commun à tous les comptes de démonstration.
 *
 * Volontairement en clair dans le code : ces comptes n'existent que sur un
 * environnement de démonstration, ne contiennent que des données fictives, et
 * le jury doit pouvoir s'y connecter. Aucun compte réel ne l'utilise.
 */
const DEMO_PASSWORD = 'demonstration-filemoica-2026';

/** Comptes créés par le jeu de données. */
const ACCOUNTS = [
  {
    email: 'admin@filemoica.fr',
    role: 'ADMIN' as const,
    plan: 'PREMIUM' as const,
    description: 'Administrateur — accès au panneau de gestion des comptes',
  },
  {
    email: 'alice@filemoica.fr',
    role: 'USER' as const,
    plan: 'FREE' as const,
    description: 'Compte gratuit — sert à montrer la limite de quota',
  },
  {
    email: 'bob@filemoica.fr',
    role: 'USER' as const,
    plan: 'PREMIUM' as const,
    description: 'Compte payant — sert à montrer la levée de la limite',
  },
];

/**
 * Crée un jeu de comptes de démonstration.
 *
 * ## Pourquoi un script plutôt qu'une saisie manuelle
 *
 * Une démonstration qui commence par créer trois comptes à la main perd cinq
 * minutes et expose à la faute de frappe au pire moment. Ce script rend l'état
 * de départ reproductible : une commande, et le service est prêt à être montré.
 *
 * ## Ce qu'il ne fait pas
 *
 * Il ne dépose aucun fichier. Le dépôt passe par le chiffrement en flux de
 * l'API, et le court-circuiter en écrivant directement en base produirait des
 * données incohérentes — précisément le genre de raccourci qui casse une démo.
 * Les fichiers se déposent par l'interface, ce qui fait d'ailleurs partie de ce
 * qu'on veut montrer.
 *
 * ## Sécurité
 *
 * Le script **refuse de s'exécuter en production**. Il crée des comptes dont le
 * mot de passe est public : les laisser apparaître sur un service réel serait
 * une porte ouverte.
 *
 * @example
 * ```bash
 * npm run seed
 * ```
 */
async function main(): Promise<void> {
  const logger = new Logger('JeuDeDonnées');

  if (process.env.NODE_ENV === NodeEnv.Production) {
    logger.error(
      'Refus : ce script crée des comptes dont le mot de passe est public et ne doit jamais tourner en production.',
    );
    process.exitCode = 1;
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  try {
    const prisma = app.get(PrismaService);
    const passwords = app.get(PasswordService);
    const passwordHash = await passwords.hash(DEMO_PASSWORD);

    for (const account of ACCOUNTS) {
      // `upsert` plutôt que `create` : le script doit pouvoir être relancé sans
      // échouer sur des comptes déjà présents, et remettre les rôles et offres
      // dans leur état attendu si une démonstration les a modifiés.
      await prisma.user.upsert({
        where: { email: account.email },
        create: {
          email: account.email,
          passwordHash,
          role: account.role,
          plan: account.plan,
          // Les comptes de démonstration sont créés déjà confirmés : ils
          // n'ont pas de vraie boîte pour recevoir le lien.
          emailVerifiedAt: new Date(),
          // Sans second facteur : leur adresse n'existe pas, le code n'arriverait
          // jamais. Il s'active depuis l'écran Compte pour la démonstration.
          mfaEnabled: false,
        },
        update: {
          passwordHash,
          role: account.role,
          plan: account.plan,
          // Les comptes de démonstration sont créés déjà confirmés : ils
          // n'ont pas de vraie boîte pour recevoir le lien.
          emailVerifiedAt: new Date(),
          // Sans second facteur : leur adresse n'existe pas, le code n'arriverait
          // jamais. Il s'active depuis l'écran Compte pour la démonstration.
          mfaEnabled: false,
        },
      });

      logger.log(`${account.email} — ${account.description}`);
    }

    logger.log('──────────────────────────────────────────────');
    logger.log(`Mot de passe commun : ${DEMO_PASSWORD}`);
    logger.log('──────────────────────────────────────────────');
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  new Logger('JeuDeDonnées').error(
    'La création du jeu de données a échoué',
    error instanceof Error ? error.stack : String(error),
  );
  process.exitCode = 1;
});
