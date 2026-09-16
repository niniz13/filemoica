import { UnsupportedMediaTypeException } from '@nestjs/common';
import { Transform, type TransformCallback } from 'node:stream';
import {
  ALLOWED_MIME_TYPES,
  ALLOWED_SIGNATURELESS_TYPES,
  looksLikeText,
} from './allowed-types';

/**
 * Quantité d'octets examinée pour identifier un format.
 *
 * Certains formats placent leur signature au-delà des premiers octets, d'où
 * cette marge plutôt qu'une poignée d'octets.
 */
const SAMPLE_BYTES = 4_100;

/**
 * Chargement différé de la bibliothèque de détection.
 *
 * `file-type` n'est distribuée qu'en modules ES, alors que ce projet compile en
 * CommonJS : l'import statique serait refusé. L'import dynamique contourne la
 * contrainte, et le résultat est mémorisé pour ne pas recharger la bibliothèque
 * à chaque dépôt.
 */
let detectType: typeof import('file-type').fileTypeFromBuffer | undefined;

async function loadDetector(): Promise<
  typeof import('file-type').fileTypeFromBuffer
> {
  detectType ??= (await import('file-type')).fileTypeFromBuffer;
  return detectType;
}

/**
 * Rejette les fichiers dont le format n'est pas accepté.
 *
 * ## Pourquoi inspecter le contenu
 *
 * L'extension et le type annoncé viennent tous deux du client : renommer
 * `virus.exe` en `rapport.pdf` suffirait à tromper une vérification qui s'y
 * fierait. Seuls les octets de signature disent ce qu'est réellement un fichier.
 *
 * ## Pourquoi un maillon du flux
 *
 * Le contenu est chiffré au fil de sa réception. Une vérification placée après
 * coup arriverait trop tard : le fichier serait déjà écrit, et il faudrait le
 * déchiffrer pour l'examiner. Ce maillon retient les premiers octets le temps
 * d'identifier le format, puis laisse tout passer si le verdict est favorable.
 *
 * Seul l'échantillon est retenu en mémoire — un fichier de 200 Mo n'y occupe
 * jamais plus de quatre kilo-octets.
 */
export class MimeTypeSniffer extends Transform {
  private sample: Buffer[] = [];
  private sampleLength = 0;
  private verified = false;

  /**
   * @param declaredType Type annoncé par le client. Sert uniquement pour les
   * formats dépourvus de signature, jamais pour valider les autres.
   */
  constructor(private readonly declaredType: string) {
    super();
  }

  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    if (this.verified) {
      callback(null, chunk);
      return;
    }

    this.sample.push(chunk);
    this.sampleLength += chunk.length;

    // Pas encore de quoi trancher : on retient, sans rien laisser filer.
    if (this.sampleLength < SAMPLE_BYTES) {
      callback();
      return;
    }

    void this.verify(callback);
  }

  /** Fin d'un fichier plus petit que l'échantillon : on tranche sur ce qu'on a. */
  _flush(callback: TransformCallback): void {
    if (this.verified) {
      callback();
      return;
    }

    void this.verify(callback);
  }

  private async verify(callback: TransformCallback): Promise<void> {
    const head = Buffer.concat(this.sample);
    this.sample = [];
    this.sampleLength = 0;

    try {
      const detected = await (await loadDetector())(head);

      if (detected) {
        if (!ALLOWED_MIME_TYPES.has(detected.mime)) {
          callback(this.refuse(detected.mime));
          return;
        }
      } else if (
        !ALLOWED_SIGNATURELESS_TYPES.has(this.declaredType) ||
        !looksLikeText(head)
      ) {
        // Aucune signature reconnue : soit c'est un format texte annoncé comme
        // tel et qui en a l'allure, soit on refuse. Sans cette porte, un binaire
        // inconnu passerait en se déclarant `text/plain`.
        callback(this.refuse(this.declaredType || 'inconnu'));
        return;
      }

      this.verified = true;
      // L'échantillon retenu repart en tête du flux : rien n'est perdu.
      this.push(head);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  private refuse(type: string): UnsupportedMediaTypeException {
    return new UnsupportedMediaTypeException({
      error: 'FILE_TYPE_NOT_ALLOWED',
      message: `Le format de ce fichier n'est pas accepté (${type}).`,
    });
  }
}
