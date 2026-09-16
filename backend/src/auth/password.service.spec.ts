import { PasswordService } from './password.service';

// argon2id est volontairement lent : les valeurs par défaut de Jest sont trop
// courtes pour une suite qui calcule plusieurs empreintes.
jest.setTimeout(30_000);

describe('PasswordService', () => {
  const passwords = new PasswordService();
  const PASSWORD = 'phrase-de-passe-suffisamment-longue';

  it('produit une empreinte argon2id', async () => {
    expect(await passwords.hash(PASSWORD)).toMatch(/^\$argon2id\$/);
  });

  it('ne laisse jamais apparaître le mot de passe dans l\'empreinte', async () => {
    expect(await passwords.hash(PASSWORD)).not.toContain(PASSWORD);
  });

  // Le sel aléatoire empêche de repérer, en lisant la base, deux comptes qui
  // partagent le même mot de passe.
  it('produit une empreinte différente à chaque appel', async () => {
    const a = await passwords.hash(PASSWORD);
    const b = await passwords.hash(PASSWORD);

    expect(a).not.toBe(b);
    expect(await passwords.verify(a, PASSWORD)).toBe(true);
    expect(await passwords.verify(b, PASSWORD)).toBe(true);
  });

  it('reconnaît le bon mot de passe', async () => {
    const hashed = await passwords.hash(PASSWORD);

    expect(await passwords.verify(hashed, PASSWORD)).toBe(true);
  });

  it.each([
    ['un mot de passe différent', 'autre-phrase-de-passe-longue'],
    ['une casse différente', 'Phrase-De-Passe-Suffisamment-Longue'],
    ['une chaîne vide', ''],
  ])('rejette %s', async (_cas, tentative) => {
    const hashed = await passwords.hash(PASSWORD);

    expect(await passwords.verify(hashed, tentative)).toBe(false);
  });

  // Une empreinte corrompue en base ne doit pas faire tomber la connexion pour
  // tout le monde : elle doit juste échouer pour ce compte.
  it.each([
    ['vide', ''],
    ['sans structure', 'nimportequoi'],
    ['tronquée', '$argon2id$v=19$m=19456'],
  ])('renvoie false sur une empreinte %s au lieu de lever', async (_cas, h) => {
    await expect(passwords.verify(h, PASSWORD)).resolves.toBe(false);
  });

  describe('Égalisation du temps de réponse', () => {
    it('renvoie toujours false', async () => {
      expect(await passwords.verifyDummy()).toBe(false);
    });

    // Sans cette égalisation, un email inconnu répondrait bien plus vite qu'un
    // email existant, ce qui permettrait d'énumérer les comptes du service.
    it('prend un temps comparable à une vraie vérification', async () => {
      const hashed = await passwords.hash(PASSWORD);

      const debutReel = performance.now();
      await passwords.verify(hashed, 'mauvais-mot-de-passe-de-test');
      const dureeReelle = performance.now() - debutReel;

      // Premier appel exclu de la mesure : il calcule l'empreinte factice.
      await passwords.verifyDummy();

      const debutFactice = performance.now();
      await passwords.verifyDummy();
      const dureeFactice = performance.now() - debutFactice;

      // Même ordre de grandeur : la marge est large pour rester fiable sur une
      // machine chargée, mais écarterait un retour immédiat.
      expect(dureeFactice).toBeGreaterThan(dureeReelle / 5);
    });
  });
});
