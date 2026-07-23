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