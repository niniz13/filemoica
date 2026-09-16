import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { EnvironmentVariables } from '../config/env.validation';
import { FileStorage } from './file-storage';

/** Longueur du nom de rangement, en octets tirés au hasard. */
const NAME_BYTES = 16;

/**
 * Stockage sur système de fichiers.
 *
 * Couvre les trois formes retenues ou envisagées côté infrastructure : volume
 * Docker nommé, répertoire de l'hôte monté, ou partage réseau. Elles ne
 * diffèrent que par ce que `STORAGE_PATH` désigne — le code est le même.
 */
@Injectable()
export class FilesystemStorage extends FileStorage implements OnModuleInit {
  private readonly logger = new Logger(FilesystemStorage.name);
  private readonly root: string;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    super();
    this.root = resolve(config.get('STORAGE_PATH', { infer: true }));
  }

  /**
   * Vérifie au démarrage que le répertoire existe et accepte l'écriture.
   *
   * Échouer ici plutôt qu'au premier dépôt : un volume mal monté est un incident
   * d'infrastructure fréquent, et il vaut mieux qu'il empêche le démarrage —
   * visible tout de suite — plutôt qu'il ne se manifeste devant un utilisateur.
   */
  async onModuleInit(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await access(this.root, constants.W_OK);

    this.logger.log(`Stockage des fichiers prêt : ${this.root}`);
  }

  newName(): string {
    return randomBytes(NAME_BYTES).toString('hex');
  }

  async openWrite(storageName: string): Promise<Writable> {
    return createWriteStream(this.pathFor(storageName), {
      // Lisible et modifiable par le seul utilisateur du service. Les
      // permissions du répertoire sont, elles, du ressort de l'infrastructure.
      mode: 0o600,
      // Refuse d'écraser un fichier existant : une collision de noms doit
      // provoquer une erreur, jamais la perte silencieuse d'un dépôt antérieur.
      flags: 'wx',
    });
  }

  async openRead(storageName: string): Promise<Readable> {
    return createReadStream(this.pathFor(storageName));
  }

  async remove(storageName: string): Promise<void> {
    await rm(this.pathFor(storageName), { force: true });
  }

  async exists(storageName: string): Promise<boolean> {
    try {
      await access(this.pathFor(storageName), constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Compose le chemin d'un fichier, en refusant tout ce qui sortirait du
   * répertoire de stockage.
   *
   * Les noms sont générés par `newName()` et ne peuvent donc pas contenir de
   * `..`. Cette vérification est une ceinture de sécurité : le jour où un nom
   * viendrait d'ailleurs — d'une restauration, d'un import, d'une évolution du
   * code — elle empêche d'écrire ou de lire n'importe où sur la machine.
   */
  private pathFor(storageName: string): string {
    const candidate = resolve(join(this.root, storageName));

    if (!candidate.startsWith(this.root) || isAbsolute(storageName)) {
      throw new Error('Nom de fichier de stockage invalide');
    }

    return candidate;
  }
}
