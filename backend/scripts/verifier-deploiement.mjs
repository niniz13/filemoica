/**
 * Vérification d'un déploiement — parcours complet contre un service qui tourne.
 *
 * Répond à la seule question qui compte après une mise en ligne : *est-ce qu'un
 * utilisateur peut déposer un fichier, et son destinataire le récupérer
 * intact ?* Un conteneur « healthy » ne prouve que sa capacité à répondre à sa
 * propre sonde ; il peut très bien avoir un stockage non inscriptible ou une
 * clé de chiffrement incohérente avec les données déjà en base.
 *
 * L'étape décisive est la dernière : **comparer les octets téléchargés à ceux
 * déposés**. Elle seule prouve que le chiffrement, le déchiffrement, le
 * stockage et le tag d'intégrité sont tous cohérents entre eux.
 *
 * S'exécute de l'extérieur, sans rien connaître de l'implémentation : utilisable
 * sur une machine de développement comme sur le serveur.
 *
 * @example
 * ```bash
 * node scripts/verifier-deploiement.mjs                       # http://localhost:3000
 * node scripts/verifier-deploiement.mjs http://localhost:3100
 * ```
 *
 * Sort en code 0 si tout passe, 1 sinon — utilisable tel quel dans un
 * déploiement automatisé.
 */

const BASE = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');

/** En-tête exigé par la défense CSRF sur les routes qui écrivent. */
const CSRF = { 'X-Requested-With': 'XMLHttpRequest' };

/** Contenu témoin, assez distinctif pour qu'une comparaison ait du sens. */
const CONTENU = `Facture n°2026-09-17 — montant : 4 250,00 €.\nAccents, € et ponctuation : é à ù ç « ».\n`;

let cookies = '';
let reussites = 0;
let echecs = 0;

/** Affiche le résultat d'une étape et tient le compte. */
function verifier(libelle, condition, detail = '') {
  if (condition) {
    reussites += 1;
    console.log(`  ✅ ${libelle}${detail ? ` — ${detail}` : ''}`);
  } else {
    echecs += 1;
    console.log(`  ❌ ${libelle}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * Appelle le service en conservant les cookies de session.
 *
 * `fetch` n'a pas de bocal à cookies : on relaie soi-même les `Set-Cookie`,
 * ce qui est de toute façon plus explicite pour un script de vérification.
 */
async function appeler(chemin, options = {}) {
  const response = await fetch(`${BASE}${chemin}`, {
    ...options,
    headers: {
      ...(cookies ? { Cookie: cookies } : {}),
      ...options.headers,
    },
  });

  const recus = response.headers.getSetCookie?.() ?? [];

  if (recus.length > 0) {
    cookies = recus.map((c) => c.split(';')[0]).join('; ');
  }

  return response;
}

async function main() {
  console.log(`\nVérification de ${BASE}\n`);

  // --- 1. Le service est-il en vie, et sa base joignable ? -----------------
  console.log('1. Supervision');
  const sante = await appeler('/health');
  const santeJson = await sante.json().catch(() => ({}));
  verifier('GET /health répond 200', sante.status === 200, `reçu ${sante.status}`);
  verifier(
    'la base est joignable',
    santeJson?.checks?.database === 'up',
    `version applicative : ${santeJson?.version ?? 'inconnue'}`,
  );

  // --- 2. Création de compte et session ------------------------------------
  console.log('\n2. Compte et session');
  const email = `verification-${Date.now()}@example.fr`;
  const motDePasse = 'phrase-de-passe-de-verification-2026';

  const inscription = await appeler('/api/auth/register', {
    method: 'POST',
    headers: { ...CSRF, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: motDePasse }),
  });
  verifier('inscription', inscription.status === 201, `reçu ${inscription.status}`);

  const connexion = await appeler('/api/auth/login', {
    method: 'POST',
    headers: { ...CSRF, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: motDePasse }),
  });
  verifier('connexion', connexion.status === 200, `reçu ${connexion.status}`);
  verifier('cookie de session reçu', cookies.includes('access_token'));

  // --- 3. Dépôt ------------------------------------------------------------
  // C'est ici que se révèle un volume mal monté ou appartenant au mauvais
  // utilisateur : l'application ne peut alors pas écrire et le dépôt échoue.
  console.log('\n3. Dépôt du fichier');
  const octetsDeposes = Buffer.from(CONTENU, 'utf8');

  const formulaire = new FormData();
  // Le type doit être déclaré : sans lui le navigateur enverrait
  // `application/octet-stream`, que le contrôle de format refuse — à raison.
  formulaire.append(
    'file',
    new Blob([octetsDeposes], { type: 'text/plain' }),
    'facture.txt',
  );

  const depot = await appeler('/api/files', {
    method: 'POST',
    headers: CSRF,
    body: formulaire,
  });
  const depotJson = await depot.json().catch(() => ({}));
  verifier('dépôt accepté', depot.status === 201, `reçu ${depot.status}`);
  verifier('taille cohérente', depotJson.sizeBytes === octetsDeposes.length);

  if (!depotJson.id) {
    console.log('\n  Dépôt impossible : la suite du parcours est sans objet.');
    return;
  }

  // --- 4. Partage ----------------------------------------------------------
  console.log('\n4. Création du lien');
  const partage = await appeler('/api/shares', {
    method: 'POST',
    headers: { ...CSRF, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: [depotJson.id], expiresInHours: 1 }),
  });
  const partageJson = await partage.json().catch(() => ({}));
  verifier('lien créé', partage.status === 201, `reçu ${partage.status}`);
  verifier('jeton renvoyé', typeof partageJson.token === 'string');

  if (!partageJson.token) {
    return;
  }

  // --- 5. Récupération sans compte -----------------------------------------
  // Le destinataire n'a pas de session : on repart d'un contexte vierge, sinon
  // le test prouverait seulement qu'un utilisateur connecté peut télécharger.
  console.log('\n5. Récupération par un destinataire sans compte');
  const sessionDeposant = cookies;
  cookies = '';

  const info = await fetch(`${BASE}/api/download/${partageJson.token}/info`);
  const infoJson = await info.json().catch(() => ({}));
  verifier('consultation du lien', info.status === 200, `reçu ${info.status}`);
  // Le nom d'origine est chiffré en base : le lire correctement prouve que la
  // clé maître du conteneur est bien celle qui a servi au dépôt.
  verifier(
    'le nom du fichier est déchiffré',
    infoJson?.files?.[0]?.fileName === 'facture.txt',
    `lu : ${infoJson?.files?.[0]?.fileName ?? 'aucun'}`,
  );

  const telechargement = await fetch(
    `${BASE}/api/download/${partageJson.token}/file/${depotJson.id}`,
  );
  const octetsRecus = Buffer.from(await telechargement.arrayBuffer());
  verifier(
    'téléchargement',
    telechargement.status === 200,
    `reçu ${telechargement.status}`,
  );

  // L'étape décisive.
  verifier(
    'LE CONTENU EST IDENTIQUE À L\'ORIGINAL',
    octetsRecus.equals(octetsDeposes),
    `${octetsRecus.length} octets reçus sur ${octetsDeposes.length}`,
  );

  verifier(
    'le téléchargement est forcé en pièce jointe',
    telechargement.headers.get('content-disposition')?.includes('attachment') ===
      true,
  );

  // --- 6. Nettoyage --------------------------------------------------------
  // Un script de vérification ne doit pas laisser de compte ni de fichier
  // derrière lui, surtout s'il est rejoué après chaque déploiement.
  console.log('\n6. Nettoyage');
  cookies = sessionDeposant;
  const suppression = await appeler(`/api/files/${depotJson.id}`, {
    method: 'DELETE',
    headers: CSRF,
  });
  verifier(
    'fichier de vérification supprimé',
    suppression.status === 200 || suppression.status === 204,
    `reçu ${suppression.status}`,
  );
}

main()
  .catch((erreur) => {
    echecs += 1;
    console.log(`\n  ❌ Le service est injoignable : ${erreur.message}`);
  })
  .finally(() => {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`${reussites} vérification(s) réussie(s), ${echecs} échec(s)`);
    console.log(
      echecs === 0
        ? 'Le déploiement est fonctionnel de bout en bout.\n'
        : 'Le déploiement présente au moins un défaut.\n',
    );
    process.exit(echecs === 0 ? 0 : 1);
  });
