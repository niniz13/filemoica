import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NodeEnv, type EnvironmentVariables } from '../config/env.validation';

/** Point d'entrée de l'API transactionnelle Brevo. */
const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

/** Au-delà, on considère que Brevo ne répondra pas. */
const TIMEOUT_MS = 10_000;

export interface Courriel {
  to: string;
  subject: string;
  /** Version texte — certains clients ne rendent que celle-ci. */
  text: string;
  html: string;
}

/**
 * Envoi de courriels transactionnels par Brevo.
 *
 * ## Pourquoi l'API REST plutôt que SMTP
 *
 * Aucune dépendance à installer — un simple `fetch` — et surtout aucun port
 * SMTP à traverser. Les réseaux d'établissement et beaucoup d'hébergeurs
 * bloquent les ports 25, 465 et 587 ; le 443 passe toujours.
 *
 * ## Le repli en développement
 *
 * Sans `BREVO_API_KEY`, rien n'est envoyé : le message est écrit dans les
 * journaux. Cela permet de développer et de faire une démonstration sans
 * réseau ni compte Brevo.
 *
 * **Ce repli est impossible en production** : {@link validateEnv} refuse de
 * démarrer sans clé. Un code de double authentification imprimé dans les
 * journaux n'est plus un secret — il serait lisible par quiconque a accès à la
 * supervision.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  /** L'envoi réel est-il configuré ? */
  get actif(): boolean {
    return Boolean(this.config.get('BREVO_API_KEY', { infer: true }));
  }

  /**
   * Envoie un courriel.
   *
   * @throws {Error} Si Brevo refuse l'envoi. L'appelant décide quoi en faire :
   * un code d'authentification non parti doit faire échouer la connexion, alors
   * qu'un lien de vérification non parti peut être redemandé.
   */
  async envoyer(courriel: Courriel): Promise<void> {
    const cle = this.config.get('BREVO_API_KEY', { infer: true });

    if (!cle) {
      this.replierSurLesJournaux(courriel);
      return;
    }

    const controleur = new AbortController();
    const minuterie = setTimeout(() => controleur.abort(), TIMEOUT_MS);

    try {
      const reponse = await fetch(BREVO_ENDPOINT, {
        method: 'POST',
        headers: {
          'api-key': cle,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          sender: {
            email: this.config.get('MAIL_FROM_ADDRESS', { infer: true }),
            name: this.config.get('MAIL_FROM_NAME', { infer: true }),
          },
          to: [{ email: courriel.to }],
          subject: courriel.subject,
          textContent: courriel.text,
          htmlContent: courriel.html,
        }),
        signal: controleur.signal,
      });

      if (!reponse.ok) {
        // Le corps de la réponse de Brevo explique le refus — expéditeur non
        // validé, quota dépassé, clé révoquée. Il n'y a rien de secret dedans,
        // et sans lui le diagnostic est impossible.
        const detail = await reponse.text().catch(() => '');
        throw new Error(
          `Brevo a refusé l'envoi (${reponse.status}) : ${detail.slice(0, 300)}`,
        );
      }

      this.logger.log(`Courriel envoyé à ${this.masquer(courriel.to)}`);
    } finally {
      clearTimeout(minuterie);
    }
  }

  /**
   * Écrit le message dans les journaux, faute de pouvoir l'envoyer.
   *
   * Volontairement bruyant : personne ne doit croire qu'un courriel est parti.
   */
  private replierSurLesJournaux(courriel: Courriel): void {
    const env = this.config.get('NODE_ENV', { infer: true });

    this.logger.warn(
      `BREVO_API_KEY absente (${env}) — le courriel n'est PAS envoyé, son contenu suit.`,
    );
    this.logger.warn(`  À        : ${courriel.to}`);
    this.logger.warn(`  Objet    : ${courriel.subject}`);
    this.logger.warn(`  Message  : ${courriel.text.replace(/\n/g, ' | ')}`);
  }

  /**
   * Masque une adresse dans les journaux.
   *
   * Savoir qu'un envoi a réussi est utile à l'exploitation ; recopier l'adresse
   * de chaque destinataire dans un fichier de logs centralisé ne l'est pas.
   */
  private masquer(adresse: string): string {
    const [avant, apres] = adresse.split('@');
    if (!apres) return '***';
    const debut = avant.slice(0, 2);
    return `${debut}${'*'.repeat(Math.max(1, avant.length - 2))}@${apres}`;
  }
}

/** Réexporté pour les tests, qui vérifient le comportement selon l'environnement. */
export { NodeEnv };
