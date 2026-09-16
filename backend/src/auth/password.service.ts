import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/**
 * Valeur de `Algorithm.Argon2id` dans `@node-rs/argon2`.
 *
 * Écrite en clair parce que la bibliothèque l'expose via un `const enum`
 * ambiant, que la compilation en modules isolés interdit d'importer. C'est
 * aussi l'algorithme par défaut de la bibliothèque : on le précise quand même,
 * pour que le choix soit lisible plutôt que subi.
 */
const ARGON2ID = 2;

/**
 * Paramètres argon2id, alignés sur les recommandations OWASP.
 *
 * Ils définissent le coût de calcul d'une empreinte. Le but est qu'une
 * vérification reste imperceptible à la connexion (quelques dizaines de
 * millisecondes) tout en rendant une attaque par dictionnaire ruineuse : là où
 * un attaquant testerait des millions de mots de passe par seconde contre du
 * SHA-256, il en teste quelques dizaines ici.
 *
 * `memoryCost` est le paramètre décisif : il force chaque tentative à occuper
 * 19 Mio de mémoire, ce qui neutralise l'avantage des cartes graphiques.
 */
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Empreinte factice, utilisée pour égaliser le temps de réponse à la connexion.
 *
 * Calculée une fois au démarrage sur un mot de passe qui n'est celui de
 * personne. Voir {@link PasswordService.verifyDummy}.
 */
const DUMMY_PASSWORD = 'mot-de-passe-qui-n-existe-pas';

/**
 * Hachage et vérification des mots de passe.
 *
 * Séparé du `CryptoService` à dessein : un mot de passe demande une fonction
 * volontairement **lente**, là où le chiffrement de données doit être rapide.
 * Confondre les deux usages — hacher un mot de passe en SHA-256, par exemple —
 * est une erreur classique et coûteuse.
 *
 * argon2id est l'algorithme recommandé aujourd'hui : il résiste à la fois aux
 * attaques par matériel spécialisé (grâce au coût mémoire) et aux attaques par
 * canal auxiliaire.
 */
@Injectable()
export class PasswordService {
  /** Empreinte factice, calculée paresseusement puis réutilisée. */
  private dummyHash?: string;

  /**
   * Calcule l'empreinte d'un mot de passe.
   *
   * Le sel est tiré au hasard par argon2 et intégré à l'empreinte : deux
   * utilisateurs ayant le même mot de passe ont des empreintes différentes, ce
   * qui interdit de les repérer en comparant la base.
   */
  async hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  /**
   * Vérifie un mot de passe contre son empreinte.
   *
   * Renvoie `false` plutôt que de propager une erreur si l'empreinte stockée
   * est illisible : une donnée corrompue en base ne doit pas devenir un moyen
   * de faire tomber la route de connexion.
   */
  async verify(hashed: string, password: string): Promise<boolean> {
    try {
      return await verify(hashed, password, ARGON2_OPTIONS);
    } catch {
      return false;
    }
  }

  /**
   * Consomme le même temps qu'une vérification réelle, sans en faire une.
   *
   * Appelée quand l'email fourni ne correspond à aucun compte. Sans elle, la
   * connexion répondrait instantanément pour un email inconnu et après ~50 ms
   * pour un email existant : en chronométrant, on pourrait énumérer les
   * comptes du service sans jamais connaître un seul mot de passe.
   */
  async verifyDummy(): Promise<false> {
    this.dummyHash ??= await this.hash(DUMMY_PASSWORD);
    await this.verify(this.dummyHash, 'tentative');
    return false;
  }
}
