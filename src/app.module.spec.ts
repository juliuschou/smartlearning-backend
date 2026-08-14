import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';

describe('AppModule', () => {
  it('should compile and provide the application module', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(moduleRef).toBeDefined();
    expect(moduleRef.get(AppModule)).toBeInstanceOf(AppModule);

    await moduleRef.close();
  });
});
