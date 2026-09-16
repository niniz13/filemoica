import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { DownloadController } from './download.controller';
import { SharesController } from './shares.controller';
import { SharesService } from './shares.service';

@Module({
  imports: [
    // Pour `FilesService.requireOwned` : on ne partage que ses propres
    // fichiers, et cette vérification n'a pas à être réécrite ici.
    FilesModule,
    // Pour `PasswordService` : les mots de passe des liens sont hachés comme
    // ceux des comptes, avec le même code.
    AuthModule,
  ],
  controllers: [SharesController, DownloadController],
  providers: [SharesService],
})
export class SharesModule {}
