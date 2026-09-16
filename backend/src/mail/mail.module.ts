import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

/**
 * Envoi de courriels.
 *
 * Global : la vérification d'adresse et la double authentification en ont
 * besoin toutes les deux, et d'autres usages suivront (alerte de révocation,
 * notification d'expiration). En faire un module à importer partout n'ajouterait
 * que du bruit.
 */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
