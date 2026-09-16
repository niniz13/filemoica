/**
 * Formats de fichiers acceptés par le service.
 *
 * ## Ce que cette liste fait, et ce qu'elle ne fait pas
 *
 * Elle **définit le périmètre du service** : filemoica transporte des documents,
 * des médias et des archives, pas n'importe quoi.
 *
 * Elle ne filtre en revanche aucune menace sérieuse, et il ne faut pas le
 * prétendre : un document bureautique porteur de macros, un PDF piégé ou une
 * archive malveillante figurent tous dans cette liste. Seule une analyse
 * antivirale les détecterait, et elle est impossible ici puisque le contenu est
 * chiffré dès sa réception.
 *
 * La vraie protection est ailleurs : le serveur n'exécute ni n'affiche jamais un
 * fichier déposé, et le téléchargement force l'enregistrement plutôt que
 * l'ouverture dans le navigateur.
 *
 * ## Élargir la liste
 *
 * Ajouter un format se limite à une ligne ici. Les types sont ceux que renvoie
 * la détection par signature, pas ceux déclarés par le client.
 */

/** Documents bureautiques et texte structuré. */
const DOCUMENTS = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/rtf',
  'application/epub+zip',
];

/** Images, y compris deux formats bruts d'appareil photo courants. */
const IMAGES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/tiff',
  'image/bmp',
  'image/heic',
  'image/avif',
  // Formats bruts : Canon et Nikon, les deux les plus répandus.
  'image/x-canon-cr2',
  'image/x-nikon-nef',
  'image/x-adobe-dng',
];

const VIDEOS = [
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/webm',
  'video/mpeg',
];

const AUDIO = [
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/aac',
  'audio/mp4',
  'audio/flac',
  'audio/x-flac',
  'audio/ogg',
];

const ARCHIVES = [
  'application/zip',
  'application/vnd.rar',
  'application/x-rar-compressed',
  'application/x-7z-compressed',
  'application/gzip',
  'application/x-tar',
];

/** Types reconnaissables à leur signature binaire. */
export const ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set([
  ...DOCUMENTS,
  ...IMAGES,
  ...VIDEOS,
  ...AUDIO,
  ...ARCHIVES,
]);

/**
 * Types acceptés **sans** signature détectable.
 *
 * Un fichier texte n'a pas d'octets de signature : rien ne distingue un `.txt`
 * d'un `.csv` ou d'un fragment quelconque. Une liste blanche strictement fondée
 * sur la signature rejetterait donc tous les fichiers texte — à commencer par
 * ceux qu'on utilise pour les démonstrations.
 *
 * Ces types-là sont donc autorisés sur la foi du type déclaré par le client,
 * doublée d'une vérification sommaire du contenu (voir `looksLikeText`).
 */
export const ALLOWED_SIGNATURELESS_TYPES: ReadonlySet<string> = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'text/xml',
  'application/xml',
]);

/**
 * Vérifie sommairement qu'un échantillon ressemble à du texte.
 *
 * L'absence d'octet nul est un indice grossier mais efficace : la plupart des
 * formats binaires en contiennent, alors que le texte n'en contient jamais.
 *
 * Ce n'est pas une garantie — un binaire sans octet nul et sans signature
 * connue passerait. C'est acceptable : le fichier ne sera ni exécuté ni affiché
 * par le serveur, et cette vérification ne sert qu'à empêcher de contourner la
 * liste en déclarant `text/plain`.
 */
export function looksLikeText(sample: Buffer): boolean {
  return !sample.includes(0);
}
