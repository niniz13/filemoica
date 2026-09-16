import { Global, Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';

/**
 * Opérations cryptographiques, disponibles partout.
 *
 * Global pour une raison de sécurité autant que de confort : il ne doit exister
 * qu'un seul endroit où les clés maîtres sont lues et manipulées. Tout module
 * qui aurait sa propre implémentation du chiffrement serait une occasion de se
 * tromper.
 */
@Global()
@Module({
  providers: [CryptoService],
  exports: [CryptoService],
})
export class CryptoModule {}
