import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  // Pour `QuotaService` : la consommation d'un compte se lit avec le même code
  // que celui qui l'applique, plutôt qu'en réimplémentant le calcul ici.
  imports: [FilesModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
