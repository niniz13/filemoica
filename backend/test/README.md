# Tests end-to-end

## Exécution en série obligatoire

`jest-e2e.json` fixe `maxWorkers: 1`. Ce n'est pas un réglage de performance.

Par défaut, Jest exécute les fichiers de test en parallèle dans plusieurs
processus. Or les suites qui touchent aux données partagent **la même base**
`filemoica_test` et vident les tables entre chaque test. En parallèle, une suite
efface donc les données d'une autre en plein milieu de son exécution, et les
échecs qui en résultent sont intermittents et déroutants — ils désignent le test
malchanceux, jamais la cause.

L'alternative serait une base par processus. Elle a été écartée : plus de
complexité pour un gain de quelques secondes sur une suite qui dure moins d'une
minute.

## Deux stratégies selon ce qui est prouvé

**Contre un double** (`app.e2e-spec.ts`, `health.e2e-spec.ts`) — `PrismaService`
est remplacé par un objet simulé. C'est ce qui permet de simuler une base tombée,
impossible à faire de façon fiable en arrêtant un vrai serveur au milieu d'une
suite.

**Contre une vraie base** (`auth.e2e-spec.ts`, `files.e2e-spec.ts`) — parce que
les garanties évaluées en dépendent : contraintes d'unicité, suppressions en
cascade, révocation de session, cloisonnement entre utilisateurs. Un double ne
prouverait rien de tout cela, il ne ferait que répéter ce qu'on lui a dit.

Les tests de fichiers écrivent aussi dans un vrai répertoire de stockage, et
relisent les fichiers **directement sur le disque** pour vérifier qu'ils sont
illisibles. C'est la preuve du chiffrement au repos ; elle n'a de sens que sur de
vrais octets.

## Avant de lancer

```bash
npm run db:up            # PostgreSQL
npm run db:migrate:test  # migrations sur filemoica_test
npm run test:e2e
```

À rejouer après chaque nouvelle migration, faute de quoi les tests échouent sur
des tables absentes.
