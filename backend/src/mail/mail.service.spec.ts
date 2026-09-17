import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MailService, type Courriel } from './mail.service';

const COURRIEL: Courriel = {
  to: 'alice@example.fr',
  subject: 'Vérification',
  text: 'Votre code : 123456',
  html: '<p>Votre code : 123456</p>',
};

/**
 * Envoi de courriels.
 *
 * Ces tests ne joignent jamais Brevo : `fetch` est remplacé. Ce qu'on vérifie,
 * c'est le contrat — ce qui part sur le réseau, et ce qui se passe quand rien
 * n'est configuré ou que Brevo refuse.
 */
describe('MailService', () => {
  const valeurs: Record<string, unknown> = {};
  let service: MailService;
  let fetchOrigine: typeof globalThis.fetch;

  beforeEach(async () => {
    fetchOrigine = globalThis.fetch;

    Object.assign(valeurs, {
      BREVO_API_KEY: 'xkeysib-cle-de-test',
      MAIL_FROM_ADDRESS: 'no-reply@filemoica.fr',
      MAIL_FROM_NAME: 'filemoica',
      NODE_ENV: 'test',
    });

    const module = await Test.createTestingModule({
      providers: [
        MailService,
        {
          provide: ConfigService,
          useValue: { get: (cle: string) => valeurs[cle] },
        },
      ],
    }).compile();

    service = module.get(MailService);
  });

  afterEach(() => {
    globalThis.fetch = fetchOrigine;
  });

  describe('Envoi normal', () => {
    it('appelle Brevo avec la clé et l\'expéditeur configurés', async () => {
      const appels: { url: string; init: RequestInit }[] = [];
      globalThis.fetch = (async (url: string, init: RequestInit) => {
        appels.push({ url, init });
        return new Response('{}', { status: 201 });
      }) as unknown as typeof globalThis.fetch;

      await service.envoyer(COURRIEL);

      expect(appels).toHaveLength(1);
      expect(appels[0].url).toBe('https://api.brevo.com/v3/smtp/email');

      const entetes = appels[0].init.headers as Record<string, string>;
      expect(entetes['api-key']).toBe('xkeysib-cle-de-test');

      const corps = JSON.parse(appels[0].init.body as string);
      expect(corps.sender.email).toBe('no-reply@filemoica.fr');
      expect(corps.to).toEqual([{ email: 'alice@example.fr' }]);
      expect(corps.subject).toBe('Vérification');
      // Les deux versions partent : certains clients n'affichent que le texte.
      expect(corps.textContent).toContain('123456');
      expect(corps.htmlContent).toContain('123456');
    });
  });

  describe('Quand Brevo refuse', () => {
    // Un expéditeur non validé est le refus le plus courant, et le message de
    // Brevo est la seule façon de le diagnostiquer.
    it('lève une erreur qui reprend la réponse de Brevo', async () => {
      globalThis.fetch = (async () =>
        new Response('{"message":"Sender not valid"}', {
          status: 400,
        })) as unknown as typeof globalThis.fetch;

      await expect(service.envoyer(COURRIEL)).rejects.toThrow(/Sender not valid/);
    });

    it('signale le code de statut', async () => {
      globalThis.fetch = (async () =>
        new Response('', { status: 401 })) as unknown as typeof globalThis.fetch;

      await expect(service.envoyer(COURRIEL)).rejects.toThrow(/401/);
    });
  });

  describe('Sans clé configurée', () => {
    beforeEach(() => {
      valeurs.BREVO_API_KEY = undefined;
    });

    // Le repli de développement : on veut pouvoir travailler sans compte Brevo.
    it('n\'appelle pas le réseau', async () => {
      let appele = false;
      globalThis.fetch = (async () => {
        appele = true;
        return new Response('{}', { status: 201 });
      }) as unknown as typeof globalThis.fetch;

      await service.envoyer(COURRIEL);

      expect(appele).toBe(false);
    });

    it('n\'échoue pas — le développement doit rester possible', async () => {
      await expect(service.envoyer(COURRIEL)).resolves.toBeUndefined();
    });

    it('se déclare inactif, pour que l\'appelant puisse le dire', () => {
      expect(service.actif).toBe(false);
    });
  });

  describe('Journaux', () => {
    it('ne recopie pas l\'adresse complète du destinataire', async () => {
      const ecrits: string[] = [];
      jest
        .spyOn(service['logger'], 'log')
        .mockImplementation((message: unknown) => {
          ecrits.push(String(message));
        });

      globalThis.fetch = (async () =>
        new Response('{}', { status: 201 })) as unknown as typeof globalThis.fetch;

      await service.envoyer(COURRIEL);

      const tout = ecrits.join(' ');
      expect(tout).not.toContain('alice@example.fr');
      expect(tout).toContain('@example.fr');
    });
  });
});
