// nlp.module.ts: binds the INlpProvider token to the Groq implementation, so the agent
// depends on the interface and never on a specific provider.
import { Module } from '@nestjs/common';
import { GroqNlpService } from './groq-nlp.service';

@Module({
  providers: [
    { provide: 'INlpProvider', useClass: GroqNlpService },
    GroqNlpService,
  ],
  exports: ['INlpProvider'],
})
export class NlpModule {}
