import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import type { EnvironmentVariables } from '../config/env.validation';
import { CryptoService } from '../crypto/crypto.service';
import { FileStorage } from '../storage/file-storage';
import { EncryptedUploadStorage } from './encrypted-upload.storage';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { QuotaGuard } from './quota.guard';
import { QuotaService } from './quota.service';
import { RetentionService } from './retention.service';

@Module({
  imports: [
    MulterModule.registerAsync({
      inject: [ConfigService, CryptoService, FileStorage],
      useFactory: (
        config: ConfigService<EnvironmentVariables, true>,
        crypto: CryptoService,
        storage: FileStorage,
      ) => ({
        // Le chiffrement est branch� sur la r�ception elle-m�me : aucun
        // contenu en clair n'atteint le disque ni la m�moire.
        storage: new EncryptedUploadStorage(crypto, storage),
        limits: {
          fileSize:
            config.get('MAX_FILE_SIZE_MB', { infer: true }) * 1024 * 1024,
          // Un seul fichier par requ�te, et aucun autre champ : r�duire ce
          // qu'on accepte r�duit d'autant ce qu'il faut valider.
          files: 1,
          fields: 0,
        },
        // Les noms de fichiers accentu�s arrivent autrement mutil�s : le format
        // d'envoi ne transporte pas d'indication d'encodage.
        defParamCharset: 'utf8',
      }),
    }),
  ],
  controllers: [FilesController],
  providers: [FilesService, QuotaService, QuotaGuard, RetentionService],
  exports: [FilesService, QuotaService, RetentionService],
})
export class FilesModule {}
