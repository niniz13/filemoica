import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { HealthService } from './health.service';

describe('HealthService', () => {
  let service: HealthService;
  let isReachable: jest.Mock<Promise<boolean>, []>;

  beforeEach(async () => {
    isReachable = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: PrismaService, useValue: { isReachable } },
        { provide: ConfigService, useValue: { get: () => 'v1.2.3' } },
      ],
    }).compile();

    service = module.get(HealthService);
  });

  it('rapporte un service en bonne santé quand la base répond', async () => {
    isReachable.mockResolvedValue(true);

    const report = await service.check();

    expect(report.status).toBe('ok');
    expect(report.checks.database).toBe('up');
    expect(report.version).toBe('v1.2.3');
  });

  // Le comportement que le test d'incident doit démontrer : une base arrêtée
  // se voit immédiatement dans la sonde, elle ne passe pas inaperçue.
  it('bascule en « degraded » quand la base ne répond plus', async () => {
    isReachable.mockResolvedValue(false);

    const report = await service.check();

    expect(report.status).toBe('degraded');
    expect(report.checks.database).toBe('down');
  });

  it('horodate la vérification pour tracer le moment de la panne', async () => {
    isReachable.mockResolvedValue(true);

    const report = await service.check();

    expect(new Date(report.checkedAt).getTime()).not.toBeNaN();
  });
});
