import type { Readable, Writable } from 'node:stream';

/**
 * Accès au support de stockage des fichiers.
 *
 * Classe abstraite plutôt qu'interface : Nest a besoin d'un jeton d'injection
 * qui existe à l'exécution, ce qu'une interface TypeScript ne fournit pas.
 *
 * ## Pourquoi cette abstraction
 *
 * Le stockage est arbitré à un volume Docker sur une machine unique
 * (voir `docs/decision-stockage-fichiers.md`). Ce choix répond au cadre du
 * projet, mais il pourrait changer : plusieurs instances imposeraient un
 * stockage partagé.
 *
 * Passer par cette abstraction ramène un tel changement à l'écriture d'une
 * seconde implémentation, sans toucher au chiffrement, aux contrôles d'accès ni
 * aux contrôleurs. Elle ne coûte rien aujourd'hui et évite d'être coincé demain.
 *
 * ## Ce qu'elle ne fait pas
 *
 * Elle ne chiffre rien. Tout ce qui lui est confié est **déjà chiffré** par
 * l'appelant : le support ne voit jamais de contenu en clair, et il n'a pas
 * besoin de connaître les clés.
 */
export abstract class FileStorage {
  /**
   * Tire un nom de rangement imprévisible.
   *
   * Aléatoire et sans rapport avec le nom d'origine : lister le support ne
   * révèle ni ce que contiennent les fichiers, ni à qui ils appartiennent.
   */
  abstract newName(): string;

  /** Ouvre un flux d'écriture vers un emplacement neuf. */
  abstract openWrite(storageName: string): Promise<Writable>;

  /** Ouvre un flux de lecture sur un fichier existant. */
  abstract openRead(storageName: string): Promise<Readable>;

  /**
   * Supprime définitivement un fichier.
   *
   * Ne lève pas si le fichier est déjà absent : la suppression doit rester
   * rejouable, notamment lors du nettoyage après un dépôt interrompu.
   */
  abstract remove(storageName: string): Promise<void>;

  /** Indique si un fichier est présent sur le support. */
  abstract exists(storageName: string): Promise<boolean>;
}
