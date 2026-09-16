import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { CryptoService, DecryptionError, IV_BYTES } from './crypto.service';

const KEY_V1 = '11'.repeat(32);
const KEY_V2 = '22'.repeat(32);
const INDEX_KEY = '33'.repeat(32);

/**
 * Construit le service avec un jeu de clés donné.
 *
 * @param withV2 Simule une rotation en cours, où deux clés coexistent.
 */
async function createService(withV2 = false): Promise<CryptoService> {
  const values: Record<string, string | undefined> = {
    ENCRYPTION_KEY_V1: KEY_V1,
    ENCRYPTION_KEY_V2: withV2 ? KEY_V2 : undefined,
    HMAC_INDEX_KEY: INDEX_KEY,
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      CryptoService,
      {
        provide: ConfigService,
        useValue: { get: (key: string) => values[key] },
      },
    ],
  }).compile();

  return module.get(CryptoService);
}

describe('CryptoService', () => {
  let crypto: CryptoService;

  beforeEach(async () => {
    crypto = await createService();
  });

  describe('Chiffrement de champs', () => {
    it('restitue exactement la valeur d\'origine', () => {
      const original = 'rapport-financier-2026.pdf';

      expect(crypto.openToString(crypto.seal(original))).toBe(original);
    });

    it('préserve les accents et les emojis', () => {
      const original = 'déclaration fiscale — très confidentielle 🔒';

      expect(crypto.openToString(crypto.seal(original))).toBe(original);
    });

    it('gère les données binaires sans les abîmer', () => {
      const original = Buffer.from([0x00, 0xff, 0x10, 0x00, 0x42]);

      expect(crypto.open(crypto.seal(original))).toEqual(original);
    });

    it('gère la chaîne vide', () => {
      expect(crypto.openToString(crypto.seal(''))).toBe('');
    });

    it('produit une chaîne au format attendu', () => {
      const parts = crypto.seal('test').split('.');

      expect(parts).toHaveLength(4);
      expect(parts[0]).toBe('v1');
      expect(Buffer.from(parts[1], 'base64')).toHaveLength(IV_BYTES);
    });

    // Sans IV unique, deux fichiers de même nom produiraient le même chiffré :
    // un observateur de la base apprendrait qu'ils sont identiques.
    it('produit un résultat différent à chaque appel, même valeur en entrée', () => {
      const a = crypto.seal('document.pdf');
      const b = crypto.seal('document.pdf');

      expect(a).not.toBe(b);
      expect(crypto.openToString(a)).toBe(crypto.openToString(b));
    });

    it('ne laisse jamais apparaître la valeur en clair dans le résultat', () => {
      const sealed = crypto.seal('secret-tres-reconnaissable');

      expect(sealed).not.toContain('secret');
    });
  });

  describe('Détection d\'altération', () => {
    // Le bénéfice concret de GCM sur CBC : on ne déchiffre pas une donnée
    // modifiée, on la refuse.
    it('refuse une valeur dont le chiffré a été modifié', () => {
      const parts = crypto.seal('virement: 100 euros').split('.');
      const corrupted = Buffer.from(parts[3], 'base64');
      corrupted[0] ^= 0xff;
      parts[3] = corrupted.toString('base64');

      expect(() => crypto.open(parts.join('.'))).toThrow(DecryptionError);
    });

    it('refuse une valeur dont le tag a été modifié', () => {
      const parts = crypto.seal('test').split('.');
      const tag = Buffer.from(parts[2], 'base64');
      tag[0] ^= 0xff;
      parts[2] = tag.toString('base64');

      expect(() => crypto.open(parts.join('.'))).toThrow(DecryptionError);
    });

    it('refuse une valeur dont l\'IV a été modifié', () => {
      const parts = crypto.seal('test').split('.');
      const iv = Buffer.from(parts[1], 'base64');
      iv[0] ^= 0xff;
      parts[1] = iv.toString('base64');

      expect(() => crypto.open(parts.join('.'))).toThrow(DecryptionError);
    });

    it.each([
      ['vide', ''],
      ['sans séparateur', 'nimportequoi'],
      ['trop peu de parties', 'v1.abc.def'],
      ['version inconnue', 'v9.abc.def.ghi'],
    ])('refuse une valeur mal formée (%s)', (_cas, value) => {
      expect(() => crypto.open(value)).toThrow(DecryptionError);
    });

    // Un message d'erreur trop précis indiquerait à un attaquant quelle partie
    // de sa tentative a échoué.
    it('ne révèle pas la cause exacte de l\'échec', () => {
      expect(() => crypto.open('v1.abc.def.ghi')).toThrow(
        'Déchiffrement impossible',
      );
    });

    it('refuse une valeur chiffrée avec une autre clé', async () => {
      const autreService = await createService(true);
      // Scellée en v2, qui n'existe pas pour le service courant.
      const sealed = autreService.seal('secret');

      expect(() => crypto.open(sealed)).toThrow(DecryptionError);
    });
  });

  describe('Rotation de clés', () => {
    it('chiffre avec la clé la plus récente disponible', async () => {
      const enRotation = await createService(true);

      expect(enRotation.keyVersion).toBe('v2');
      expect(enRotation.seal('test').startsWith('v2.')).toBe(true);
    });

    // Le cœur de la rotation : pendant la bascule, les anciennes données
    // doivent rester lisibles, sinon il faudrait tout re-chiffrer d'un coup.
    it('déchiffre encore les valeurs scellées avec l\'ancienne clé', async () => {
      const avant = crypto.seal('document-ancien.pdf');
      const enRotation = await createService(true);

      expect(enRotation.openToString(avant)).toBe('document-ancien.pdf');
    });

    it('utilise v1 tant qu\'aucune clé v2 n\'est configurée', () => {
      expect(crypto.keyVersion).toBe('v1');
    });
  });

  describe('Chiffrement enveloppe', () => {
    it('tire une clé de fichier de 32 octets', () => {
      expect(crypto.generateDataKey()).toHaveLength(32);
    });

    it('tire une clé différente à chaque fichier', () => {
      const a = crypto.generateDataKey();
      const b = crypto.generateDataKey();

      expect(a.equals(b)).toBe(false);
    });

    it('scelle et rouvre une clé de fichier à l\'identique', () => {
      const dek = crypto.generateDataKey();

      expect(crypto.open(crypto.seal(dek))).toEqual(dek);
    });

    it('chiffre puis déchiffre un contenu de fichier', () => {
      const dek = crypto.generateDataKey();
      const contenu = Buffer.from('Contenu confidentiel du fichier.', 'utf8');

      const { cipher, iv, authTag } = crypto.createContentCipher(dek);
      const chiffre = Buffer.concat([cipher.update(contenu), cipher.final()]);
      const tag = authTag();

      const decipher = crypto.createContentDecipher(dek, iv, tag);
      const dechiffre = Buffer.concat([
        decipher.update(chiffre),
        decipher.final(),
      ]);

      expect(dechiffre).toEqual(contenu);
      expect(chiffre).not.toEqual(contenu);
    });

    // La démonstration à faire au jury : un octet modifié sur le disque et le
    // téléchargement échoue au lieu de servir un fichier corrompu.
    it('refuse un contenu de fichier altéré sur le disque', () => {
      const dek = crypto.generateDataKey();
      const contenu = Buffer.from('Contenu intègre', 'utf8');

      const { cipher, iv, authTag } = crypto.createContentCipher(dek);
      const chiffre = Buffer.concat([cipher.update(contenu), cipher.final()]);
      const tag = authTag();

      chiffre[0] ^= 0xff;

      const decipher = crypto.createContentDecipher(dek, iv, tag);

      expect(() => {
        decipher.update(chiffre);
        decipher.final();
      }).toThrow();
    });

    it('refuse un contenu déchiffré avec la mauvaise clé de fichier', () => {
      const contenu = Buffer.from('Contenu', 'utf8');
      const { cipher, iv, authTag } = crypto.createContentCipher(
        crypto.generateDataKey(),
      );
      const chiffre = Buffer.concat([cipher.update(contenu), cipher.final()]);

      const decipher = crypto.createContentDecipher(
        crypto.generateDataKey(),
        iv,
        authTag(),
      );

      expect(() => {
        decipher.update(chiffre);
        decipher.final();
      }).toThrow();
    });
  });

  describe('Index aveugle', () => {
    it('donne le même index pour le même email', () => {
      expect(crypto.blindIndex('alice@example.fr')).toBe(
        crypto.blindIndex('alice@example.fr'),
      );
    });

    it('donne des index différents pour des emails différents', () => {
      expect(crypto.blindIndex('alice@example.fr')).not.toBe(
        crypto.blindIndex('bob@example.fr'),
      );
    });

    // Sans normalisation, un destinataire saisi avec une majuscule ne
    // retrouverait pas son propre partage.
    it.each([
      ['une majuscule', 'Alice@Example.fr'],
      ['des espaces', '  alice@example.fr  '],
      ['les deux', '  ALICE@EXAMPLE.FR '],
    ])('normalise %s avant de calculer l\'index', (_cas, variante) => {
      expect(crypto.blindIndex(variante)).toBe(
        crypto.blindIndex('alice@example.fr'),
      );
    });

    it('ne laisse pas deviner l\'email d\'origine', () => {
      const index = crypto.blindIndex('alice@example.fr');

      expect(index).not.toContain('alice');
      expect(index).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('Jetons de partage', () => {
    it('produit un jeton utilisable dans une URL', () => {
      expect(crypto.generateToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('produit un jeton différent à chaque appel', () => {
      const jetons = new Set(
        Array.from({ length: 100 }, () => crypto.generateToken()),
      );

      expect(jetons.size).toBe(100);
    });

    it('tire au moins 32 octets d\'entropie', () => {
      expect(Buffer.from(crypto.generateToken(), 'base64url')).toHaveLength(32);
    });

    it('produit une empreinte stable pour un même jeton', () => {
      const token = crypto.generateToken();

      expect(crypto.hashToken(token)).toBe(crypto.hashToken(token));
    });

    // Ce qui rend une fuite de la base inexploitable : les liens de partage
    // n'y figurent pas.
    it('ne permet pas de retrouver le jeton depuis son empreinte', () => {
      const token = crypto.generateToken();
      const hash = crypto.hashToken(token);

      expect(hash).not.toContain(token);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('Comparaison à temps constant', () => {
    it('reconnaît deux valeurs identiques', () => {
      expect(crypto.safeEquals('abc123', 'abc123')).toBe(true);
    });

    it('distingue deux valeurs différentes', () => {
      expect(crypto.safeEquals('abc123', 'abc124')).toBe(false);
    });

    it('gère des longueurs différentes sans lever d\'erreur', () => {
      expect(crypto.safeEquals('court', 'beaucoup-plus-long')).toBe(false);
    });

    it('gère les chaînes vides', () => {
      expect(crypto.safeEquals('', '')).toBe(true);
      expect(crypto.safeEquals('', 'x')).toBe(false);
    });
  });
});
