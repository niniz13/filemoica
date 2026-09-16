import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Accès à la base, disponible partout.
 *
 * Marqué global : presque tous les modules métier en dépendent, et le
 * réimporter dans chacun n'apporterait rien d'autre que du bruit.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
