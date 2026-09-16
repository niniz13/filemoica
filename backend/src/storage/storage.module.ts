import { Global, Module } from '@nestjs/common';
import { FileStorage } from './file-storage';
import { FilesystemStorage } from './filesystem.storage';

/**
 * Accès au support de stockage.
 *
 * Le reste de l'application dépend de `FileStorage`, jamais de
 * `FilesystemStorage` : changer de support reviendrait à modifier cette seule
 * ligne.
 */
@Global()
@Module({
  providers: [{ provide: FileStorage, useClass: FilesystemStorage }],
  exports: [FileStorage],
})
export class StorageModule {}
