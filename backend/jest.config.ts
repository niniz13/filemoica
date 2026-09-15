import type { Config } from 'jest';
import { pathsToModuleNameMapper } from 'ts-jest';
import ts from 'typescript';

// Path aliases (e.g. the ones added by `nest g library`) live in tsconfig.json,
// so they are read from there instead of being duplicated here.
const { config: tsconfig } = ts.readConfigFile(
  './tsconfig.json',
  ts.sys.readFile,
);
const paths = tsconfig?.compilerOptions?.paths ?? {};

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleNameMapper: {
    // Le client Prisma généré importe ses voisins avec une extension `.js`
    // (convention ESM) alors que ce sont des fichiers `.ts`. Jest, lui, résout
    // les chemins littéralement : sans cette correspondance, il cherche des
    // fichiers qui n'existent pas.
    '^(\\.{1,2}/.*)\\.js$': '$1',
    ...pathsToModuleNameMapper(paths, { prefix: '<rootDir>/' }),
  },
  // Même environnement factice que les tests e2e : la validation de
  // configuration est stricte, y compris quand on ne teste qu'une classe.
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  collectCoverageFrom: [
    'src/**/*.(t|j)s',
    'libs/**/*.(t|j)s',
    'apps/**/*.(t|j)s',
    // Le client Prisma est du code généré : il ne se teste pas et fausserait
    // la couverture réelle du code écrit à la main.
    '!src/generated/**',
  ],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
};

export default config;
