/**
 * Chemins dont un segment est un secret.
 *
 * Le jeton d'un lien de partage est **le** secret qui donne accès au fichier :
 * depuis que le destinataire n'a plus besoin de compte, il suffit à lui seul.
 * Le journaliser reviendrait à recopier tous les liens du service dans un
 * fichier de logs — souvent centralisé, souvent conservé longtemps, et lisible
 * par toute personne ayant accès à la supervision.
 */
const REDACTED_PATHS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /^\/api\/download\/[^/]+/,
    replacement: '/api/download/:token',
  },
];

/**
 * Remplace les segments secrets d'une URL par un libellé, et retire la chaîne
 * de requête.
 *
 * **À utiliser partout où une URL est journalisée.** Cette fonction est
 * partagée plutôt que dupliquée pour une raison concrète : une première version
 * masquait le jeton dans le journal de requêtes, mais le filtre d'exceptions
 * écrivait l'URL brute de son côté. Le secret fuyait donc quand même, par
 * l'endroit auquel on ne pensait pas.
 *
 * @example
 * ```ts
 * redactPath('/api/download/k3Jv8Qw2?x=1'); // '/api/download/:token'
 * ```
 */
export function redactPath(url: string): string {
  // La chaîne de requête est retirée entièrement : elle peut contenir n'importe
  // quoi, et rien d'utile n'y transite aujourd'hui.
  const path = url.split('?')[0];

  for (const { pattern, replacement } of REDACTED_PATHS) {
    if (pattern.test(path)) {
      return path.replace(pattern, replacement);
    }
  }

  return path;
}
