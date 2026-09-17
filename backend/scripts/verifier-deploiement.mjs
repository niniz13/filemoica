/**
 * Vérification d'un déploiement, depuis l'extérieur.
 *
 * ## Ce que ce script peut, et ce qu'il ne peut plus
 *
 * Depuis que la double authentification est exigée, **aucun script ne peut
 * ouvrir une session** : il faudrait relever un code à six chiffres dans une
 * boîte aux lettres. Le parcours complet — dépôt, lien, téléchargement — est
 * donc couvert par la suite end-to-end, qui dispose de la base.
 *
 * Ce qui reste vérifiable de l'extérieur est précisément ce qui casse à un
 * déploiement : la sonde, l'accès à la base, la protection CSRF, et le fait
 * que les contrôles d'accès répondent — plutôt que de laisser passer.
 *
 * @example
 * ```bash
 * node scripts/verifier-deploiement.mjs https://filemoica.example.fr
 * ```
 *
 * Sort en code 0 si tout passe, 1 sinon.
 */

const BASE = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');

/** En-tête exigé par la défense CSRF sur les routes qui écrivent. */
const CSRF = { 'X-Requested-With': 'XMLHttpRequest' };
const JSON_CSRF = { ...CSRF, 'Content-Type': 'application/json' };

let reussites = 0;
let echecs = 0;

function verifier(libelle, condition, detail = '') {
  if (condition) {
    reussites += 1;
    console.log(`  ✅ ${libelle}${detail ? ` — ${detail}` : ''}`);
  } else {
    echecs += 1;
    console.log(`  ❌ ${libelle}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log(`\nVérification de ${BASE}\n`);

  // --- 1. Le service est-il en vie, et sa base joignable ? -----------------
  console.log('1. Supervision');
  const sante = await fetch(`${BASE}/health`);
  const santeJson = await sante.json().catch(() => ({}));

  verifier('GET /health répond 200', sante.status === 200, `reçu ${sante.status}`);
  verifier(
    'la base est joignable',
    santeJson?.checks?.database === 'up',
    `version applicative : ${santeJson?.version ?? 'inconnue'}`,
  );

  // --- 2. La protection CSRF est-elle active ? ------------------------------
  // Le contrôle le plus facile à perdre au déploiement : il suffit qu'une
  // configuration de proxy avale l'en-tête pour que la protection tombe.
  console.log('\n2. Protection CSRF');
  const sansEntete = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'x@example.fr', password: 'peu-importe-ok' }),
  });
  verifier(
    'une écriture sans en-tête est refusée',
    sansEntete.status === 403,
    `reçu ${sansEntete.status}`,
  );

  // --- 3. Le parcours d'inscription -----------------------------------------
  console.log('\n3. Inscription et contrôle d\'accès');
  const email = `verification-${Date.now()}@example.fr`;
  const motDePasse = 'phrase-de-passe-de-verification-2026';

  const inscription = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: JSON_CSRF,
    body: JSON.stringify({ email, password: motDePasse }),
  });
  verifier('inscription acceptée', inscription.status === 201, `reçu ${inscription.status}`);

  // Preuve que la chaîne d'envoi fonctionne : sans clé Brevo valide, le
  // service journalise au lieu d'envoyer, mais l'inscription passe quand même.
  // C'est le refus ci-dessous qui prouve que le contrôle est en place.
  const connexion = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: JSON_CSRF,
    body: JSON.stringify({ email, password: motDePasse }),
  });
  const refus = await connexion.json().catch(() => ({}));

  verifier(
    'la connexion exige une adresse confirmée',
    connexion.status === 403,
    `reçu ${connexion.status}`,
  );
  verifier(
    'le refus est explicite',
    refus?.error === 'EMAIL_NOT_VERIFIED',
    `code ${refus?.error ?? 'absent'}`,
  );
  verifier(
    'aucun cookie de session n\'est posé',
    (connexion.headers.getSetCookie?.() ?? []).length === 0,
  );

  const mauvaisIdentifiants = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: JSON_CSRF,
    body: JSON.stringify({ email, password: 'mauvaise-phrase-de-passe' }),
  });
  verifier(
    'un mot de passe faux est refusé',
    mauvaisIdentifiants.status === 401,
    `reçu ${mauvaisIdentifiants.status}`,
  );

  // --- 4. Les routes publiques de téléchargement ---------------------------
  console.log('\n4. Liens de partage');
  const jetonInconnu = '00000000-0000-4000-8000-000000000000';
  const inconnu = await fetch(`${BASE}/api/download/${jetonInconnu}/info`);
  verifier('un lien inconnu répond 404', inconnu.status === 404, `reçu ${inconnu.status}`);

  const verifSansJeton = await fetch(`${BASE}/api/auth/verify-email`, {
    method: 'POST',
    headers: JSON_CSRF,
    body: JSON.stringify({ token: 'jeton-qui-nexiste-pas' }),
  });
  verifier(
    'un jeton de confirmation inconnu est refusé',
    verifSansJeton.status === 400,
    `reçu ${verifSansJeton.status}`,
  );

  // --- 5. Les routes protégées le sont-elles ? -----------------------------
  console.log('\n5. Routes protégées');
  for (const route of ['/api/files', '/api/files/quota', '/api/admin/users']) {
    const sansSession = await fetch(`${BASE}${route}`);
    verifier(
      `${route} refuse une requête sans session`,
      sansSession.status === 401,
      `reçu ${sansSession.status}`,
    );
  }
}

main()
  .catch((erreur) => {
    echecs += 1;
    console.log(`\n  ❌ Le service est injoignable : ${erreur.message}`);
  })
  .finally(() => {
    console.log(`\n${'─'.repeat(58)}`);
    console.log(`${reussites} vérification(s) réussie(s), ${echecs} échec(s)`);

    if (echecs === 0) {
      console.log('Le service répond et ses contrôles d\'accès sont en place.');
      console.log(
        'Le parcours complet — dépôt, lien, téléchargement — exige une session,',
      );
      console.log(
        'donc un code reçu par courriel : il est couvert par `npm run test:e2e`.\n',
      );
    } else {
      console.log('Le déploiement présente au moins un défaut.\n');
    }

    process.exit(echecs === 0 ? 0 : 1);
  });
